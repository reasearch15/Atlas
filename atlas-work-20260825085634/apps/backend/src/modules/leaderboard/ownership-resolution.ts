import type { PrismaClient } from "@prisma/client";

export type ContactBindabilityClass =
  | "BINDABLE"
  | "ALREADY_BOUND"
  | "AMBIGUOUS_OWNER"
  | "NOT_PRIVATE"
  | "NON_NUMERIC_PEER"
  | "CONTACT_MISSING"
  | "OWNER_SCOPE_MISMATCH";

export interface ClassifyContactBindabilityInput {
  readonly workspaceId: string;
  readonly crmContactId: string;
  /** When set, BINDABLE only if deterministic owner equals this id. */
  readonly ownerCoadminUserId?: string;
}

export interface ClassifyContactBindabilityResult {
  readonly classification: ContactBindabilityClass;
  readonly deterministicOwnerId: string | null;
  readonly existingOwnerId: string | null;
  readonly kind: string | null;
  readonly telegramPeerId: string | null;
}

type PrismaLike = Pick<PrismaClient, "user" | "leaderboardParticipant" | "crmContact">;

/** Telegram user ids are positive decimals; channels/groups use negative / -100… ids. */
export const NUMERIC_TELEGRAM_USER_PEER = /^\d+$/;

/**
 * True for person contacts eligible for automatic LeaderboardParticipant binding.
 *
 * PRIVATE is the happy path. UNKNOWN + numeric user peer is also eligible because
 * live-sync historically created CRM rows as UNKNOWN while TelegramChat defaulted to PRIVATE
 * — those contacts must not stay unbound forever.
 *
 * CHANNEL / GROUP are never eligible.
 */
export function isAutoBindEligiblePrivatePerson(input: {
  readonly kind: string | null | undefined;
  readonly telegramPeerId: string | null | undefined;
}): boolean {
  const kind = input.kind ?? "UNKNOWN";
  if (kind === "CHANNEL" || kind === "GROUP") return false;
  if (kind !== "PRIVATE" && kind !== "UNKNOWN") return false;
  return NUMERIC_TELEGRAM_USER_PEER.test(input.telegramPeerId ?? "");
}

/**
 * Deterministic sole ACTIVE COADMIN owner for a workspace.
 * Exactly 1 → that user id; 0 or >1 → null (never guess via primaryCoadminId).
 */
export async function resolveDeterministicLeaderboardOwner(
  prisma: PrismaLike,
  workspaceId: string
): Promise<string | null> {
  const coadmins = await prisma.user.findMany({
    where: {
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: 2
  });
  if (coadmins.length !== 1) return null;
  return coadmins[0]!.id;
}

/**
 * Classifies whether a CRM contact can be auto-bound for backfill reporting.
 */
export async function classifyContactBindability(
  prisma: PrismaLike,
  input: ClassifyContactBindabilityInput
): Promise<ClassifyContactBindabilityResult> {
  const deterministicOwnerId = await resolveDeterministicLeaderboardOwner(prisma, input.workspaceId);
  const contact = await prisma.crmContact.findFirst({
    where: { id: input.crmContactId, workspaceId: input.workspaceId },
    select: { id: true, kind: true, telegramPeerId: true }
  });
  if (!contact) {
    return {
      classification: "CONTACT_MISSING",
      deterministicOwnerId,
      existingOwnerId: null,
      kind: null,
      telegramPeerId: null
    };
  }

  const participants = await prisma.leaderboardParticipant.findMany({
    where: { workspaceId: input.workspaceId, crmContactId: input.crmContactId },
    select: { ownerCoadminUserId: true }
  });
  if (participants.length > 1) {
    return {
      classification: "AMBIGUOUS_OWNER",
      deterministicOwnerId,
      existingOwnerId: null,
      kind: contact.kind,
      telegramPeerId: contact.telegramPeerId
    };
  }
  if (participants.length === 1) {
    return {
      classification: "ALREADY_BOUND",
      deterministicOwnerId,
      existingOwnerId: participants[0]!.ownerCoadminUserId,
      kind: contact.kind,
      telegramPeerId: contact.telegramPeerId
    };
  }

  if (contact.kind === "CHANNEL" || contact.kind === "GROUP") {
    return {
      classification: "NOT_PRIVATE",
      deterministicOwnerId,
      existingOwnerId: null,
      kind: contact.kind,
      telegramPeerId: contact.telegramPeerId
    };
  }
  if (!NUMERIC_TELEGRAM_USER_PEER.test(contact.telegramPeerId)) {
    return {
      classification: "NON_NUMERIC_PEER",
      deterministicOwnerId,
      existingOwnerId: null,
      kind: contact.kind,
      telegramPeerId: contact.telegramPeerId
    };
  }
  // PRIVATE or UNKNOWN with numeric user peer — both bindable.
  if (contact.kind !== "PRIVATE" && contact.kind !== "UNKNOWN") {
    return {
      classification: "NOT_PRIVATE",
      deterministicOwnerId,
      existingOwnerId: null,
      kind: contact.kind,
      telegramPeerId: contact.telegramPeerId
    };
  }
  if (deterministicOwnerId == null) {
    return {
      classification: "AMBIGUOUS_OWNER",
      deterministicOwnerId: null,
      existingOwnerId: null,
      kind: contact.kind,
      telegramPeerId: contact.telegramPeerId
    };
  }
  if (input.ownerCoadminUserId != null && input.ownerCoadminUserId !== deterministicOwnerId) {
    return {
      classification: "OWNER_SCOPE_MISMATCH",
      deterministicOwnerId,
      existingOwnerId: null,
      kind: contact.kind,
      telegramPeerId: contact.telegramPeerId
    };
  }

  return {
    classification: "BINDABLE",
    deterministicOwnerId,
    existingOwnerId: null,
    kind: contact.kind,
    telegramPeerId: contact.telegramPeerId
  };
}
