import type { PrismaClient } from "@prisma/client";
import type { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";

export type WinnerAnnouncementRecoveryClassification =
  | "ALREADY_ANNOUNCED"
  | "MISSING"
  | "PENDING"
  | "FAILED_RETRYABLE"
  | "BLOCKED"
  | "NEEDS_MANUAL_REVIEW"
  | "INCONSISTENT_WINNERS";

export interface WinnerAnnouncementRecoveryRow {
  competitionId: string;
  finalizedAt: string;
  winnerCount: number;
  deliveryState: string;
  artifactState: string;
  classification: WinnerAnnouncementRecoveryClassification;
  proposedAction: string;
  duplicateRisk: "NONE" | "LOW" | "HIGH";
  reason: string;
}

export class WinnerAnnouncementRecoveryService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly outbox: LeaderboardTelegramOutboxService,
  ) {}

  public async inspect(input: {
    lookbackDays?: number;
    competitionId?: string;
    execute?: boolean;
    now?: Date;
  }): Promise<WinnerAnnouncementRecoveryRow[]> {
    const lookbackDays = input.lookbackDays ?? 30;
    if (
      !Number.isInteger(lookbackDays) ||
      lookbackDays < 1 ||
      lookbackDays > 30
    ) {
      throw new Error("lookback-days must be an integer from 1 through 30");
    }
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - lookbackDays * 86_400_000);
    const competitions = await this.prisma.leaderboardCompetition.findMany({
      where: {
        status: "FINALIZED",
        finalizedAt: { gte: cutoff, lte: now },
        ...(input.competitionId ? { id: input.competitionId } : {}),
      },
      orderBy: { finalizedAt: "asc" },
      include: {
        snapshot: { select: { winnersJson: true, winnersLockedAt: true } },
        payouts: { select: { id: true, prizeRank: true, crmContactId: true } },
        eligibilityCandidates: {
          select: { crmContactId: true, membershipStatus: true },
        },
      },
    });

    const report: WinnerAnnouncementRecoveryRow[] = [];
    for (const competition of competitions) {
      const [jobs, artifacts, integration] = await Promise.all([
        this.prisma.leaderboardTelegramOutbox.findMany({
          where: {
            competitionId: competition.id,
            jobType: "POST_PUBLIC_RESULTS",
          },
          orderBy: { createdAt: "desc" },
        }),
        this.prisma.leaderboardTelegramArtifact.findMany({
          where: {
            competitionId: competition.id,
            artifactType: {
              in: ["PUBLIC_RESULTS", "WINNERS_PICTURE", "FINAL_LEADERBOARD"],
            },
          },
        }),
        this.prisma.leaderboardBotIntegration.findUnique({
          where: { ownerCoadminUserId: competition.ownerCoadminUserId },
          select: {
            postingEnabled: true,
            disconnectedAt: true,
            channelId: true,
          },
        }),
      ]);
      const winners = parseWinners(competition.snapshot?.winnersJson);
      const payoutIds = new Set(competition.payouts.map((p) => p.crmContactId));
      const winnerDataValid =
        competition.snapshot?.winnersLockedAt != null &&
        winners != null &&
        winners.length === competition.payouts.length &&
        winners.every((winner) => payoutIds.has(winner.crmContactId)) &&
        winners.every((winner) =>
          competition.eligibilityCandidates.some(
            (candidate) =>
              candidate.crmContactId === winner.crmContactId &&
              candidate.membershipStatus === "ELIGIBLE",
          ),
        );
      const publicArtifact = artifacts.find(
        (a) => a.artifactType === "PUBLIC_RESULTS",
      );
      const equivalentArtifact = artifacts.find(
        (a) =>
          a.artifactType === "WINNERS_PICTURE" &&
          a.status === "SENT" &&
          a.messageId,
      );
      const job = jobs[0];

      let row: WinnerAnnouncementRecoveryRow;
      if (!winnerDataValid) {
        row = makeRow(
          competition,
          winners?.length ?? 0,
          job,
          artifacts,
          "INCONSISTENT_WINNERS",
          "SKIP",
          "HIGH",
          "Persisted winners, payouts, and eligible candidates are missing or inconsistent",
        );
      } else if (
        publicArtifact?.status === "SENT" &&
        publicArtifact.messageId
      ) {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "ALREADY_ANNOUNCED",
          "SKIP",
          "NONE",
          "Public-results artifact has a persisted Telegram message ID",
        );
      } else if (equivalentArtifact) {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "ALREADY_ANNOUNCED",
          "SKIP",
          "NONE",
          "A winners-picture artifact already confirms an equivalent public winner announcement",
        );
      } else if (
        publicArtifact?.status === "RESERVED" ||
        job?.status === "DISPATCHING" ||
        job?.status === "SUCCEEDED"
      ) {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "NEEDS_MANUAL_REVIEW",
          "SKIP",
          "HIGH",
          "Delivery may have reached Telegram without a persisted acknowledgement",
        );
      } else if (
        !integration ||
        integration.disconnectedAt ||
        !integration.channelId ||
        !integration.postingEnabled
      ) {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "BLOCKED",
          "SKIP",
          "NONE",
          !integration
            ? "Bot integration is missing"
            : integration.disconnectedAt
              ? "Bot integration is disconnected"
              : !integration.channelId
                ? "Telegram channel is missing"
                : "Telegram posting is disabled",
        );
      } else if (job && ["QUEUED", "RETRY_SCHEDULED"].includes(job.status)) {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "PENDING",
          "WAKE_EXISTING_JOB",
          "NONE",
          "A pending deterministic announcement job already exists",
        );
        if (input.execute) await this.outbox.wake(job.id, 0);
      } else if (
        job?.status === "FAILED" &&
        job.lastErrorCode !== "DELIVERY_AMBIGUOUS"
      ) {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "FAILED_RETRYABLE",
          "REQUEUE_EXISTING_JOB",
          "LOW",
          `Prior failure is explicit and retryable: ${job.lastErrorCode ?? "unknown"}`,
        );
        if (input.execute) {
          await this.outbox.enqueuePostResults(
            competition.workspaceId,
            competition.ownerCoadminUserId,
            competition.id,
          );
        }
      } else if (job?.lastErrorCode === "DELIVERY_AMBIGUOUS") {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "NEEDS_MANUAL_REVIEW",
          "SKIP",
          "HIGH",
          "Prior delivery outcome is explicitly ambiguous",
        );
      } else {
        row = makeRow(
          competition,
          winners.length,
          job,
          artifacts,
          "MISSING",
          "CREATE_ANNOUNCEMENT_JOB",
          "LOW",
          "No public or equivalent winner delivery is recorded",
        );
        if (input.execute) {
          await this.outbox.enqueuePostResults(
            competition.workspaceId,
            competition.ownerCoadminUserId,
            competition.id,
          );
        }
      }
      report.push(row);
    }
    return report;
  }
}

