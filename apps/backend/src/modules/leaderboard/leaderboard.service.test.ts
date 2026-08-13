import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "./competition-schedule";
import { LeaderboardError } from "./leaderboard.errors";
import { LeaderboardService, MemoryLeaderboardStore } from "./leaderboard.service";
import { createFixedRandomSource } from "./promotion-points";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "22222222-2222-4222-8222-222222222222";
const actorId = ownerA;
const playerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const playerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const playerC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const playerD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function createService(randomValues: number[] = [2, 2, 2, 2, 2]) {
  const store = new MemoryLeaderboardStore();
  store.registerContact(playerA, workspaceId);
  store.registerContact(playerB, workspaceId);
  store.registerContact(playerC, workspaceId);
  store.registerContact(playerD, workspaceId);
  const service = new LeaderboardService(store, {
    random: createFixedRandomSource(randomValues),
    requireEnabled: true
  });
  return { store, service };
}

async function enable(service: LeaderboardService, now = new Date()): Promise<void> {
  await service.ensureSettings(workspaceId, ownerA, actorId);
  await service.setEnabled(workspaceId, ownerA, true, actorId, now);
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: ownerA,
    crmContactId: playerA,
    createdByUserId: actorId
  });
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: ownerA,
    crmContactId: playerB,
    createdByUserId: actorId
  });
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: ownerA,
    crmContactId: playerC,
    createdByUserId: actorId
  });
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: ownerA,
    crmContactId: playerD,
    createdByUserId: actorId
  });
  await service.ensureCurrentCompetition(workspaceId, ownerA, now);
}

describe("LeaderboardService deposits + pool", () => {
  it("awards cumulative deposit points and snapshots pool rate", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 300,
      actorUserId: actorId,
      idempotencyKey: "dep-1",
      now
    });
    let standing = service.listStandings((await service.ensureCurrentCompetition(workspaceId, ownerA, now)).id)[0]!;
    expect(standing.depositPoints).toBe(3);
    expect(standing.qualifyingDepositCents).toBe(300);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 200,
      actorUserId: actorId,
      idempotencyKey: "dep-2",
      now: new Date(now.getTime() + 1000)
    });
    standing = service.listStandings((await service.ensureCurrentCompetition(workspaceId, ownerA, now)).id)[0]!;
    expect(standing.depositPoints).toBe(5);
    expect(standing.totalPoints).toBe(5);

    const hundred = await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 10000,
      actorUserId: actorId,
      idempotencyKey: "dep-100",
      now: new Date(now.getTime() + 2000)
    });
    expect(hundred.pointsDelta).toBe(100);
    expect(hundred.poolContributionCents).toBe(200);
    expect(hundred.poolRateBpsApplied).toBe(200);

    await service.setPoolRate({
      workspaceId,
      ownerCoadminUserId: ownerA,
      poolRateBps: 500,
      actorUserId: actorId,
      now: new Date(now.getTime() + 3000)
    });
    const afterRate = await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 10000,
      actorUserId: actorId,
      idempotencyKey: "dep-100-5pct",
      now: new Date(now.getTime() + 4000)
    });
    expect(afterRate.poolContributionCents).toBe(500);
    expect(afterRate.poolRateBpsApplied).toBe(500);
    expect(hundred.poolContributionCents).toBe(200);

    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    expect(service.getCompetition(competition.id)?.prizePoolCents).toBe(200 + 500 + poolFor(300, 200) + poolFor(200, 200));
    expect(store.audits.some((a) => a.action === "leaderboard.deposit")).toBe(true);
  });

  it("ten $10 deposits equal one $100 deposit for points", async () => {
    const { service } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    for (let i = 0; i < 10; i += 1) {
      await service.recordDeposit({
        workspaceId,
        crmContactId: playerA,
        amountCents: 1000,
        actorUserId: actorId,
        idempotencyKey: `split-${i}`,
        now: new Date(now.getTime() + i * 1000)
      });
    }
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    const standing = service.listStandings(competition.id).find((s) => s.crmContactId === playerA)!;
    expect(standing.depositPoints).toBe(100);
    expect(standing.qualifyingDepositCents).toBe(10000);
  });

  it("is idempotent for duplicate deposit keys", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    const a = await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "same",
      now
    });
    const b = await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "same",
      now
    });
    expect(a.id).toBe(b.id);
    expect(store.events.filter((e) => e.type === "DEPOSIT")).toHaveLength(1);
  });

  it("rejects deposit when participant is not bound", async () => {
    const { service, store } = createService();
    const unbound = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    store.registerContact(unbound, workspaceId);
    await service.ensureSettings(workspaceId, ownerA, actorId);
    await service.setEnabled(workspaceId, ownerA, true, actorId, chicagoWallTimeToUtc("2024-01-10T12:00:00"));
    await expect(
      service.recordDeposit({
        workspaceId,
        crmContactId: unbound,
        amountCents: 1000,
        actorUserId: actorId,
        idempotencyKey: "unbound",
        now: chicagoWallTimeToUtc("2024-01-10T12:00:00")
      })
    ).rejects.toMatchObject({ code: "PARTICIPANT_NOT_BOUND" });
  });
});

