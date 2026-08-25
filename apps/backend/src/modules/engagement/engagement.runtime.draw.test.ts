import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import {
  createFakeLeaderboardTelegramClient,
  type FakeLeaderboardTelegramState
} from "../leaderboard/telegram/leaderboard-telegram.client";
import type { WheelRng } from "../leaderboard/wheel-rng";
import { DAILY_DRAW_PRIZE_CENTS } from "./engagement.constants";
import { dailyDrawFreeplayIdempotencyKey } from "./engagement.draw";
import { MemoryEngagementRuntime } from "./engagement.memory";
import type { EngagementQuestionInput } from "./question-bank";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const workspace = "11111111-1111-4111-8111-111111111111";
const integrationId = "i1111111-iiii-4iii-8iii-iiiiiiiiiii1";
const channelId = "-100123";
const contactA = "d1111111-dddd-4ddd-8ddd-ddddddddddd1";
const contactB = "d2222222-dddd-4ddd-8ddd-ddddddddddd2";
const contactC = "d3333333-dddd-4ddd-8ddd-ddddddddddd3";

function tinyBank(count = 4): EngagementQuestionInput[] {
  return Array.from({ length: count }, (_, i) => ({
    externalId: String(i + 1),
    category: "Test",
    question: `Question ${i + 1}?`,
    options: ["A", "B", "C", "D"],
    active: true
  }));
}

function rngPick(pick: number): WheelRng {
  return {
    nextInt(maxExclusive: number) {
      if (pick < 0 || pick >= maxExclusive) {
        throw new Error(`pick ${pick} is outside 0..${maxExclusive - 1}`);
      }
      return pick;
    }
  };
}

function setup(rng: WheelRng = rngPick(0)) {
  const state: FakeLeaderboardTelegramState = {
    bots: new Map([["token", { id: 1, isBot: true, firstName: "Bot", username: "sayubot" }]]),
    chats: new Map([
      [
        Number(channelId),
        {
          id: Number(channelId),
          type: "channel",
          members: new Map([
            [100, "member"],
            [200, "member"],
            [300, "member"]
          ]),
          messages: [],
          nextMessageId: 1
        }
      ]
    ])
  };
  const client = createFakeLeaderboardTelegramClient(state);
  const runtime = new MemoryEngagementRuntime(undefined, client, state, rng);
  runtime.importQuestions(tinyBank());
  runtime.integrations.push({
    id: integrationId,
    workspaceId: workspace,
    ownerCoadminUserId: owner,
    channelId,
    postingEnabled: true,
    disconnectedAt: null,
    botToken: "token"
  });
  runtime.contacts.set(contactA, { displayName: "Emily" });
  runtime.contacts.set(contactB, { displayName: "John" });
  runtime.contacts.set(contactC, { displayName: "Sarah" });
  runtime.playerLinks.push(
    { botIntegrationId: integrationId, telegramUserId: "100", crmContactId: contactA, ownerCoadminUserId: owner },
    { botIntegrationId: integrationId, telegramUserId: "200", crmContactId: contactB, ownerCoadminUserId: owner },
    { botIntegrationId: integrationId, telegramUserId: "300", crmContactId: contactC, ownerCoadminUserId: owner }
  );
  return { runtime, state };
}

