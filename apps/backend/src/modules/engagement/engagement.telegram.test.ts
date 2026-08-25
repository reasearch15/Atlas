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
      engagement: { voteFromCallback: vote }
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