describe("LeaderboardService referrals", () => {
  it("rejects self-referral and duplicate referred assignment", async () => {
    const { service } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    await expect(
      service.setReferral({
        workspaceId,
        referrerCrmContactId: playerA,
        referredCrmContactId: playerA,
        actorUserId: actorId,
        idempotencyKey: "r1",
        now
      })
    ).rejects.toBeInstanceOf(LeaderboardError);

    await service.setReferral({
      workspaceId,
      referrerCrmContactId: playerA,
      referredCrmContactId: playerB,
      actorUserId: actorId,
      idempotencyKey: "r2",
      now
    });
    await expect(
      service.setReferral({
        workspaceId,
        referrerCrmContactId: playerC,
        referredCrmContactId: playerB,
        actorUserId: actorId,
        idempotencyKey: "r3",
        now
      })
    ).rejects.toMatchObject({ code: "REFERRAL_ALREADY_EXISTS" });
  });

  it("awards lifetime milestones once and stops after $250", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    await service.setReferral({
      workspaceId,
      referrerCrmContactId: playerA,
      referredCrmContactId: playerB,
      actorUserId: actorId,
      idempotencyKey: "ref",
      now
    });

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 1000,
      actorUserId: actorId,
      idempotencyKey: "d10",
      now
    });
    let referral = store.referrals[0]!;
    expect(service.getActiveMilestones(referral.id).map((m) => m.milestoneCode)).toEqual(["FIRST_10"]);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 4000,
      actorUserId: actorId,
      idempotencyKey: "d50",
      now: new Date(now.getTime() + 1000)
    });
    expect(service.getActiveMilestones(referral.id).map((m) => m.milestoneCode).sort()).toEqual(["CUM_50", "FIRST_10"]);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "d100",
      now: new Date(now.getTime() + 2000)
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 15000,
      actorUserId: actorId,
      idempotencyKey: "d250",
      now: new Date(now.getTime() + 3000)
    });
    expect(service.getActiveMilestones(referral.id)).toHaveLength(4);

    const beforeExtra = service
      .listStandings((await service.ensureCurrentCompetition(workspaceId, ownerA, now)).id)
      .find((s) => s.crmContactId === playerA)!.referralPoints;
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 10000,
      actorUserId: actorId,
      idempotencyKey: "d-extra",
      now: new Date(now.getTime() + 4000)
    });
    const afterExtra = service
      .listStandings((await service.ensureCurrentCompetition(workspaceId, ownerA, now)).id)
      .find((s) => s.crmContactId === playerA)!.referralPoints;
    expect(afterExtra).toBe(beforeExtra);
    expect(beforeExtra).toBe(300);
  });

  it("spans competitions without resetting lifetime progress", async () => {
    const { service, store } = createService();
    const c1 = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, c1);
    await service.setReferral({
      workspaceId,
      referrerCrmContactId: playerA,
      referredCrmContactId: playerB,
      actorUserId: actorId,
      idempotencyKey: "ref",
      now: c1
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 1000,
      actorUserId: actorId,
      idempotencyKey: "d10",
      now: c1
    });

    const c2 = chicagoWallTimeToUtc("2024-01-16T21:05:00");
    const competition2 = await service.ensureCurrentCompetition(workspaceId, ownerA, c2);
    expect(competition2.status).toBe("ACTIVE");
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 4000,
      actorUserId: actorId,
      idempotencyKey: "d50-c2",
      now: c2
    });
    const referral = store.referrals[0]!;
    const codes = service.getActiveMilestones(referral.id).map((m) => m.milestoneCode).sort();
    expect(codes).toEqual(["CUM_50", "FIRST_10"]);
    const standing = service.listStandings(competition2.id).find((s) => s.crmContactId === playerA)!;
    expect(standing.referralPoints).toBe(50);
    expect(service.getLifetimeCents(ownerA, playerB)).toBe(5000);
  });

  it("reverses milestones when lifetime drops and allows clean re-award", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    await service.setReferral({
      workspaceId,
      referrerCrmContactId: playerA,
      referredCrmContactId: playerB,
      actorUserId: actorId,
      idempotencyKey: "ref",
      now
    });
    const deposit = await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "d50",
      now
    });
    const referral = store.referrals[0]!;
    expect(service.getActiveMilestones(referral.id).map((m) => m.milestoneCode).sort()).toEqual(["CUM_50", "FIRST_10"]);

    await service.reverseDeposit({
      workspaceId,
      depositEventId: deposit.id,
      actorUserId: actorId,
      idempotencyKey: "rev-d50",
      now: new Date(now.getTime() + 1000)
    });
    expect(service.getActiveMilestones(referral.id)).toHaveLength(0);
    expect(store.milestones.filter((m) => m.status === "REVERSED")).toHaveLength(2);
    expect(store.events.some((e) => e.type === "REFERRAL_MILESTONE_REVERSAL")).toBe(true);

    await expect(
      service.reverseDeposit({
        workspaceId,
        depositEventId: deposit.id,
        actorUserId: actorId,
        idempotencyKey: "rev-d50-again",
        now: new Date(now.getTime() + 2000)
      })
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_REVERSED" });

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "d50-again",
      now: new Date(now.getTime() + 3000)
    });
    expect(service.getActiveMilestones(referral.id)).toHaveLength(2);
    expect(store.milestones.filter((m) => m.milestoneCode === "FIRST_10")).toHaveLength(2);
  });

  it("keeps historical awards with original referrer after override", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    await service.setReferral({
      workspaceId,
      referrerCrmContactId: playerA,
      referredCrmContactId: playerB,
      actorUserId: actorId,
      idempotencyKey: "ref",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 1000,
      actorUserId: actorId,
      idempotencyKey: "d10",
      now
    });
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    const aBefore = service.listStandings(competition.id).find((s) => s.crmContactId === playerA)!.referralPoints;
    expect(aBefore).toBe(25);

    await service.overrideReferral({
      workspaceId,
      referredCrmContactId: playerB,
      newReferrerCrmContactId: playerC,
      actorUserId: actorId,
      reason: "correction",
      idempotencyKey: "override",
      now: new Date(now.getTime() + 1000)
    });
    expect(store.referrals[0]?.referrerCrmContactId).toBe(playerC);
    expect(store.referrals[0]?.originalReferrerCrmContactId).toBe(playerA);
    expect(service.listStandings(competition.id).find((s) => s.crmContactId === playerA)!.referralPoints).toBe(25);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 4000,
      actorUserId: actorId,
      idempotencyKey: "d50",
      now: new Date(now.getTime() + 2000)
    });
    expect(service.listStandings(competition.id).find((s) => s.crmContactId === playerC)!.referralPoints).toBe(50);
    expect(service.listStandings(competition.id).find((s) => s.crmContactId === playerA)!.referralPoints).toBe(25);
  });
});

