import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState,
  type FakeTelegramChatState
} from "./leaderboard-telegram.client";
import {
  isRefreshPayloadDirty,
  LeaderboardTelegramOutboxService,
  mergeRefreshPayload
} from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { publishPublicLeaderboardSnapshot } from "./public-leaderboard-publisher";
import { createMemoryPrisma } from "./leaderboard-telegram.test-harness";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const competitionA = "f9db36db-d526-47bb-8942-91e316e2cf19";
const encryptionKey = "k".repeat(64);
const channelId = "-1003981197633";
const playerId = "b1e1e379-82bf-494c-aa45-0de204e72209";

function makeChannel(existingMessageId = 42): FakeTelegramChatState {
  return {
    id: Number(channelId),
    type: "channel",
    title: "Test",
    members: new Map([[1, "administrator"]]),
    messages: [{ messageId: existingMessageId, text: "OLD ZERO BOARD", deleted: false }],
    nextMessageId: existingMessageId + 1
  };
}

function seedBoard(points: number, poolCents: number) {
  const prisma = createMemoryPrisma();
  const integrationId = crypto.randomUUID();
  prisma._state.integrations.push({
    id: integrationId,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    encryptedBotToken: encryptSecret("tok", encryptionKey),
    botUsername: "atlas_lb_bot",
    channelId,
    channelTitle: "Test",
    postingEnabled: true,
    lastChannelVerifiedAt: new Date(),
    persistentMessageId: "42",
    persistentMessageCompetitionId: competitionA,
    lastPublicTop10Json: [
      { crmContactId: playerId, rank: 1, displayName: "Picasso", totalPoints: 0 }
    ],
    disconnectedAt: null,
    lastError: null
  });
  prisma._state.competitions.push({
    id: competitionA,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    status: "ACTIVE",
    prizePoolCents: poolCents,
    endsAt: new Date(Date.now() + 86_400_000),
    startsAt: new Date(),
    sequence: 1
  });
  prisma._state.standings.push({
    competitionId: competitionA,
    ownerCoadminUserId: ownerA,
    crmContactId: playerId,
    totalPoints: points,
    pointsReachedAt: new Date(),
    crmContact: { displayName: "Picasso", chats: [] }
  });
  prisma._state.settings.push({ ownerCoadminUserId: ownerA, timezone: "America/Chicago" });
  return { prisma, integrationId };
}

