import type { PrismaClient } from "@prisma/client";
import { LeaderboardError } from "./leaderboard.errors";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";
import {
  classifyContactBindability,
  resolveDeterministicLeaderboardOwner
} from "./ownership-resolution";

export type AutoBindSource =
  | "CRM"
  | "BACKFILL"
  | "BOT_START"
  | "DEPOSIT_RETRY"
  | "PROMOTION_RETRY"
  | "LIVE_SYNC"
  | "PLAYER_STATUS";

export interface TryAutoBindParticipantInput {
  readonly workspaceId: string;
  readonly crmContactId: string;
  readonly ownerCoadminUserId: string;
  readonly source: AutoBindSource;
  readonly actorUserId?: string;
  readonly dryRun?: boolean;
  /**
   * When true (BOT_START), skip PRIVATE/numeric peer gate — bot already authenticated the user id.
   * CRM/backfill paths must keep the gate.
   */
  readonly skipPrivatePeerGate?: boolean;
}

export type TryAutoBindResult =
  | { readonly status: "BOUND"; readonly ownerCoadminUserId: string; readonly dryRun: boolean }
  | { readonly status: "ALREADY_BOUND"; readonly ownerCoadminUserId: string }
  | { readonly status: "SKIPPED"; readonly reason: string }
  | { readonly status: "TRANSFER_REJECTED"; readonly existingOwnerId: string }
  | { readonly status: "FAILED"; readonly reason: string; readonly code?: string };

/**
 * Attempts an idempotent participant bind using PrismaLeaderboardService semantics.
 * Never transfers. CRM/backfill bind PRIVATE (and UNKNOWN person) contacts with numeric telegramPeerId.
 */
export async function tryAutoBindParticipant(
  prisma: PrismaClient,
  input: TryAutoBindParticipantInput,
  domain: PrismaLeaderboardService = new PrismaLeaderboardService(prisma)
): Promise<TryAutoBindResult> {
  const classified = await classifyContactBindability(prisma, {
    workspaceId: input.workspaceId,
    crmContactId: input.crmContactId,
    ownerCoadminUserId: input.ownerCoadminUserId
  });

  if (classified.classification === "CONTACT_MISSING") {
    return { status: "FAILED", reason: "CONTACT_MISSING", code: "CONTACT_NOT_FOUND" };
  }

  if (classified.classification === "ALREADY_BOUND") {
    if (classified.existingOwnerId === input.ownerCoadminUserId) {
      return { status: "ALREADY_BOUND", ownerCoadminUserId: input.ownerCoadminUserId };
    }
    return {
      status: "TRANSFER_REJECTED",
      existingOwnerId: classified.existingOwnerId!
    };
  }

  // Bot /start always binds to that bot's owner (even when workspace has multiple coadmins).
  if (!input.skipPrivatePeerGate) {
    if (classified.classification === "AMBIGUOUS_OWNER") {
      return { status: "SKIPPED", reason: "AMBIGUOUS_OWNER" };
    }
    if (classified.classification === "NOT_PRIVATE") {
      return { status: "SKIPPED", reason: "NOT_PRIVATE" };
    }
    if (classified.classification === "NON_NUMERIC_PEER") {
      return { status: "SKIPPED", reason: "NON_NUMERIC_PEER" };
    }
    if (classified.classification === "OWNER_SCOPE_MISMATCH") {
      return { status: "SKIPPED", reason: "OWNER_SCOPE_MISMATCH" };
    }
    if (
      classified.deterministicOwnerId != null &&
      classified.deterministicOwnerId !== input.ownerCoadminUserId
    ) {
      return { status: "SKIPPED", reason: "OWNER_SCOPE_MISMATCH" };
    }
  }

  if (input.dryRun) {
    return { status: "BOUND", ownerCoadminUserId: input.ownerCoadminUserId, dryRun: true };
  }

  try {
    await domain.ensureSettings(input.workspaceId, input.ownerCoadminUserId, input.actorUserId);
    const row = await domain.bindParticipant({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      crmContactId: input.crmContactId,
      ...(input.actorUserId !== undefined ? { createdByUserId: input.actorUserId } : {})
    });
    // Heal historical UNKNOWN person contacts to PRIVATE once bound.
    if (classified.kind === "UNKNOWN") {
      await prisma.crmContact
        .updateMany({
          where: {
            id: input.crmContactId,
            workspaceId: input.workspaceId,
            kind: "UNKNOWN"
          },
          data: { kind: "PRIVATE" }
        })
        .catch(() => undefined);
    }
    return { status: "BOUND", ownerCoadminUserId: row.ownerCoadminUserId, dryRun: false };
  } catch (error) {
    if (error instanceof LeaderboardError) {
      if (error.code === "PARTICIPANT_TRANSFER_UNSUPPORTED") {
        return { status: "TRANSFER_REJECTED", existingOwnerId: "unknown" };
      }
      if (error.code === "PARTICIPANT_ALREADY_BOUND" || error.code === "PARTICIPANT_INTEGRITY_ERROR") {
        return { status: "FAILED", reason: error.code, code: error.code };
      }
      return { status: "FAILED", reason: error.message, code: error.code };
    }
    return {
      status: "FAILED",
      reason: error instanceof Error ? error.message : "AUTO_BIND_FAILED"
    };
  }
}