describe("LeaderboardService promotions", () => {
  it("uses random then +1 within 24h and resets after window", async () => {
    const { service } = createService([3, 1]);
    const start = chicagoWallTimeToUtc("2024-01-10T10:00:00");
    await enable(service, start);

    const first = await service.recordPromotion({
      workspaceId,
      crmContactId: playerA,
      actorUserId: actorId,
      idempotencyKey: "p1",
      now: start
    });
    expect(first.pointsDelta).toBe(3);

    const second = await service.recordPromotion({
      workspaceId,
      crmContactId: playerA,
      actorUserId: actorId,
      idempotencyKey: "p2",
      now: new Date(start.getTime() + 4 * 3600_000)
    });
    expect(second.pointsDelta).toBe(1);

    const third = await service.recordPromotion({
      workspaceId,
      crmContactId: playerA,
      actorUserId: actorId,
      idempotencyKey: "p3",
      now: new Date(start.getTime() + 8 * 3600_000)
    });
    expect(third.pointsDelta).toBe(1);

    const nextWindow = await service.recordPromotion({
      workspaceId,
      crmContactId: playerA,
      actorUserId: actorId,
      idempotencyKey: "p4",
      now: new Date(start.getTime() + 24 * 3600_000)
    });
    expect(nextWindow.pointsDelta).toBe(1);

    const dup = await service.recordPromotion({
      workspaceId,
      crmContactId: playerA,
      actorUserId: actorId,
      idempotencyKey: "p1",
      now: new Date(start.getTime() + 25 * 3600_000)
    });
    expect(dup.id).toBe(first.id);
  });
});