describe("immediate live Telegram refresh after scoring", () => {
  it("mergeRefreshPayload marks dirty and preserves announcement preference", () => {
    const merged = mergeRefreshPayload(
      { competitionId: competitionA, skipRankAnnouncements: false },
      { competitionId: competitionA, skipRankAnnouncements: true, dirty: true }
    );
    expect(merged.dirty).toBe(true);
    expect(merged.skipRankAnnouncements).toBe(false);
    expect(isRefreshPayloadDirty(merged)).toBe(true);
  });

  it("$10 deposit standing is reflected via sendMessage replace (not edit)", async () => {
    const { prisma } = seedBoard(10, 20);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const editSpy = vi.spyOn(client, "editMessageText");
    const sendSpy = vi.spyOn(client, "sendMessage");
    const deleteSpy = vi.spyOn(client, "deleteMessage");
    const outbox = new LeaderboardTelegramOutboxService(prisma as never, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox,
      client
    });

    const outboxId = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    await processor.processJob(outboxId);

    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    expect(editSpy).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("tok", channelId, 42);
    const sentText = String(sendSpy.mock.calls[0]?.[2] ?? "");
    expect(sentText).toMatch(/Picasso/i);
    expect(sentText).toMatch(/\b10\b/);
    expect(prisma._state.integrations[0].persistentMessageId).toBe("43");
    expect(tgState.chats.get(Number(channelId))!.messages.find((m) => m.messageId === 42)?.deleted).toBe(
      true
    );
  });

  it("previous SUCCEEDED refresh is re-armed by a second deposit-style enqueue", async () => {
    const { prisma } = seedBoard(0, 0);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma as never, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox,
      client
    });

    const id1 = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    await processor.processJob(id1);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");

    prisma._state.standings[0].totalPoints = 10;
    prisma._state.competitions[0].prizePoolCents = 20;

    const id2 = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    expect(id2).toBe(id1);
    expect(prisma._state.outbox[0].status).toBe("QUEUED");
    await processor.processJob(id2);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    const live = tgState.chats
      .get(Number(channelId))!
      .messages.filter((m) => !m.deleted && m.text.includes("BIWEEKLY LEADERBOARD"));
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toMatch(/\b10\b/);
  });

  it("10 sequential deposits keep re-arming and converge to latest points", async () => {
    const { prisma } = seedBoard(0, 0);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma as never, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox,
      client
    });

    for (let i = 1; i <= 10; i += 1) {
      prisma._state.standings[0].totalPoints = i * 10;
      prisma._state.competitions[0].prizePoolCents = i * 20;
      const id = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
      await processor.processJob(id);
      expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    }

    const live = tgState.chats
      .get(Number(channelId))!
      .messages.filter((m) => !m.deleted && m.text.includes("BIWEEKLY LEADERBOARD"));
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toMatch(/\b100\b/);
  });

  it("mutation during DISPATCHING dirties payload and final snapshot is latest", async () => {
    const { prisma } = seedBoard(10, 20);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma as never, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox,
      client
    });

    const outboxId = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    const originalSend = client.sendMessage.bind(client);
    let dirtied = false;
    vi.spyOn(client, "sendMessage").mockImplementation(async (...args) => {
      if (!dirtied) {
        dirtied = true;
        prisma._state.standings[0].totalPoints = 30;
        prisma._state.competitions[0].prizePoolCents = 60;
        await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
        expect(prisma._state.outbox[0].status).toBe("DISPATCHING");
        expect(isRefreshPayloadDirty(prisma._state.outbox[0].payloadJson)).toBe(true);
      }
      return originalSend(...(args as [string, string, string]));
    });

    await processor.processJob(outboxId);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    expect(isRefreshPayloadDirty(prisma._state.outbox[0].payloadJson)).toBe(false);
    const live = tgState.chats
      .get(Number(channelId))!
      .messages.filter((m) => !m.deleted && m.text.includes("BIWEEKLY LEADERBOARD"));
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toMatch(/\b30\b/);
  });

  it("Telegram temporary failure leaves deposit-like standing intact and schedules retry", async () => {
    const { prisma } = seedBoard(10, 20);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]]),
      failures: new Map()
    };
    tgState.failures!.set(
      "tok:sendMessage",
      new LeaderboardTelegramApiError({
        httpStatus: 429,
        telegramErrorCode: 429,
        description: "Too Many Requests: retry after 1",
        permanent: false,
        retryAfterSeconds: 1
      })
    );
    const wakes: Array<{ id: string; delay: number }> = [];
    const outbox = new LeaderboardTelegramOutboxService(prisma as never, async (id, delay = 0) => {
      wakes.push({ id, delay });
    });
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox,
      client: createFakeLeaderboardTelegramClient(tgState)
    });

    const outboxId = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    await processor.processJob(outboxId);

    expect(prisma._state.standings[0].totalPoints).toBe(10);
    expect(prisma._state.outbox[0].status).toBe("RETRY_SCHEDULED");
    expect(prisma._state.integrations[0].persistentMessageId).toBe("42");
    expect(tgState.chats.get(Number(channelId))!.messages.find((m) => m.messageId === 42)?.deleted).not.toBe(
      true
    );
    expect(wakes.some((w) => w.id === outboxId && w.delay > 0)).toBe(true);

    tgState.failures!.clear();
    prisma._state.outbox[0].status = "QUEUED";
    prisma._state.outbox[0].nextAttemptAt = null;
    await processor.processJob(outboxId);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
  });

  it("stale DISPATCHING refresh is reopened so a later deposit can deliver", async () => {
    const { prisma } = seedBoard(10, 20);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma as never, async () => undefined);
    const processor = new LeaderboardTelegramProcessor({
      prisma: prisma as never,
      encryptionKey,
      outbox,
      client
    });

    const outboxId = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    prisma._state.outbox[0].status = "DISPATCHING";
    prisma._state.outbox[0].updatedAt = new Date(Date.now() - 60_000);

    const again = await outbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    expect(again).toBe(outboxId);
    expect(prisma._state.outbox[0].status).toBe("QUEUED");
    expect(isRefreshPayloadDirty(prisma._state.outbox[0].payloadJson)).toBe(true);

    await processor.processJob(outboxId);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    const live = tgState.chats
      .get(Number(channelId))!
      .messages.filter((m) => !m.deleted && m.text.includes("BIWEEKLY LEADERBOARD"));
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toMatch(/\b10\b/);
  });
});

