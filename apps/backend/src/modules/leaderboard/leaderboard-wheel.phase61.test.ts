import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APPROVED_WHEEL_DISTRIBUTION,
  APPROVED_WHEEL_EXPECTED_VALUE,
  expectedValueFromDistribution,
  getApprovedWheelDistribution,
  isApprovedWheelDistribution
} from "./approved-wheel-distribution";
import { competitionWindowContaining } from "./competition-schedule";
import { WHEEL_PRODUCT_QUALIFICATION_POLICY, WHEEL_QUALIFICATION_CENTS } from "./leaderboard.constants";
import type { CompetitionRow, EventRow } from "./leaderboard.types";
import {
  createEmptyWheelStore,
  WheelService,
  type WheelServiceStore
} from "./wheel.service";
import type { WheelRng } from "./wheel-rng";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const WS = "workspace-1";
const CONTACT = "contact-1";

function alwaysPoints(points: number, outcomes: Array<{ points: number; weight: number }>): WheelRng {
  const index = outcomes.findIndex((o) => o.points === points);
  if (index < 0) throw new Error(`points ${points} not in outcomes`);
  let total = 0;
  for (let i = 0; i < index; i += 1) total += Math.round(outcomes[i]!.weight * 1_000_000);
  return { nextInt: () => total };
}

function seedCompetition(store: WheelServiceStore, owner = OWNER_A): CompetitionRow {
  const window = competitionWindowContaining(new Date("2026-07-08T03:00:00.000Z"));
  const competition: CompetitionRow = {
    id: randomUUID(),
    workspaceId: WS,
    ownerCoadminUserId: owner,
    sequence: window.sequence,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    status: "ACTIVE",
    prizePoolCents: 0,
    frozenAt: null,
    finalizedAt: null,
    finalizedByUserId: null,
    finalizationIdempotencyKey: null,
    createdAt: window.startsAt,
    updatedAt: window.startsAt
  };
  store.competitions.push(competition);
  return competition;
}

function addDeposit(
  store: WheelServiceStore,
  competition: CompetitionRow,
  cents: number,
  at: Date,
  contact = CONTACT,
  owner = OWNER_A
): void {
  const event: EventRow = {
    id: randomUUID(),
    workspaceId: WS,
    ownerCoadminUserId: owner,
    competitionId: competition.id,
    crmContactId: contact,
    type: "DEPOSIT",
    pointsDelta: Math.floor(cents / 100),
    depositAmountCents: cents,
    poolContributionCents: 0,
    poolRateBpsApplied: 200,
    actorUserId: owner,
    reason: "deposit",
    metadataJson: {},
    occurredAt: at,
    idempotencyKey: randomUUID(),
    reversesEventId: null,
    createdAt: at
  };
  store.events.push(event);
  let standing = store.standings.find(
    (s) => s.competitionId === competition.id && s.crmContactId === contact
  );
  if (!standing) {
    standing = {
      id: randomUUID(),
      workspaceId: WS,
      ownerCoadminUserId: owner,
      competitionId: competition.id,
      crmContactId: contact,
      totalPoints: 0,
      depositPoints: 0,
      referralPoints: 0,
      promotionPoints: 0,
      wheelPoints: 0,
      qualifyingDepositCents: 0,
      successfulReferralCount: 0,
      pointsReachedAt: at,
      lastEventId: event.id,
      lastEventAt: at,
      lastEventType: "DEPOSIT",
      lastEventReason: "deposit",
      createdAt: at,
      updatedAt: at
    };
    store.standings.push(standing);
  }
  standing.depositPoints += Math.floor(cents / 100);
  standing.qualifyingDepositCents += cents;
  standing.totalPoints =
    standing.depositPoints + standing.referralPoints + standing.promotionPoints + standing.wheelPoints;
  standing.lastEventId = event.id;
  standing.lastEventAt = at;
  standing.updatedAt = at;
}