describe("LeaderboardService freeze / ties / finalize", () => {
  it("freezes once with deterministic top ranks and idempotent retry", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "a",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "b",
      now: new Date(now.getTime() + 5000)
    });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    const next = await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.status === "FROZEN")!;
    expect(frozen).toBeTruthy();
    expect(next.id).not.toBe(frozen.id);
    expect(next.prizePoolCents).toBe(0);

    const snapshot = service.getSnapshot(frozen.id)!;
    expect(snapshot).toBeTruthy();
    const top = snapshot.top10Json as Array<{ crmContactId: string; rank: number }>;
    expect(top[0]?.crmContactId).toBe(playerA);
    expect(top[1]?.crmContactId).toBe(playerB);

    expect(service.getPayouts(frozen.id)).toHaveLength(0);
    expect(service.getEligibilityCandidates(frozen.id)).toHaveLength(2);

    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerA,
      membershipStatus: "ELIGIBLE",
      actorUserId: actorId,
      idempotencyKey: "el-a",
      now: boundary
    });
    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerB,
      membershipStatus: "ELIGIBLE",
      actorUserId: actorId,
      idempotencyKey: "el-b",
      now: boundary
    });

    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    expect(store.snapshots.filter((s) => s.competitionId === frozen.id)).toHaveLength(1);

    const finalized = await service.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      actorUserId: actorId,
      idempotencyKey: "fin-1",
      now: boundary
    });
    expect(finalized.status).toBe("FINALIZED");
    const payouts = service.getPayouts(frozen.id);
    expect(payouts).toHaveLength(2);
    expect(payouts[0]?.prizeRank).toBe(1);
    expect(payouts[0]?.leaderboardRank).toBe(1);
    expect(payouts.reduce((sum, p) => sum + p.payoutCents, 0)).toBe(100 + 60);
    const again = await service.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      actorUserId: actorId,
      idempotencyKey: "fin-1",
      now: boundary
    });
    expect(again.id).toBe(finalized.id);
  });

  it("applies deposit reversal against original pool contribution not current rate", async () => {
    const { service } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    const deposit = await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 10000,
      actorUserId: actorId,
      idempotencyKey: "d",
      now
    });
    expect(deposit.poolContributionCents).toBe(200);
    await service.setPoolRate({
      workspaceId,
      ownerCoadminUserId: ownerA,
      poolRateBps: 500,
      actorUserId: actorId,
      now: new Date(now.getTime() + 1000)
    });
    await service.reverseDeposit({
      workspaceId,
      depositEventId: deposit.id,
      actorUserId: actorId,
      idempotencyKey: "rev",
      now: new Date(now.getTime() + 2000)
    });
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    expect(service.getCompetition(competition.id)?.prizePoolCents).toBe(0);
  });
});

