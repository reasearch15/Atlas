import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState
} from "./leaderboard-telegram.client";
import { publishPublicLeaderboardSnapshot } from "./public-leaderboard-publisher";
import { createMemoryPrisma } from "./leaderboard-telegram.test-harness";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const competitionA = "f9db36db-d526-47bb-8942-91e316e2cf19";
const competitionB = "a1b2c3d4-e5f6-4789-8abc-def012345678";
const encryptionKey = "k".repeat(64);
const channelA = "-100111";
const channelB = "-100222";
const playerA = "b1e1e379-82bf-494c-aa45-0de204e72209";
const playerB = "c2f2f48a-93c0-5a5d-bb56-1ef315f8331a";

function seedOwner(opts: {
  workspaceId: string;
  ownerId: string;
  competitionId: string;
  channelId: string;
  token: string;
  playerId: string;
  displayName: string;
  points: number;
  poolCents: number;
  messageId: string | null;
}) {
  const prisma = createMemoryPrisma();
  const integrationId = crypto.randomUUID();
  prisma._state.integrations.push({
    id: integrationId,
    workspaceId: opts.workspaceId,
    ownerCoadminUserId: opts.ownerId,
    encryptedBotToken: encryptSecret(opts.token, encryptionKey),
    botUsername: `${opts.token}_bot`,
    channelId: opts.channelId,
    channelTitle: `${opts.ownerId} Hub`,
    postingEnabled: true,
    lastChannelVerifiedAt: new Date(),
    persistentMessageId: opts.messageId,
    persistentMessageCompetitionId: opts.messageId ? opts.competitionId : null,
    lastPublicTop10Json: [],
    disconnectedAt: null,
    lastError: null
  });
  prisma._state.competitions.push({
    id: opts.competitionId,
    workspaceId: opts.workspaceId,
    ownerCoadminUserId: opts.ownerId,
    status: "ACTIVE",
    prizePoolCents: opts.poolCents,
    endsAt: new Date(Date.now() + 86_400_000),
    startsAt: new Date(),
    sequence: 1
  });
  prisma._state.standings.push({
    competitionId: opts.competitionId,
    ownerCoadminUserId: opts.ownerId,
    crmContactId: opts.playerId,
    totalPoints: opts.points,
    pointsReachedAt: new Date(),
    crmContact: { displayName: opts.displayName, chats: [] }
  });
  prisma._state.settings.push({ ownerCoadminUserId: opts.ownerId, timezone: "America/Chicago" });
  return { prisma, integrationId };
}

