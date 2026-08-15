import { randomUUID } from "node:crypto";
import type { LeaderboardTelegramJobType, Prisma, PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";

const PENDING_STATUSES = ["QUEUED", "DISPATCHING", "RETRY_SCHEDULED"] as const;
const TERMINAL_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

/**
 * DISPATCHING older than this is treated as a crashed/stuck claim.
 * Fresh DISPATCHING keeps dirty-coalesce (do not steal); stale must reopen to QUEUED
 * or refreshes permanently never claim again.
 */
export const STALE_DISPATCHING_MS = 30_000;

/** Statuses from which a processor may atomically claim an outbox row. */
export const CLAIMABLE_OUTBOX_STATUSES = ["QUEUED", "RETRY_SCHEDULED"] as const;

export type LeaderboardTelegramWakeFn = (jobId: string, delayMs?: number) => Promise<void>;

/**
 * BullMQ wake-only job id. Must be unique per wake attempt so a completed
 * `removeOnComplete` retention entry cannot suppress a later re-queue of the
 * same Postgres outbox row (static `:now` caused permanent QUEUED stalls).
 *
 * BullMQ 5.x rejects custom job IDs containing `:`.
 */
export function buildLeaderboardTelegramWakeJobId(outboxId: string, nowMs = Date.now()): string {
  return `lb-tg-${outboxId}-${nowMs}-${randomUUID()}`.slice(0, 120);
}

/** Payload marker: mutations arrived while a refresh was already DISPATCHING. */
export function isRefreshPayloadDirty(payload: unknown): boolean {
  return (
    payload != null &&
    typeof payload === "object" &&
    (payload as { dirty?: unknown }).dirty === true
  );
}

export function mergeRefreshPayload(
  previous: unknown,
  next: Record<string, unknown>
): Record<string, unknown> {
  const prev = (previous ?? {}) as Record<string, unknown>;
  const prevSkip = prev.skipRankAnnouncements === true;
  const nextSkip = next.skipRankAnnouncements === true;
  return {
    ...next,
    skipRankAnnouncements: prevSkip && nextSkip,
    // Preserve dirty if already set; callers may force dirty=true for in-flight coalescing.
    dirty: prev.dirty === true || next.dirty === true
  };
}

export function clearRefreshDirty(payload: unknown): Record<string, unknown> {
  const prev = (payload ?? {}) as Record<string, unknown>;
  const { dirty: _dirty, ...rest } = prev;
  return { ...rest, dirty: false };
}

export function mergeRankAnnouncementPayload(
  previous: unknown,
  next: Record<string, unknown>
): Record<string, unknown> {
  const prev = (previous ?? {}) as Record<string, unknown>;
  const prevFrom = typeof prev.fromRank === "number" ? prev.fromRank : null;
  const nextFrom = typeof next.fromRank === "number" ? next.fromRank : null;
  return {
    ...prev,
    ...next,
    // Preserve the earliest public context. `null` means the player was unranked.
    fromRank: prevFrom == null || nextFrom == null ? null : Math.max(prevFrom, nextFrom)
  };
}

export interface RankAnnouncementEnqueueInput {
  readonly workspaceId: string;
  readonly ownerCoadminUserId: string;
  readonly competitionId: string;
  readonly crmContactId: string;
  readonly fromRank: number | null;
  readonly toRank: number;
  readonly displayName: string;
  readonly reason: string;
  readonly kind: string;
  readonly totalPoints?: number | null;
  readonly pointsGained?: number | null;
  readonly pointsBehindNext?: number | null;
}

/**
 * Durable Postgres outbox for leaderboard Bot API jobs. BullMQ is wake-only.
 */
export class LeaderboardTelegramOutboxService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly wakeFn: LeaderboardTelegramWakeFn
  ) {}

  public static createWakeFromQueue(queue: Queue): LeaderboardTelegramWakeFn {
    return async (outboxId: string, delayMs = 0) => {
      await queue.add(
        "process",
        { outboxId },
        {
          // Unique every call — BullMQ must not dedupe future wakes for this outbox row.
          jobId: buildLeaderboardTelegramWakeJobId(outboxId),
          delay: Math.max(0, delayMs),
          attempts: 1,
          removeOnComplete: 5_000,
          removeOnFail: 5_000
        }
      );
    };
  }

  public async wake(jobId: string, delayMs = 0): Promise<void> {
    await this.wakeFn(jobId, delayMs);
  }

  /** Wake must not block durable enqueue / immediate processJob when Redis is flaky. */
  private async wakeBestEffort(jobId: string, delayMs = 0): Promise<void> {
    try {
      await this.wakeFn(jobId, delayMs);
    } catch {
      // Durable row remains claimable; resumePending / immediate processJob recover.
    }
  }

  private isStaleDispatching(row: { status: string; updatedAt?: Date | null }): boolean {
    if (row.status !== "DISPATCHING") return false;
    const updatedAt = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
    if (!updatedAt) return true;
    return Date.now() - updatedAt >= STALE_DISPATCHING_MS;
  }

  public async enqueueRefresh(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string,
    options?: { readonly skipRankAnnouncements?: boolean }
  ): Promise<string> {
    return this.upsertJob({
      workspaceId,
      ownerCoadminUserId,
      competitionId,
      jobType: "REFRESH_PUBLIC_LEADERBOARD",
      idempotencyKey: `lb:refresh:${ownerCoadminUserId}:${competitionId}`,
      payloadJson: {
        competitionId,
        // Manual "Send Leaderboard" is snapshot-only; scoring-driven refresh keeps false.
        skipRankAnnouncements: options?.skipRankAnnouncements === true
      }
    });
  }

  public async enqueueVerifyMembership(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string
  ): Promise<string> {
    return this.upsertJob({
      workspaceId,
      ownerCoadminUserId,
      competitionId,
      jobType: "VERIFY_MEMBERSHIP",
      idempotencyKey: `lb:verify:${ownerCoadminUserId}:${competitionId}`,
      payloadJson: { competitionId }
    });
  }

  public async enqueuePostResults(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string
  ): Promise<string> {
    return this.upsertJob({
      workspaceId,
      ownerCoadminUserId,
      competitionId,
      jobType: "POST_PUBLIC_RESULTS",
      idempotencyKey: `lb:results:${ownerCoadminUserId}:${competitionId}`,
      payloadJson: { competitionId }
    });
  }

  public async enqueueRankAnnouncement(input: RankAnnouncementEnqueueInput): Promise<string> {
    const coalesceKey = `lb:announce:${input.ownerCoadminUserId}:${input.competitionId}:${input.crmContactId}`;
    const payloadJson = {
      competitionId: input.competitionId,
      crmContactId: input.crmContactId,
      fromRank: input.fromRank,
      toRank: input.toRank,
      displayName: input.displayName,
      reason: input.reason,
      kind: input.kind,
      totalPoints: input.totalPoints ?? null,
      pointsGained: input.pointsGained ?? null,
      pointsBehindNext: input.pointsBehindNext ?? null
    };
    const existing = await this.findPendingRankAnnouncement(coalesceKey, input);
    if (existing) {
      await this.prisma.leaderboardTelegramOutbox.update({
        where: { id: existing.id },
        data: {
          payloadJson: mergeRankAnnouncementPayload(existing.payloadJson, payloadJson) as Prisma.InputJsonValue,
          ...(existing.status === "DISPATCHING" && this.isStaleDispatching(existing)
            ? { status: "QUEUED" as const, nextAttemptAt: null }
            : {})
        }
      });
      await this.wakeBestEffort(existing.id, 0);
      return existing.id;
    }

    return this.upsertJob({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      competitionId: input.competitionId,
      jobType: "POST_RANK_ANNOUNCEMENT",
      idempotencyKey: `${coalesceKey}:${Date.now()}:${randomUUID()}`.slice(0, 320),
      payloadJson
    });
  }

  public async enqueuePlayerDm(input: {
    readonly workspaceId: string;
    readonly ownerCoadminUserId: string;
    readonly competitionId: string;
    readonly crmContactId: string;
    readonly kind: string;
    readonly fromRank?: number | null;
    readonly toRank?: number;
    readonly totalPoints?: number;
    readonly text?: string;
    readonly dedupeKey?: string;
  }): Promise<string> {
    const key =
      input.dedupeKey ??
      `lb:pdm:${input.ownerCoadminUserId}:${input.competitionId}:${input.crmContactId}:${input.kind}`;
    return this.upsertJob({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      competitionId: input.competitionId,
      jobType: "SEND_PLAYER_DM",
      idempotencyKey: key.slice(0, 320),
      payloadJson: {
        competitionId: input.competitionId,
        crmContactId: input.crmContactId,
        kind: input.kind,
        fromRank: input.fromRank ?? null,
        toRank: input.toRank ?? null,
        totalPoints: input.totalPoints ?? null,
        text: input.text ?? null
      }
    });
  }

  public async enqueueFinalResultDm(input: {
    readonly workspaceId: string;
    readonly ownerCoadminUserId: string;
    readonly competitionId: string;
    readonly crmContactId: string;
    readonly kind: "FINAL_RESULT_WINNER" | "FINAL_RESULT_INELIGIBLE" | "FINAL_RESULT" | string;
  }): Promise<string> {
    const key = `lb:fdm:${input.ownerCoadminUserId}:${input.competitionId}:${input.crmContactId}:${input.kind}`;
    return this.upsertJob({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      competitionId: input.competitionId,
      jobType: "SEND_FINAL_RESULT_DM",
      idempotencyKey: key.slice(0, 320),
      payloadJson: {
        competitionId: input.competitionId,
        crmContactId: input.crmContactId,
        kind: input.kind
      }
    });
  }

  public async cancelPendingForOwner(ownerCoadminUserId: string): Promise<number> {
    const now = new Date();
    const result = await this.prisma.leaderboardTelegramOutbox.updateMany({
      where: {
        ownerCoadminUserId,
        status: { in: [...PENDING_STATUSES] }
      },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        nextAttemptAt: null,
        lastErrorCode: "INTEGRATION_DISCONNECTED",
        lastErrorMessage: "Cancelled because bot integration was disconnected"
      }
    });
    return result.count;
  }

  public async resumePending(limit = 100): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_DISPATCHING_MS);
    // Reclaim crashed DISPATCHING claims so maintenance can wake them again.
    await this.prisma.leaderboardTelegramOutbox.updateMany({
      where: {
        status: "DISPATCHING",
        updatedAt: { lte: staleBefore }
      },
      data: {
        status: "QUEUED",
        nextAttemptAt: null
      }
    });
    const rows = await this.prisma.leaderboardTelegramOutbox.findMany({
      where: {
        status: { in: ["QUEUED", "RETRY_SCHEDULED"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true }
    });
    let firstWakeError: unknown;
    for (const row of rows) {
      try {
        await this.wake(row.id, 0);
      } catch (error) {
        // Continue waking remaining rows; surface one error so safeResume can log it.
        firstWakeError ??= error;
      }
    }
    if (firstWakeError) throw firstWakeError;
    return rows.length;
  }

  private async upsertJob(input: {
    readonly workspaceId: string;
    readonly ownerCoadminUserId: string;
    readonly competitionId: string;
    readonly jobType: LeaderboardTelegramJobType;
    readonly idempotencyKey: string;
    readonly payloadJson: Record<string, unknown>;
  }): Promise<string> {
    const integration = await this.prisma.leaderboardBotIntegration.findUnique({
      where: { ownerCoadminUserId: input.ownerCoadminUserId },
      select: { id: true, disconnectedAt: true }
    });

    const existing = await this.prisma.leaderboardTelegramOutbox.findUnique({
      where: { idempotencyKey: input.idempotencyKey }
    });

    if (existing && (PENDING_STATUSES as readonly string[]).includes(existing.status)) {
      // Coalesce refresh payloads: announcements remain enabled if either enqueued wants them.
      let payloadJson = input.payloadJson;
      const staleDispatching = this.isStaleDispatching(existing);
      if (input.jobType === "REFRESH_PUBLIC_LEADERBOARD") {
        payloadJson = mergeRefreshPayload(existing.payloadJson, {
          ...input.payloadJson,
          // Fresh in-flight: dirty so completion re-queues. Stale: reopen below.
          ...(existing.status === "DISPATCHING" ? { dirty: true } : {})
        });
      }
      const reopenDispatching =
        existing.status === "DISPATCHING" &&
        (input.jobType !== "REFRESH_PUBLIC_LEADERBOARD" || staleDispatching);
      await this.prisma.leaderboardTelegramOutbox.update({
        where: { id: existing.id },
        data: {
          payloadJson: payloadJson as Prisma.InputJsonValue,
          ...(reopenDispatching ? { status: "QUEUED" as const, nextAttemptAt: null } : {})
        }
      });
      await this.wakeBestEffort(existing.id, 0);
      return existing.id;
    }

    if (existing && (TERMINAL_STATUSES as readonly string[]).includes(existing.status)) {
      const reset = await this.prisma.leaderboardTelegramOutbox.update({
        where: { id: existing.id },
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          competitionId: input.competitionId,
          botIntegrationId: integration?.disconnectedAt ? null : (integration?.id ?? null),
          jobType: input.jobType,
          status: "QUEUED",
          payloadJson: input.payloadJson as Prisma.InputJsonValue,
          attemptCount: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          succeededAt: null,
          failedAt: null,
          cancelledAt: null
        }
      });
      await this.wakeBestEffort(reset.id, 0);
      return reset.id;
    }

    try {
      const created = await this.prisma.leaderboardTelegramOutbox.create({
        data: {
          workspaceId: input.workspaceId,
          ownerCoadminUserId: input.ownerCoadminUserId,
          competitionId: input.competitionId,
          botIntegrationId: integration?.disconnectedAt ? null : (integration?.id ?? null),
          jobType: input.jobType,
          status: "QUEUED",
          idempotencyKey: input.idempotencyKey,
          payloadJson: input.payloadJson as Prisma.InputJsonValue
        }
      });
      await this.wakeBestEffort(created.id, 0);
      return created.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.leaderboardTelegramOutbox.findUnique({
        where: { idempotencyKey: input.idempotencyKey }
      });
      if (!raced) throw error;
      if ((TERMINAL_STATUSES as readonly string[]).includes(raced.status)) {
        const reset = await this.prisma.leaderboardTelegramOutbox.update({
          where: { id: raced.id },
          data: {
            status: "QUEUED",
            attemptCount: 0,
            nextAttemptAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            succeededAt: null,
            failedAt: null,
            cancelledAt: null,
            payloadJson: input.payloadJson as Prisma.InputJsonValue,
            competitionId: input.competitionId,
            botIntegrationId: integration?.disconnectedAt ? null : (integration?.id ?? null)
          }
        });
        await this.wakeBestEffort(reset.id, 0);
        return reset.id;
      }
      if ((PENDING_STATUSES as readonly string[]).includes(raced.status)) {
        let payloadJson = input.payloadJson;
        const staleDispatching = this.isStaleDispatching(raced);
        if (input.jobType === "REFRESH_PUBLIC_LEADERBOARD") {
          payloadJson = mergeRefreshPayload(raced.payloadJson, {
            ...input.payloadJson,
            ...(raced.status === "DISPATCHING" ? { dirty: true } : {})
          });
        }
        const reopenDispatching =
          raced.status === "DISPATCHING" &&
          (input.jobType !== "REFRESH_PUBLIC_LEADERBOARD" || staleDispatching);
        await this.prisma.leaderboardTelegramOutbox.update({
          where: { id: raced.id },
          data: {
            payloadJson: payloadJson as Prisma.InputJsonValue,
            ...(reopenDispatching ? { status: "QUEUED" as const, nextAttemptAt: null } : {})
          }
        });
      }
      await this.wakeBestEffort(raced.id, 0);
      return raced.id;
    }
  }

  private async findPendingRankAnnouncement(
    coalesceKey: string,
    input: RankAnnouncementEnqueueInput
  ): Promise<{
    id: string;
    status: string;
    payloadJson: unknown;
    updatedAt?: Date | null;
  } | null> {
    const rows = await this.prisma.leaderboardTelegramOutbox.findMany({
      where: {
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: input.competitionId,
        jobType: "POST_RANK_ANNOUNCEMENT",
        status: { in: [...PENDING_STATUSES] },
        idempotencyKey: { startsWith: coalesceKey }
      },
      orderBy: { createdAt: "asc" },
      take: 1
    });
    return rows[0] ?? null;
  }
}

export type LeaderboardTelegramResumeLogger = {
  info: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * Runs outbox resume without ever rejecting to the caller.
 * BullMQ / Redis / Prisma failures are logged; Atlas stays up.
 */
export async function resumeLeaderboardTelegramOutboxSafely(
  outbox: Pick<LeaderboardTelegramOutboxService, "resumePending">,
  log: LeaderboardTelegramResumeLogger
): Promise<void> {
  try {
    const count = await outbox.resumePending();
    if (count > 0) {
      log.info({ count }, "Resumed pending leaderboard Telegram outbox jobs");
    }
  } catch (error) {
    log.error({ err: error }, "Failed to resume pending leaderboard Telegram outbox jobs");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