describe("LeaderboardService concurrency", () => {
  it("serializes concurrent deposits for the same player", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);

    const tasks = Array.from({ length: 20 }, (_, i) =>
      service.recordDeposit({
        workspaceId,
        crmContactId: playerA,
        amountCents: 500,
        actorUserId: actorId,
        idempotencyKey: `concurrent-${i}`,
        now: new Date(now.getTime() + i)
      })
    );
    await Promise.all(tasks);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    const standing = service.listStandings(competition.id).find((s) => s.crmContactId === playerA)!;
    expect(standing.qualifyingDepositCents).toBe(10000);
    expect(standing.depositPoints).toBe(100);
    expect(store.events.filter((e) => e.type === "DEPOSIT")).toHaveLength(20);
  });

  it("handles concurrent freeze attempts without duplicate snapshots", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 1000,
      actorUserId: actorId,
      idempotencyKey: "d",
      now
    });
    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await Promise.all([
      service.ensureCurrentCompetition(workspaceId, ownerA, boundary),
      service.ensureCurrentCompetition(workspaceId, ownerA, boundary),
      service.ensureCurrentCompetition(workspaceId, ownerA, boundary)
    ]);
    expect(store.snapshots).toHaveLength(1);
    expect(store.competitions.filter((c) => c.status === "FROZEN")).toHaveLength(1);
    expect(store.competitions.filter((c) => c.status === "ACTIVE")).toHaveLength(1);
  });

  it("handles concurrent promotions with idempotent duplicates", async () => {
    const { service, store } = createService([2]);
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    const results = await Promise.all([
      service.recordPromotion({
        workspaceId,
        crmContactId: playerA,
        actorUserId: actorId,
        idempotencyKey: "same-promo",
        now
      }),
      service.recordPromotion({
        workspaceId,
        crmContactId: playerA,
        actorUserId: actorId,
        idempotencyKey: "same-promo",
        now
      }),
      service.recordPromotion({
        workspaceId,
        crmContactId: playerA,
        actorUserId: actorId,
        idempotencyKey: "same-promo",
        now
      })
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(store.events.filter((e) => e.type === "PROMOTION")).toHaveLength(1);
  });
});

