import type { Prisma, PrismaClient } from "@prisma/client";
import { LEADERBOARD_TIMEZONE } from "../leaderboard.constants";
import { withRanks } from "../ranking";
import { detectRankAnnouncements, previousTop10ForAnnouncements } from "./announcement-policy";
import type { LeaderboardTelegramClient } from "./leaderboard-telegram.client";
import { LeaderboardTelegramApiError } from "./leaderboard-telegram.client";
import {
  computeRankMovement,
  renderPublicLeaderboardCard,
  resolveLeaderboardCardTheme,
  type LeaderboardCardStanding
} from "./public-leaderboard-card";
import {
  buildPublicLeaderboardClimbTips,
  maxWheelPointsFromDistribution
} from "./public-leaderboard-climb-tips";
import { resolvePublicLeaderboardDisplayName } from "./public-display-name";
import {
  buildPublicLeaderboardKeyboard,
  formatPublicLeaderboardCaption,
  formatPublicLeaderboardMessage
} from "./public-message";
import { WHEEL_MAX_POINTS, WHEEL_QUALIFICATION_CENTS } from "../leaderboard.constants";

export type PublicLeaderboardDeliveryAction = "SENT_NEW" | "UPDATED_EXISTING";

/**
 * Public full-board delivery.
 * Prefer editMessageMedia when a photo board already exists; otherwise sendPhoto replace.
 * `edit_or_create` / `replace` / `send_new` are retained as mode aliases.
 */
export type PublicLeaderboardPublishMode = "replace" | "send_new" | "edit_or_create";

export interface PublicLeaderboardTop10Row {
  readonly crmContactId: string;
  readonly rank: number;
  readonly displayName: string;
  readonly totalPoints: number;
}

export interface PublishPublicLeaderboardResult {
  readonly messageId: string;
  readonly deliveryAction: PublicLeaderboardDeliveryAction;
  readonly recoveredFromFailedEdit: boolean;
  readonly deletedPreviousMessageId: string | null;
  readonly nextTop10: readonly PublicLeaderboardTop10Row[];
  readonly announcements: ReturnType<typeof detectRankAnnouncements>;
  /** Caption (media path) or full text body (text fallback). */
  readonly text: string;
  readonly channelId: string;
  readonly deliveryFormat: "photo" | "text";
}

export interface PublishPublicLeaderboardInput {
  readonly prisma: PrismaClient;
  readonly client: LeaderboardTelegramClient;
  readonly token: string;
  readonly workspaceId: string;
  readonly ownerCoadminUserId: string;
  readonly competitionId: string;
  readonly integrationId: string;
  readonly channelId: string;
  readonly botUsername: string | null;
  /** Optional brand line on the card (channel title). */
  readonly brandName?: string | null;
  /** Canonical full-board message to replace/edit (same channel only). */
  readonly persistentMessageId: string | null;
  readonly persistentMessageCompetitionId: string | null;
  readonly lastPublicTop10Json: unknown;
  readonly mode: PublicLeaderboardPublishMode;
  readonly skipRankAnnouncements: boolean;
  readonly logger?: {
    warn: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
  };
}

/**
 * Builds the public leaderboard snapshot and delivers premium PNG + caption + keyboard.
 * Falls back to the legacy text board if card render / media transport fails appropriately.
 */
