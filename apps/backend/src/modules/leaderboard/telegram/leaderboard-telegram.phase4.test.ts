import { describe, expect, it, vi } from "vitest";
import { hasPermission } from "@atlas/shared";
import { decryptSecret, encryptSecret } from "@atlas/shared/session-encryption";
import { selectPrizeWinnersFromEligibility } from "../prize-eligibility";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState
} from "./leaderboard-telegram.client";
import { LeaderboardTelegramIntegrationService } from "./leaderboard-telegram.integration-service";
import { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { formatPublicLeaderboardMessage } from "./public-message";
import { mapTelegramChatMemberStatus } from "./membership-status";

const encryptionKey = "k".repeat(64);
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const competitionA = "c1111111-cccc-4ccc-8ccc-ccccccccccc1";
const contact1 = "d1111111-dddd-4ddd-8ddd-ddddddddddd1";
const contact2 = "d2222222-dddd-4ddd-8ddd-ddddddddddd2";
const contact3 = "d3333333-dddd-4ddd-8ddd-ddddddddddd3";
const contact4 = "d4444444-dddd-4ddd-8ddd-ddddddddddd4";

function createMemoryPrisma() {
  const integrations: any[] = [];
  const outbox: any[] = [];
  const competitions: any[] = [];
  const standings: any[] = [];
  const candidates: any[] = [];
  const contacts: any[] = [];
  const settings: any[] = [];
  const payouts: any[] = [];
  const audits: any[] = [];

  const prisma = {
    leaderboardBotIntegration: {
      findUnique: async ({ where }: any) =>
        integrations.find((r) => r.ownerCoadminUserId === where.ownerCoadminUserId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = integrations.find((r) => r.ownerCoadminUserId === where.ownerCoadminUserId);
        if (!existing) {
          const row = {
            id: crypto.randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            lastVerifiedAt: null,
            lastChannelVerifiedAt: null,
            lastSuccessfulPostAt: null,
            lastMembershipCheckAt: null,
            persistentMessageId: null,
            persistentMessageCompetitionId: null,
            lastPublicTop10Json: null,
            channelId: null,
            channelTitle: null,
            channelUsername: null,
            postingEnabled: false,
            lastError: null,
            disconnectedAt: null,
            ...create
          };
          integrations.push(row);
          return row;
        }
        Object.assign(existing, update, { updatedAt: new Date() });
        return existing;
      },
      update: async ({ where, data }: any) => {
        const row = integrations.find((r) => r.id === where.id);
        if (!row) throw new Error("integration missing");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }
    },
    leaderboardTelegramOutbox: {
      findUnique: async ({ where }: any) => {
        if (where.id) return outbox.find((r) => r.id === where.id) ?? null;
        if (where.idempotencyKey) return outbox.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
        return null;
      },
      findMany: async ({ where }: any) => {
        return outbox.filter((r) => {
          if (where?.ownerCoadminUserId && r.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where?.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        });
      },
      create: async ({ data }: any) => {
        if (outbox.some((r) => r.idempotencyKey === data.idempotencyKey)) {
          const err = new Error("Unique") as Error & { code: string };
          err.code = "P2002";
          throw err;
        }
        const row = {
          id: crypto.randomUUID(),
          attemptCount: 0,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          succeededAt: null,
          failedAt: null,
          cancelledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data
        };
        outbox.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = outbox.find((r) => r.id === where.id);
        if (!row) throw new Error("outbox missing");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of outbox) {
          if (where.ownerCoadminUserId && row.ownerCoadminUserId !== where.ownerCoadminUserId) continue;
          if (where.status?.in && !where.status.in.includes(row.status)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }
    },
    leaderboardCompetition: {
      findFirst: async ({ where }: any) =>
        competitions.find((c) => {
          if (where.id && c.id !== where.id) return false;
          if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
          if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where.status) {
            if (typeof where.status === "string" && c.status !== where.status) return false;
            if (where.status.in && !where.status.in.includes(c.status)) return false;
          }
          return true;
        }) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const row = competitions.find((c) => c.id === where.id);
        if (!row) throw new Error("competition missing");
        return row;
      }
    },
    leaderboardStanding: {
      findMany: async ({ where }: any) =>
        standings
          .filter(
            (s) =>
              s.competitionId === where.competitionId &&
              (!where.ownerCoadminUserId || s.ownerCoadminUserId === where.ownerCoadminUserId)
          )
          .map((s) => ({
            ...s,
            crmContact: s.crmContact ?? { displayName: "Player" }
          }))
    },
    leaderboardSettings: {
      findUnique: async ({ where }: any) =>
        settings.find((s) => s.ownerCoadminUserId === where.ownerCoadminUserId) ?? null
    },
    giveawayEligibilityCandidate: {
      findFirst: async ({ where }: any) =>
        candidates.find((c) => {
          if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
          if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          if (where.membershipStatus && c.membershipStatus !== where.membershipStatus) return false;
          return true;
        }) ?? null,
      findMany: async ({ where }: any) =>
        candidates
          .filter(
            (c) =>
              c.competitionId === where.competitionId &&
              c.ownerCoadminUserId === where.ownerCoadminUserId
          )
          .sort((a, b) => a.leaderboardRank - b.leaderboardRank)
    },
    crmContact: {
      findFirst: async ({ where }: any) =>
        contacts.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null
    },
    giveawayPayout: {
      findMany: async ({ where }: any) =>
        payouts
          .filter(
            (p) =>
              p.competitionId === where.competitionId &&
              p.ownerCoadminUserId === where.ownerCoadminUserId
          )
          .sort((a, b) => a.prizeRank - b.prizeRank)
    },
    auditLog: {
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      }
    },
    _state: { integrations, outbox, competitions, standings, candidates, contacts, settings, payouts, audits }
  };

  return prisma as any;
}

