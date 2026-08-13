import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "./competition-schedule";
import {
  correctDepositPointsFromLedger,
  depositScoringReconciliationIdempotencyKey,
  validQualifyingDepositCentsFromLedger
} from "./deposit-scoring-reconciliation";
import { LeaderboardService, MemoryLeaderboardStore } from "./leaderboard.service";
import { createFixedRandomSource } from "./promotion-points";
import type { EventRow, StandingRow } from "./leaderboard.types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const john = "j1111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sarah = "s2222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const playerB1 = "b1111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createBase() {
  const store = new MemoryLeaderboardStore();
  for (const id of [john, sarah, playerB1]) store.registerContact(id, workspaceId);
  const service = new LeaderboardService(store, {
    random: createFixedRandomSource([2, 2, 2]),
    requireEnabled: true
  });
  return { store, service };
}

async function enableOwner(
  service: LeaderboardService,
  owner: string,
  players: string[],
  now: Date
): Promise<void> {
  await service.ensureSettings(workspaceId, owner, owner);
  await service.setEnabled(workspaceId, owner, true, owner);
  for (const crmContactId of players) {
    await service.bindParticipant({
      workspaceId,
      ownerCoadminUserId: owner,
      crmContactId,
      createdByUserId: owner
    });
  }
  await service.ensureCurrentCompetition(workspaceId, owner, now);
}

function cryptoRandom(): string {
  return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  );
}

/** Inject a legacy $5=1 deposit into the ACTIVE competition without using recordDeposit. */
function injectLegacyDeposit(input: {
  store: MemoryLeaderboardStore;
  competitionId: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  amountCents: number;
  legacyPointsDelta: number;
  poolContributionCents: number;
  poolRateBps: number;
  occurredAt: Date;
  idempotencyKey: string;
}): void {
  const competition = input.store.competitions.find((c) => c.id === input.competitionId)!;
  const event: EventRow = {
    id: cryptoRandom(),
    workspaceId,
    ownerCoadminUserId: input.ownerCoadminUserId,
    competitionId: input.competitionId,
    crmContactId: input.crmContactId,
    type: "DEPOSIT",
    pointsDelta: input.legacyPointsDelta,
    depositAmountCents: input.amountCents,
    poolContributionCents: input.poolContributionCents,
    poolRateBpsApplied: input.poolRateBps,
    actorUserId: input.ownerCoadminUserId,
    reason: "deposit",
    metadataJson: { amountCents: input.amountCents, legacyScoring: true },
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
    reversesEventId: null,
    createdAt: input.occurredAt
  };
  input.store.events.push(event);
  competition.prizePoolCents += input.poolContributionCents;

  let standing = input.store.standings.find(
    (s) => s.competitionId === input.competitionId && s.crmContactId === input.crmContactId
  );
  if (!standing) {
    standing = {
      id: cryptoRandom(),
      workspaceId,
      ownerCoadminUserId: input.ownerCoadminUserId,
      competitionId: input.competitionId,
      crmContactId: input.crmContactId,
      totalPoints: 0,
      depositPoints: 0,
      referralPoints: 0,
      promotionPoints: 0,
      wheelPoints: 0,
      qualifyingDepositCents: 0,
      successfulReferralCount: 0,
      pointsReachedAt: input.occurredAt,
      lastEventId: null,
      lastEventAt: null,
      lastEventType: null,
      lastEventReason: null,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt
    } satisfies StandingRow;
    input.store.standings.push(standing);
  }
  standing.qualifyingDepositCents += input.amountCents;
  standing.depositPoints += input.legacyPointsDelta;
  standing.totalPoints =
    standing.depositPoints + standing.referralPoints + standing.promotionPoints + standing.wheelPoints;
  standing.pointsReachedAt = input.occurredAt;
  standing.lastEventId = event.id;
  standing.lastEventAt = input.occurredAt;
  standing.lastEventType = "DEPOSIT";
  standing.lastEventReason = "deposit";
  standing.updatedAt = input.occurredAt;
}