describe("publishPublicLeaderboardSnapshot media publisher", () => {
  it("first publish sends photo and persists message id", async () => {
    const { prisma, integrationId } = seedOwner({
      workspaceId: workspaceA,
      ownerId: ownerA,
      competitionId: competitionA,
      channelId: channelA,
      token: "tokA",
      playerId: playerA,
      displayName: "Picasso",
      points: 10,
      poolCents: 25000,
      messageId: null
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tokA", { id: 1, isBot: true, firstName: "Bot", username: "tokA_bot" }]]),
      chats: new Map([
        [
          Number(channelA),
          {
            id: Number(channelA),
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [],
            nextMessageId: 7
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const published = await publishPublicLeaderboardSnapshot({
      prisma: prisma as never,
      client,
      token: "tokA",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId,
      channelId: channelA,
      botUsername: "tokA_bot",
      playTelegramUsername: "officialsayugaming",
      persistentMessageId: null,
      persistentMessageCompetitionId: null,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true
    });
    expect(published.deliveryFormat).toBe("photo");
    expect(published.deliveryAction).toBe("SENT_NEW");
    expect(published.messageId).toBe("7");
    expect(prisma._state.integrations[0].persistentMessageId).toBe("7");
    expect(tgState.chats.get(Number(channelA))!.messages[0]!.photo).toBe(true);
    expect(tgState.chats.get(Number(channelA))!.messages[0]!.caption).toContain("Competition is live");
    expect(tgState.chats.get(Number(channelA))!.messages[0]!.replyMarkup?.inline_keyboard[0]).toEqual([
      { text: "🔴 PLAY", url: "https://t.me/officialsayugaming" },
      { text: "🏆 My Rank", url: "https://t.me/tokA_bot?start=rank" }
    ]);
  });

  it("existing board is replaced via sendPhoto then delete (never edit)", async () => {
    const { prisma, integrationId } = seedOwner({
      workspaceId: workspaceA,
      ownerId: ownerA,
      competitionId: competitionA,
      channelId: channelA,
      token: "tokA",
      playerId: playerA,
      displayName: "Picasso",
      points: 10,
      poolCents: 25000,
      messageId: "42"
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tokA", { id: 1, isBot: true, firstName: "Bot", username: "tokA_bot" }]]),
      chats: new Map([
        [
          Number(channelA),
          {
            id: Number(channelA),
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [
              {
                messageId: 42,
                photo: true,
                photoBytes: 1200,
                caption: "old",
                deleted: false
              }
            ],
            nextMessageId: 43
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const editSpy = vi.spyOn(client, "editMessageMedia");
    const sendSpy = vi.spyOn(client, "sendPhoto");
    const deleteSpy = vi.spyOn(client, "deleteMessage");
    const published = await publishPublicLeaderboardSnapshot({
      prisma: prisma as never,
      client,
      token: "tokA",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId,
      channelId: channelA,
      botUsername: "tokA_bot",
      playTelegramUsername: "officialsayugaming",
      persistentMessageId: "42",
      persistentMessageCompetitionId: competitionA,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true
    });
    expect(editSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("tokA", channelA, 42);
    expect(published.deliveryAction).toBe("SENT_NEW");
    expect(published.recoveredFromFailedEdit).toBe(false);
    expect(published.messageId).toBe("43");
    expect(published.deletedPreviousMessageId).toBe("42");
    expect(prisma._state.integrations[0].persistentMessageId).toBe("43");
    expect(tgState.chats.get(Number(channelA))!.messages.find((m) => m.messageId === 42)?.deleted).toBe(
      true
    );
    expect(tgState.chats.get(Number(channelA))!.messages.find((m) => m.messageId === 43)?.replyMarkup?.inline_keyboard[0]).toEqual([
      { text: "🔴 PLAY", url: "https://t.me/officialsayugaming" },
      { text: "🏆 My Rank", url: "https://t.me/tokA_bot?start=rank" }
    ]);
  });

  it("sendPhoto failure keeps previous canonical message", async () => {
    const { prisma, integrationId } = seedOwner({
      workspaceId: workspaceA,
      ownerId: ownerA,
      competitionId: competitionA,
      channelId: channelA,
      token: "tokA",
      playerId: playerA,
      displayName: "Picasso",
      points: 10,
      poolCents: 25000,
      messageId: "100"
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tokA", { id: 1, isBot: true, firstName: "Bot", username: "tokA_bot" }]]),
      chats: new Map([
        [
          Number(channelA),
          {
            id: Number(channelA),
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [
              {
                messageId: 100,
                photo: true,
                photoBytes: 800,
                caption: "live",
                deleted: false
              }
            ],
            nextMessageId: 101
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    vi.spyOn(client, "sendPhoto").mockRejectedValue(
      new LeaderboardTelegramApiError({
        httpStatus: 429,
        telegramErrorCode: 429,
        description: "Too Many Requests: retry after 3",
        permanent: false
      })
    );
    const deleteSpy = vi.spyOn(client, "deleteMessage");
    await expect(
      publishPublicLeaderboardSnapshot({
        prisma: prisma as never,
        client,
        token: "tokA",
        workspaceId: workspaceA,
        ownerCoadminUserId: ownerA,
        competitionId: competitionA,
        integrationId,
        channelId: channelA,
        botUsername: "tokA_bot",
        persistentMessageId: "100",
        persistentMessageCompetitionId: competitionA,
        lastPublicTop10Json: [],
        mode: "replace",
        skipRankAnnouncements: true
      })
    ).rejects.toBeInstanceOf(LeaderboardTelegramApiError);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(prisma._state.integrations[0].persistentMessageId).toBe("100");
    expect(tgState.chats.get(Number(channelA))!.messages.find((m) => m.messageId === 100)?.deleted).toBe(
      false
    );
  });

  it("delete failure keeps new message canonical", async () => {
    const { prisma, integrationId } = seedOwner({
      workspaceId: workspaceA,
      ownerId: ownerA,
      competitionId: competitionA,
      channelId: channelA,
      token: "tokA",
      playerId: playerA,
      displayName: "Picasso",
      points: 10,
      poolCents: 25000,
      messageId: "100"
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tokA", { id: 1, isBot: true, firstName: "Bot", username: "tokA_bot" }]]),
      chats: new Map([
        [
          Number(channelA),
          {
            id: Number(channelA),
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [
              {
                messageId: 100,
                photo: true,
                photoBytes: 800,
                caption: "old",
                deleted: false
              }
            ],
            nextMessageId: 101
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const warn = vi.fn();
    vi.spyOn(client, "deleteMessage").mockRejectedValue(
      new LeaderboardTelegramApiError({
        httpStatus: 400,
        telegramErrorCode: 400,
        description: "Bad Request: message to delete not found",
        permanent: true
      })
    );
    const published = await publishPublicLeaderboardSnapshot({
      prisma: prisma as never,
      client,
      token: "tokA",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId,
      channelId: channelA,
      botUsername: "tokA_bot",
      persistentMessageId: "100",
      persistentMessageCompetitionId: competitionA,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true,
      logger: { warn, info: vi.fn() }
    });
    expect(published.messageId).toBe("101");
    expect(published.deletedPreviousMessageId).toBeNull();
    expect(prisma._state.integrations[0].persistentMessageId).toBe("101");
    expect(warn).toHaveBeenCalled();
    // New board must still be live (not rolled back).
    const newest = tgState.chats.get(Number(channelA))!.messages.find((m) => m.messageId === 101);
    expect(newest).toBeTruthy();
    expect(newest!.deleted).not.toBe(true);
  });

  it("second update sends 102, persists 102, deletes 101", async () => {
    const { prisma, integrationId } = seedOwner({
      workspaceId: workspaceA,
      ownerId: ownerA,
      competitionId: competitionA,
      channelId: channelA,
      token: "tokA",
      playerId: playerA,
      displayName: "Picasso",
      points: 10,
      poolCents: 25000,
      messageId: "101"
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tokA", { id: 1, isBot: true, firstName: "Bot", username: "tokA_bot" }]]),
      chats: new Map([
        [
          Number(channelA),
          {
            id: Number(channelA),
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [
              {
                messageId: 101,
                photo: true,
                photoBytes: 900,
                caption: "board",
                deleted: false
              }
            ],
            nextMessageId: 102
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const editSpy = vi.spyOn(client, "editMessageMedia");
    const published = await publishPublicLeaderboardSnapshot({
      prisma: prisma as never,
      client,
      token: "tokA",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId,
      channelId: channelA,
      botUsername: "tokA_bot",
      persistentMessageId: "101",
      persistentMessageCompetitionId: competitionA,
      lastPublicTop10Json: [
        { crmContactId: playerA, rank: 1, displayName: "Picasso", totalPoints: 10 }
      ],
      mode: "replace",
      skipRankAnnouncements: true
    });
    expect(editSpy).not.toHaveBeenCalled();
    expect(published.messageId).toBe("102");
    expect(published.deletedPreviousMessageId).toBe("101");
    expect(prisma._state.integrations[0].persistentMessageId).toBe("102");
  });

  it("Coadmin A cannot affect Coadmin B Telegram leaderboard message", async () => {
    const a = seedOwner({
      workspaceId: workspaceA,
      ownerId: ownerA,
      competitionId: competitionA,
      channelId: channelA,
      token: "tokA",
      playerId: playerA,
      displayName: "OwnerAStar",
      points: 50,
      poolCents: 10000,
      messageId: null
    });
    // Merge B into same prisma memory by copying — use separate prismas + clients.
    const b = seedOwner({
      workspaceId: workspaceB,
      ownerId: ownerB,
      competitionId: competitionB,
      channelId: channelB,
      token: "tokB",
      playerId: playerB,
      displayName: "OwnerBStar",
      points: 99,
      poolCents: 99900,
      messageId: null
    });

    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([
        ["tokA", { id: 1, isBot: true, firstName: "BotA", username: "tokA_bot" }],
        ["tokB", { id: 2, isBot: true, firstName: "BotB", username: "tokB_bot" }]
      ]),
      chats: new Map([
        [
          Number(channelA),
          {
            id: Number(channelA),
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [],
            nextMessageId: 1
          }
        ],
        [
          Number(channelB),
          {
            id: Number(channelB),
            type: "channel",
            members: new Map([[2, "administrator"]]),
            messages: [],
            nextMessageId: 1
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);

    const pubA = await publishPublicLeaderboardSnapshot({
      prisma: a.prisma as never,
      client,
      token: "tokA",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId: a.integrationId,
      channelId: channelA,
      botUsername: "tokA_bot",
      playTelegramUsername: "officialsayugaming",
      persistentMessageId: null,
      persistentMessageCompetitionId: null,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true
    });
    const pubB = await publishPublicLeaderboardSnapshot({
      prisma: b.prisma as never,
      client,
      token: "tokB",
      workspaceId: workspaceB,
      ownerCoadminUserId: ownerB,
      competitionId: competitionB,
      integrationId: b.integrationId,
      channelId: channelB,
      botUsername: "tokB_bot",
      playTelegramUsername: "coadminbplay",
      persistentMessageId: null,
      persistentMessageCompetitionId: null,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true
    });

    expect(pubA.messageId).toBe("1");
    expect(pubB.messageId).toBe("1");
    expect(a.prisma._state.integrations[0].persistentMessageId).toBe("1");
    expect(b.prisma._state.integrations[0].persistentMessageId).toBe("1");
    expect(a.prisma._state.integrations[0].channelId).toBe(channelA);
    expect(b.prisma._state.integrations[0].channelId).toBe(channelB);
    expect(tgState.chats.get(Number(channelA))!.messages).toHaveLength(1);
    expect(tgState.chats.get(Number(channelB))!.messages).toHaveLength(1);
    expect(tgState.chats.get(Number(channelA))!.messages[0]!.replyMarkup?.inline_keyboard[0]?.[0]).toEqual({
      text: "🔴 PLAY",
      url: "https://t.me/officialsayugaming"
    });
    expect(tgState.chats.get(Number(channelB))!.messages[0]!.replyMarkup?.inline_keyboard[0]?.[0]).toEqual({
      text: "🔴 PLAY",
      url: "https://t.me/coadminbplay"
    });
    expect((a.prisma._state.integrations[0].lastPublicTop10Json as any)[0].displayName).toBe("OwnerAStar");
    expect((b.prisma._state.integrations[0].lastPublicTop10Json as any)[0].displayName).toBe("OwnerBStar");
  });

  it("falls back to text when render path is forced to fail via client media permanent photo error after render", async () => {
    const { prisma, integrationId } = seedOwner({
      workspaceId: workspaceA,
      ownerId: ownerA,
      competitionId: competitionA,
      channelId: channelA,
      token: "tokA",
      playerId: playerA,
      displayName: "Picasso",
      points: 10,
      poolCents: 25000,
      messageId: null
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tokA", { id: 1, isBot: true, firstName: "Bot", username: "tokA_bot" }]]),
      chats: new Map([
        [
          Number(channelA),
          {
            id: Number(channelA),
            type: "channel",
            members: new Map([[1, "administrator"]]),
            messages: [],
            nextMessageId: 1
          }
        ]
      ]),
      failures: new Map([
        [
          "tokA:sendPhoto",
          new LeaderboardTelegramApiError({
            httpStatus: 400,
            telegramErrorCode: 400,
            description: "Bad Request: PHOTO_INVALID_DIMENSIONS",
            permanent: true
          })
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const published = await publishPublicLeaderboardSnapshot({
      prisma: prisma as never,
      client,
      token: "tokA",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId,
      channelId: channelA,
      botUsername: "tokA_bot",
      playTelegramUsername: "officialsayugaming",
      persistentMessageId: null,
      persistentMessageCompetitionId: null,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true
    });
    expect(published.deliveryFormat).toBe("text");
    expect(published.text).toContain("BIWEEKLY LEADERBOARD");
    expect(tgState.chats.get(Number(channelA))!.messages[0]!.text).toContain("Picasso");
    expect(tgState.chats.get(Number(channelA))!.messages[0]!.replyMarkup?.inline_keyboard[0]).toEqual([
      { text: "🔴 PLAY", url: "https://t.me/officialsayugaming" },
      { text: "🏆 My Rank", url: "https://t.me/tokA_bot?start=rank" }
    ]);
  });
});
