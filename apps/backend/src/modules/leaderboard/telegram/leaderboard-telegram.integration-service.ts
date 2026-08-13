import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { LeaderboardTelegramIntegrationDto, LeaderboardTelegramSendLatestDto } from "@atlas/shared";
import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret
} from "@atlas/shared/session-encryption";
import { AppError } from "../../../utils/errors";
import { AuditService } from "../../audit/audit.service";
import {
  HttpLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type LeaderboardTelegramClient
} from "./leaderboard-telegram.client";
import type { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { publishPublicLeaderboardSnapshot } from "./public-leaderboard-publisher";

export interface LeaderboardTelegramIntegrationDeps {
  readonly prisma: PrismaClient;
  readonly encryptionKey: string;
  readonly client?: LeaderboardTelegramClient;
  readonly outbox?: LeaderboardTelegramOutboxService;
  readonly audit?: AuditService;
  /** Public HTTPS origin for webhook registration (optional). */
  readonly webhookBaseUrl?: string | null;
}

/**
 * Coadmin-scoped dedicated Bot API integration. Never returns decrypted tokens.
 */
export class LeaderboardTelegramIntegrationService {
  private readonly prisma: PrismaClient;
  private readonly encryptionKey: string;
  private readonly client: LeaderboardTelegramClient;
  private readonly outbox: LeaderboardTelegramOutboxService | undefined;
  private readonly audit: AuditService;
  private readonly webhookBaseUrl: string | null;

  public constructor(deps: LeaderboardTelegramIntegrationDeps) {
    this.prisma = deps.prisma;
    this.encryptionKey = deps.encryptionKey;
    this.client = deps.client ?? new HttpLeaderboardTelegramClient();
    this.outbox = deps.outbox;
    this.audit = deps.audit ?? new AuditService(deps.prisma);
    this.webhookBaseUrl = deps.webhookBaseUrl?.replace(/\/$/, "") ?? null;
  }

  public async getIntegration(
    workspaceId: string,
    ownerCoadminUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const row = await this.prisma.leaderboardBotIntegration.findUnique({
      where: { ownerCoadminUserId }
    });
    if (!row || row.workspaceId !== workspaceId || row.disconnectedAt) {
      const warning = await this.disconnectWarning(workspaceId, ownerCoadminUserId);
      return emptyIntegrationDto(warning);
    }
    const warning = await this.disconnectWarning(workspaceId, ownerCoadminUserId);
    return toDto(row, warning);
  }

  public async connect(
    workspaceId: string,
    ownerCoadminUserId: string,
    token: string,
    actorUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const trimmed = token.trim();
    let me;
    try {
      me = await this.client.getMe(trimmed);
    } catch (error) {
      throw mapConnectError(error);
    }
    if (!me.isBot) {
      throw new AppError(400, "TELEGRAM_BOT_TOKEN_INVALID", "Token must belong to a Telegram bot.");
    }

    const encrypted = encryptSecret(trimmed, this.encryptionKey) as unknown as Prisma.InputJsonValue;
    const now = new Date();
    const row = await this.prisma.leaderboardBotIntegration.upsert({
      where: { ownerCoadminUserId },
      create: {
        workspaceId,
        ownerCoadminUserId,
        encryptedBotToken: encrypted,
        botTelegramUserId: String(me.id),
        botUsername: me.username ?? null,
        botDisplayName: [me.firstName, me.lastName].filter(Boolean).join(" ").trim() || null,
        connectedAt: now,
        lastVerifiedAt: now,
        disconnectedAt: null,
        postingEnabled: false,
        lastError: null
      },
      update: {
        workspaceId,
        encryptedBotToken: encrypted,
        botTelegramUserId: String(me.id),
        botUsername: me.username ?? null,
        botDisplayName: [me.firstName, me.lastName].filter(Boolean).join(" ").trim() || null,
        connectedAt: now,
        lastVerifiedAt: now,
        disconnectedAt: null,
        postingEnabled: false,
        lastError: null,
        channelId: null,
        channelTitle: null,
        channelUsername: null,
        lastChannelVerifiedAt: null,
        persistentMessageId: null,
        persistentMessageCompetitionId: null
      }
    });

    await this.audit.record({
      workspaceId,
      actorId: actorUserId,
      action: "leaderboard.telegram.bot_connected",
      metadata: {
        ownerCoadminUserId,
        botTelegramUserId: row.botTelegramUserId,
        botUsername: row.botUsername
      }
    });

    const withWebhook = await this.maybeRegisterWebhook(row.id, trimmed);
    return toDto(withWebhook ?? row, null);
  }

  public async testConnection(
    workspaceId: string,
    ownerCoadminUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const row = await this.requireConnected(workspaceId, ownerCoadminUserId);
    const token = this.decryptToken(row.encryptedBotToken);
    try {
      const me = await this.client.getMe(token);
      let updated = await this.prisma.leaderboardBotIntegration.update({
        where: { id: row.id },
        data: {
          lastVerifiedAt: new Date(),
          botUsername: me.username ?? row.botUsername,
          botDisplayName:
            [me.firstName, me.lastName].filter(Boolean).join(" ").trim() || row.botDisplayName,
          lastError: null
        }
      });
      const withWebhook = await this.maybeRegisterWebhook(updated.id, token);
      if (withWebhook) updated = withWebhook;
      return toDto(updated, await this.disconnectWarning(workspaceId, ownerCoadminUserId));
    } catch (error) {
      const message = error instanceof LeaderboardTelegramApiError ? error.description : "getMe failed";
      await this.prisma.leaderboardBotIntegration.update({
        where: { id: row.id },
        data: { lastError: truncate(message, 500) }
      });
      throw mapConnectError(error);
    }
  }

  public async registerWebhook(
    workspaceId: string,
    ownerCoadminUserId: string,
    actorUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const row = await this.requireConnected(workspaceId, ownerCoadminUserId);
    if (!this.webhookBaseUrl) {
      throw new AppError(
        400,
        "WEBHOOK_BASE_URL_MISSING",
        "LEADERBOARD_BOT_WEBHOOK_BASE_URL is not configured on this server."
      );
    }
    const token = this.decryptToken(row.encryptedBotToken);
    const updated = await this.registerWebhookForIntegration(row.id, token);
    await this.audit.record({
      workspaceId,
      actorId: actorUserId,
      action: "leaderboard.telegram.webhook_registered",
      metadata: { ownerCoadminUserId, integrationId: row.id }
    });
    return toDto(updated, await this.disconnectWarning(workspaceId, ownerCoadminUserId));
  }

  public async rotateToken(
    workspaceId: string,
    ownerCoadminUserId: string,
    token: string,
    actorUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const row = await this.requireConnected(workspaceId, ownerCoadminUserId);
    const trimmed = token.trim();
    let me;
    try {
      me = await this.client.getMe(trimmed);
    } catch (error) {
      throw mapConnectError(error);
    }
    if (!me.isBot) {
      throw new AppError(400, "TELEGRAM_BOT_TOKEN_INVALID", "Token must belong to a Telegram bot.");
    }

    const encrypted = encryptSecret(trimmed, this.encryptionKey) as unknown as Prisma.InputJsonValue;
    const updated = await this.prisma.leaderboardBotIntegration.update({
      where: { id: row.id },
      data: {
        encryptedBotToken: encrypted,
        botTelegramUserId: String(me.id),
        botUsername: me.username ?? null,
        botDisplayName: [me.firstName, me.lastName].filter(Boolean).join(" ").trim() || null,
        lastVerifiedAt: new Date(),
        lastError: null
      }
    });

    await this.audit.record({
      workspaceId,
      actorId: actorUserId,
      action: "leaderboard.telegram.bot_token_rotated",
      metadata: { ownerCoadminUserId, botTelegramUserId: updated.botTelegramUserId }
    });

    return toDto(updated, await this.disconnectWarning(workspaceId, ownerCoadminUserId));
  }

  public async setChannel(
    workspaceId: string,
    ownerCoadminUserId: string,
    channelRef: string,
    actorUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const row = await this.requireConnected(workspaceId, ownerCoadminUserId);
    const normalized = normalizeChannelRef(channelRef);
    const updated = await this.prisma.leaderboardBotIntegration.update({
      where: { id: row.id },
      data: {
        channelId: normalized,
        channelTitle: null,
        channelUsername: normalized.startsWith("@") ? normalized.slice(1) : null,
        lastChannelVerifiedAt: null,
        postingEnabled: false,
        persistentMessageId: null,
        persistentMessageCompetitionId: null,
        lastError: null
      }
    });

    await this.audit.record({
      workspaceId,
      actorId: actorUserId,
      action: "leaderboard.telegram.channel_set",
      metadata: { ownerCoadminUserId, channelId: updated.channelId }
    });

    return toDto(updated, await this.disconnectWarning(workspaceId, ownerCoadminUserId));
  }

  public async verifyChannel(
    workspaceId: string,
    ownerCoadminUserId: string,
    actorUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const row = await this.requireConnected(workspaceId, ownerCoadminUserId);
    if (!row.channelId) {
      throw new AppError(400, "TELEGRAM_CHANNEL_REQUIRED", "Set a channel before verifying.");
    }
    if (!row.botTelegramUserId) {
      throw new AppError(400, "TELEGRAM_BOT_REQUIRED", "Bot identity is missing; reconnect the bot.");
    }

    const token = this.decryptToken(row.encryptedBotToken);
    try {
      const chat = await this.client.getChat(token, row.channelId);
      const member = await this.client.getChatMember(token, row.channelId, row.botTelegramUserId);
      if (member.status !== "administrator" && member.status !== "creator") {
        throw new AppError(
          400,
          "TELEGRAM_BOT_NOT_ADMIN",
          "Bot must be a channel administrator to post and verify membership."
        );
      }

      // Optional safe probe: send + delete a short test message when sendMessage is available.
      if (this.client.sendMessage && this.client.deleteMessage) {
        const probe = await this.client.sendMessage(
          token,
          row.channelId,
          "Atlas leaderboard channel verification"
        );
        try {
          await this.client.deleteMessage(token, row.channelId, probe.messageId);
        } catch {
          // Non-fatal: probe post succeeded even if delete is restricted.
        }
      }

      const updated = await this.prisma.leaderboardBotIntegration.update({
        where: { id: row.id },
        data: {
          channelId: String(chat.id),
          channelTitle: chat.title ?? null,
          channelUsername: chat.username ?? row.channelUsername,
          lastChannelVerifiedAt: new Date(),
          lastError: null
        }
      });

      await this.audit.record({
        workspaceId,
        actorId: actorUserId,
        action: "leaderboard.telegram.channel_verified",
        metadata: {
          ownerCoadminUserId,
          channelId: updated.channelId,
          channelTitle: updated.channelTitle
        }
      });

      return toDto(updated, await this.disconnectWarning(workspaceId, ownerCoadminUserId));
    } catch (error) {
      if (error instanceof AppError) {
        await this.prisma.leaderboardBotIntegration.update({
          where: { id: row.id },
          data: { lastError: truncate(error.message, 500) }
        });
        throw error;
      }
      const message = error instanceof LeaderboardTelegramApiError ? error.description : "Channel verify failed";
      await this.prisma.leaderboardBotIntegration.update({
        where: { id: row.id },
        data: { lastError: truncate(message, 500) }
      });
      throw mapConnectError(error);
    }
  }

  public async setPostingEnabled(
    workspaceId: string,
    ownerCoadminUserId: string,
    postingEnabled: boolean,
    actorUserId: string
  ): Promise<LeaderboardTelegramIntegrationDto> {
    const row = await this.requireConnected(workspaceId, ownerCoadminUserId);
    if (postingEnabled) {
      if (!row.channelId || !row.lastChannelVerifiedAt) {
        throw new AppError(
          400,
          "TELEGRAM_CHANNEL_NOT_VERIFIED",
          "Verify the channel before enabling public posting."
        );
      }
    }

    const updated = await this.prisma.leaderboardBotIntegration.update({
      where: { id: row.id },
      data: { postingEnabled, lastError: postingEnabled ? null : row.lastError }
    });

    if (postingEnabled && this.outbox) {
      const competition = await this.prisma.leaderboardCompetition.findFirst({
        where: {
          workspaceId,
          ownerCoadminUserId,
          status: { in: ["ACTIVE", "FROZEN", "FINALIZED"] }
        },
        orderBy: { sequence: "desc" }
      });
      if (competition) {
        await this.outbox.enqueueRefresh(workspaceId, ownerCoadminUserId, competition.id);
      }
    }

    await this.audit.record({
      workspaceId,
      actorId: actorUserId,
      action: "leaderboard.telegram.posting_set",
      metadata: { ownerCoadminUserId, postingEnabled }
    });

    return toDto(updated, await this.disconnectWarning(workspaceId, ownerCoadminUserId));
  }

  /**
   * Manually queue a public leaderboard snapshot for the Coadmin's verified channel.
   * Snapshot/publish only — never emits rank-achievement announcements.
   * Reuses REFRESH_PUBLIC_LEADERBOARD outbox coalescing (edit persistent message when present).
   */
  public async sendLatestLeaderboard(
    workspaceId: string,
    ownerCoadminUserId: string,
    actorUserId: string
  ): Promise<LeaderboardTelegramSendLatestDto> {
    const row = await this.requireConnected(workspaceId, ownerCoadminUserId);

    if (!row.channelId) {
      throw new AppError(400, "TELEGRAM_CHANNEL_REQUIRED", "Set a channel before sending the leaderboard.");
    }
    if (!row.lastChannelVerifiedAt) {
      throw new AppError(
        400,
        "TELEGRAM_CHANNEL_NOT_VERIFIED",
        "Verify the channel before sending the leaderboard."
      );
    }
    if (!row.postingEnabled) {
      throw new AppError(400, "TELEGRAM_POSTING_DISABLED", "Enable posting first.");
    }

    const competition = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        workspaceId,
        ownerCoadminUserId,
        status: "ACTIVE"
      },
      orderBy: { sequence: "desc" }
    });
    if (!competition) {
      throw new AppError(
        404,
        "COMPETITION_NOT_FOUND",
        "No active leaderboard competition is available."
      );
    }

    const channelLabel =
      row.channelTitle?.trim() ||
      (row.channelUsername ? `@${row.channelUsername.replace(/^@/, "")}` : null) ||
      "Telegram channel";

    let token: string;
    try {
      token = this.decryptToken(row.encryptedBotToken);
    } catch {
      throw new AppError(500, "TELEGRAM_TOKEN_DECRYPT_FAILED", "Stored bot token could not be decrypted.");
    }

    let published;
    try {
      published = await publishPublicLeaderboardSnapshot({
        prisma: this.prisma,
        client: this.client,
        token,
        workspaceId,
        ownerCoadminUserId,
        competitionId: competition.id,
        integrationId: row.id,
        channelId: row.channelId,
        botUsername: row.botUsername,
        // Manual send always posts a fresh message (never silently edit a historical one).
        persistentMessageId: null,
        persistentMessageCompetitionId: row.persistentMessageCompetitionId,
        lastPublicTop10Json: row.lastPublicTop10Json,
        mode: "send_new",
        skipRankAnnouncements: true
      });
    } catch (error) {
      if (error instanceof LeaderboardTelegramApiError) {
        await this.prisma.leaderboardBotIntegration.update({
          where: { id: row.id },
          data: { lastError: error.description.slice(0, 500) }
        });
        throw new AppError(
          502,
          "TELEGRAM_SEND_FAILED",
          `Telegram rejected the leaderboard post: ${error.description}`
        );
      }
      if (error instanceof Error && error.message === "COMPETITION_NOT_FOUND") {
        throw new AppError(
          404,
          "COMPETITION_NOT_FOUND",
          "No active leaderboard competition is available."
        );
      }
      throw error;
    }

    await this.audit.record({
      workspaceId,
      actorId: actorUserId,
      action: "leaderboard.telegram.send_latest",
      metadata: {
        ownerCoadminUserId,
        competitionId: competition.id,
        channelId: published.channelId,
        telegramMessageId: published.messageId,
        deliveryAction: published.deliveryAction,
        skipRankAnnouncements: true
      }
    });

    return {
      queued: false,
      competitionId: competition.id,
      channelId: published.channelId,
      channelTitle: row.channelTitle?.trim() || null,
      telegramMessageId: published.messageId,
      deliveryAction: "SENT_NEW",
      mode: "send",
      message: `Leaderboard sent to ${channelLabel}`
    };
  }

  public async disconnect(
    workspaceId: string,
    ownerCoadminUserId: string,
    actorUserId: string,
    confirm: true
  ): Promise<LeaderboardTelegramIntegrationDto & { readonly cancelledJobs: number }> {
    if (confirm !== true) {
      throw new AppError(400, "CONFIRM_REQUIRED", "Disconnect requires confirm=true.");
    }
    const row = await this.prisma.leaderboardBotIntegration.findUnique({
      where: { ownerCoadminUserId }
    });
    if (!row || row.workspaceId !== workspaceId) {
      throw new AppError(404, "TELEGRAM_INTEGRATION_NOT_FOUND", "No bot integration is connected.");
    }

    const warning = await this.disconnectWarning(workspaceId, ownerCoadminUserId);
    const cancelledJobs = (await this.outbox?.cancelPendingForOwner(ownerCoadminUserId)) ?? 0;

    // Overwrite ciphertext so plaintext token is never recoverable from this row.
    const scrubbed = encryptSecret(`disconnected:${row.id}`, this.encryptionKey) as unknown as Prisma.InputJsonValue;
    try {
      const token = this.decryptToken(row.encryptedBotToken);
      if (this.client.deleteWebhook) {
        await this.client.deleteWebhook(token, false);
      }
    } catch {
      // Best-effort webhook cleanup.
    }

    await this.prisma.leaderboardBotIntegration.update({
      where: { id: row.id },
      data: {
        encryptedBotToken: scrubbed,
        disconnectedAt: new Date(),
        postingEnabled: false,
        botTelegramUserId: null,
        botUsername: null,
        botDisplayName: null,
        channelId: null,
        channelTitle: null,
        channelUsername: null,
        lastChannelVerifiedAt: null,
        persistentMessageId: null,
        persistentMessageCompetitionId: null,
        encryptedWebhookSecret: Prisma.DbNull,
        webhookRegisteredAt: null,
        lastInboundAt: null,
        lastError: warning
      }
    });

    await this.audit.record({
      workspaceId,
      actorId: actorUserId,
      action: "leaderboard.telegram.bot_disconnected",
      metadata: { ownerCoadminUserId, cancelledJobs, warning }
    });

    return { ...emptyIntegrationDto(warning), cancelledJobs };
  }

  /** Decrypt for processor use only — never expose via HTTP. */
  public decryptTokenForOwner(encryptedBotToken: unknown): string {
    return this.decryptToken(encryptedBotToken);
  }

  private async requireConnected(workspaceId: string, ownerCoadminUserId: string) {
    const row = await this.prisma.leaderboardBotIntegration.findUnique({
      where: { ownerCoadminUserId }
    });
    if (!row || row.workspaceId !== workspaceId || row.disconnectedAt) {
      throw new AppError(404, "TELEGRAM_INTEGRATION_NOT_FOUND", "Connect a leaderboard bot first.");
    }
    return row;
  }

  private decryptToken(encryptedBotToken: unknown): string {
    try {
      return decryptSecret(encryptedBotToken as EncryptedSecret, this.encryptionKey);
    } catch {
      throw new AppError(500, "TELEGRAM_TOKEN_DECRYPT_FAILED", "Stored bot token could not be decrypted.");
    }
  }

  private async maybeRegisterWebhook(integrationId: string, token: string) {
    if (!this.webhookBaseUrl || !this.client.setWebhook) return null;
    try {
      return await this.registerWebhookForIntegration(integrationId, token);
    } catch {
      return null;
    }
  }

  private async registerWebhookForIntegration(integrationId: string, token: string) {
    if (!this.webhookBaseUrl) {
      throw new AppError(
        400,
        "WEBHOOK_BASE_URL_MISSING",
        "LEADERBOARD_BOT_WEBHOOK_BASE_URL is not configured on this server."
      );
    }
    if (!this.client.setWebhook) {
      throw new AppError(500, "WEBHOOK_UNSUPPORTED", "Telegram client does not support setWebhook.");
    }
    const secret = randomBytes(32).toString("hex");
    const url = `${this.webhookBaseUrl}/api/leaderboard/telegram/webhook/${integrationId}`;
    await this.client.setWebhook(token, url, secret);
    const encrypted = encryptSecret(secret, this.encryptionKey) as unknown as Prisma.InputJsonValue;
    return this.prisma.leaderboardBotIntegration.update({
      where: { id: integrationId },
      data: {
        encryptedWebhookSecret: encrypted,
        webhookRegisteredAt: new Date(),
        lastError: null
      }
    });
  }

  private async disconnectWarning(
    workspaceId: string,
    ownerCoadminUserId: string
  ): Promise<string | null> {
    const pending = await this.prisma.giveawayEligibilityCandidate.findFirst({
      where: {
        workspaceId,
        ownerCoadminUserId,
        membershipStatus: "PENDING_REVIEW",
        competition: { status: "FROZEN" }
      },
      select: { id: true }
    });
    if (!pending) return null;
    return "A frozen competition still has PENDING_REVIEW membership candidates. Disconnecting may force manual review.";
  }
}

