import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@atlas/shared/session-encryption";
import {
  createFakeLeaderboardTelegramClient,
  LeaderboardTelegramApiError,
  type FakeLeaderboardTelegramState,
  type FakeTelegramChatState
} from "./leaderboard-telegram.client";
import { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { createMemoryPrisma } from "./leaderboard-telegram.test-harness";

/**
 * Requirement 7 coverage: once Telegram membership verification resolves enough
 * candidates to determine the prize Top 3, VERIFY_MEMBERSHIP must resume
 * finalization on its own (via domain.attemptAutoFinalize), instead of waiting
 * for the next periodic FROZEN re-scan. Also covers requirement 6: a technical
 * Telegram failure must never auto-disqualify a candidate — it stays
 * PENDING_REVIEW and finalization must not proceed while it's in the Top 3.
 */

const workspaceA = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const competitionA = "c1111111-cccc-4ccc-8ccc-ccccccccccc1";
const contact1 = "d1111111-dddd-4ddd-8ddd-ddddddddddd1";
const contact2 = "d2222222-dddd-4ddd-8ddd-ddddddddddd2";
const contact3 = "d3333333-dddd-4ddd-8ddd-ddddddddddd3";
const contact4 = "d4444444-dddd-4ddd-8ddd-ddddddddddd4";
const encryptionKey = "k".repeat(64);
const channelId = "-1001";

function seedIntegrationAndCompetition(prisma: ReturnType<typeof createMemoryPrisma>) {
  const integrationId = crypto.randomUUID();
  prisma._state.integrations.push({
    id: integrationId,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    encryptedBotToken: encryptSecret("token-a", encryptionKey),
    botUsername: "atlas_lb_bot",
    channelId,
    channelTitle: "LB",
    postingEnabled: false,
    disconnectedAt: null,
    lastError: null,
    lastMembershipCheckAt: null
  });
  prisma._state.competitions.push({
    id: competitionA,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    status: "FROZEN",
    prizePoolCents: 50_000,
    endsAt: new Date()
  });
  return integrationId;
}

function seedCandidates(prisma: ReturnType<typeof createMemoryPrisma>) {
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
}

function attachRealisticSetMembershipEligibility(prisma: ReturnType<typeof createMemoryPrisma>) {
  return async (input: any) => {
    const row = prisma._state.candidates.find((c: any) => c.crmContactId === input.crmContactId);
    if (row) {
      row.membershipStatus = input.membershipStatus;
      row.ineligibilityReason = input.ineligibilityReason ?? null;
      row.verificationSource = input.verificationSource;
      row.telegramChatMemberStatus = input.telegramChatMemberStatus ?? null;
      row.verificationErrorCode = input.verificationErrorCode ?? null;
    }
    return row;
  };
}

describe("VERIFY_MEMBERSHIP resumes automatic finalization", () => {
  it("resolves Top 3 (rank 4 stays technically PENDING_REVIEW via missing Telegram id) and calls attemptAutoFinalize once", async () => {
    const prisma = createMemoryPrisma();
    seedIntegrationAndCompetition(prisma);
    seedCandidates(prisma);

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
              [1001, "member"],
              [1002, "member"],
              [1003, "member"]
            ]),
            messages: [],
            nextMessageId: 1
          } satisfies FakeTelegramChatState
        ]
      ]),
      failures: new Map()
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);

    const attemptAutoFinalize = vi.fn(async () => ({ competition: { id: competitionA }, finalized: true }));
    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client,
      domain: {
        setMembershipEligibility: attachRealisticSetMembershipEligibility(prisma),
        attemptAutoFinalize
      } as never
    });

    const verifyId = await outbox.enqueueVerifyMembership(workspaceA, ownerA, competitionA);
    await processor.processJob(verifyId);

    const byContact = (id: string) => prisma._state.candidates.find((c: any) => c.crmContactId === id);
    expect(byContact(contact1)?.membershipStatus).toBe("ELIGIBLE");
    expect(byContact(contact2)?.membershipStatus).toBe("ELIGIBLE");
    expect(byContact(contact3)?.membershipStatus).toBe("ELIGIBLE");
    // Ranks 1-3 fill all 3 prize slots, so rank 4 (a GROUP contact — never a real
    // Telegram user) is never even inspected and stays PENDING_REVIEW forever.
    // That must not block resolution: only a PENDING_REVIEW candidate ahead of an
    // unfilled prize slot blocks selection.
    expect(byContact(contact4)?.membershipStatus).toBe("PENDING_REVIEW");

    expect(attemptAutoFinalize).toHaveBeenCalledTimes(1);
    expect(attemptAutoFinalize).toHaveBeenCalledWith(workspaceA, ownerA, competitionA, expect.any(Date));
  });

  it("does not call attemptAutoFinalize while a Top-3 candidate is still unresolved", async () => {
    const prisma = createMemoryPrisma();
    seedIntegrationAndCompetition(prisma);
    // Only rank 1 seeded, and it stays PENDING_REVIEW (GROUP contact, no numeric id).
    prisma._state.contacts.push({ id: contact1, workspaceId: workspaceA, kind: "GROUP", telegramPeerId: "g1" });
    prisma._state.candidates.push({
      id: crypto.randomUUID(),
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      crmContactId: contact1,
      leaderboardRank: 1,
      totalPoints: 300,
      membershipStatus: "PENDING_REVIEW",
      ineligibilityReason: null,
      verificationSource: null
    });

    const client = createFakeLeaderboardTelegramClient({
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map(),
      failures: new Map()
    });
    const outbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const attemptAutoFinalize = vi.fn();
    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client,
      domain: {
        setMembershipEligibility: attachRealisticSetMembershipEligibility(prisma),
        attemptAutoFinalize
      } as never
    });

    const verifyId = await outbox.enqueueVerifyMembership(workspaceA, ownerA, competitionA);
    await processor.processJob(verifyId);

    const candidate = prisma._state.candidates.find((c: any) => c.crmContactId === contact1);
    expect(candidate.membershipStatus).toBe("PENDING_REVIEW");
    expect(attemptAutoFinalize).not.toHaveBeenCalled();
  });
});

