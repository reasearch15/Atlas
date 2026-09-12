import type { PrismaClient } from "@prisma/client";
import {
  PUBLIC_LEADERBOARD_CONTACT_IDENTITY_SELECT,
  resolvePublicLeaderboardNameFromContact,
  shouldHealCrmPublicDisplayName
} from "./telegram/public-leaderboard-identity";
import { PUBLIC_LEADERBOARD_FALLBACK_NAME } from "./telegram/public-display-name";

export interface ReconcileLeaderboardPublicNamesInput {
  readonly workspaceId?: string;
  readonly ownerCoadminUserId?: string;
  readonly dryRun?: boolean;
  readonly limit?: number;
  readonly logger?: {
    info?: (obj: unknown, msg?: string) => void;
  };
}

export interface ReconciledLeaderboardPublicName {
  readonly crmContactId: string;
  readonly workspaceId: string;
  readonly fromDisplayName: string;
  readonly toDisplayName: string;
}

export interface ReconcileLeaderboardPublicNamesResult {
  readonly scanned: number;
  readonly eligible: number;
  readonly updated: number;
  readonly skippedUnchanged: number;
  readonly skippedNoIdentity: number;
  readonly dryRun: boolean;
  readonly repaired: readonly ReconciledLeaderboardPublicName[];
}

/**
 * Repairs CRM display names for leaderboard participants whose public label
 * currently resolves to "Player" while linked Telegram identity has a safe name.
 * Never changes points, ranks, deposits, standings, competition data, Telegram IDs,
 * or participant IDs.
 */
export async function reconcileLeaderboardPublicNames(
  prisma: PrismaClient,
  input: ReconcileLeaderboardPublicNamesInput = {}
): Promise<ReconcileLeaderboardPublicNamesResult> {
  const dryRun = input.dryRun !== false;
  const repaired: ReconciledLeaderboardPublicName[] = [];
  const counts = {
    scanned: 0,
    eligible: 0,
    updated: 0,
    skippedUnchanged: 0,
    skippedNoIdentity: 0,
    dryRun
  };

  const participants = await prisma.leaderboardParticipant.findMany({
    where: {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.ownerCoadminUserId ? { ownerCoadminUserId: input.ownerCoadminUserId } : {})
    },
    select: {
      crmContactId: true,
      workspaceId: true,
      crmContact: {
        select: PUBLIC_LEADERBOARD_CONTACT_IDENTITY_SELECT
      }
    },
    orderBy: { updatedAt: "asc" },
    ...(input.limit != null ? { take: input.limit } : {})
  });

  for (const participant of participants) {
    counts.scanned += 1;
    const contact = participant.crmContact;
    const resolved = resolvePublicLeaderboardNameFromContact(contact);
    if (!shouldHealCrmPublicDisplayName(contact.displayName, resolved)) {
      if (resolved === PUBLIC_LEADERBOARD_FALLBACK_NAME) counts.skippedNoIdentity += 1;
      else counts.skippedUnchanged += 1;
      continue;
    }

    counts.eligible += 1;
    const entry: ReconciledLeaderboardPublicName = {
      crmContactId: participant.crmContactId,
      workspaceId: participant.workspaceId,
      fromDisplayName: contact.displayName,
      toDisplayName: resolved
    };
    repaired.push(entry);
    input.logger?.info?.(entry, "leaderboard.public_name.reconciled");
    if (dryRun) continue;

    await prisma.crmContact.update({
      where: { id: participant.crmContactId },
      data: { displayName: resolved.slice(0, 255) }
    });
    counts.updated += 1;
  }

  return { ...counts, repaired };
}
