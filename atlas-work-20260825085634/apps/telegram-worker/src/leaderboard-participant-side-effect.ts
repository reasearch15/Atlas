/**
 * Best-effort LeaderboardParticipant bind after Telegram CRM contact create/link.
 *
 * Kept inside the telegram-worker (no @atlas/backend dependency) but mirrors
 * backend ownership rules:
 * - PRIVATE or UNKNOWN person + numeric telegramPeerId
 * - exactly one ACTIVE COADMIN owner
 * - never transfer / never guess
 * - never throw into message ingestion
 */
import type { PrismaClient } from "@prisma/client";

const NUMERIC_PEER = /^\d+$/;

export type LiveSyncAutoBindResult =
  | { readonly status: "BOUND" | "ALREADY_BOUND"; readonly ownerCoadminUserId: string }
  | { readonly status: "SKIPPED"; readonly reason: string }
  | { readonly status: "FAILED"; readonly reason: string };

function isEligiblePrivatePerson(kind: string, telegramPeerId: string): boolean {
  if (kind === "CHANNEL" || kind === "GROUP") return false;
  if (kind !== "PRIVATE" && kind !== "UNKNOWN") return false;
  return NUMERIC_PEER.test(telegramPeerId);
}

/**
 * Idempotent side effect: ensure a PRIVATE Atlas contact has a LeaderboardParticipant
 * when the workspace has a deterministic sole Coadmin.
 */
export async function ensureLeaderboardParticipantBestEffort(
  prisma: PrismaClient,
  workspaceId: string,
  crmContactId: string
): Promise<LiveSyncAutoBindResult> {
  try {
    const contact = await prisma.crmContact.findFirst({
      where: { id: crmContactId, workspaceId },
      select: { id: true, kind: true, telegramPeerId: true }
    });
    if (!contact) return { status: "SKIPPED", reason: "CONTACT_MISSING" };
    if (!isEligiblePrivatePerson(contact.kind, contact.telegramPeerId)) {
      if (contact.kind === "CHANNEL" || contact.kind === "GROUP") {
        return { status: "SKIPPED", reason: "NOT_PRIVATE" };
      }
      if (!NUMERIC_PEER.test(contact.telegramPeerId)) {
        return { status: "SKIPPED", reason: "NON_NUMERIC_PEER" };
      }
      return { status: "SKIPPED", reason: "NOT_PRIVATE" };
    }

    const coadmins = await prisma.user.findMany({
      where: { workspaceId, role: "COADMIN", status: "ACTIVE" },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 2
    });
    if (coadmins.length !== 1) {
      return { status: "SKIPPED", reason: "AMBIGUOUS_OWNER" };
    }
    const ownerCoadminUserId = coadmins[0]!.id;

    const existing = await prisma.leaderboardParticipant.findMany({
      where: { workspaceId, crmContactId },
      select: { id: true, ownerCoadminUserId: true }
    });
    if (existing.length > 1) {
      return { status: "SKIPPED", reason: "PARTICIPANT_INTEGRITY_ERROR" };
    }
    if (existing.length === 1) {
      if (existing[0]!.ownerCoadminUserId !== ownerCoadminUserId) {
        return { status: "SKIPPED", reason: "TRANSFER_REJECTED" };
      }
      await healUnknownKind(prisma, workspaceId, crmContactId, contact.kind);
      await ensureZeroStandingIfActive(prisma, workspaceId, ownerCoadminUserId, crmContactId);
      return { status: "ALREADY_BOUND", ownerCoadminUserId };
    }

    // Settings may be missing; create disabled defaults without enabling the board.
    await prisma.leaderboardSettings.upsert({
      where: { ownerCoadminUserId },
      create: {
        workspaceId,
        ownerCoadminUserId,
        enabled: false,
        poolRateBps: 200,
        timezone: "America/Chicago"
      },
      update: { ownerCoadminUserId }
    });

    try {
      await prisma.leaderboardParticipant.create({
        data: {
          workspaceId,
          ownerCoadminUserId,
          crmContactId
        }
      });
    } catch (error) {
      // Unique race → treat as already bound if same owner.
      const raced = await prisma.leaderboardParticipant.findMany({
        where: { workspaceId, crmContactId },
        select: { ownerCoadminUserId: true }
      });
      if (raced.length === 1 && raced[0]!.ownerCoadminUserId === ownerCoadminUserId) {
        await healUnknownKind(prisma, workspaceId, crmContactId, contact.kind);
        await ensureZeroStandingIfActive(prisma, workspaceId, ownerCoadminUserId, crmContactId);
        return { status: "ALREADY_BOUND", ownerCoadminUserId };
      }
      if (raced.length === 1) {
        return { status: "SKIPPED", reason: "TRANSFER_REJECTED" };
      }
      throw error;
    }

    await healUnknownKind(prisma, workspaceId, crmContactId, contact.kind);
    await ensureZeroStandingIfActive(prisma, workspaceId, ownerCoadminUserId, crmContactId);
    return { status: "BOUND", ownerCoadminUserId };
  } catch (error) {
    return {
      status: "FAILED",
      reason: error instanceof Error ? error.message : "LIVE_SYNC_AUTO_BIND_FAILED"
    };
  }
}

async function healUnknownKind(
  prisma: PrismaClient,
  workspaceId: string,
  crmContactId: string,
  kind: string
): Promise<void> {
  if (kind !== "UNKNOWN") return;
  await prisma.crmContact
    .updateMany({
      where: { id: crmContactId, workspaceId, kind: "UNKNOWN" },
      data: { kind: "PRIVATE" }
    })
    .catch(() => undefined);
}

async function ensureZeroStandingIfActive(
  prisma: PrismaClient,
  workspaceId: string,
  ownerCoadminUserId: string,
  crmContactId: string
): Promise<void> {
  const settings = await prisma.leaderboardSettings.findUnique({
    where: { ownerCoadminUserId }
  });
  if (!settings?.enabled || settings.workspaceId !== workspaceId) return;

  const now = new Date();
  const competition = await prisma.leaderboardCompetition.findFirst({
    where: {
      workspaceId,
      ownerCoadminUserId,
      status: "ACTIVE",
      startsAt: { lte: now },
      endsAt: { gt: now }
    },
    select: { id: true }
  });
  if (!competition) return;

  await prisma.leaderboardStanding.upsert({
    where: {
      competitionId_crmContactId: {
        competitionId: competition.id,
        crmContactId
      }
    },
    create: {
      workspaceId,
      ownerCoadminUserId,
      competitionId: competition.id,
      crmContactId,
      pointsReachedAt: now
    },
    update: { ownerCoadminUserId }
  });
}