describe("Technical Telegram failures never auto-disqualify", () => {
  it("a getChatMember API error keeps the candidate PENDING_REVIEW (never NOT_ELIGIBLE) and blocks finalization", async () => {
    const prisma = createMemoryPrisma();
    seedIntegrationAndCompetition(prisma);
    prisma._state.contacts.push({ id: contact1, workspaceId: workspaceA, kind: "PRIVATE", telegramPeerId: "1001" });
    prisma._state.candidates.push({
      id: crypto.randomUUID(),
      workspaceId: workspaceA,
      ownerCoadminUserId: ownerA,
      competitionId: competitionA,
      crmContactId: contact1,
      leaderboardRank: 1,
      totalPoints: 300,
      membershipStatus: "PENDING_REVIEW",
      ineligibilityReason: null,
      verificationSource: null
    });

    const tgState: FakeLeaderboardTelegramState = {
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map([
        [
          -1001,
          {
            id: -1001,
            type: "channel",
            title: "LB",
            members: new Map([[101, "administrator"]]),
            messages: [],
            nextMessageId: 1
          } satisfies FakeTelegramChatState
        ]
      ]),
      failures: new Map([
        [
          "token-a:getChatMember",
          new LeaderboardTelegramApiError({
            httpStatus: 500,
            telegramErrorCode: 500,
            description: "Internal Server Error",
            permanent: false
          })
        ]
      ])
    };
    const client = createFakeLeaderboardTelegramClient(tgState);
    const outbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const attemptAutoFinalize = vi.fn();
    const setMembershipEligibility = vi.fn(attachRealisticSetMembershipEligibility(prisma));
    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client,
      domain: { setMembershipEligibility, attemptAutoFinalize } as never
    });

    const verifyId = await outbox.enqueueVerifyMembership(workspaceA, ownerA, competitionA);
    await processor.processJob(verifyId);

    expect(setMembershipEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ crmContactId: contact1, membershipStatus: "PENDING_REVIEW" })
    );
    const candidate = prisma._state.candidates.find((c: any) => c.crmContactId === contact1);
    expect(candidate.membershipStatus).toBe("PENDING_REVIEW");
    expect(candidate.membershipStatus).not.toBe("NOT_ELIGIBLE");
    expect(attemptAutoFinalize).not.toHaveBeenCalled();
  });
});

describe("Telegram plugin onFrozen wiring (mirrors leaderboard-telegram.plugin.ts)", () => {
  it("enqueues REFRESH_PUBLIC_LEADERBOARD and VERIFY_MEMBERSHIP for a newly frozen competition", async () => {
    const prisma = createMemoryPrisma();
    seedIntegrationAndCompetition(prisma);
    prisma._state.integrations[0].postingEnabled = false; // avoid requiring a full refresh setup

    const outbox = new LeaderboardTelegramOutboxService(prisma, async () => undefined);
    const client = createFakeLeaderboardTelegramClient({
      bots: new Map([["token-a", { id: 101, isBot: true, firstName: "BotA", username: "bot_a" }]]),
      chats: new Map(),
      failures: new Map()
    });
    const processor = new LeaderboardTelegramProcessor({
      prisma,
      encryptionKey,
      outbox,
      client,
      domain: { setMembershipEligibility: vi.fn(), attemptAutoFinalize: vi.fn() } as never
    });

    // Same body as leaderboardTelegramPlugin's projectionHooks.onFrozen.
    const onFrozen = async (info: { workspaceId: string; ownerCoadminUserId: string; competitionId: string }) => {
      const refreshId = await outbox.enqueueRefresh(info.workspaceId, info.ownerCoadminUserId, info.competitionId);
      await processor.processJob(refreshId);
      const verifyId = await outbox.enqueueVerifyMembership(info.workspaceId, info.ownerCoadminUserId, info.competitionId);
      await processor.processJob(verifyId);
    };

    await onFrozen({ workspaceId: workspaceA, ownerCoadminUserId: ownerA, competitionId: competitionA });

    const refreshRow = prisma._state.outbox.find(
      (r: any) => r.jobType === "REFRESH_PUBLIC_LEADERBOARD" && r.idempotencyKey === `lb:refresh:${ownerA}:${competitionA}`
    );
    const verifyRow = prisma._state.outbox.find(
      (r: any) => r.jobType === "VERIFY_MEMBERSHIP" && r.idempotencyKey === `lb:verify:${ownerA}:${competitionA}`
    );
    expect(refreshRow).toBeTruthy();
    expect(verifyRow).toBeTruthy();
  });
});