export async function publishPublicLeaderboardSnapshot(
  input: PublishPublicLeaderboardInput
): Promise<PublishPublicLeaderboardResult> {
  const competition = await input.prisma.leaderboardCompetition.findFirst({
    where: {
      id: input.competitionId,
      workspaceId: input.workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId
    }
  });
  if (!competition) {
    throw new Error("COMPETITION_NOT_FOUND");
  }

  const settings = await input.prisma.leaderboardSettings.findUnique({
    where: { ownerCoadminUserId: input.ownerCoadminUserId }
  });

  const wheelConfig = await input.prisma.leaderboardWheelConfig.findUnique({
    where: { ownerCoadminUserId: input.ownerCoadminUserId },
    include: { activeVersion: true }
  });
  const wheelEnabled = Boolean(wheelConfig?.enabled && wheelConfig.activeVersionId);
  const wheelMaxFromDist = maxWheelPointsFromDistribution(
    wheelConfig?.activeVersion?.rewardDistributionJson
  );
  const climbTips = buildPublicLeaderboardClimbTips({
    includeDeposit: true,
    includeReferral: true,
    includePromotions: true,
    includeWheel: wheelEnabled,
    wheelQualificationCents: WHEEL_QUALIFICATION_CENTS,
    wheelMaxPoints: wheelMaxFromDist ?? WHEEL_MAX_POINTS
  });

  const standings = await input.prisma.leaderboardStanding.findMany({
    where: { competitionId: competition.id, ownerCoadminUserId: input.ownerCoadminUserId },
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

  const ranked = withRanks(
    standings.map((s) => ({
      crmContactId: s.crmContactId,
      totalPoints: s.totalPoints,
      pointsReachedAt: s.pointsReachedAt
    }))
  ).slice(0, 10);

  const displayById = new Map(
    standings.map((s) => {
      const chat = Array.isArray(s.crmContact.chats) ? s.crmContact.chats[0] : undefined;
      return [
        s.crmContactId,
        resolvePublicLeaderboardDisplayName({
          displayName: s.crmContact.displayName,
          firstName: chat?.firstName ?? null,
          lastName: chat?.lastName ?? null,
          username: s.crmContact.username ?? chat?.username ?? null
        })
      ] as const;
    })
  );

  const nextTop10: PublicLeaderboardTop10Row[] = ranked.map((r) => ({
    crmContactId: r.crmContactId,
    rank: r.rank,
    displayName: displayById.get(r.crmContactId) ?? "Player",
    totalPoints: r.totalPoints
  }));

  const prevTop10 = previousTop10ForAnnouncements(
    input.persistentMessageCompetitionId,
    competition.id,
    input.lastPublicTop10Json
  );

  const announcements =
    !input.skipRankAnnouncements && competition.status === "ACTIVE"
      ? detectRankAnnouncements(prevTop10, nextTop10)
      : [];

  const timezone = settings?.timezone ?? LEADERBOARD_TIMEZONE;
  const brandName =
    (input.brandName && input.brandName.trim()) ||
    "SAYU GAMING HUB";

  const caption = formatPublicLeaderboardCaption({ competitionStatus: competition.status });
  const keyboard = buildPublicLeaderboardKeyboard(input.botUsername);

  const textFallback = formatPublicLeaderboardMessage({
    title: "BIWEEKLY LEADERBOARD",
    top10: nextTop10.map((r) => ({
      rank: r.rank,
      displayName: r.displayName,
      points: r.totalPoints
    })),
    prizePoolCents: competition.prizePoolCents,
    endsAt: competition.endsAt,
    timezone,
    botUsername: input.botUsername
  });

  const cardStandings: LeaderboardCardStanding[] = nextTop10.map((r) => {
    const movement = computeRankMovement(r.crmContactId, r.rank, prevTop10);
    return {
      rank: r.rank,
      displayName: r.displayName,
      points: r.totalPoints,
      ...(movement ? { movement } : {})
    };
  });

  let png: Buffer | null = null;
  try {
    const rendered = await renderPublicLeaderboardCard({
      brandName,
      prizePoolCents: competition.prizePoolCents,
      endsAt: competition.endsAt,
      timezone,
      competitionStatus: competition.status,
      standings: cardStandings,
      theme: resolveLeaderboardCardTheme(competition.status, competition.endsAt),
      climbTips
    });
    png = rendered.png;
    input.logger?.info?.(
      {
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: competition.id,
        standingsCount: cardStandings.length,
        renderMs: rendered.renderMs,
        imageBytes: rendered.imageBytes
      },
      "[LEADERBOARD_CARD_RENDERED]"
    );
  } catch (error) {
    input.logger?.error?.(
      {
        err: error,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: competition.id
      },
      "[LEADERBOARD_CARD_RENDER_FAILED]"
    );
    png = null;
  }

  if (!png) {
    const delivered = await deliverTextBoard({
      ...input,
      text: textFallback,
      competitionId: competition.id,
      nextTop10
    });
    return {
      ...delivered,
      nextTop10,
      announcements,
      text: textFallback,
      channelId: input.channelId,
      deliveryFormat: "text"
    };
  }

  try {
    const delivered = await deliverPhotoBoard({
      ...input,
      png,
      caption,
      keyboard,
      competitionId: competition.id,
      nextTop10
    });
    return {
      ...delivered,
      nextTop10,
      announcements,
      text: caption,
      channelId: input.channelId,
      deliveryFormat: "photo"
    };
  } catch (error) {
    if (!shouldFallbackToText(error)) {
      throw error;
    }
    input.logger?.warn?.(
      {
        err: error,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: competition.id
      },
      "leaderboard.telegram.media_fallback_to_text"
    );
    const delivered = await deliverTextBoard({
      ...input,
      text: textFallback,
      competitionId: competition.id,
      nextTop10
    });
    return {
      ...delivered,
      nextTop10,
      announcements,
      text: textFallback,
      channelId: input.channelId,
      deliveryFormat: "text"
    };
  }
}

async function deliverPhotoBoard(input: {
  readonly prisma: PrismaClient;
  readonly client: LeaderboardTelegramClient;
  readonly token: string;
  readonly integrationId: string;
  readonly channelId: string;
  readonly ownerCoadminUserId: string;
  readonly competitionId: string;
  readonly persistentMessageId: string | null;
  readonly png: Buffer;
  readonly caption: string;
  readonly keyboard: ReturnType<typeof buildPublicLeaderboardKeyboard>;
  readonly nextTop10: readonly PublicLeaderboardTop10Row[];
  readonly logger?: PublishPublicLeaderboardInput["logger"];
}): Promise<{
  messageId: string;
  deliveryAction: PublicLeaderboardDeliveryAction;
  recoveredFromFailedEdit: boolean;
  deletedPreviousMessageId: string | null;
}> {
  const previousMessageId = input.persistentMessageId;
  const publishChannelId = input.channelId;
  const mediaOptions = {
    caption: input.caption,
    ...(input.keyboard ? { replyMarkup: input.keyboard } : {}),
    filename: "leaderboard.png"
  };

  // Prefer living edit when a canonical message exists.
  if (previousMessageId) {
    try {
      await input.client.editMessageMedia(
        input.token,
        publishChannelId,
        Number(previousMessageId),
        input.png,
        mediaOptions
      );
      await persistBoardMeta({
        prisma: input.prisma,
        integrationId: input.integrationId,
        channelId: publishChannelId,
        expectedPersistentMessageId: previousMessageId,
        persistentMessageId: previousMessageId,
        competitionId: input.competitionId,
        nextTop10: input.nextTop10
      });
      input.logger?.info?.(
        {
          ownerCoadminUserId: input.ownerCoadminUserId,
          competitionId: input.competitionId,
          messageId: previousMessageId,
          channelId: publishChannelId
        },
        "[LEADERBOARD_MEDIA_EDITED]"
      );
      return {
        messageId: previousMessageId,
        deliveryAction: "UPDATED_EXISTING",
        recoveredFromFailedEdit: false,
        deletedPreviousMessageId: null
      };
    } catch (error) {
      // Telegram returns this when photo/caption/markup are byte-identical — treat as success.
      if (isUnmodifiedTelegramEditError(error)) {
        await persistBoardMeta({
          prisma: input.prisma,
          integrationId: input.integrationId,
          channelId: publishChannelId,
          expectedPersistentMessageId: previousMessageId,
          persistentMessageId: previousMessageId,
          competitionId: input.competitionId,
          nextTop10: input.nextTop10
        });
        input.logger?.info?.(
          {
            ownerCoadminUserId: input.ownerCoadminUserId,
            competitionId: input.competitionId,
            messageId: previousMessageId,
            channelId: publishChannelId,
            unchanged: true
          },
          "[LEADERBOARD_MEDIA_EDITED]"
        );
        return {
          messageId: previousMessageId,
          deliveryAction: "UPDATED_EXISTING",
          recoveredFromFailedEdit: false,
          deletedPreviousMessageId: null
        };
      }
      input.logger?.warn?.(
        {
          err: error,
          ownerCoadminUserId: input.ownerCoadminUserId,
          competitionId: input.competitionId,
          previousMessageId
        },
        "[LEADERBOARD_MEDIA_EDIT_FALLBACK_REPLACE]"
      );
      // Fall through to sendPhoto replace.
    }
  }

  const sent = await input.client.sendPhoto(input.token, publishChannelId, input.png, mediaOptions);
  const newMessageId = String(sent.messageId);
  input.logger?.info?.(
    {
      ownerCoadminUserId: input.ownerCoadminUserId,
      competitionId: input.competitionId,
      messageId: newMessageId,
      channelId: publishChannelId
    },
    "[LEADERBOARD_MEDIA_SENT]"
  );

  const claimed = await persistBoardMeta({
    prisma: input.prisma,
    integrationId: input.integrationId,
    channelId: publishChannelId,
    expectedPersistentMessageId: previousMessageId,
    persistentMessageId: newMessageId,
    competitionId: input.competitionId,
    nextTop10: input.nextTop10
  });

  let deletedPreviousMessageId: string | null = null;
  if (claimed) {
    if (
      previousMessageId &&
      previousMessageId !== newMessageId &&
      (await stillCanonical(input.prisma, input.integrationId, newMessageId, publishChannelId))
    ) {
      deletedPreviousMessageId = await deletePreviousBoardSafely({
        client: input.client,
        token: input.token,
        channelId: publishChannelId,
        previousMessageId,
        newMessageId,
        logger: input.logger
      });
    }
  } else {
    await handleLostCasRace({
      prisma: input.prisma,
      client: input.client,
      token: input.token,
      integrationId: input.integrationId,
      channelId: publishChannelId,
      newMessageId,
      competitionId: input.competitionId,
      nextTop10: input.nextTop10,
      logger: input.logger
    });
  }

  const finalRow = await input.prisma.leaderboardBotIntegration.findUnique({
    where: { id: input.integrationId },
    select: { persistentMessageId: true }
  });

  return {
    messageId: finalRow?.persistentMessageId ?? newMessageId,
    deliveryAction: "SENT_NEW",
    recoveredFromFailedEdit: Boolean(previousMessageId),
    deletedPreviousMessageId
  };
}

async function deliverTextBoard(input: {
  readonly prisma: PrismaClient;
  readonly client: LeaderboardTelegramClient;
  readonly token: string;
  readonly integrationId: string;
  readonly channelId: string;
  readonly competitionId: string;
  readonly persistentMessageId: string | null;
  readonly text: string;
  readonly nextTop10: readonly PublicLeaderboardTop10Row[];
  readonly logger?: PublishPublicLeaderboardInput["logger"];
}): Promise<{
  messageId: string;
  deliveryAction: PublicLeaderboardDeliveryAction;
  recoveredFromFailedEdit: boolean;
  deletedPreviousMessageId: string | null;
}> {
  const previousMessageId = input.persistentMessageId;
  const publishChannelId = input.channelId;

  const sent = await input.client.sendMessage(input.token, publishChannelId, input.text);
  const newMessageId = String(sent.messageId);

  const claimed = await persistBoardMeta({
    prisma: input.prisma,
    integrationId: input.integrationId,
    channelId: publishChannelId,
    expectedPersistentMessageId: previousMessageId,
    persistentMessageId: newMessageId,
    competitionId: input.competitionId,
    nextTop10: input.nextTop10
  });

  let deletedPreviousMessageId: string | null = null;
  if (claimed) {
    if (
      previousMessageId &&
      previousMessageId !== newMessageId &&
      (await stillCanonical(input.prisma, input.integrationId, newMessageId, publishChannelId))
    ) {
      deletedPreviousMessageId = await deletePreviousBoardSafely({
        client: input.client,
        token: input.token,
        channelId: publishChannelId,
        previousMessageId,
        newMessageId,
        logger: input.logger
      });
    }
  } else {
    await handleLostCasRace({
      prisma: input.prisma,
      client: input.client,
      token: input.token,
      integrationId: input.integrationId,
      channelId: publishChannelId,
      newMessageId,
      competitionId: input.competitionId,
      nextTop10: input.nextTop10,
      logger: input.logger
    });
  }

  const finalRow = await input.prisma.leaderboardBotIntegration.findUnique({
    where: { id: input.integrationId },
    select: { persistentMessageId: true }
  });

  return {
    messageId: finalRow?.persistentMessageId ?? newMessageId,
    deliveryAction: "SENT_NEW",
    recoveredFromFailedEdit: false,
    deletedPreviousMessageId
  };
}

async function persistBoardMeta(input: {
  readonly prisma: PrismaClient;
  readonly integrationId: string;
  readonly channelId: string;
  readonly expectedPersistentMessageId: string | null;
  readonly persistentMessageId: string;
  readonly competitionId: string;
  readonly nextTop10: readonly PublicLeaderboardTop10Row[];
}): Promise<boolean> {
  const boardData = {
    persistentMessageId: input.persistentMessageId,
    persistentMessageCompetitionId: input.competitionId,
    lastSuccessfulPostAt: new Date(),
    lastPublicTop10Json: input.nextTop10 as unknown as Prisma.InputJsonValue,
    lastError: null
  };
  const claimed = await input.prisma.leaderboardBotIntegration.updateMany({
    where: {
      id: input.integrationId,
      channelId: input.channelId,
      persistentMessageId: input.expectedPersistentMessageId
    },
    data: boardData
  });
  return claimed.count === 1;
}

async function handleLostCasRace(input: {
  readonly prisma: PrismaClient;
  readonly client: LeaderboardTelegramClient;
  readonly token: string;
  readonly integrationId: string;
  readonly channelId: string;
  readonly newMessageId: string;
  readonly competitionId: string;
  readonly nextTop10: readonly PublicLeaderboardTop10Row[];
  readonly logger?: PublishPublicLeaderboardInput["logger"];
}): Promise<void> {
  const current = await input.prisma.leaderboardBotIntegration.findUnique({
    where: { id: input.integrationId },
    select: { persistentMessageId: true, channelId: true }
  });
  if (current?.channelId === input.channelId && current.persistentMessageId !== input.newMessageId) {
    try {
      await input.client.deleteMessage(input.token, input.channelId, Number(input.newMessageId));
    } catch (error) {
      input.logger?.warn(
        {
          err: error,
          channelId: input.channelId,
          orphanMessageId: input.newMessageId,
          canonicalMessageId: current.persistentMessageId
        },
        "leaderboard.telegram.orphan_delete_failed"
      );
    }
  }

  if (!current?.persistentMessageId) {
    await input.prisma.leaderboardBotIntegration.update({
      where: { id: input.integrationId },
      data: {
        persistentMessageId: input.newMessageId,
        persistentMessageCompetitionId: input.competitionId,
        lastSuccessfulPostAt: new Date(),
        lastPublicTop10Json: input.nextTop10 as unknown as Prisma.InputJsonValue,
        lastError: null
      }
    });
  }
}

async function stillCanonical(
  prisma: PrismaClient,
  integrationId: string,
  messageId: string,
  channelId: string
): Promise<boolean> {
  const row = await prisma.leaderboardBotIntegration.findUnique({
    where: { id: integrationId },
    select: { persistentMessageId: true, channelId: true }
  });
  return row?.persistentMessageId === messageId && row.channelId === channelId;
}

async function deletePreviousBoardSafely(input: {
  readonly client: LeaderboardTelegramClient;
  readonly token: string;
  readonly channelId: string;
  readonly previousMessageId: string;
  readonly newMessageId: string;
  readonly logger?: PublishPublicLeaderboardInput["logger"];
}): Promise<string | null> {
  if (input.previousMessageId === input.newMessageId) return null;
  try {
    await input.client.deleteMessage(
      input.token,
      input.channelId,
      Number(input.previousMessageId)
    );
    return input.previousMessageId;
  } catch (error) {
    input.logger?.warn(
      {
        err: error,
        channelId: input.channelId,
        previousMessageId: input.previousMessageId,
        newMessageId: input.newMessageId
      },
      "leaderboard.telegram.previous_board_delete_failed"
    );
    return null;
  }
}

function shouldFallbackToText(error: unknown): boolean {
  if (!(error instanceof LeaderboardTelegramApiError)) return false;
  if (!error.permanent) return false;
  // Temporary / rate-limit / network must stay retryable via outbox.
  const d = error.description.toLowerCase();
  return (
    d.includes("photo") ||
    d.includes("media") ||
    d.includes("image") ||
    d.includes("file") ||
    d.includes("mime") ||
    d.includes("too big")
  );
}

function isUnmodifiedTelegramEditError(error: unknown): boolean {
  if (!(error instanceof LeaderboardTelegramApiError)) return false;
  return /message is not modified/i.test(error.description);
}