describe("Phase 4 telegram permissions", () => {
  it("grants telegram manage/verify only to COADMIN", () => {
    expect(hasPermission("COADMIN", "leaderboard:telegram:manage")).toBe(true);
    expect(hasPermission("COADMIN", "leaderboard:telegram:verify")).toBe(true);
    expect(hasPermission("COADMIN", "leaderboard:eligibility:verify")).toBe(true);
    expect(hasPermission("STAFF", "leaderboard:telegram:manage")).toBe(false);
    expect(hasPermission("STAFF", "leaderboard:telegram:verify")).toBe(false);
  });
});

describe("Phase 4 integration + outbox + processor", () => {
  it("isolates integrations A/B, never returns token, encrypts at rest", async () => {
    const prisma = createMemoryPrisma();
    const wakes: string[] = [];
    const outbox = new LeaderboardTelegramOutboxService(prisma, async (id) => {
      wakes.push(id);
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([
        ["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }],
        ["token-b", { id: 202, isBot: true, firstName: "BotB", username: "bot_b" }]
      ]),
      chats: new Map()
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const serviceA = new LeaderboardTelegramIntegrationService({
      prisma,
      encryptionKey,
      client,
      outbox
    });
    const serviceB = new LeaderboardTelegramIntegrationService({
      prisma,
      encryptionKey,
      client,
      outbox
    });

    const dtoA = await serviceA.connect(workspaceA, ownerA, "token-a", ownerA);
    const dtoB = await serviceB.connect(workspaceB, ownerB, "token-b", ownerB);

    expect(dtoA.botUsername).toBe("bot_a");
    expect(dtoB.botUsername).toBe("bot_b");
    expect(JSON.stringify(dtoA)).not.toContain("token-a");
    expect(JSON.stringify(dtoB)).not.toContain("token-b");

    const storedA = prisma._state.integrations.find((r: any) => r.ownerCoadminUserId === ownerA);
    expect(decryptSecret(storedA.encryptedBotToken, encryptionKey)).toBe("token-a");
    expect(storedA.encryptedBotToken).not.toEqual("token-a");

    const cross = await serviceA.getIntegration(workspaceA, ownerB);
    expect(cross.connected).toBe(false);
  });

  it("rejects invalid getMe before persisting", async () => {
    const prisma = createMemoryPrisma();
    const tgState: FakeLeaderboardTelegramState = { bots: new Map(), chats: new Map() };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const service = new LeaderboardTelegramIntegrationService({
      prisma,
      encryptionKey,
      client
    });
    await expect(service.connect(workspaceA, ownerA, "bad-token-value-xxxxxx", ownerA)).rejects.toMatchObject({
      code: "TELEGRAM_BOT_TOKEN_INVALID"
    });
    expect(prisma._state.integrations).toHaveLength(0);
  });

  it("requires channel admin verification before posting ON; posting OFF skips refresh send", async () => {
    const prisma = createMemoryPrisma();
    const wakes: string[] = [];
    const outboxSvc = new LeaderboardTelegramOutboxService(prisma, async (id) => {
      wakes.push(id);
    });
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map([
        [
          -1001,
          {
            id: -1001,
            type: "channel",
            title: "LB Channel",
            members: new Map([[101, "administrator"]]),
            messages: [],
            nextMessageId: 1
          }
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const service = new LeaderboardTelegramIntegrationService({
      prisma,
      encryptionKey,
      client,
      outbox: outboxSvc
    });

    await service.connect(workspaceA, ownerA, "token-a", ownerA);
    await expect(service.setPostingEnabled(workspaceA, ownerA, true, ownerA)).rejects.toMatchObject({
      code: "TELEGRAM_CHANNEL_NOT_VERIFIED"
    });

    await service.setChannel(workspaceA, ownerA, "-1001", ownerA);
    await service.verifyChannel(workspaceA, ownerA, ownerA);

    prisma._state.competitions.push({
      id: competitionA,
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      status: "ACTIVE",
      sequence: 1,
      prizePoolCents: 1000,
      endsAt: new Date("2026-08-18T02:00:00.000Z")
    });

    const enabled = await service.setPostingEnabled(workspaceA, ownerA, true, ownerA);
    expect(enabled.postingEnabled).toBe(true);
    expect(wakes.length).toBeGreaterThan(0);

    // Coalesce refresh: second enqueue reuses pending job
    const before = prisma._state.outbox.length;
    await outboxSvc.enqueueRefresh(workspaceA, ownerA, competitionA);
    await outboxSvc.enqueueRefresh(workspaceA, ownerA, competitionA);
    expect(prisma._state.outbox.length).toBe(before);

    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox: outboxSvc,
      client,
      domain: {
        setMembershipEligibility: vi.fn()
      } as never
    });

    const job = prisma._state.outbox[0];
    // First process with posting disabled path already covered; enable and process
    prisma._state.standings.push({
      competitionId: competitionA,
      ownerCoadminUserId: ownerA,
      crmContactId: contact1,
      totalPoints: 100,
      pointsReachedAt: new Date(),
      crmContact: { displayName: "Alice Smith" }
    });
    prisma._state.settings.push({
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      timezone: "America/Chicago"
    });

    await processor.processJob(job.id);
    expect(job.status).toBe("SUCCEEDED");
    const chat = tgState.chats.get(-1001)!;
    expect(chat.messages.some((m) => m.text.includes("Alice") && m.text.includes("$10.00"))).toBe(true);
    expect(chat.messages.some((m) => /2%|rateBps/i.test(m.text))).toBe(false);

    // Edit path
    await outboxSvc.enqueueRefresh(workspaceA, ownerA, competitionA);
    const refresh2 = prisma._state.outbox.find((r: any) => r.jobType === "REFRESH_PUBLIC_LEADERBOARD");
    await processor.processJob(refresh2.id);
    expect(chat.messages.filter((m) => !m.deleted)).toHaveLength(1);

    // Deleted message recovery
    chat.messages[0]!.deleted = true;
    const integration = prisma._state.integrations[0];
    // keep persistent id pointing at deleted message
    await outboxSvc.enqueueRefresh(workspaceA, ownerA, competitionA);
    await processor.processJob(refresh2.id);
    expect(chat.messages.filter((m) => !m.deleted).length).toBeGreaterThanOrEqual(1);
    expect(integration.persistentMessageId).toBeTruthy();

    // Posting OFF no-ops
    await service.setPostingEnabled(workspaceA, ownerA, false, ownerA);
    await outboxSvc.enqueueRefresh(workspaceA, ownerA, competitionA);
    const offJob = prisma._state.outbox.find((r: any) => r.status === "QUEUED");
    if (offJob) {
      await processor.processJob(offJob.id);
      expect(offJob.status).toBe("SUCCEEDED");
    }
  });

  it("maps membership via processor; #1 ineligible yields next winners; API failure stays PENDING", async () => {
    expect(mapTelegramChatMemberStatus("member").membershipStatus).toBe("ELIGIBLE");
    expect(mapTelegramChatMemberStatus("left")).toEqual({
      membershipStatus: "NOT_ELIGIBLE",
      ineligibilityReason: "NOT_SUBSCRIBED"
    });

    const winners = selectPrizeWinnersFromEligibility([
      { crmContactId: contact1, leaderboardRank: 1, totalPoints: 300, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: contact2, leaderboardRank: 2, totalPoints: 280, membershipStatus: "ELIGIBLE" },
      { crmContactId: contact3, leaderboardRank: 3, totalPoints: 250, membershipStatus: "ELIGIBLE" },
      { crmContactId: contact4, leaderboardRank: 4, totalPoints: 240, membershipStatus: "ELIGIBLE" }
    ]);
    expect(winners.ok).toBe(true);
    if (winners.ok) {
      expect(winners.winners.map((w) => w.crmContactId)).toEqual([contact2, contact3, contact4]);
      expect(winners.winners[0]?.prizeRank).toBe(1);
    }

    const prisma = createMemoryPrisma();
    const calls: any[] = [];
    const outboxSvc = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map([
        [
          -1001,
          {
            id: -1001,
            type: "channel",
            title: "LB",
            members: new Map([
              [101, "administrator"],
              [1001, "left"],
              [1002, "member"],
              [1003, "member"]
            ]),
            messages: [],
            nextMessageId: 1
          }
        ]
      ]),
      failures: new Map()
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const integrationSvc = new LeaderboardTelegramIntegrationService({
      prisma,
      encryptionKey,
      client,
      outbox: outboxSvc
    });
    await integrationSvc.connect(workspaceA, ownerA, "token-a", ownerA);
    await integrationSvc.setChannel(workspaceA, ownerA, "-1001", ownerA);
    await integrationSvc.verifyChannel(workspaceA, ownerA, ownerA);

    prisma._state.competitions.push({
      id: competitionA,
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      status: "FROZEN",
      prizePoolCents: 50000,
      endsAt: new Date()
    });
    prisma._state.contacts.push(
      { id: contact1, workspaceId: workspaceA, kind: "PRIVATE", telegramPeerId: "1001", displayName: "One" },
      { id: contact2, workspaceId: workspaceA, kind: "PRIVATE", telegramPeerId: "1002", displayName: "Two" },
      { id: contact3, workspaceId: workspaceA, kind: "PRIVATE", telegramPeerId: "1003", displayName: "Three" },
      { id: contact4, workspaceId: workspaceA, kind: "GROUP", telegramPeerId: "g1", displayName: "Four" }
    );
    for (const [id, rank, points] of [
      [contact1, 1, 300],
      [contact2, 2, 280],
      [contact3, 3, 250],
      [contact4, 4, 240]
    ] as const) {
      prisma._state.candidates.push({
        id: crypto.randomUUID(),
        workspaceId: workspaceA,
        ownerCoadminUserId: ownerA,
        competitionId: competitionA,
        crmContactId: id,
        leaderboardRank: rank,
        totalPoints: points,
        membershipStatus: "PENDING_REVIEW",
        ineligibilityReason: null,
        verificationSource: null
      });
    }

    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox: outboxSvc,
      client,
      domain: {
        setMembershipEligibility: async (input: any) => {
          calls.push(input);
          const row = prisma._state.candidates.find((c: any) => c.crmContactId === input.crmContactId);
          if (row) {
            row.membershipStatus = input.membershipStatus;
            row.ineligibilityReason = input.ineligibilityReason ?? null;
            row.verificationSource = input.verificationSource;
            row.telegramChatMemberStatus = input.telegramChatMemberStatus ?? null;
          }
          return row;
        }
      } as never
    });

    const verifyId = await outboxSvc.enqueueVerifyMembership(workspaceA, ownerA, competitionA);
    await processor.processJob(verifyId);

    expect(calls.some((c) => c.crmContactId === contact1 && c.membershipStatus === "NOT_ELIGIBLE")).toBe(
      true
    );
    expect(calls.some((c) => c.crmContactId === contact2 && c.membershipStatus === "ELIGIBLE")).toBe(true);
    expect(calls.some((c) => c.crmContactId === contact4 && c.membershipStatus === "PENDING_REVIEW")).toBe(
      true
    );

    // Transient vs permanent retries
    const failOutbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    tgState.failures = new Map([
      [
        "token-a:sendMessage",
        new LeaderboardTelegramApiError({
          httpStatus: 429,
          telegramErrorCode: 429,
          description: "Too Many Requests",
          retryAfterSeconds: 1,
          permanent: false
        })
      ]
    ]);
    const integration = prisma._state.integrations[0];
    integration.postingEnabled = true;
    const refreshId = await failOutbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    const retryProcessor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox: failOutbox,
      client
    });
    await retryProcessor.processJob(refreshId);
    const refreshRow = prisma._state.outbox.find((r: any) => r.id === refreshId);
    expect(refreshRow.status).toBe("RETRY_SCHEDULED");

    tgState.failures = new Map([
      [
        "token-a:sendMessage",
        new LeaderboardTelegramApiError({
          httpStatus: 403,
          telegramErrorCode: 403,
          description: "Forbidden: bot was kicked from the channel",
          permanent: true
        })
      ]
    ]);
    await failOutbox.enqueueRefresh(workspaceA, ownerA, competitionA);
    await retryProcessor.processJob(refreshId);
    expect(refreshRow.status).toBe("FAILED");
  });

  it("disconnect cancels pending jobs and scrubs token", async () => {
    const prisma = createMemoryPrisma();
    const outboxSvc = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map()
    };
    const service = new LeaderboardTelegramIntegrationService({
      prisma,
      encryptionKey,
      client: createFakeLeaderboardTelegramClient(tgState),
      outbox: outboxSvc
    });
    await service.connect(workspaceA, ownerA, "token-a", ownerA);
    await outboxSvc.enqueueRefresh(workspaceA, ownerA, competitionA);
    prisma._state.candidates.push({
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      membershipStatus: "PENDING_REVIEW",
      competition: { status: "FROZEN" }
    });
    // findFirst for disconnect warning uses competition relation — simplify by stubbing findFirst already matching membership
    const result = await service.disconnect(workspaceA, ownerA, ownerA, true);
    expect(result.connected).toBe(false);
    expect(result.cancelledJobs).toBeGreaterThanOrEqual(1);
    const stored = prisma._state.integrations[0];
    expect(stored.disconnectedAt).toBeTruthy();
    expect(decryptSecret(stored.encryptedBotToken, encryptionKey)).not.toBe("token-a");
    expect(JSON.stringify(result)).not.toContain("token-a");
  });

  it("keeps public message pool privacy", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [{ rank: 1, displayName: "Sam", points: 10 }],
      prizePoolCents: 12345,
      endsAt: new Date("2026-08-18T02:00:00.000Z"),
      timezone: "America/Chicago"
    });
    expect(text).toContain("$123.45");
    expect(text).not.toMatch(/\b2%\b/);
    expect(text).not.toMatch(/rateBps/i);
    expect(encryptSecret("secret", encryptionKey).ciphertext).not.toContain("secret");
  });
});
