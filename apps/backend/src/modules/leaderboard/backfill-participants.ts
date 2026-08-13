import type { PrismaClient } from "@prisma/client";
import { tryAutoBindParticipant } from "./auto-bind";
import { resolveDeterministicLeaderboardOwner } from "./ownership-resolution";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";

export interface BackfillParticipantsInput {
  readonly workspaceId: string;
  readonly ownerCoadminUserId?: string;
  readonly dryRun?: boolean;
  readonly actorUserId?: string;
  readonly limit?: number;
}

export interface BackfillParticipantsCounts {
  scanned: number;
  eligible: number;
  bound: number;
  alreadyBound: number;
  ambiguous: number;
  conflict: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  deterministicOwnerId: string | null;
}

/**
 * Backfills LeaderboardParticipant rows for PRIVATE numeric CRM contacts when the
 * workspace has exactly one ACTIVE COADMIN (or when that owner matches scope).
 * Never runs at app startup — invoke via script or Coadmin API only.
 */
export async function backfillLeaderboardParticipants(
  prisma: PrismaClient,
  input: BackfillParticipantsInput,
  domain: PrismaLeaderboardService = new PrismaLeaderboardService(prisma)
): Promise<BackfillParticipantsCounts> {
  const dryRun = input.dryRun === true;
  const deterministicOwnerId = await resolveDeterministicLeaderboardOwner(prisma, input.workspaceId);

  const counts: BackfillParticipantsCounts = {
    scanned: 0,
    eligible: 0,
    bound: 0,
    alreadyBound: 0,
    ambiguous: 0,
    conflict: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    deterministicOwnerId
  };

  if (deterministicOwnerId == null) {
    // Still scan eligible contacts for reporting when possible, but never bind.
    const contacts = await prisma.crmContact.findMany({
      where: { workspaceId: input.workspaceId, kind: "PRIVATE" },
      select: { id: true, telegramPeerId: true },
      ...(input.limit != null ? { take: input.limit } : {})
    });
    counts.scanned = contacts.length;
    counts.eligible = contacts.filter((c) => /^\d+$/.test(c.telegramPeerId)).length;
    counts.ambiguous = counts.eligible > 0 ? counts.eligible : 1;
    return counts;
  }

  if (input.ownerCoadminUserId != null && input.ownerCoadminUserId !== deterministicOwnerId) {
    counts.ambiguous = 1;
    return counts;
  }

  const ownerCoadminUserId = input.ownerCoadminUserId ?? deterministicOwnerId;
  const contacts = await prisma.crmContact.findMany({
    where: {
      workspaceId: input.workspaceId,
      kind: "PRIVATE"
    },
    select: { id: true, telegramPeerId: true },
    orderBy: { createdAt: "asc" },
    ...(input.limit != null ? { take: input.limit } : {})
  });

  for (const contact of contacts) {
    counts.scanned += 1;
    if (!/^\d+$/.test(contact.telegramPeerId)) {
      counts.skipped += 1;
      continue;
    }
    counts.eligible += 1;

    const result = await tryAutoBindParticipant(
      prisma,
      {
        workspaceId: input.workspaceId,
        crmContactId: contact.id,
        ownerCoadminUserId,
        source: "BACKFILL",
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
        dryRun
      },
      domain
    );

    switch (result.status) {
      case "BOUND":
        counts.bound += 1;
        break;
      case "ALREADY_BOUND":
        counts.alreadyBound += 1;
        break;
      case "TRANSFER_REJECTED":
        counts.conflict += 1;
        break;
      case "SKIPPED":
        if (result.reason === "AMBIGUOUS_OWNER") counts.ambiguous += 1;
        else counts.skipped += 1;
        break;
      case "FAILED":
        counts.failed += 1;
        break;
    }
  }

  return counts;
}