describe("public leaderboard replace (send new + delete old)", () => {
  it("sendMessage fails → old message is NOT deleted", async () => {
    const { prisma, integrationId } = seedBoard(10, 20);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]]),
      failures: new Map([
        [
          "tok:sendMessage",
          new LeaderboardTelegramApiError({
            httpStatus: 400,
            telegramErrorCode: 400,
            description: "chat not found",
            permanent: true
          })
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    await expect(
      publishPublicLeaderboardSnapshot({
        prisma: prisma as never,
        client,
        token: "tok",
        workspaceId: workspaceA,
        ownerCoadminUserId: ownerA,
        competitionId: competitionA,
        integrationId,
        channelId,
        botUsername: "atlas_lb_bot",
        persistentMessageId: "42",
        persistentMessageCompetitionId: competitionA,
        lastPublicTop10Json: [],
        mode: "replace",
        skipRankAnnouncements: true
      })
    ).rejects.toBeTruthy();
    expect(prisma._state.integrations[0].persistentMessageId).toBe("42");
    expect(tgState.chats.get(Number(channelId))!.messages.find((m) => m.messageId === 42)?.deleted).not.toBe(
      true
    );
  });

  it("delete old fails → new message remains canonical", async () => {
    const { prisma, integrationId } = seedBoard(10, 20);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]]),
      failures: new Map()
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    tgState.failures!.set(
      "tok:deleteMessage",
      new LeaderboardTelegramApiError({
        httpStatus: 400,
        telegramErrorCode: 400,
        description: "message to delete not found",
        permanent: true
      })
    );
    const published = await publishPublicLeaderboardSnapshot({
      prisma: prisma as never,
      client,
      token: "tok",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId,
      channelId,
      botUsername: "atlas_lb_bot",
      persistentMessageId: "42",
      persistentMessageCompetitionId: competitionA,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true
    });
    expect(published.messageId).toBe("43");
    expect(prisma._state.integrations[0].persistentMessageId).toBe("43");
    expect(published.deletedPreviousMessageId).toBeNull();
  });

  it("concurrent publishes do not delete the newest canonical message", async () => {
    const { prisma, integrationId } = seedBoard(10, 20);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([[Number(channelId), makeChannel(42)]])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);

    const [a, b] = await Promise.all([
      publishPublicLeaderboardSnapshot({
        prisma: prisma as never,
        client,
        token: "tok",
        workspaceId: workspaceA,
        ownerCoadminUserId: ownerA,
        competitionId: competitionA,
        integrationId,
        channelId,
        botUsername: "atlas_lb_bot",
        persistentMessageId: "42",
        persistentMessageCompetitionId: competitionA,
        lastPublicTop10Json: [],
        mode: "replace",
        skipRankAnnouncements: true
      }),
      publishPublicLeaderboardSnapshot({
        prisma: prisma as never,
        client,
        token: "tok",
        workspaceId: workspaceA,
        ownerCoadminUserId: ownerA,
        competitionId: competitionA,
        integrationId,
        channelId,
        botUsername: "atlas_lb_bot",
        persistentMessageId: "42",
        persistentMessageCompetitionId: competitionA,
        lastPublicTop10Json: [],
        mode: "replace",
        skipRankAnnouncements: true
      })
    ]);

    const canonical = prisma._state.integrations[0].persistentMessageId;
    expect(canonical).toBeTruthy();
    expect([a.messageId, b.messageId]).toContain(canonical);
    const liveBoards = tgState.chats
      .get(Number(channelId))!
      .messages.filter((m) => !m.deleted && m.text.includes("BIWEEKLY LEADERBOARD"));
    // Winner remains; loser orphan deleted when possible → at most one live board.
    expect(liveBoards.length).toBeLessThanOrEqual(1);
    expect(liveBoards.some((m) => String(m.messageId) === canonical)).toBe(true);
    // Newest canonical must not be deleted.
    expect(tgState.chats.get(Number(channelId))!.messages.find((m) => String(m.messageId) === canonical)?.deleted).not.toBe(
      true
    );
  });

  it("channel switch cleared id → does not delete foreign-channel message id", async () => {
    const { prisma, integrationId } = seedBoard(10, 20);
    // Simulate setChannel: clear canonical pointer before posting to new channel.
    prisma._state.integrations[0].persistentMessageId = null;
    prisma._state.integrations[0].channelId = "-100999";
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["tok", { id: 1, isBot: true, firstName: "Bot", username: "atlas_lb_bot" }]]),
      chats: new Map([
        [
          -100999,
          {
            id: -100999,
            type: "channel",
            title: "Hub",
            members: new Map([[1, "administrator"]]),
            messages: [],
            nextMessageId: 1
          }
        ],
        [
          Number(channelId),
          {
            id: Number(channelId),
            type: "channel",
            title: "Old Test",
            members: new Map([[1, "administrator"]]),
            messages: [{ messageId: 42, text: "OLD ZERO BOARD", deleted: false }],
            nextMessageId: 43
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const deleteSpy = vi.spyOn(client, "deleteMessage");
    await publishPublicLeaderboardSnapshot({
      prisma: prisma as never,
      client,
      token: "tok",
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      integrationId,
      channelId: "-100999",
      botUsername: "atlas_lb_bot",
      persistentMessageId: null,
      persistentMessageCompetitionId: null,
      lastPublicTop10Json: [],
      mode: "replace",
      skipRankAnnouncements: true
    });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(tgState.chats.get(Number(channelId))!.messages.find((m) => m.messageId === 42)?.deleted).not.toBe(
      true
    );
    expect(prisma._state.integrations[0].persistentMessageId).toBe("1");
  });
});