/**
 * Safe auto-bind for Coadmin deposit/promotion retry when PARTICIPANT_NOT_BOUND.
 * Only binds to the authenticated coadmin when they are the deterministic sole owner
 * (or when the requested owner matches deterministic resolution).
 */
export async function tryAutoBindForActingCoadmin(
  prisma: PrismaClient,
  input: {
    readonly workspaceId: string;
    readonly crmContactId: string;
    readonly actingCoadminUserId: string;
  }
): Promise<TryAutoBindResult> {
  const deterministic = await resolveDeterministicLeaderboardOwner(prisma, input.workspaceId);
  if (deterministic == null || deterministic !== input.actingCoadminUserId) {
    return { status: "SKIPPED", reason: "AMBIGUOUS_OR_NOT_SOLE_OWNER" };
  }
  return tryAutoBindParticipant(prisma, {
    workspaceId: input.workspaceId,
    crmContactId: input.crmContactId,
    ownerCoadminUserId: input.actingCoadminUserId,
    source: "DEPOSIT_RETRY",
    actorUserId: input.actingCoadminUserId
  });
}

/**
 * Resolves the sole ACTIVE Coadmin and binds a PRIVATE numeric contact.
 * Used by CRM ensure, player-status heal, and any workspace-scoped lifecycle hook.
 * Never guesses when ownership is ambiguous.
 */
export async function tryAutoBindForDeterministicOwner(
  prisma: PrismaClient,
  input: {
    readonly workspaceId: string;
    readonly crmContactId: string;
    readonly source: AutoBindSource;
    readonly actorUserId?: string;
    readonly dryRun?: boolean;
  },
  domain?: PrismaLeaderboardService
): Promise<TryAutoBindResult> {
  const deterministic = await resolveDeterministicLeaderboardOwner(prisma, input.workspaceId);
  if (deterministic == null) {
    return { status: "SKIPPED", reason: "AMBIGUOUS_OWNER" };
  }
  return tryAutoBindParticipant(
    prisma,
    {
      workspaceId: input.workspaceId,
      crmContactId: input.crmContactId,
      ownerCoadminUserId: deterministic,
      source: input.source,
      ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {})
    },
    domain
  );
}

/**
 * Fire-and-forget safe side effect after CRM contact create/link.
 * Never throws — Telegram/CRM ingestion must not fail because of leaderboard binding.
 */
export async function ensurePrivateContactParticipantSideEffect(
  prisma: PrismaClient,
  input: {
    readonly workspaceId: string;
    readonly crmContactId: string;
    readonly source?: AutoBindSource;
    readonly actorUserId?: string;
  },
  domain?: PrismaLeaderboardService
): Promise<TryAutoBindResult> {
  try {
    return await tryAutoBindForDeterministicOwner(
      prisma,
      {
        workspaceId: input.workspaceId,
        crmContactId: input.crmContactId,
        source: input.source ?? "LIVE_SYNC",
        ...(input.actorUserId !== undefined ? { actorUserId: input.actorUserId } : {})
      },
      domain
    );
  } catch (error) {
    return {
      status: "FAILED",
      reason: error instanceof Error ? error.message : "AUTO_BIND_SIDE_EFFECT_FAILED"
    };
  }
}