function reverseDeposit(
  store: WheelServiceStore,
  competition: CompetitionRow,
  cents: number,
  at: Date,
  contact = CONTACT
): void {
  const standing = store.standings.find(
    (s) => s.competitionId === competition.id && s.crmContactId === contact
  )!;
  const event: EventRow = {
    id: randomUUID(),
    workspaceId: WS,
    ownerCoadminUserId: competition.ownerCoadminUserId,
    competitionId: competition.id,
    crmContactId: contact,
    type: "DEPOSIT_REVERSAL",
    pointsDelta: -Math.floor(cents / 100),
    depositAmountCents: -cents,
    poolContributionCents: 0,
    poolRateBpsApplied: 200,
    actorUserId: competition.ownerCoadminUserId,
    reason: "reversal",
    metadataJson: {},
    occurredAt: at,
    idempotencyKey: randomUUID(),
    reversesEventId: null,
    createdAt: at
  };
  store.events.push(event);
  standing.qualifyingDepositCents -= cents;
  standing.depositPoints -= Math.floor(cents / 100);
  standing.totalPoints =
    standing.depositPoints + standing.referralPoints + standing.promotionPoints + standing.wheelPoints;
}

describe("Phase 6.1 approved distribution", () => {
  it("contains exact approved weights totaling 100 with EV 13.45", () => {
    const expected: Array<[number, number]> = [
      [0, 8],
      [5, 18],
      [10, 24],
      [15, 20],
      [20, 14],
      [25, 8],
      [30, 5],
      [35, 2],
      [40, 1]
    ];
    expect(APPROVED_WHEEL_DISTRIBUTION).toHaveLength(9);
    for (const [points, weight] of expected) {
      const row = APPROVED_WHEEL_DISTRIBUTION.find((o) => o.points === points);
      expect(row?.weight).toBe(weight);
    }
    const validated = getApprovedWheelDistribution();
    expect(validated.totalWeight).toBe(100);
    expect(expectedValueFromDistribution(validated.outcomes)).toBe(APPROVED_WHEEL_EXPECTED_VALUE);
    expect(APPROVED_WHEEL_EXPECTED_VALUE).toBe(13.7);
    // Explicit regression: Σ(points×weight)/100
    expect(
      (0 * 8 + 5 * 18 + 10 * 24 + 15 * 20 + 20 * 14 + 25 * 8 + 30 * 5 + 35 * 2 + 40 * 1) / 100
    ).toBe(13.7);

    const points = new Set(APPROVED_WHEEL_DISTRIBUTION.map((o) => o.points));
    expect(points.has(0)).toBe(true);
    expect(points.has(40)).toBe(true);
    for (const p of [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 50]) {
      expect(points.has(p)).toBe(false);
    }
    expect(isApprovedWheelDistribution(APPROVED_WHEEL_DISTRIBUTION)).toBe(true);
    expect(isApprovedWheelDistribution([{ points: 10, weight: 1 }])).toBe(false);
  });

  it("ensureApprovedDistributionVersion is per-coadmin and isolated", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const a = service.ensureApprovedDistributionVersion({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      createdByUserId: OWNER_A
    });
    const b = service.ensureApprovedDistributionVersion({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_B,
      createdByUserId: OWNER_B
    });
    expect(a.id).not.toBe(b.id);
    expect(a.ownerCoadminUserId).toBe(OWNER_A);
    expect(b.ownerCoadminUserId).toBe(OWNER_B);
    expect(isApprovedWheelDistribution(a.rewardDistributionJson)).toBe(true);
    expect(isApprovedWheelDistribution(b.rewardDistributionJson)).toBe(true);
    expect(service.ensureConfig(WS, OWNER_A).qualificationCreditPolicy).toBe(
      WHEEL_PRODUCT_QUALIFICATION_POLICY
    );
  });
});

