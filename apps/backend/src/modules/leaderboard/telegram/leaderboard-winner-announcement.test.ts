import { describe, expect, it } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
} from "./leaderboard-telegram.client";
import { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { createMemoryPrisma } from "./leaderboard-telegram.test-harness";
import { WinnerAnnouncementRecoveryService } from "./winner-announcement-recovery";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const competitionId = "f9db36db-d526-47bb-8942-91e316e2cf19";
const contactId = "b1e1e379-82bf-494c-aa45-0de204e72209";
const channelId = "-1003981197633";
const encryptionKey = "k".repeat(64);

function setup(postingEnabled = true) {
  const prisma = createMemoryPrisma();
  const integrationId = crypto.randomUUID();
  prisma._state.integrations.push({
    id: integrationId,
    workspaceId,
    ownerCoadminUserId: ownerId,
    encryptedBotToken: encryptSecret("token", encryptionKey),
    postingEnabled,
    channelId,
    disconnectedAt: null,
    lastError: null,
  });
  prisma._state.competitions.push({
    id: competitionId,
    workspaceId,
    ownerCoadminUserId: ownerId,
    status: "FINALIZED",
    prizePoolCents: 1000,
    startsAt: new Date(),
    endsAt: new Date(),
    finalizedAt: new Date(),
    snapshot: {
      winnersLockedAt: new Date(),
      winnersJson: [{ crmContactId: contactId }],
    },
  });
  prisma._state.contacts.push({
    id: contactId,
    workspaceId,
    displayName: "Winner",
    chats: [],
  });
  prisma._state.payouts.push({
    id: crypto.randomUUID(),
    workspaceId,
    ownerCoadminUserId: ownerId,
    competitionId,
    crmContactId: contactId,
    prizeRank: 1,
    leaderboardRank: 1,
    payoutCents: 1000,
    crmContact: prisma._state.contacts[0],
  });
  prisma._state.candidates.push({
    competitionId,
    ownerCoadminUserId: ownerId,
    crmContactId: contactId,
    leaderboardRank: 1,
    membershipStatus: "ELIGIBLE",
  });
  const wakes: string[] = [];
  const outbox = new LeaderboardTelegramOutboxService(prisma, async (id) => {
    wakes.push(id);
  });
  return { prisma, outbox, wakes, integrationId };
}

describe("public winner announcement", () => {
  it("durably creates one results job and one final-board job under repeated projection", async () => {
    const { prisma, outbox } = setup();
    const input = { workspaceId, ownerCoadminUserId: ownerId, competitionId };
    await outbox.enqueueFinalizationJobsTx(prisma, input);
    await outbox.enqueueFinalizationJobsTx(prisma, input);
    expect(prisma._state.outbox).toHaveLength(2);
    expect(prisma._state.outbox.map((row: any) => row.jobType).sort()).toEqual([
      "POST_PUBLIC_RESULTS",
      "PUBLISH_FINAL_LEADERBOARD",
    ]);
  });

  it("persists Telegram message ID before marking the outbox successful", async () => {
    const { prisma, outbox } = setup();
    const id = await outbox.enqueuePostResults(
      workspaceId,
      ownerId,
      competitionId,
    );
    const telegram = createFakeLeaderboardTelegramClient({
      bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot" }]]),
      chats: new Map([
        [
          Number(channelId),
          {
            id: Number(channelId),
            type: "channel",
            messages: [],
            members: new Map(),
            nextMessageId: 10,
          },
        ],
      ]),
    });
    await new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client: telegram,
    }).processJob(id);
    expect(
      prisma._state.outbox[0].status,
      JSON.stringify(prisma._state.outbox[0]),
    ).toBe("SUCCEEDED");
    expect(prisma._state.artifacts[0]).toMatchObject({
      artifactType: "PUBLIC_RESULTS",
      status: "SENT",
      messageId: "10",
    });
  });

  it("records posting disabled as a failure and sends nothing", async () => {
    const { prisma, outbox } = setup(false);
    const id = await outbox.enqueuePostResults(
      workspaceId,
      ownerId,
      competitionId,
    );
    const chat = {
      id: Number(channelId),
      type: "channel",
      messages: [],
      members: new Map(),
      nextMessageId: 10,
    };
    const telegram = createFakeLeaderboardTelegramClient({
      bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot" }]]),
      chats: new Map([[Number(channelId), chat]]),
    });
    await new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client: telegram,
    }).processJob(id);
    expect(prisma._state.outbox[0]).toMatchObject({
      status: "FAILED",
      lastErrorCode: "POSTING_DISABLED",
    });
    expect(chat.messages).toHaveLength(0);
  });

  it("retries a definite Telegram rejection without leaving an ambiguous reservation", async () => {
    const { prisma, outbox } = setup();
    const id = await outbox.enqueuePostResults(
      workspaceId,
      ownerId,
      competitionId,
    );
    const failures = new Map([
      [
        "token:sendMessage",
        new LeaderboardTelegramApiError({
          httpStatus: 429,
          telegramErrorCode: 429,
          description: "Too Many Requests",
          retryAfterSeconds: 1,
          permanent: false,
        }),
      ],
    ]);
    const chat = {
      id: Number(channelId),
      type: "channel",
      messages: [],
      members: new Map(),
      nextMessageId: 10,
    };
    const telegram = createFakeLeaderboardTelegramClient({
      bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot" }]]),
      chats: new Map([[Number(channelId), chat]]),
      failures,
    });
    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client: telegram,
    });
    await processor.processJob(id);
    expect(prisma._state.outbox[0].status).toBe("RETRY_SCHEDULED");
    expect(prisma._state.artifacts).toHaveLength(0);
    failures.clear();
    await processor.processJob(id);
    expect(prisma._state.outbox[0].status).toBe("SUCCEEDED");
    expect(prisma._state.artifacts[0].messageId).toBe("10");
  });
});