function toDto(
  row: {
    disconnectedAt: Date | null;
    botUsername: string | null;
    botDisplayName: string | null;
    botTelegramUserId: string | null;
    channelId: string | null;
    channelTitle: string | null;
    channelUsername: string | null;
    postingEnabled: boolean;
    connectedAt: Date;
    lastVerifiedAt: Date | null;
    lastChannelVerifiedAt: Date | null;
    lastSuccessfulPostAt: Date | null;
    lastMembershipCheckAt: Date | null;
    lastError: string | null;
    persistentMessageId: string | null;
    webhookRegisteredAt?: Date | null;
    lastInboundAt?: Date | null;
    encryptedWebhookSecret?: unknown;
  },
  disconnectWarning: string | null
): LeaderboardTelegramIntegrationDto {
  const botUsername = row.botUsername;
  return {
    connected: row.disconnectedAt == null,
    botUsername,
    botDisplayName: row.botDisplayName,
    botTelegramUserId: row.botTelegramUserId,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    channelUsername: row.channelUsername,
    postingEnabled: row.postingEnabled,
    channelVerified: row.lastChannelVerifiedAt != null && row.channelId != null,
    connectedAt: row.connectedAt.toISOString(),
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastChannelVerifiedAt: row.lastChannelVerifiedAt?.toISOString() ?? null,
    lastSuccessfulPostAt: row.lastSuccessfulPostAt?.toISOString() ?? null,
    lastMembershipCheckAt: row.lastMembershipCheckAt?.toISOString() ?? null,
    lastError: row.lastError,
    hasPersistentMessage: row.persistentMessageId != null,
    disconnectWarning,
    botDeepLink: botUsername ? `https://t.me/${botUsername.replace(/^@/, "")}?start=rank` : null,
    webhookRegisteredAt: row.webhookRegisteredAt?.toISOString() ?? null,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    webhookConfigured: row.encryptedWebhookSecret != null && row.webhookRegisteredAt != null
  };
}

