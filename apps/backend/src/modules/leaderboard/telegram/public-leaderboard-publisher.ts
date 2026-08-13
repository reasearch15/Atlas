import type { Prisma, PrismaClient } from "@prisma/client";
import { LEADERBOARD_TIMEZONE } from "../leaderboard.constants";
import { withRanks } from "../ranking";
import { detectRankAnnouncements, previousTop10ForAnnouncements } from "./announcement-policy";
import type { LeaderboardTelegramClient } from "./leaderboard-telegram.client";
import { LeaderboardTelegramApiError } from "./leaderboard-telegram.client";
import { formatPublicLeaderboardMessage } from "./public-message";
import { resolvePublicLeaderboardDisplayName } from "./public-display-name";

export type PublicLeaderboardDeliveryAction = "SENT_NEW" | "UPDATED_EXISTING";

/**
 * Public full-board delivery.
 * All modes use replace semantics: sendMessage → persist → delete previous.
 * `edit_or_create` is retained as a deprecated alias (no longer edits in place).
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
  /** Always false — full boards are never edit-in-place anymore. */
  readonly recoveredFromFailedEdit: boolean;
  readonly deletedPreviousMessageId: string | null;
  readonly nextTop10: readonly PublicLeaderboardTop10Row[];
  readonly announcements: ReturnType<typeof detectRankAnnouncements>;
  readonly text: string;
  readonly channelId: string;
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
  /** Canonical full-board message to replace (same channel only). */
  readonly persistentMessageId: string | null;
  readonly persistentMessageCompetitionId: string | null;
  readonly lastPublicTop10Json: unknown;
  readonly mode: PublicLeaderboardPublishMode;
  readonly skipRankAnnouncements: boolean;
  readonly logger?: {
    warn: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
  };
}

/**
 * Builds the elegant public leaderboard snapshot and delivers it via Bot API.
 *
 * Replacement order (never edit-in-place):
 * 1) sendMessage latest snapshot
 * 2) CAS-persist new canonical message id
 * 3) delete previous canonical message (same channel only)
 *
 * Rank announcement messages are never deleted here.
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

  const text = formatPublicLeaderboardMessage({
    title: "BIWEEKLY LEADERBOARD",
    top10: nextTop10.map((r) => ({
      rank: r.rank,
      displayName: r.displayName,
      points: r.totalPoints
    })),
    prizePoolCents: competition.prizePoolCents,
    endsAt: competition.endsAt,
    timezone: settings?.timezone ?? LEADERBOARD_TIMEZONE,
    botUsername: input.botUsername
  });

  const previousMessageId = input.persistentMessageId;
  const publishChannelId = input.channelId;

  // 1) Send NEW full board first — never delete old until this succeeds.
  const sent = await input.client.sendMessage(input.token, publishChannelId, text);
  const newMessageId = String(sent.messageId);

  const prevTop10 = previousTop10ForAnnouncements(
    input.persistentMessageCompetitionId,
    competition.id,
    input.lastPublicTop10Json
  );
  const announcements =
    !input.skipRankAnnouncements && competition.status === "ACTIVE"
      ? detectRankAnnouncements(prevTop10, nextTop10)
      : [];

  const boardData = {
    persistentMessageId: newMessageId,
    persistentMessageCompetitionId: competition.id,
    lastSuccessfulPostAt: new Date(),
    lastPublicTop10Json: nextTop10 as unknown as Prisma.InputJsonValue,
    lastError: null
  };

  // 2) CAS persist — only win if canonical still matches what we intended to replace.
  //    setChannel clears persistentMessageId, so channel-switch never CAS-matches an old id.
  const claimed = await input.prisma.leaderboardBotIntegration.updateMany({
    where: {
      id: input.integrationId,
      channelId: publishChannelId,
      persistentMessageId: previousMessageId
    },
    data: boardData
  });

  let deletedPreviousMessageId: string | null = null;

  if (claimed.count === 1) {
    // 3) Delete previous canonical board only after we own the new one.
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
    // Lost the race — another refresh became canonical. Do not delete their board.
    // Drop our orphaned send so the channel does not accumulate stale boards.
    const current = await input.prisma.leaderboardBotIntegration.findUnique({
      where: { id: input.integrationId },
      select: { persistentMessageId: true, channelId: true }
    });
    if (
      current?.channelId === publishChannelId &&
      current.persistentMessageId !== newMessageId
    ) {
      try {
        await input.client.deleteMessage(input.token, publishChannelId, Number(newMessageId));
      } catch (error) {
        input.logger?.warn(
          {
            err: error,
            channelId: publishChannelId,
            orphanMessageId: newMessageId,
            canonicalMessageId: current.persistentMessageId
          },
          "leaderboard.telegram.orphan_delete_failed"
        );
      }
    }

    // If nothing else owns canonical yet (unexpected), force-persist ours.
    if (!current?.persistentMessageId) {
      await input.prisma.leaderboardBotIntegration.update({
        where: { id: input.integrationId },
        data: boardData
      });
    }
  }

  const finalRow = await input.prisma.leaderboardBotIntegration.findUnique({
    where: { id: input.integrationId },
    select: { persistentMessageId: true }
  });
  const messageId = finalRow?.persistentMessageId ?? newMessageId;

  return {
    messageId,
    deliveryAction: "SENT_NEW",
    recoveredFromFailedEdit: false,
    deletedPreviousMessageId,
    nextTop10,
    announcements,
    text,
    channelId: publishChannelId
  };
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
    // New board stays; delete failure must not roll back publication.
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