describe("Phase 1.1 frozen ranking vs prize eligibility", () => {
  it("keeps CompetitionSnapshot immutable after post-freeze deposit reversal", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    const deposit = await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 10000,
      actorUserId: actorId,
      idempotencyKey: "d-freeze",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "d-b",
      now: new Date(now.getTime() + 1000)
    });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.status === "FROZEN")!;
    const before = structuredClone(service.getSnapshot(frozen.id)!);

    await service.reverseDeposit({
      workspaceId,
      depositEventId: deposit.id,
      actorUserId: actorId,
      idempotencyKey: "rev-after-freeze",
      now: new Date(boundary.getTime() + 60_000)
    });

    const after = service.getSnapshot(frozen.id)!;
    expect(after.prizePoolCents).toBe(before.prizePoolCents);
    expect(after.top10Json).toEqual(before.top10Json);
    expect(after.top3Json).toEqual(before.top3Json);
    expect(after.standingsHash).toBe(before.standingsHash);
    expect(after.winnersJson).toBeNull();
    expect(store.events.some((e) => e.type === "DEPOSIT_REVERSAL")).toBe(true);
  });

  it("selects prize winners by eligibility without rewriting frozen ranks", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    for (const [contact, cents, key, offset] of [
      [playerA, 15000, "a", 0],
      [playerB, 14000, "b", 1],
      [playerC, 13000, "c", 2],
      [playerD, 12000, "d", 3]
    ] as const) {
      await service.recordDeposit({
        workspaceId,
        crmContactId: contact,
        amountCents: cents,
        actorUserId: actorId,
        idempotencyKey: key,
        now: new Date(now.getTime() + offset * 1000)
      });
    }

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.status === "FROZEN")!;
    const ranking = (service.getSnapshot(frozen.id)!.top10Json as Array<{ crmContactId: string }>).map((r) => r.crmContactId);
    expect(ranking.slice(0, 4)).toEqual([playerA, playerB, playerC, playerD]);

    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerA,
      membershipStatus: "NOT_ELIGIBLE",
      ineligibilityReason: "NOT_SUBSCRIBED",
      actorUserId: actorId,
      idempotencyKey: "m-a",
      now: boundary
    });
    expect(
      service.getEligibilityCandidates(frozen.id).find((c) => c.crmContactId === playerA)?.ineligibilityReason
    ).toBe("NOT_SUBSCRIBED");
    for (const [contact, key] of [
      [playerB, "m-b"],
      [playerC, "m-c"],
      [playerD, "m-d"]
    ] as const) {
      await service.setMembershipEligibility({
        workspaceId,
        ownerCoadminUserId: ownerA,
        competitionId: frozen.id,
        crmContactId: contact,
        membershipStatus: "ELIGIBLE",
        actorUserId: actorId,
        idempotencyKey: key,
        now: boundary
      });
    }

    await service.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      actorUserId: actorId,
      idempotencyKey: "fin-elig",
      now: boundary
    });

    const snapshot = service.getSnapshot(frozen.id)!;
    expect((snapshot.top10Json as Array<{ crmContactId: string }>).map((r) => r.crmContactId).slice(0, 4)).toEqual([
      playerA,
      playerB,
      playerC,
      playerD
    ]);
    const winners = snapshot.winnersJson as Array<{
      prizeRank: number;
      crmContactId: string;
      leaderboardRank: number;
    }>;
    expect(winners.map((w) => ({ prizeRank: w.prizeRank, crmContactId: w.crmContactId, leaderboardRank: w.leaderboardRank }))).toEqual([
      { prizeRank: 1, crmContactId: playerB, leaderboardRank: 2 },
      { prizeRank: 2, crmContactId: playerC, leaderboardRank: 3 },
      { prizeRank: 3, crmContactId: playerD, leaderboardRank: 4 }
    ]);
    const payouts = service.getPayouts(frozen.id);
    expect(payouts.map((p) => ({ prize: p.prizeRank, board: p.leaderboardRank, id: p.crmContactId }))).toEqual([
      { prize: 1, board: 2, id: playerB },
      { prize: 2, board: 3, id: playerC },
      { prize: 3, board: 4, id: playerD }
    ]);
  });

  it("blocks finalize while a ahead-of-slot candidate is PENDING_REVIEW", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "a",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 4000,
      actorUserId: actorId,
      idempotencyKey: "b",
      now: new Date(now.getTime() + 1000)
    });
    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.status === "FROZEN")!;

    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerB,
      membershipStatus: "ELIGIBLE",
      actorUserId: actorId,
      idempotencyKey: "el-b",
      now: boundary
    });

    await expect(
      service.finalizeCompetition({
        workspaceId,
        ownerCoadminUserId: ownerA,
        competitionId: frozen.id,
        actorUserId: actorId,
        idempotencyKey: "fin-pending",
        now: boundary
      })
    ).rejects.toMatchObject({ code: "PENDING_REVIEW_BLOCKS_FINALIZE" });
    expect(service.getPayouts(frozen.id)).toHaveLength(0);
  });

  it("locks eligibility after finalize and still lets NOT_ELIGIBLE players earn/rank", async () => {
    const { service, store } = createService();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enable(service, now);
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 10000,
      actorUserId: actorId,
      idempotencyKey: "a",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 5000,
      actorUserId: actorId,
      idempotencyKey: "b",
      now: new Date(now.getTime() + 1000)
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerC,
      amountCents: 4000,
      actorUserId: actorId,
      idempotencyKey: "c",
      now: new Date(now.getTime() + 2000)
    });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.status === "FROZEN")!;
    expect((service.getSnapshot(frozen.id)!.top10Json as Array<{ crmContactId: string }>)[0]?.crmContactId).toBe(playerA);

    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerA,
      membershipStatus: "NOT_ELIGIBLE",
      actorUserId: actorId,
      idempotencyKey: "na",
      now: boundary
    });
    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerB,
      membershipStatus: "ELIGIBLE",
      actorUserId: actorId,
      idempotencyKey: "eb",
      now: boundary
    });
    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerC,
      membershipStatus: "ELIGIBLE",
      actorUserId: actorId,
      idempotencyKey: "ec",
      now: boundary
    });

    await service.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      actorUserId: actorId,
      idempotencyKey: "fin-lock",
      now: boundary
    });
    const lockedWinners = structuredClone(service.getSnapshot(frozen.id)!.winnersJson);

    await expect(
      service.setMembershipEligibility({
        workspaceId,
        ownerCoadminUserId: ownerA,
        competitionId: frozen.id,
        crmContactId: playerA,
        membershipStatus: "ELIGIBLE",
        actorUserId: actorId,
        idempotencyKey: "late-join",
        now: new Date(boundary.getTime() + 86_400_000)
      })
    ).rejects.toMatchObject({ code: "ELIGIBILITY_LOCKED" });
    expect(service.getSnapshot(frozen.id)!.winnersJson).toEqual(lockedWinners);
    expect(service.getPayouts(frozen.id)[0]?.crmContactId).toBe(playerB);
  });
});

function poolFor(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps) / 10000);
}
