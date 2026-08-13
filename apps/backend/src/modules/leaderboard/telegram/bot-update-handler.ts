/**
 * Telegram Bot webhook handler for leaderboard player onboarding (/start, /rank).
 *
 * Deploy requirement: set LEADERBOARD_BOT_WEBHOOK_BASE_URL to the public HTTPS origin
 * of atlas-backend (e.g. https://api.example.com). Webhooks are registered to
 * `${base}/api/leaderboard/telegram/webhook/${integrationId}` with a secret token.
 * Prefer webhook in production; optional LEADERBOARD_BOT_POLLING is for local/dev only.
 */
import type { PrismaClient } from "@prisma/client";
import {
  decryptSecret,
  type EncryptedSecret
} from "@atlas/shared/session-encryption";
import { tryAutoBindParticipant } from "../auto-bind";
import { LEADERBOARD_TIMEZONE } from "../leaderboard.constants";
import { computeStandingGaps } from "../leaderboard.standing-helpers";
import { PrismaLeaderboardService } from "../leaderboard.prisma-service";
import { withRanks } from "../ranking";
import { verifyBotStartToken } from "./bot-start-token";
import type { LeaderboardTelegramClient } from "./leaderboard-telegram.client";
import { formatPersonalRankMessage } from "./personal-rank-message";
import { PrismaWheelService } from "../wheel.prisma-service";

export interface BotUpdateHandlerDeps {
  readonly prisma: PrismaClient;
  readonly client: LeaderboardTelegramClient;
  readonly encryptionKey: string;
  readonly startTokenSecret: string;
  readonly domain?: PrismaLeaderboardService;
}

export interface InboundTelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly message_id?: number;
    readonly text?: string;
    readonly date?: number;
    readonly chat?: { readonly id?: number; readonly type?: string };
    readonly from?: {
      readonly id?: number;
      readonly is_bot?: boolean;
      readonly first_name?: string;
      readonly last_name?: string;
      readonly username?: string;
    };
  };
}

const WELCOME =
  "Welcome to the Atlas leaderboard bot!\n\nYou are connected to this coadmin's leaderboard.\nSend /rank anytime to see your personal standing.";

/**
 * Handles a single Telegram update for a bot integration (webhook or poller).
 */
export class LeaderboardBotUpdateHandler {
  private readonly prisma: PrismaClient;
  private readonly client: LeaderboardTelegramClient;
  private readonly encryptionKey: string;
  private readonly startTokenSecret: string;
  private readonly domain: PrismaLeaderboardService;

  public constructor(deps: BotUpdateHandlerDeps) {
    this.prisma = deps.prisma;
    this.client = deps.client;
    this.encryptionKey = deps.encryptionKey;
    this.startTokenSecret = deps.startTokenSecret;
    this.domain = deps.domain ?? new PrismaLeaderboardService(deps.prisma);
  }

  public async handleWebhook(input: {
    readonly integrationId: string;
    readonly secretHeader: string | undefined;
    readonly update: InboundTelegramUpdate;
  }): Promise<{ readonly ok: true; readonly duplicate?: boolean } | { readonly ok: false; readonly status: number; readonly code: string }> {
    const integration = await this.prisma.leaderboardBotIntegration.findUnique({
      where: { id: input.integrationId }
    });
    if (!integration || integration.disconnectedAt) {
      return { ok: false, status: 404, code: "INTEGRATION_NOT_FOUND" };
    }

    if (integration.encryptedWebhookSecret) {
      let expected: string;
      try {
        expected = decryptSecret(
          integration.encryptedWebhookSecret as unknown as EncryptedSecret,
          this.encryptionKey
        );
      } catch {
        return { ok: false, status: 500, code: "WEBHOOK_SECRET_DECRYPT_FAILED" };
      }
      if (!input.secretHeader || !timingSafeEqualStrings(input.secretHeader, expected)) {
        return { ok: false, status: 401, code: "WEBHOOK_SECRET_INVALID" };
      }
    }

    const inserted = await this.recordUpdateIdempotent(integration.id, input.update.update_id);
    if (!inserted) {
      return { ok: true, duplicate: true };
    }

    await this.prisma.leaderboardBotIntegration.update({
      where: { id: integration.id },
      data: { lastInboundAt: new Date() }
    });

    await this.processUpdate(integration, input.update);
    return { ok: true };
  }