function parseWinners(value: unknown): Array<{ crmContactId: string }> | null {
  if (!Array.isArray(value)) return null;
  const rows: Array<{ crmContactId: string }> = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { crmContactId?: unknown }).crmContactId !== "string"
    )
      return null;
    rows.push({
      crmContactId: (item as { crmContactId: string }).crmContactId,
    });
  }
  return rows;
}

function makeRow(
  competition: { id: string; finalizedAt: Date | null },
  winnerCount: number,
  job: { status: string } | undefined,
  artifacts: Array<{
    artifactType: string;
    status: string;
    messageId: string | null;
  }>,
  classification: WinnerAnnouncementRecoveryClassification,
  proposedAction: string,
  duplicateRisk: "NONE" | "LOW" | "HIGH",
  reason: string,
): WinnerAnnouncementRecoveryRow {
  return {
    competitionId: competition.id,
    finalizedAt: competition.finalizedAt?.toISOString() ?? "unknown",
    winnerCount,
    deliveryState: job?.status ?? "NO_JOB",
    artifactState:
      artifacts
        .map(
          (a) =>
            `${a.artifactType}:${a.status}:${a.messageId ?? "no-message-id"}`,
        )
        .join(",") || "NONE",
    classification,
    proposedAction,
    duplicateRisk,
    reason,
  };
}