describe("Phase 6.1 mid-cycle enablement", () => {
  it("counts deposits before and after enable in the current cycle ($25+$15=$40)", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const cycles = service.ensureCyclesForCompetition(competition);
    const cycle = cycles[0]!;
    const beforeEnable = new Date(cycle.startsAt.getTime() + 60_000);
    const enableAt = new Date(cycle.startsAt.getTime() + 2 * 60 * 60_000);
    const afterEnable = new Date(cycle.startsAt.getTime() + 3 * 60 * 60_000);

    addDeposit(store, competition, 2500, beforeEnable);
    service.ensureApprovedDistributionVersion({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      createdByUserId: OWNER_A,
      now: enableAt
    });
    service.patchSettings({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      enabled: true,
      now: enableAt
    });
    addDeposit(store, competition, 1500, afterEnable);

    const status = service.getStatus(WS, OWNER_A, CONTACT, afterEnable);
    expect(status.qualifyingDepositCents).toBe(4000);
    expect(status.available).toBe(true);
    expect(status.consumed).toBe(false);
  });

  it("does not count prior completed-cycle deposits or award retroactive spins", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const cycles = service.ensureCyclesForCompetition(competition);
    const prior = cycles[0]!;
    const current = cycles[1]!;
    const priorDepositAt = new Date(prior.startsAt.getTime() + 60_000);
    const enableAt = new Date(current.startsAt.getTime() + 60_000);
    const currentDepositAt = new Date(current.startsAt.getTime() + 120_000);

    addDeposit(store, competition, 10_000, priorDepositAt);
    service.ensureApprovedDistributionVersion({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      createdByUserId: OWNER_A,
      now: enableAt
    });
    service.patchSettings({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      enabled: true,
      now: enableAt
    });
    addDeposit(store, competition, 1000, currentDepositAt);

    const status = service.getStatus(WS, OWNER_A, CONTACT, currentDepositAt);
    expect(status.cycleSequence).toBe(current.sequence);
    expect(status.qualifyingDepositCents).toBe(1000);
    expect(status.available).toBe(false);
    expect(store.spins).toHaveLength(0);
  });
});

describe("Phase 6.1 reversals", () => {
  function enableApproved(service: WheelService, now: Date) {
    service.ensureApprovedDistributionVersion({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      createdByUserId: OWNER_A,
      now
    });
    service.patchSettings({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      enabled: true,
      now
    });
  }

  it("pre-spin reversal below $40 removes availability", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + 60_000);
    enableApproved(service, now);
    addDeposit(store, competition, 4000, now);
    expect(service.getStatus(WS, OWNER_A, CONTACT, now).available).toBe(true);
    reverseDeposit(store, competition, 1000, new Date(now.getTime() + 1000));
    const status = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 1000));
    expect(status.qualifyingDepositCents).toBe(3000);
    expect(status.available).toBe(false);
    expect(store.spins).toHaveLength(0);
  });

  it("post-spin reversal keeps spin/points and sets qualificationInvalidatedAt", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + 60_000);
    enableApproved(service, now);
    const approved = getApprovedWheelDistribution().outcomes;
    addDeposit(store, competition, 4000, now);
    const spun = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "post-rev",
      actorUserId: OWNER_A,
      now,
      rng: alwaysPoints(30, [...approved])
    });
    expect(spun.spin.pointsAwarded).toBe(30);
    expect(spun.standing.wheelPoints).toBe(30);
    const wheelEvent = store.events.find((e) => e.type === "WHEEL_SPIN");
    expect(wheelEvent).toBeTruthy();

    reverseDeposit(store, competition, 1000, new Date(now.getTime() + 1000));
    service.recomputeQualification(
      OWNER_A,
      competition,
      service.ensureCyclesForCompetition(competition).find((c) => c.id === spun.spin.cycleId)!,
      CONTACT,
      new Date(now.getTime() + 1000)
    );

    expect(store.spins).toHaveLength(1);
    expect(store.spins[0]!.pointsAwarded).toBe(30);
    expect(store.spins[0]!.qualificationInvalidatedAt).not.toBeNull();
    expect(store.standings[0]!.wheelPoints).toBe(30);
    expect(store.events.filter((e) => e.type === "WHEEL_SPIN")).toHaveLength(1);
  });
});
