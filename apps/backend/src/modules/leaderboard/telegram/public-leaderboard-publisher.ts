import type { Prisma, PrismaClient } from "@prisma/client";
import { LEADERBOARD_TIMEZONE } from "../leaderboard.constants";
import { withRanks } from "../ranking";
import { detectRankAnnouncements, previousTop10ForAnnouncements } from "./announcement-policy";
import type { LeaderboardTelegramClient } from "./leaderboard-telegram.client";
import { LeaderboardTelegramApiError } from "./leaderboard-telegram.client";
import { formatPublicLeaderboardMessage } from "./public-message";
import { resolvePublicLeaderboardDisplayName } from "./public-display-name";

export type PublicLeaderboardDeliveryAction = "SENT_NEW" | "UPDATED_EXISTING";

export type PublicLeaderboardPublishMode =
  /** Manual Send Leaderboard — always posts a fresh channel message. */
  | "send_new"
  /** Automatic refresh — edit canonical message when present, else send. */
  | "edit_or_create";

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
  readonly persistentMessageId: string | null;
  readonly persistentMessageCompetitionId: string | null;
  readonly lastPublicTop10Json: unknown;
  readonly mode: PublicLeaderboardPublishMode;
  readonly skipRankAnnouncements: boolean;
}

/**
 * Builds the elegant public leaderboard snapshot and delivers it via Bot API.
 * Manual mode always sendMessage; auto mode edits the canonical message when possible.
 * Does not enqueue announcement jobs — callers decide.
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

  let messageId = input.persistentMessageId;
  let deliveryAction: PublicLeaderboardDeliveryAction = "SENT_NEW";
  let recoveredFromFailedEdit = false;

  if (input.mode === "send_new") {
    const sent = await input.client.sendMessage(input.token, input.channelId, text);
    messageId = String(sent.messageId);
    deliveryAction = "SENT_NEW";
  } else if (messageId) {
    try {
      await input.client.editMessageText(input.token, input.channelId, Number(messageId), text);
      deliveryAction = "UPDATED_EXISTING";
    } catch (error) {
      if (!isMessageEditRecoverable(error)) throw error;
      const sent = await input.client.sendMessage(input.token, input.channelId, text);
      messageId = String(sent.messageId);
      deliveryAction = "SENT_NEW";
      recoveredFromFailedEdit = true;
    }
  } else {
    const sent = await input.client.sendMessage(input.token, input.channelId, text);
    messageId = String(sent.messageId);
    deliveryAction = "SENT_NEW";
  }

  const prevTop10 = previousTop10ForAnnouncements(
    input.persistentMessageCompetitionId,
    competition.id,
    input.lastPublicTop10Json
  );
  const announcements =
    !input.skipRankAnnouncements && competition.status === "ACTIVE"
      ? detectRankAnnouncements(prevTop10, nextTop10)
      : [];

  await input.prisma.leaderboardBotIntegration.update({
    where: { id: input.integrationId },
    data: {
      persistentMessageId: messageId,
      persistentMessageCompetitionId: competition.id,
      lastSuccessfulPostAt: new Date(),
      lastPublicTop10Json: nextTop10 as unknown as Prisma.InputJsonValue,
      lastError: null
    }
  });

  return {
    messageId: messageId!,
    deliveryAction,
    recoveredFromFailedEdit,
    nextTop10,
    announcements,
    text,
    channelId: input.channelId
  };
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