describe("deposit scoring reconciliation helpers", () => {
  it("sums valid cents and maps $1 = 1 point", () => {
    const events = [
      { type: "DEPOSIT" as const, depositAmountCents: 300 },
      { type: "DEPOSIT" as const, depositAmountCents: 200 },
      { type: "DEPOSIT" as const, depositAmountCents: 1500 }
    ];
    expect(validQualifyingDepositCentsFromLedger(events)).toBe(2000);
    expect(correctDepositPointsFromLedger(events)).toBe(20);
  });
});

describe("ACTIVE deposit scoring reconciliation", () => {
  it("corrects mixed-rule ACTIVE standings without changing pool/referral/promotion", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john, sarah], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);

    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "legacy-john-100"
    });

    await service.recordDeposit({
      workspaceId,
      crmContactId: sarah,
      amountCents: 10000,
      actorUserId: ownerA,
      idempotencyKey: "sarah-100",
      now: new Date(now.getTime() + 1000)
    });

    const poolBefore = service.getCompetition(competition.id)!.prizePoolCents;
    const johnBefore = service.listStandings(competition.id).find((s) => s.crmContactId === john)!;
    expect(johnBefore.depositPoints).toBe(20);

    johnBefore.referralPoints = 25;
    johnBefore.promotionPoints = 2;
    johnBefore.totalPoints = johnBefore.depositPoints + 25 + 2;

    const referralEventsBefore = store.events.filter((e) => e.type.startsWith("REFERRAL")).length;
    const promoEventsBefore = store.events.filter((e) => e.type.startsWith("PROMOTION")).length;

    await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 5000)
    });

    const johnAfter = service.listStandings(competition.id).find((s) => s.crmContactId === john)!;
    expect(johnAfter.qualifyingDepositCents).toBe(10000);
    expect(johnAfter.depositPoints).toBe(100);
    expect(johnAfter.referralPoints).toBe(25);
    expect(johnAfter.promotionPoints).toBe(2);
    expect(johnAfter.totalPoints).toBe(127);
    expect(service.getCompetition(competition.id)!.prizePoolCents).toBe(poolBefore);

    const johnDeposit = store.events.find((e) => e.idempotencyKey === "legacy-john-100")!;
    expect(johnDeposit.pointsDelta).toBe(20);
    expect(johnDeposit.poolContributionCents).toBe(200);

    const adjustment = store.events.find(
      (e) => e.idempotencyKey === depositScoringReconciliationIdempotencyKey(competition.id, john)
    )!;
    expect(adjustment.type).toBe("MANUAL_ADJUSTMENT");
    expect(adjustment.pointsDelta).toBe(80);
    expect(adjustment.poolContributionCents).toBeNull();

    expect(store.events.filter((e) => e.type.startsWith("REFERRAL")).length).toBe(referralEventsBefore);
    expect(store.events.filter((e) => e.type.startsWith("PROMOTION")).length).toBe(promoEventsBefore);
    expect(service.listStandings(competition.id).find((s) => s.crmContactId === sarah)!.depositPoints).toBe(100);
  });

  it("handles multiple deposits totaling $20 → 20 points", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);

    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 300,
      legacyPointsDelta: 0,
      poolContributionCents: 6,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "d3"
    });
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 200,
      legacyPointsDelta: 1,
      poolContributionCents: 4,
      poolRateBps: 200,
      occurredAt: new Date(now.getTime() + 1000),
      idempotencyKey: "d2"
    });
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 1500,
      legacyPointsDelta: 3,
      poolContributionCents: 30,
      poolRateBps: 200,
      occurredAt: new Date(now.getTime() + 2000),
      idempotencyKey: "d15"
    });

    await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 3000)
    });
    const standing = service.listStandings(competition.id).find((s) => s.crmContactId === john)!;
    expect(standing.qualifyingDepositCents).toBe(2000);
    expect(standing.depositPoints).toBe(20);
  });

  it("excludes reversed deposits from qualifying cents", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);

    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "dep-100"
    });
    const deposit = store.events.find((e) => e.idempotencyKey === "dep-100")!;

    store.events.push({
      id: cryptoRandom(),
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: competition.id,
      crmContactId: john,
      type: "DEPOSIT_REVERSAL",
      pointsDelta: -8,
      depositAmountCents: -4000,
      poolContributionCents: -80,
      poolRateBpsApplied: 200,
      actorUserId: ownerA,
      reason: "deposit_reversal",
      metadataJson: { reversesEventId: deposit.id },
      occurredAt: new Date(now.getTime() + 1000),
      idempotencyKey: "rev-40",
      reversesEventId: deposit.id,
      createdAt: new Date(now.getTime() + 1000)
    });
    competition.prizePoolCents -= 80;
    const standing = store.standings.find((s) => s.crmContactId === john)!;
    standing.qualifyingDepositCents = 6000;
    standing.depositPoints = 12;
    standing.totalPoints = 12;

    const poolBefore = competition.prizePoolCents;
    await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 2000)
    });

    const after = service.listStandings(competition.id).find((s) => s.crmContactId === john)!;
    expect(after.qualifyingDepositCents).toBe(6000);
    expect(after.depositPoints).toBe(60);
    expect(service.getCompetition(competition.id)!.prizePoolCents).toBe(poolBefore);
  });

  it("does not alter Coadmin B when reconciling A", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john], now);
    await enableOwner(service, ownerB, [playerB1], now);
    const compA = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    const compB = await service.ensureCurrentCompetition(workspaceId, ownerB, now);

    injectLegacyDeposit({
      store,
      competitionId: compA.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "a-legacy"
    });
    injectLegacyDeposit({
      store,
      competitionId: compB.id,
      ownerCoadminUserId: ownerB,
      crmContactId: playerB1,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "b-legacy"
    });

    const bStandingBefore = structuredClone(
      store.standings.find((s) => s.competitionId === compB.id && s.crmContactId === playerB1)!
    );
    const bEventsBefore = store.events.filter((e) => e.ownerCoadminUserId === ownerB).map((e) => ({ ...e }));
    const bPoolBefore = service.getCompetition(compB.id)!.prizePoolCents;

    await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 1000)
    });

    expect(
      store.standings.find((s) => s.competitionId === compB.id && s.crmContactId === playerB1)
    ).toEqual(bStandingBefore);
    expect(service.getCompetition(compB.id)!.prizePoolCents).toBe(bPoolBefore);
    expect(store.events.filter((e) => e.ownerCoadminUserId === ownerB)).toEqual(bEventsBefore);
    expect(service.listStandings(compA.id).find((s) => s.crmContactId === john)!.depositPoints).toBe(100);
  });

  it("leaves FROZEN competitions unchanged", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "frozen-legacy"
    });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.id === competition.id)!;
    expect(frozen.status).toBe("FROZEN");
    const standingBefore = structuredClone(store.standings.find((s) => s.competitionId === frozen.id)!);
    const eventsBefore = store.events.length;
    const poolBefore = frozen.prizePoolCents;
    const snapshotBefore = structuredClone(store.snapshots.find((s) => s.competitionId === frozen.id)!);

    const result = await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      now: boundary
    });
    expect(result.competitionsProcessed).toBe(0);
    expect(store.standings.find((s) => s.competitionId === frozen.id)).toEqual(standingBefore);
    expect(store.events.length).toBe(eventsBefore);
    expect(frozen.prizePoolCents).toBe(poolBefore);
    expect(store.snapshots.find((s) => s.competitionId === frozen.id)).toEqual(snapshotBefore);
  });

  it("leaves FINALIZED competitions unchanged", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john, sarah], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "fin-j"
    });
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: sarah,
      amountCents: 5000,
      legacyPointsDelta: 10,
      poolContributionCents: 100,
      poolRateBps: 200,
      occurredAt: new Date(now.getTime() + 500),
      idempotencyKey: "fin-s"
    });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.id === competition.id)!;

    for (const candidate of store.eligibilityCandidates.filter((c) => c.competitionId === frozen.id)) {
      await service.setMembershipEligibility({
        workspaceId,
        ownerCoadminUserId: ownerA,
        competitionId: frozen.id,
        crmContactId: candidate.crmContactId,
        membershipStatus: "ELIGIBLE",
        actorUserId: ownerA,
        idempotencyKey: `el-${candidate.crmContactId}`,
        now: boundary
      });
    }
    await service.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      actorUserId: ownerA,
      idempotencyKey: "finalize-1",
      now: boundary
    });
    expect(service.getCompetition(frozen.id)?.status).toBe("FINALIZED");

    const standingBefore = structuredClone(
      store.standings.find((s) => s.competitionId === frozen.id && s.crmContactId === john)!
    );
    const result = await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      now: boundary
    });
    expect(result.competitionsProcessed).toBe(0);
    expect(
      store.standings.find((s) => s.competitionId === frozen.id && s.crmContactId === john)
    ).toEqual(standingBefore);
  });

  it("is idempotent on second run", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "idem-dep"
    });

    const first = await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 1000)
    });
    const eventsAfterFirst = store.events.length;
    const standingAfterFirst = structuredClone(store.standings.find((s) => s.crmContactId === john)!);
    const poolAfterFirst = service.getCompetition(competition.id)!.prizePoolCents;

    const second = await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 2000)
    });
    expect(first.playersAdjusted).toBe(1);
    expect(second.playersSkippedIdempotent).toBe(1);
    expect(second.playersAdjusted).toBe(0);
    expect(store.events.length).toBe(eventsAfterFirst);
    expect(store.standings.find((s) => s.crmContactId === john)).toEqual(standingAfterFirst);
    expect(service.getCompetition(competition.id)!.prizePoolCents).toBe(poolAfterFirst);
  });

  it("updates rankings from corrected deposit points with reconstructed tie times", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john, sarah], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);

    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: sarah,
      amountCents: 5000,
      legacyPointsDelta: 10,
      poolContributionCents: 100,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "sarah-50"
    });
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: new Date(now.getTime() + 60_000),
      idempotencyKey: "john-100"
    });

    expect(service.listStandings(competition.id)[0]!.crmContactId).toBe(john);

    await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 120_000)
    });

    const ranked = service.listStandings(competition.id);
    expect(ranked[0]!.crmContactId).toBe(john);
    expect(ranked[0]!.depositPoints).toBe(100);
    expect(ranked[1]!.crmContactId).toBe(sarah);
    expect(ranked[1]!.depositPoints).toBe(50);
    expect(ranked[0]!.pointsReachedAt.getTime()).toBe(new Date(now.getTime() + 60_000).getTime());
    expect(ranked[1]!.pointsReachedAt.getTime()).toBe(now.getTime());
  });

  it("never changes pool contribution history or aggregate", async () => {
    const { store, service } = createBase();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await enableOwner(service, ownerA, [john], now);
    const competition = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    injectLegacyDeposit({
      store,
      competitionId: competition.id,
      ownerCoadminUserId: ownerA,
      crmContactId: john,
      amountCents: 10000,
      legacyPointsDelta: 20,
      poolContributionCents: 200,
      poolRateBps: 200,
      occurredAt: now,
      idempotencyKey: "pool-dep"
    });
    const poolHistoryBefore = store.poolRateHistory.map((r) => ({ ...r }));
    const depositBefore = { ...store.events.find((e) => e.idempotencyKey === "pool-dep")! };

    await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: ownerA,
      now: new Date(now.getTime() + 1)
    });

    expect(service.getCompetition(competition.id)!.prizePoolCents).toBe(200);
    expect(store.events.find((e) => e.idempotencyKey === "pool-dep")).toMatchObject({
      poolContributionCents: depositBefore.poolContributionCents,
      poolRateBpsApplied: depositBefore.poolRateBpsApplied,
      pointsDelta: depositBefore.pointsDelta
    });
    expect(store.poolRateHistory).toEqual(poolHistoryBefore);
  });
});
