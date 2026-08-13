import type { LeaderboardTelegramJobType, Prisma, PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";

const PENDING_STATUSES = ["QUEUED", "DISPATCHING", "RETRY_SCHEDULED"] as const;
const TERMINAL_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

export type LeaderboardTelegramWakeFn = (jobId: string, delayMs?: number) => Promise<void>;

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
    return async (jobId: string, delayMs = 0) => {
      await queue.add(
        "process",
        { outboxId: jobId },
        {
          jobId: `lb-tg:${jobId}:${delayMs > 0 ? Math.floor(Date.now() / 1000) : "now"}`.slice(0, 120),
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

  public async enqueueRefresh(
    workspaceId: string,
    ownerCoadminUserId: string,
    competitionId: string
  ): Promise<string> {
    return this.upsertJob({
      workspaceId,
      ownerCoadminUserId,
      competitionId,
      jobType: "REFRESH_PUBLIC_LEADERBOARD",
      idempotencyKey: `lb:refresh:${ownerCoadminUserId}:${competitionId}`,
      payloadJson: { competitionId }
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
    const from = input.fromRank == null ? "none" : String(input.fromRank);
    const key = `lb:announce:${input.ownerCoadminUserId}:${input.competitionId}:${input.crmContactId}:${from}:${input.toRank}:${input.kind}`;
    return this.upsertJob({
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      competitionId: input.competitionId,
      jobType: "POST_RANK_ANNOUNCEMENT",
      idempotencyKey: key.slice(0, 320),
      payloadJson: {
        competitionId: input.competitionId,
        crmContactId: input.crmContactId,
        fromRank: input.fromRank,
        toRank: input.toRank,
        displayName: input.displayName,
        reason: input.reason,
        kind: input.kind
      }
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
    const rows = await this.prisma.leaderboardTelegramOutbox.findMany({
      where: {
        status: { in: ["QUEUED", "RETRY_SCHEDULED"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true }
    });
    for (const row of rows) {
      await this.wake(row.id, 0);
    }
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
      await this.wake(existing.id, 0);
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
      await this.wake(reset.id, 0);
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
      await this.wake(created.id, 0);
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
        await this.wake(reset.id, 0);
        return reset.id;
      }
      await this.wake(raced.id, 0);
      return raced.id;
    }
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
