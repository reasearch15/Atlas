import type { Prisma, PrismaClient } from "@prisma/client";
import {
  decryptSecret,
  type EncryptedSecret
} from "@atlas/shared/session-encryption";
import { AuditService } from "../../audit/audit.service";
import { PrismaLeaderboardService } from "../leaderboard.prisma-service";
import {
  HttpLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type LeaderboardTelegramClient
} from "./leaderboard-telegram.client";
import { mapTelegramChatMemberStatus } from "./membership-status";
import { planMembershipVerification } from "./membership-verify-plan";
import type { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { CLAIMABLE_OUTBOX_STATUSES } from "./leaderboard-telegram.outbox";
import {
  formatPublicResultsMessage,
  formatRankAnnouncement
} from "./public-message";
import { publishPublicLeaderboardSnapshot } from "./public-leaderboard-publisher";
import { resolvePublicLeaderboardDisplayName } from "./public-display-name";
import {
  formatPersonalAnnouncementDm,
  formatPersonalFinalResultMessage
} from "./personal-rank-message";
import {
  announcementKindToPlayerKind,
  decidePlayerNotification
} from "./player-notification-policy";

const MAX_VERIFY_CANDIDATES = 20;
const VERIFY_CONCURRENCY = 3;
const MAX_ATTEMPTS = 12;

export interface LeaderboardTelegramProcessorDeps {
  readonly prisma: PrismaClient;
  readonly encryptionKey: string;
  readonly outbox: LeaderboardTelegramOutboxService;
  readonly client?: LeaderboardTelegramClient;
  readonly domain?: PrismaLeaderboardService;
  readonly audit?: AuditService;
  readonly logger?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

/**
 * Processes durable leaderboard Telegram outbox jobs. Never logs bot tokens.
 */
export class LeaderboardTelegramProcessor {
  private readonly prisma: PrismaClient;
  private readonly encryptionKey: string;
  private readonly outbox: LeaderboardTelegramOutboxService;
  private readonly client: LeaderboardTelegramClient;
  private readonly domain: PrismaLeaderboardService;
  private readonly audit: AuditService;
  private readonly logger: LeaderboardTelegramProcessorDeps["logger"];

  public constructor(deps: LeaderboardTelegramProcessorDeps) {
    this.prisma = deps.prisma;
    this.encryptionKey = deps.encryptionKey;
    this.outbox = deps.outbox;
    this.client = deps.client ?? new HttpLeaderboardTelegramClient();
    this.domain = deps.domain ?? new PrismaLeaderboardService(deps.prisma);
    this.audit = deps.audit ?? new AuditService(deps.prisma);
    this.logger = deps.logger;
  }

  public async processJob(jobId: string): Promise<void> {
    // Atomic claim — duplicate BullMQ wakes for the same outbox row must not double-deliver.
    const claimed = await this.prisma.leaderboardTelegramOutbox.updateMany({
      where: {
        id: jobId,
        status: { in: [...CLAIMABLE_OUTBOX_STATUSES] }
      },
      data: {
        status: "DISPATCHING",
        attemptCount: { increment: 1 },
        nextAttemptAt: null
      }
    });
    if (claimed.count !== 1) return;

    const row = await this.prisma.leaderboardTelegramOutbox.findUnique({ where: { id: jobId } });
    if (!row) return;

    const attempt = row.attemptCount;

    const integration = await this.prisma.leaderboardBotIntegration.findUnique({
      where: { ownerCoadminUserId: row.ownerCoadminUserId }
    });

    if (!integration || integration.disconnectedAt || integration.workspaceId !== row.workspaceId) {
      await this.failPermanent(row.id, integration?.id ?? null, "INTEGRATION_MISSING", "Bot integration missing or disconnected");
      return;
    }

    let token: string;
    try {
      token = decryptSecret(integration.encryptedBotToken as unknown as EncryptedSecret, this.encryptionKey);
    } catch {
      await this.failPermanent(row.id, integration.id, "TOKEN_DECRYPT_FAILED", "Stored bot token could not be decrypted");
      return;
    }

    try {
      switch (row.jobType) {
        case "REFRESH_PUBLIC_LEADERBOARD":
          await this.processRefresh(row, integration, token);
          break;
        case "VERIFY_MEMBERSHIP":
          await this.processVerifyMembership(row, integration, token);
          break;
        case "POST_PUBLIC_RESULTS":
          await this.processPostResults(row, integration, token);
          break;
        case "POST_RANK_ANNOUNCEMENT":
          await this.processRankAnnouncement(row, integration, token);
          break;
        case "SEND_PLAYER_DM":
          await this.processPlayerDm(row, integration, token);
          break;
        case "SEND_FINAL_RESULT_DM":
          await this.processFinalResultDm(row, integration, token);
          break;
        case "PROCESS_BOT_UPDATE":
          // Updates are handled inline by the webhook/poller — no-op succeed.
          break;
        default:
          await this.failPermanent(row.id, integration.id, "UNKNOWN_JOB_TYPE", `Unknown job type ${row.jobType}`);
          return;
      }

      await this.prisma.leaderboardTelegramOutbox.update({
        where: { id: row.id },
        data: {
          status: "SUCCEEDED",
          succeededAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAttemptAt: null
        }
      });
    } catch (error) {
      await this.handleFailure(row.id, integration.id, attempt, error);
    }
  }

  private async processRefresh(
    row: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      competitionId: string | null;
      payloadJson?: unknown;
    },
    integration: {
      id: string;
      postingEnabled: boolean;
      channelId: string | null;
      persistentMessageId: string | null;
      persistentMessageCompetitionId: string | null;
      lastPublicTop10Json: unknown;
      botUsername: string | null;
    },
    token: string
  ): Promise<void> {
    if (!integration.postingEnabled) {
      this.logger?.info(
        { outboxId: row.id, ownerCoadminUserId: row.ownerCoadminUserId, jobType: "REFRESH_PUBLIC_LEADERBOARD" },
        "Leaderboard Telegram refresh skipped (posting disabled)"
      );
      return;
    }
    if (!integration.channelId || !row.competitionId) {
      throw permanentError("CHANNEL_OR_COMPETITION_MISSING", "Channel or competition missing for refresh");
    }

    const skipRankAnnouncements =
      row.payloadJson != null &&
      typeof row.payloadJson === "object" &&
      (row.payloadJson as { skipRankAnnouncements?: unknown }).skipRankAnnouncements === true;

    let published;
    try {
      published = await publishPublicLeaderboardSnapshot({
        prisma: this.prisma,
        client: this.client,
        token,
        workspaceId: row.workspaceId,
        ownerCoadminUserId: row.ownerCoadminUserId,
        competitionId: row.competitionId,
        integrationId: integration.id,
        channelId: integration.channelId,
        botUsername: integration.botUsername,
        persistentMessageId: integration.persistentMessageId,
        persistentMessageCompetitionId: integration.persistentMessageCompetitionId,
        lastPublicTop10Json: integration.lastPublicTop10Json,
        mode: "edit_or_create",
        skipRankAnnouncements
      });
    } catch (error) {
      if (error instanceof Error && error.message === "COMPETITION_NOT_FOUND") {
        throw permanentError("COMPETITION_NOT_FOUND", "Competition not found for refresh");
      }
      throw error;
    }

    for (const event of published.announcements) {
      await this.outbox.enqueueRankAnnouncement({
        workspaceId: row.workspaceId,
        ownerCoadminUserId: row.ownerCoadminUserId,
        competitionId: row.competitionId,
        crmContactId: event.crmContactId,
        fromRank: event.fromRank,
        toRank: event.toRank,
        displayName: event.displayName,
        reason: event.reason,
        kind: event.kind,
        ...(event.totalPoints != null ? { totalPoints: event.totalPoints } : {}),
        ...(event.pointsGained != null ? { pointsGained: event.pointsGained } : {}),
        ...(event.pointsBehindNext != null ? { pointsBehindNext: event.pointsBehindNext } : {})
      });

      // Personal DMs must never fail the public refresh / scoring path.
      try {
        const linkModel = (this.prisma as { leaderboardBotPlayerLink?: { findFirst: Function } })
          .leaderboardBotPlayerLink;
        if (!linkModel) continue;
        const link = await linkModel.findFirst({
          where: {
            ownerCoadminUserId: row.ownerCoadminUserId,
            crmContactId: event.crmContactId,
            botIntegrationId: integration.id
          },
          select: { id: true }
        });
        const decision = decidePlayerNotification({
          competitionId: row.competitionId,
          crmContactId: event.crmContactId,
          kind: announcementKindToPlayerKind(event.kind),
          hasPlayerLink: link != null,
          ownerCoadminUserId: row.ownerCoadminUserId,
          botOwnerCoadminUserId: row.ownerCoadminUserId
        });
        if (decision.shouldNotify) {
          const standing = published.nextTop10.find((r) => r.crmContactId === event.crmContactId);
          await this.outbox.enqueuePlayerDm({
            workspaceId: row.workspaceId,
            ownerCoadminUserId: row.ownerCoadminUserId,
            competitionId: row.competitionId,
            crmContactId: event.crmContactId,
            kind: decision.kind,
            fromRank: event.fromRank,
            toRank: event.toRank,
            ...(standing?.totalPoints != null ? { totalPoints: standing.totalPoints } : {}),
            dedupeKey: decision.dedupeKey
          });
        }
      } catch (error) {
        this.logger?.warn(
          { err: error, crmContactId: event.crmContactId, competitionId: row.competitionId },
          "Leaderboard personal DM enqueue skipped"
        );
      }
    }

    if (published.recoveredFromFailedEdit) {
      await this.audit.record({
        workspaceId: row.workspaceId,
        actorId: null,
        action: "leaderboard.telegram.persistent_message_recovered",
        metadata: {
          ownerCoadminUserId: row.ownerCoadminUserId,
          competitionId: row.competitionId,
          messageId: published.messageId
        }
      });
    }
  }


  private async processVerifyMembership(
    row: { id: string; workspaceId: string; ownerCoadminUserId: string; competitionId: string | null },
    integration: { id: string; channelId: string | null },
    token: string
  ): Promise<void> {
    if (!integration.channelId || !row.competitionId) {
      throw permanentError("CHANNEL_OR_COMPETITION_MISSING", "Channel or competition missing for membership verify");
    }

    const competition = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        id: row.competitionId,
        workspaceId: row.workspaceId,
        ownerCoadminUserId: row.ownerCoadminUserId,
        status: { in: ["FROZEN", "FINALIZED"] }
      }
    });
    if (!competition) {
      throw permanentError("COMPETITION_NOT_FROZEN", "Competition is not frozen for membership verify");
    }
    if (competition.status === "FINALIZED") {
      return;
    }

    let verified = 0;
    while (verified < MAX_VERIFY_CANDIDATES) {
      const candidates = await this.prisma.giveawayEligibilityCandidate.findMany({
        where: { competitionId: competition.id, ownerCoadminUserId: row.ownerCoadminUserId },
        orderBy: { leaderboardRank: "asc" }
      });
      const plan = planMembershipVerification(candidates);
      if (plan.resolved || plan.toVerify.length === 0) break;

      const batch = plan.toVerify.slice(0, Math.min(VERIFY_CONCURRENCY, MAX_VERIFY_CANDIDATES - verified));
      await Promise.all(
        batch.map((candidate) =>
          this.verifyOneCandidate({
            workspaceId: row.workspaceId,
            ownerCoadminUserId: row.ownerCoadminUserId,
            competitionId: competition.id,
            candidateId: candidate.crmContactId,
            integrationId: integration.id,
            channelId: integration.channelId!,
            token
          })
        )
      );
      verified += batch.length;
      if (batch.length === 0) break;
    }

    await this.prisma.leaderboardBotIntegration.update({
      where: { id: integration.id },
      data: { lastMembershipCheckAt: new Date(), lastError: null }
    });
  }

  private async verifyOneCandidate(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    competitionId: string;
    candidateId: string;
    integrationId: string;
    channelId: string;
    token: string;
  }): Promise<void> {
    const contact = await this.prisma.crmContact.findFirst({
      where: { id: input.candidateId, workspaceId: input.workspaceId }
    });

    if (!contact || contact.kind !== "PRIVATE" || !/^\d+$/.test(contact.telegramPeerId)) {
      await this.domain.setMembershipEligibility({
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: input.competitionId,
        crmContactId: input.candidateId,
        membershipStatus: "PENDING_REVIEW",
        actorUserId: input.ownerCoadminUserId,
        reason: "Missing stable private Telegram user id for membership check",
        idempotencyKey: `lb:verify-result:${input.competitionId}:${input.candidateId}:missing-peer`,
        verificationSource: "TELEGRAM_BOT_API",
        telegramChatMemberStatus: null,
        verifiedChannelId: input.channelId,
        botIntegrationId: input.integrationId,
        verificationErrorCode: "MISSING_TELEGRAM_USER_ID",
        verificationErrorMessage: "CrmContact is not PRIVATE with a numeric telegramPeerId",
        allowTelegramOverwrite: true
      });
      return;
    }

    try {
      const member = await this.client.getChatMember(input.token, input.channelId, contact.telegramPeerId);
      const mapped = mapTelegramChatMemberStatus(member.status);
      await this.domain.setMembershipEligibility({
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: input.competitionId,
        crmContactId: input.candidateId,
        membershipStatus: mapped.membershipStatus,
        actorUserId: input.ownerCoadminUserId,
        reason: "Telegram Bot API membership verification",
        ineligibilityReason: mapped.ineligibilityReason,
        idempotencyKey: `lb:verify-result:${input.competitionId}:${input.candidateId}:${member.status}`,
        verificationSource: "TELEGRAM_BOT_API",
        telegramChatMemberStatus: member.status,
        verifiedChannelId: input.channelId,
        botIntegrationId: input.integrationId,
        verificationErrorCode: null,
        verificationErrorMessage: null,
        allowTelegramOverwrite: true
      });
    } catch (error) {
      const code =
        error instanceof LeaderboardTelegramApiError
          ? String(error.telegramErrorCode ?? error.httpStatus)
          : "TELEGRAM_API_ERROR";
      const message =
        error instanceof LeaderboardTelegramApiError ? error.description : "Membership check failed";
      // Technical failure must stay PENDING_REVIEW — never auto NOT_ELIGIBLE.
      await this.domain.setMembershipEligibility({
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: input.competitionId,
        crmContactId: input.candidateId,
        membershipStatus: "PENDING_REVIEW",
        actorUserId: input.ownerCoadminUserId,
        reason: "Telegram membership API failure",
        idempotencyKey: `lb:verify-result:${input.competitionId}:${input.candidateId}:error:${code}`,
        verificationSource: "TELEGRAM_BOT_API",
        telegramChatMemberStatus: null,
        verifiedChannelId: input.channelId,
        botIntegrationId: input.integrationId,
        verificationErrorCode: truncate(code, 120),
        verificationErrorMessage: truncate(message, 500),
        allowTelegramOverwrite: true
      });

      if (error instanceof LeaderboardTelegramApiError && error.permanent) {
        throw error;
      }
    }
  }

  private async processPostResults(
    row: { id: string; workspaceId: string; ownerCoadminUserId: string; competitionId: string | null },
    integration: { id: string; postingEnabled: boolean; channelId: string | null },
    token: string
  ): Promise<void> {
    if (!integration.postingEnabled) return;
    if (!integration.channelId || !row.competitionId) {
      throw permanentError("CHANNEL_OR_COMPETITION_MISSING", "Channel or competition missing for results");
    }

    const competition = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        id: row.competitionId,
        workspaceId: row.workspaceId,
        ownerCoadminUserId: row.ownerCoadminUserId,
        status: "FINALIZED"
      }
    });
    if (!competition) {
      throw permanentError("COMPETITION_NOT_FINALIZED", "Results require a FINALIZED competition");
    }

    const payouts = await this.prisma.giveawayPayout.findMany({
      where: { competitionId: competition.id, ownerCoadminUserId: row.ownerCoadminUserId },
      orderBy: { prizeRank: "asc" },
      include: {
        crmContact: {
          select: {
            displayName: true,
            username: true,
            chats: {
              select: { firstName: true, lastName: true, username: true, updatedAt: true },
              orderBy: { updatedAt: "desc" },
              take: 1
            }
          }
        }
      }
    });

    const text = formatPublicResultsMessage({
      prizePoolCents: competition.prizePoolCents,
      winners: payouts.map((p) => {
        const chat = Array.isArray(p.crmContact.chats) ? p.crmContact.chats[0] : undefined;
        return {
          prizeRank: p.prizeRank as 1 | 2 | 3,
          displayName: resolvePublicLeaderboardDisplayName({
            displayName: p.crmContact.displayName,
            firstName: chat?.firstName ?? null,
            lastName: chat?.lastName ?? null,
            username: p.crmContact.username ?? chat?.username ?? null
          }),
          payoutCents: p.payoutCents
        };
      })
    });

    await this.client.sendMessage(token, integration.channelId, text);
    await this.prisma.leaderboardBotIntegration.update({
      where: { id: integration.id },
      data: { lastSuccessfulPostAt: new Date(), lastError: null }
    });
  }

  private async processRankAnnouncement(
    row: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      competitionId: string | null;
      payloadJson: unknown;
    },
    integration: { id: string; postingEnabled: boolean; channelId: string | null },
    token: string
  ): Promise<void> {
    if (!integration.postingEnabled || !integration.channelId) return;
    const payload = (row.payloadJson ?? {}) as {
      displayName?: string;
      fromRank?: number | null;
      toRank?: number;
      reason?: string;
      kind?: string;
      totalPoints?: number | null;
      pointsGained?: number | null;
      pointsBehindNext?: number | null;
    };
    if (payload.toRank == null || !payload.displayName) {
      throw permanentError("ANNOUNCEMENT_PAYLOAD_INVALID", "Rank announcement payload incomplete");
    }
    const text = formatRankAnnouncement({
      displayName: payload.displayName,
      fromRank: payload.fromRank ?? null,
      toRank: payload.toRank,
      reason: payload.reason ?? "a ranking update",
      ...(payload.kind === "REACHED_NUMBER_1" ||
      payload.kind === "ENTER_TOP_3" ||
      payload.kind === "ENTER_TOP_10" ||
      payload.kind === "TOP_3_ORDER_CHANGED"
        ? { kind: payload.kind }
        : {}),
      ...(payload.totalPoints != null ? { totalPoints: payload.totalPoints } : {}),
      ...(payload.pointsGained != null ? { pointsGained: payload.pointsGained } : {}),
      ...(payload.pointsBehindNext != null ? { pointsBehindNext: payload.pointsBehindNext } : {})
    });
    await this.client.sendMessage(token, integration.channelId, text);
    await this.prisma.leaderboardBotIntegration.update({
      where: { id: integration.id },
      data: { lastSuccessfulPostAt: new Date(), lastError: null }
    });
  }

  private async processPlayerDm(
    row: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      competitionId: string | null;
      payloadJson: unknown;
    },
    integration: { id: string; ownerCoadminUserId: string },
    token: string
  ): Promise<void> {
    const payload = (row.payloadJson ?? {}) as {
      crmContactId?: string;
      kind?: string;
      fromRank?: number | null;
      toRank?: number;
      totalPoints?: number | null;
      text?: string | null;
    };
    if (!payload.crmContactId || !payload.kind) {
      throw permanentError("PLAYER_DM_PAYLOAD_INVALID", "Player DM payload incomplete");
    }

    const link = await this.prisma.leaderboardBotPlayerLink.findFirst({
      where: {
        botIntegrationId: integration.id,
        ownerCoadminUserId: row.ownerCoadminUserId,
        crmContactId: payload.crmContactId
      }
    });
    if (!link) return;
    if (integration.ownerCoadminUserId !== row.ownerCoadminUserId) return;

    const text =
      payload.text?.trim() ||
      formatPersonalAnnouncementDm({
        kind: payload.kind,
        fromRank: payload.fromRank ?? null,
        toRank: payload.toRank ?? 0,
        ...(payload.totalPoints != null ? { totalPoints: payload.totalPoints } : {})
      });

    await this.client.sendMessage(token, link.telegramUserId, text);
  }

  private async processFinalResultDm(
    row: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      competitionId: string | null;
      payloadJson: unknown;
    },
    integration: { id: string; ownerCoadminUserId: string },
    token: string
  ): Promise<void> {
    const payload = (row.payloadJson ?? {}) as { crmContactId?: string };
    if (!payload.crmContactId || !row.competitionId) {
      throw permanentError("FINAL_DM_PAYLOAD_INVALID", "Final result DM payload incomplete");
    }
    if (integration.ownerCoadminUserId !== row.ownerCoadminUserId) return;

    const link = await this.prisma.leaderboardBotPlayerLink.findFirst({
      where: {
        botIntegrationId: integration.id,
        ownerCoadminUserId: row.ownerCoadminUserId,
        crmContactId: payload.crmContactId
      }
    });
    if (!link) return;

    const competition = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        id: row.competitionId,
        workspaceId: row.workspaceId,
        ownerCoadminUserId: row.ownerCoadminUserId,
        status: "FINALIZED"
      }
    });
    if (!competition) {
      throw permanentError("COMPETITION_NOT_FINALIZED", "Final DMs require FINALIZED competition");
    }

    const candidate = await this.prisma.giveawayEligibilityCandidate.findFirst({
      where: {
        competitionId: competition.id,
        ownerCoadminUserId: row.ownerCoadminUserId,
        crmContactId: payload.crmContactId
      }
    });
    const payout = await this.prisma.giveawayPayout.findFirst({
      where: {
        competitionId: competition.id,
        ownerCoadminUserId: row.ownerCoadminUserId,
        crmContactId: payload.crmContactId
      }
    });
    const standing = await this.prisma.leaderboardStanding.findFirst({
      where: {
        competitionId: competition.id,
        ownerCoadminUserId: row.ownerCoadminUserId,
        crmContactId: payload.crmContactId
      }
    });

    const text = formatPersonalFinalResultMessage({
      leaderboardRank: candidate?.leaderboardRank ?? payout?.leaderboardRank ?? 0,
      totalPoints: standing?.totalPoints ?? payout?.points ?? 0,
      prizeRank: payout?.prizeRank ?? null,
      payoutCents: payout?.payoutCents ?? null,
      membershipStatus: candidate?.membershipStatus ?? "PENDING_REVIEW",
      ineligibilityReason: candidate?.ineligibilityReason ?? null,
      prizePoolCents: competition.prizePoolCents
    });

    await this.client.sendMessage(token, link.telegramUserId, text);
  }

  private async handleFailure(
    outboxId: string,
    integrationId: string,
    attempt: number,
    error: unknown
  ): Promise<void> {
    const apiError = error instanceof LeaderboardTelegramApiError ? error : null;
    const permanent =
      (error as { permanent?: boolean } | null)?.permanent === true ||
      (apiError?.permanent ?? false);
    const code = apiError
      ? String(apiError.telegramErrorCode ?? apiError.httpStatus)
      : ((error as { code?: string } | null)?.code ?? "TELEGRAM_JOB_FAILED");
    const message = apiError
      ? apiError.description
      : error instanceof Error
        ? error.message
        : "Telegram job failed";

    if (permanent || attempt >= MAX_ATTEMPTS) {
      await this.failPermanent(outboxId, integrationId, truncate(code, 120), truncate(message, 500));
      return;
    }

    const retryAfterSeconds = apiError?.retryAfterSeconds;
    const backoffMs =
      retryAfterSeconds != null
        ? retryAfterSeconds * 1000
        : Math.min(60_000, 2 ** Math.min(attempt, 6) * 1000);
    const nextAttemptAt = new Date(Date.now() + backoffMs);

    await this.prisma.leaderboardTelegramOutbox.update({
      where: { id: outboxId },
      data: {
        status: "RETRY_SCHEDULED",
        nextAttemptAt,
        lastErrorCode: truncate(code, 120),
        lastErrorMessage: truncate(message, 500),
        failedAt: new Date()
      }
    });
    await this.prisma.leaderboardBotIntegration.update({
      where: { id: integrationId },
      data: { lastError: truncate(message, 500) }
    });
    await this.outbox.wake(outboxId, backoffMs);
  }

  private async failPermanent(
    outboxId: string,
    integrationId: string | null,
    code: string,
    message: string
  ): Promise<void> {
    await this.prisma.leaderboardTelegramOutbox.update({
      where: { id: outboxId },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        nextAttemptAt: null,
        lastErrorCode: truncate(code, 120),
        lastErrorMessage: truncate(message, 500)
      }
    });
    if (integrationId) {
      await this.prisma.leaderboardBotIntegration.update({
        where: { id: integrationId },
        data: { lastError: truncate(message, 500) }
      });
    }
    this.logger?.warn(
      { outboxId, integrationId, code },
      "Leaderboard Telegram job failed permanently"
    );
  }
}

function isMessageEditRecoverable(error: unknown): boolean {
  if (!(error instanceof LeaderboardTelegramApiError)) return false;
  const d = error.description.toLowerCase();
  return (
    d.includes("message to edit not found") ||
    d.includes("message can't be edited") ||
    d.includes("message is not modified") ||
    d.includes("message_id_invalid")
  );
}

function permanentError(code: string, message: string): Error & { permanent: boolean; code: string } {
  const err = new Error(message) as Error & { permanent: boolean; code: string };
  err.permanent = true;
  err.code = code;
  return err;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