describe("winner announcement recovery", () => {
  it("dry-run identifies a missing announcement without enqueueing or waking", async () => {
    const { prisma, outbox, wakes } = setup();
    const report = await new WinnerAnnouncementRecoveryService(
      prisma,
      outbox,
    ).inspect({ now: new Date() });
    expect(report[0]).toMatchObject({
      classification: "MISSING",
      proposedAction: "CREATE_ANNOUNCEMENT_JOB",
    });
    expect(prisma._state.outbox).toHaveLength(0);
    expect(wakes).toHaveLength(0);
  });

  it("skips a delivered winners picture as an equivalent public announcement", async () => {
    const { prisma, outbox } = setup();
    prisma._state.artifacts.push({
      id: crypto.randomUUID(),
      competitionId,
      artifactType: "WINNERS_PICTURE",
      status: "SENT",
      messageId: "99",
      chatId: channelId,
    });
    const report = await new WinnerAnnouncementRecoveryService(
      prisma,
      outbox,
    ).inspect({ now: new Date() });
    expect(report[0]).toMatchObject({
      classification: "ALREADY_ANNOUNCED",
      proposedAction: "SKIP",
    });
  });

  it("reuses and wakes an existing pending deterministic job", async () => {
    const { prisma, outbox, wakes } = setup();
    const id = await outbox.enqueuePostResults(
      workspaceId,
      ownerId,
      competitionId,
    );
    wakes.length = 0;
    const report = await new WinnerAnnouncementRecoveryService(
      prisma,
      outbox,
    ).inspect({ execute: true, now: new Date() });
    expect(report[0]).toMatchObject({
      classification: "PENDING",
      proposedAction: "WAKE_EXISTING_JOB",
    });
    expect(prisma._state.outbox).toHaveLength(1);
    expect(wakes).toEqual([id]);
  });

  it("blocks ambiguous reserved delivery and never wakes it", async () => {
    const { prisma, outbox, wakes } = setup();
    prisma._state.artifacts.push({
      id: crypto.randomUUID(),
      competitionId,
      artifactType: "PUBLIC_RESULTS",
      status: "RESERVED",
      messageId: null,
      chatId: channelId,
    });
    const report = await new WinnerAnnouncementRecoveryService(
      prisma,
      outbox,
    ).inspect({ execute: true, now: new Date() });
    expect(report[0]).toMatchObject({
      classification: "NEEDS_MANUAL_REVIEW",
      duplicateRisk: "HIGH",
    });
    expect(wakes).toHaveLength(0);
  });
});