function emptyIntegrationDto(disconnectWarning: string | null): LeaderboardTelegramIntegrationDto {
  return {
    connected: false,
    botUsername: null,
    botDisplayName: null,
    botTelegramUserId: null,
    channelId: null,
    channelTitle: null,
    channelUsername: null,
    postingEnabled: false,
    channelVerified: false,
    connectedAt: null,
    lastVerifiedAt: null,
    lastChannelVerifiedAt: null,
    lastSuccessfulPostAt: null,
    lastMembershipCheckAt: null,
    lastError: null,
    hasPersistentMessage: false,
    disconnectWarning,
    botDeepLink: null,
    webhookRegisteredAt: null,
    lastInboundAt: null,
    webhookConfigured: false
  };
}

function normalizeChannelRef(channelRef: string): string {
  const trimmed = channelRef.trim();
  if (!trimmed) {
    throw new AppError(400, "TELEGRAM_CHANNEL_INVALID", "Channel reference is required.");
  }
  if (trimmed.startsWith("@")) return trimmed;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9_]{5,}$/.test(trimmed)) return `@${trimmed}`;
  throw new AppError(
    400,
    "TELEGRAM_CHANNEL_INVALID",
    "Channel must be @username or a numeric chat id."
  );
}

function mapConnectError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof LeaderboardTelegramApiError) {
    if (error.permanent || error.httpStatus === 401 || error.httpStatus === 403) {
      return new AppError(400, "TELEGRAM_BOT_TOKEN_INVALID", "Telegram rejected the bot token.");
    }
    return new AppError(502, "TELEGRAM_BOT_API_ERROR", error.description);
  }
  return new AppError(502, "TELEGRAM_BOT_API_ERROR", "Telegram Bot API request failed.");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