  public async processUpdate(
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      encryptedBotToken: unknown;
      disconnectedAt: Date | null;
    },
    update: InboundTelegramUpdate
  ): Promise<void> {
    const message = update.message;
    const from = message?.from;
    const text = message?.text?.trim() ?? "";
    if (!from?.id || from.is_bot) return;

    const token = decryptSecret(
      integration.encryptedBotToken as unknown as EncryptedSecret,
      this.encryptionKey
    );
    const telegramUserId = String(from.id);

    if (text === "/start" || text.startsWith("/start ")) {
      const payloadRaw = text === "/start" ? null : text.slice("/start ".length).trim();
      await this.handleStart({
        integration,
        token,
        telegramUserId,
        firstName: from.first_name ?? "Player",
        lastName: from.last_name,
        username: from.username,
        payloadRaw
      });
      return;
    }

    if (text === "/rank" || text.startsWith("/rank@") || payloadIsRank(text)) {
      await this.handleRank({
        integration,
        token,
        telegramUserId
      });
    }
  }

  private async handleStart(input: {
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
    };
    token: string;
    telegramUserId: string;
    firstName: string;
    lastName?: string | undefined;
    username?: string | undefined;
    payloadRaw: string | null;
  }): Promise<void> {
    // Optional signed payload may assert workspace/owner; bot identity is authoritative.
    if (input.payloadRaw && input.payloadRaw !== "rank") {
      const verified = verifyBotStartToken(this.startTokenSecret, input.payloadRaw);
      if (
        verified &&
        (verified.w !== input.integration.workspaceId ||
          verified.o !== input.integration.ownerCoadminUserId)
      ) {
        await this.client.sendMessage(
          input.token,
          Number(input.telegramUserId),
          "This start link belongs to a different leaderboard bot. Open the correct bot and try again."
        );
        return;
      }
    }

    const displayName = [input.firstName, input.lastName].filter(Boolean).join(" ").trim() || "Player";
    const contact = await this.upsertPrivateContact({
      workspaceId: input.integration.workspaceId,
      telegramPeerId: input.telegramUserId,
      displayName,
      username: input.username
    });

    const bind = await tryAutoBindParticipant(
      this.prisma,
      {
        workspaceId: input.integration.workspaceId,
        crmContactId: contact.id,
        ownerCoadminUserId: input.integration.ownerCoadminUserId,
        source: "BOT_START",
        skipPrivatePeerGate: true
      },
      this.domain
    );

    if (bind.status === "TRANSFER_REJECTED") {
      await this.client.sendMessage(
        input.token,
        Number(input.telegramUserId),
        "You are already connected to another coadmin's leaderboard in this workspace. Transfers are not supported — ask an admin if you need help."
      );
      return;
    }

    if (bind.status === "FAILED") {
      await this.client.sendMessage(
        input.token,
        Number(input.telegramUserId),
        "Could not connect you to the leaderboard right now. Please try again later."
      );
      return;
    }

    await this.prisma.leaderboardBotPlayerLink.upsert({
      where: {
        botIntegrationId_telegramUserId: {
          botIntegrationId: input.integration.id,
          telegramUserId: input.telegramUserId
        }
      },
      create: {
        workspaceId: input.integration.workspaceId,
        ownerCoadminUserId: input.integration.ownerCoadminUserId,
        botIntegrationId: input.integration.id,
        crmContactId: contact.id,
        telegramUserId: input.telegramUserId,
        startedAt: new Date()
      },
      update: {
        crmContactId: contact.id,
        startedAt: new Date()
      }
    });

    const reply =
      input.payloadRaw === "rank"
        ? `${WELCOME}\n\nFetching your rank…`
        : WELCOME;
    await this.client.sendMessage(input.token, Number(input.telegramUserId), reply);

    if (input.payloadRaw === "rank") {
      await this.handleRank({
        integration: input.integration,
        token: input.token,
        telegramUserId: input.telegramUserId
      });
    }
  }

  private async handleRank(input: {
    integration: {
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
    };
    token: string;
    telegramUserId: string;
  }): Promise<void> {
    const link = await this.prisma.leaderboardBotPlayerLink.findUnique({
      where: {
        botIntegrationId_telegramUserId: {
          botIntegrationId: input.integration.id,
          telegramUserId: input.telegramUserId
        }
      }
    });
    if (!link || link.ownerCoadminUserId !== input.integration.ownerCoadminUserId) {
      await this.client.sendMessage(
        input.token,
        Number(input.telegramUserId),
        "Send /start first to connect to this leaderboard."
      );
      return;
    }

    const competition = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        workspaceId: input.integration.workspaceId,
        ownerCoadminUserId: input.integration.ownerCoadminUserId,
        status: { in: ["ACTIVE", "FROZEN", "FINALIZED"] }
      },
      orderBy: [{ status: "asc" }, { sequence: "desc" }]
    });
    // Prefer ACTIVE when present.
    const active = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        workspaceId: input.integration.workspaceId,
        ownerCoadminUserId: input.integration.ownerCoadminUserId,
        status: "ACTIVE"
      },
      orderBy: { sequence: "desc" }
    });
    const chosen = active ?? competition;
    if (!chosen) {
      await this.client.sendMessage(
        input.token,
        Number(input.telegramUserId),
        "No active leaderboard competition right now. Check back soon."
      );
      return;
    }

    const settings = await this.prisma.leaderboardSettings.findUnique({
      where: { ownerCoadminUserId: input.integration.ownerCoadminUserId }
    });

    const standings = await this.prisma.leaderboardStanding.findMany({
      where: {
        competitionId: chosen.id,
        ownerCoadminUserId: input.integration.ownerCoadminUserId
      }
    });
    const ranked = withRanks(
      standings.map((s) => ({
        crmContactId: s.crmContactId,
        totalPoints: s.totalPoints,
        pointsReachedAt: s.pointsReachedAt
      }))
    );
    let me = ranked.find((r) => r.crmContactId === link.crmContactId);
    if (!me) {
      me = {
        crmContactId: link.crmContactId,
        totalPoints: 0,
        pointsReachedAt: new Date(),
        rank: ranked.length + 1
      };
      ranked.push(me);
    }

    const gaps = computeStandingGaps(ranked, link.crmContactId);

    // Wheel status for /rank only — bot Spin callback DEFERRED (Atlas UI spin first).
    let wheelStatus: {
      qualifyingDepositCents: number;
      qualificationCentsRequired: number;
      available: boolean;
      consumed: boolean;
      pointsAwarded: number | null;
      cycleSequence: number | null;
    } | null = null;
    try {
      const wheelService = new PrismaWheelService(this.prisma);
      const status = await wheelService.getStatus(
        input.integration.workspaceId,
        input.integration.ownerCoadminUserId,
        link.crmContactId,
        new Date()
      );
      if (status.wheelEnabled && status.configured) {
        wheelStatus = {
          qualifyingDepositCents: status.qualifyingDepositCents,
          qualificationCentsRequired: status.qualificationCentsRequired,
          available: status.available,
          consumed: status.consumed,
          pointsAwarded: status.pointsAwarded,
          cycleSequence: status.cycleSequence
        };
      }
    } catch {
      wheelStatus = null;
    }

    const text = formatPersonalRankMessage({
      rank: me.rank,
      totalPoints: me.totalPoints,
      pointsAbove: gaps?.pointsAbove ?? null,
      pointsToTop3: gaps?.pointsToTop3 ?? null,
      prizePoolCents: chosen.prizePoolCents,
      endsAt: chosen.endsAt,
      timezone: settings?.timezone ?? LEADERBOARD_TIMEZONE,
      isFirst: gaps?.isFirst ?? me.rank === 1,
      wheelStatus
    });

    await this.client.sendMessage(input.token, Number(input.telegramUserId), text);
    await this.prisma.leaderboardBotPlayerLink.update({
      where: { id: link.id },
      data: { lastRankRequestedAt: new Date() }
    });
  }

  private async upsertPrivateContact(input: {
    workspaceId: string;
    telegramPeerId: string;
    displayName: string;
    username?: string | undefined;
  }) {
    const existing = await this.prisma.crmContact.findUnique({
      where: {
        workspaceId_telegramPeerId: {
          workspaceId: input.workspaceId,
          telegramPeerId: input.telegramPeerId
        }
      }
    });
    if (existing) {
      return this.prisma.crmContact.update({
        where: { id: existing.id },
        data: {
          kind: "PRIVATE",
          displayName: input.displayName.slice(0, 255),
          ...(input.username !== undefined ? { username: input.username.slice(0, 120) } : {}),
          lastSeenAt: new Date()
        }
      });
    }
    return this.prisma.crmContact.create({
      data: {
        workspaceId: input.workspaceId,
        telegramPeerId: input.telegramPeerId,
        kind: "PRIVATE",
        displayName: input.displayName.slice(0, 255),
        username: input.username?.slice(0, 120) ?? null
      }
    });
  }

  private async recordUpdateIdempotent(botIntegrationId: string, updateId: number): Promise<boolean> {
    try {
      await this.prisma.leaderboardTelegramUpdate.create({
        data: {
          botIntegrationId,
          updateId: BigInt(updateId),
          processedAt: new Date()
        }
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }
}

function payloadIsRank(text: string): boolean {
  return text === "/start rank" || text.startsWith("/start rank");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