describe("daily $5 Freeplay draw runtime", () => {
  it("selects one weighted winner, grants $5 once, and announces a photo", async () => {
    const { runtime, state } = setup(rngPick(0));
    runtime.referrals.push(
      {
        id: "ref-old",
        ownerCoadminUserId: owner,
        referrerCrmContactId: contactA,
        status: "ACTIVE",
        awardedAt: chicagoWallTimeToUtc("2026-01-01T12:00:00")
      },
      {
        id: "ref-new",
        ownerCoadminUserId: owner,
        referrerCrmContactId: contactA,
        status: "ACTIVE",
        awardedAt: chicagoWallTimeToUtc("2026-08-25T12:00:00")
      },
      {
        id: "ref-dead",
        ownerCoadminUserId: owner,
        referrerCrmContactId: contactB,
        status: "REVERSED",
        awardedAt: chicagoWallTimeToUtc("2026-08-25T12:00:00")
      }
    );
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:30"));
    const draw = runtime.draws.find((row) => row.chicagoDate === "2026-08-25")!;
    expect(runtime.draws.filter((row) => row.chicagoDate === "2026-08-25")).toHaveLength(1);
    expect(runtime.results).toHaveLength(0);
    expect(draw.winnerCrmContactId).toBe(contactA);
    expect(draw.winnerBaseWeight).toBe(10);
    expect(draw.winnerReferralWeight).toBe(50);
    expect(draw.winnerTotalWeight).toBe(60);
    expect(draw.winnerActiveReferralCount).toBe(1);
    expect(Array.isArray(draw.snapshot)).toBe(true);
    const claim = runtime.claims.find((c) => c.source === "ENGAGEMENT_DAILY_DRAW");
    expect(claim?.rewardAmountCents).toBe(DAILY_DRAW_PRIZE_CENTS);
    expect(claim?.idempotencyKey).toBe(dailyDrawFreeplayIdempotencyKey(owner, "2026-08-25"));
    const photo = state.chats.get(Number(channelId))?.messages.find((m) => m.photo);
    expect(photo?.caption).toContain("Emily");
    expect(photo?.caption).toContain("$5 Freeplay");
    expect(photo?.caption).toContain("increased your chances");
    expect(photo?.caption).not.toMatch(/won because/i);
    expect(draw.telegramMessageId).toBeTruthy();
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:01:00"));
    expect(runtime.claims.filter((c) => c.idempotencyKey === dailyDrawFreeplayIdempotencyKey(owner, "2026-08-25"))).toHaveLength(
      1
    );
    expect(state.chats.get(Number(channelId))?.messages.filter((m) => m.photo)).toHaveLength(1);
  });

  it("lets a zero-referral member win when the RNG lands in their range", async () => {
    const { runtime, state } = setup(rngPick(60));
    runtime.referrals.push({
      id: "ref-new",
      ownerCoadminUserId: owner,
      referrerCrmContactId: contactA,
      status: "ACTIVE",
      awardedAt: chicagoWallTimeToUtc("2026-08-25T12:00:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    const draw = runtime.draws.find((row) => row.chicagoDate === "2026-08-25")!;
    expect(draw.winnerCrmContactId).toBe(contactB);
    expect(draw.winnerReferralWeight).toBe(0);
    expect(draw.winnerTotalWeight).toBe(10);
    const caption = state.chats.get(Number(channelId))?.messages.find((m) => m.photo)?.caption ?? "";
    expect(caption).toContain("John");
    expect(caption).not.toContain("increased your chances");
  });

  it("excludes non-members, unlinked users, bots, and admins", async () => {
    const { runtime, state } = setup(rngPick(0));
    const members = state.chats.get(Number(channelId))!.members;
    members.delete(200);
    members.set(300, "administrator");
    runtime.playerLinks.push({
      botIntegrationId: integrationId,
      telegramUserId: "400",
      crmContactId: contactB,
      ownerCoadminUserId: owner
    });
    state.botUserIds = new Set([400]);
    members.set(400, "member");
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    const draw = runtime.draws.find((row) => row.chicagoDate === "2026-08-25")!;
    const snapshot = draw.snapshot as Array<{ crmContactId: string; telegramUserId: string }>;
    expect(snapshot.map((row) => row.telegramUserId)).toEqual(["100"]);
    expect(draw.winnerCrmContactId).toBe(contactA);
    expect(draw.candidateCount).toBe(1);
  });

  it("keeps a winner ineligible for the next 7 draws then restores eligibility", async () => {
    const { runtime } = setup(rngPick(0));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"));
    expect(runtime.draws.find((row) => row.chicagoDate === "2026-08-25")?.winnerCrmContactId).toBe(contactA);
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T23:00:00"));
    const next = runtime.draws.find((row) => row.chicagoDate === "2026-08-26")!;
    expect(next.winnerCrmContactId).not.toBe(contactA);
    expect((next.snapshot as Array<{ crmContactId: string }>).some((row) => row.crmContactId === contactA)).toBe(false);
    runtime.draws.push({
      ...next,
      id: "forced-sep1",
      chicagoDate: "2026-09-01",
      winnerCrmContactId: contactB,
      winnerTelegramUserId: "200",
      telegramMessageId: "already",
      drawnAt: chicagoWallTimeToUtc("2026-09-01T23:00:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-09-02T23:00:00"));
    const restored = runtime.draws.find((row) => row.chicagoDate === "2026-09-02")!;
    expect((restored.snapshot as Array<{ crmContactId: string }>).some((row) => row.crmContactId === contactA)).toBe(true);
  });

  it("does not duplicate the draw or announcement when two sweeps race", async () => {
    const { runtime, state } = setup(rngPick(0));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await Promise.all([
      runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00")),
      runtime.sweep(chicagoWallTimeToUtc("2026-08-25T23:00:00"))
    ]);
    expect(runtime.draws.filter((row) => row.chicagoDate === "2026-08-25")).toHaveLength(1);
    expect(runtime.claims.filter((c) => c.source === "ENGAGEMENT_DAILY_DRAW")).toHaveLength(1);
    expect(state.chats.get(Number(channelId))?.messages.filter((m) => m.photo)).toHaveLength(1);
  });

  it("does not synthesize a historical daily draw from old referrals on a fresh deploy", async () => {
    const { runtime } = setup(rngPick(0));
    runtime.referrals.push({
      id: "ref-old-floor",
      ownerCoadminUserId: owner,
      referrerCrmContactId: contactA,
      status: "ACTIVE",
      awardedAt: chicagoWallTimeToUtc("2026-01-01T12:00:00")
    });
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:45"));
    expect(runtime.draws.find((r) => r.chicagoDate === "2026-08-24")).toBeUndefined();
    expect(runtime.draws).toHaveLength(0);
    expect(runtime.results).toHaveLength(0);
    expect(runtime.claims.filter((c) => c.idempotencyKey.includes(":2026-08-24"))).toHaveLength(0);
  });

  it("recovers a missed legitimate 11 PM draw after engagement has been running", async () => {
    const { runtime } = setup(rngPick(0));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-25T10:00:01"));
    await runtime.sweep(chicagoWallTimeToUtc("2026-08-26T08:00:00"));
    expect(runtime.draws.some((r) => r.chicagoDate === "2026-08-25")).toBe(true);
    expect(runtime.draws.some((r) => r.chicagoDate === "2026-08-24")).toBe(false);
    expect(runtime.results).toHaveLength(0);
  });

  it("creates a wheel-free $5 draw claim and does not duplicate on retry", () => {
    const { runtime } = setup();
    const first = runtime.grantEngagementClaim({
      ownerCoadminUserId: owner,
      crmContactId: contactA,
      amountCents: 500,
      idempotencyKey: dailyDrawFreeplayIdempotencyKey(owner, "2026-08-25"),
      source: "ENGAGEMENT_DAILY_DRAW"
    });
    const replay = runtime.grantEngagementClaim({
      ownerCoadminUserId: owner,
      crmContactId: contactA,
      amountCents: 500,
      idempotencyKey: dailyDrawFreeplayIdempotencyKey(owner, "2026-08-25"),
      source: "ENGAGEMENT_DAILY_DRAW"
    });
    runtime.addWheelClaim({
      ownerCoadminUserId: owner,
      crmContactId: contactA,
      spinId: "spin-1",
      idempotencyKey: "wheel:spin-1",
      rewardAmountCents: 200
    });
    expect(first.replay).toBe(false);
    expect(replay.replay).toBe(true);
    expect(replay.claimId).toBe(first.claimId);
    expect(runtime.claims.find((c) => c.source === "ENGAGEMENT_DAILY_DRAW")?.rewardAmountCents).toBe(500);
    expect(runtime.claims.find((c) => c.source === "WHEEL")?.spinId).toBe("spin-1");
  });
});
