import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import { LeaderboardBotUpdateHandler } from "../leaderboard/telegram/bot-update-handler";
import { createFakeLeaderboardTelegramClient } from "../leaderboard/telegram/leaderboard-telegram.client";
import { buildVoteCallbackData } from "./engagement.messages";

const encryptionKey = "k".repeat(64);
const integrationId = "i1111111-iiii-4iii-8iii-iiiiiiiiiii1";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const pollId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("engagement telegram callbacks", () => {
  it("answers registered, duplicate, and unregistered votes without editing the channel", async () => {
    const vote = vi.fn(async () => "recorded" as const);
    const pollAnswer = vi.fn(async () => "recorded" as const);
    vote
      .mockResolvedValueOnce("recorded")
      .mockResolvedValueOnce("already_voted")
      .mockResolvedValueOnce("unregistered");
    const answers: string[] = [];
    const state = {
      bots: new Map([["bot-token-a", { id: 9, isBot: true, firstName: "Bot", username: "bot" }]]),
      chats: new Map()
    };
    const client = createFakeLeaderboardTelegramClient(state);
    const editSpy = vi.spyOn(client, "editMessageText");
    const originalAnswer = client.answerCallbackQuery!;
    client.answerCallbackQuery = async (token, id, text) => {
      if (text) answers.push(text);
      return originalAnswer(token, id, text);
    };
    const handler = new LeaderboardBotUpdateHandler({
      prisma: {
        leaderboardBotIntegration: {
          findUnique: async () => ({
            id: integrationId,
            workspaceId,
            ownerCoadminUserId: ownerA,
            encryptedBotToken: encryptSecret("bot-token-a", encryptionKey),
            disconnectedAt: null
          }),
          update: async () => ({})
        },
        leaderboardTelegramUpdate: {
          create: async () => ({})
        }
      } as never,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      engagement: { voteFromCallback: vote, voteFromPollAnswer: pollAnswer, persistNativePollCounts: vi.fn() }
    });

    const send = async (telegramUserId: number, updateId: number) => {
      await handler.handleWebhook({
        integrationId,
        secretHeader: undefined,
        update: {
          update_id: updateId,
          callback_query: {
            id: `cq-${updateId}`,
            data: buildVoteCallbackData(pollId, 0),
            from: { id: telegramUserId, is_bot: false, first_name: "P" }
          }
        }
      });
    };

    await send(100, 1);
    await send(100, 2);
    await send(999, 3);
    expect(vote).toHaveBeenCalledTimes(3);
    expect(editSpy).not.toHaveBeenCalled();
    expect(answers).toEqual(["Vote recorded", "You already voted.", "Send /start first to join this engagement poll."]);
  });
});

describe("engagement telegram native poll answers", () => {
  it("routes poll_answer by Telegram poll id and user id without callback toasts", async () => {
    const pollAnswer = vi.fn(async () => "recorded" as const);
    const persist = vi.fn(async () => undefined);
    const logs: Array<{ obj: unknown; msg?: string }> = [];
    const state = {
      bots: new Map([["bot-token-a", { id: 9, isBot: true, firstName: "Bot", username: "bot" }]]),
      chats: new Map()
    };
    const client = createFakeLeaderboardTelegramClient(state);
    const answerSpy = vi.spyOn(client, "answerCallbackQuery");
    const handler = new LeaderboardBotUpdateHandler({
      prisma: {
        leaderboardBotIntegration: {
          findUnique: async () => ({
            id: integrationId,
            workspaceId,
            ownerCoadminUserId: ownerA,
            encryptedBotToken: encryptSecret("bot-token-a", encryptionKey),
            disconnectedAt: null
          }),
          update: async () => ({})
        },
        leaderboardTelegramUpdate: {
          create: async () => ({})
        }
      } as never,
      client,
      encryptionKey,
      startTokenSecret: encryptionKey,
      engagement: {
        voteFromCallback: vi.fn(),
        voteFromPollAnswer: pollAnswer,
        persistNativePollCounts: persist
      },
      log: {
        info: (obj: unknown, msg?: string) => {
          logs.push({ obj, msg });
        },
        warn: () => undefined
      }
    });

    await handler.handleWebhook({
      integrationId,
      secretHeader: undefined,
      update: {
        update_id: 88,
        poll_answer: {
          poll_id: "tg-poll-live",
          option_ids: [2],
          user: { id: 4242, is_bot: false, first_name: "Voter", username: "ignored" }
        }
      }
    });

    expect(pollAnswer).toHaveBeenCalledWith({
      botIntegrationId: integrationId,
      ownerCoadminUserId: ownerA,
      workspaceId,
      telegramUserId: "4242",
      telegramPollId: "tg-poll-live",
      optionIds: [2]
    });
    expect(answerSpy).not.toHaveBeenCalled();
    expect(logs.some((row) => row.msg === "engagement.poll_answer")).toBe(true);
  });

  it("logs poll_answer without a user id and does not invent a player", async () => {
    const pollAnswer = vi.fn(async () => "recorded" as const);
    const handler = new LeaderboardBotUpdateHandler({
      prisma: {
        leaderboardBotIntegration: {
          findUnique: async () => ({
            id: integrationId,
            workspaceId,
            ownerCoadminUserId: ownerA,
            encryptedBotToken: encryptSecret("bot-token-a", encryptionKey),
            disconnectedAt: null
          }),
          update: async () => ({})
        },
        leaderboardTelegramUpdate: {
          create: async () => ({})
        }
      } as never,
      client: createFakeLeaderboardTelegramClient({
        bots: new Map([["bot-token-a", { id: 9, isBot: true, firstName: "Bot" }]]),
        chats: new Map()
      }),
      encryptionKey,
      startTokenSecret: encryptionKey,
      engagement: {
        voteFromCallback: vi.fn(),
        voteFromPollAnswer: pollAnswer,
        persistNativePollCounts: vi.fn()
      }
    });

    await handler.handleWebhook({
      integrationId,
      secretHeader: undefined,
      update: {
        update_id: 89,
        poll_answer: {
          poll_id: "tg-poll-anon",
          option_ids: [0]
        }
      }
    });
    expect(pollAnswer).not.toHaveBeenCalled();
  });
});

