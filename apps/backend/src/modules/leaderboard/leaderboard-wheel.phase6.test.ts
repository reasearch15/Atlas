import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { competitionWindowContaining } from "./competition-schedule";
import { WHEEL_QUALIFICATION_CENTS } from "./leaderboard.constants";
import type { CompetitionRow, EventRow, StandingRow } from "./leaderboard.types";
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
const CONTACT_B = "contact-b";

function fixedRng(pointsPickIndex: number): WheelRng {
  return {
    nextInt(maxExclusive: number) {
      // Map index into scaled weight space for equal weights.
      return Math.min(pointsPickIndex, maxExclusive - 1);
    }
  };
}

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
      lastEventId: null,
      lastEventAt: null,
      lastEventType: null,
      lastEventReason: null,
      createdAt: at,
      updatedAt: at
    } satisfies StandingRow;
    store.standings.push(standing);
  }
  standing.qualifyingDepositCents += cents;
  standing.depositPoints += Math.floor(cents / 100);
  standing.totalPoints =
    standing.depositPoints + standing.referralPoints + standing.promotionPoints + standing.wheelPoints;
  standing.updatedAt = at;
}

function reverseDeposit(
  store: WheelServiceStore,
  competition: CompetitionRow,
  cents: number,
  at: Date,
  contact = CONTACT,
  owner = OWNER_A
): void {
  store.events.push({
    id: randomUUID(),
    workspaceId: WS,
    ownerCoadminUserId: owner,
    competitionId: competition.id,
    crmContactId: contact,
    type: "DEPOSIT_REVERSAL",
    pointsDelta: -Math.floor(cents / 100),
    depositAmountCents: -cents,
    poolContributionCents: 0,
    poolRateBpsApplied: 200,
    actorUserId: owner,
    reason: "reversal",
    metadataJson: {},
    occurredAt: at,
    idempotencyKey: randomUUID(),
    reversesEventId: null,
    createdAt: at
  });
  const standing = store.standings.find(
    (s) => s.competitionId === competition.id && s.crmContactId === contact
  )!;
  standing.qualifyingDepositCents -= cents;
  standing.depositPoints -= Math.floor(cents / 100);
  standing.totalPoints =
    standing.depositPoints + standing.referralPoints + standing.promotionPoints + standing.wheelPoints;
}

function enableWheel(service: WheelService, owner = OWNER_A, policy: "CYCLE_DEPOSITS_ALL" | "CYCLE_DEPOSITS_AFTER_ENABLE" = "CYCLE_DEPOSITS_ALL") {
  const version = service.createVersion({
    workspaceId: WS,
    ownerCoadminUserId: owner,
    createdByUserId: owner,
    distribution: [
      { points: 0, weight: 1 },
      { points: 10, weight: 1 },
      { points: 40, weight: 1 }
    ]
  });
  service.activateVersion({ ownerCoadminUserId: owner, versionId: version.id });
  service.patchSettings({
    workspaceId: WS,
    ownerCoadminUserId: owner,
    qualificationCreditPolicy: policy,
    enabled: true
  });
  return version;
}

describe("leaderboard wheel phase 6", () => {
  it("ensures 7 cycles idempotently", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    const first = service.ensureCyclesForCompetition(competition);
    const second = service.ensureCyclesForCompetition(competition);
    expect(first).toHaveLength(7);
    expect(second).toHaveLength(7);
    expect(store.cycles).toHaveLength(7);
  });

  it("$39.99 locked, $40 available, $80 still one spin", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);

    addDeposit(store, competition, 3999, now);
    let status = service.getStatus(WS, OWNER_A, CONTACT, now);
    expect(status.available).toBe(false);
    expect(status.qualifyingDepositCents).toBe(3999);

    addDeposit(store, competition, 1, new Date(now.getTime() + 1000));
    status = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 1000));
    expect(status.available).toBe(true);
    expect(status.qualifyingDepositCents).toBe(WHEEL_QUALIFICATION_CENTS);

    addDeposit(store, competition, 4000, new Date(now.getTime() + 2000));
    status = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 2000));
    expect(status.available).toBe(true);
    expect(status.consumed).toBe(false);

    const spin = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "spin-1",
      actorUserId: OWNER_A,
      now: new Date(now.getTime() + 3000),
      rng: alwaysPoints(10, [
        { points: 0, weight: 1 },
        { points: 10, weight: 1 },
        { points: 40, weight: 1 }
      ])
    });
    expect(spin.spin.pointsAwarded).toBe(10);
    status = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 4000));
    expect(status.available).toBe(false);
    expect(status.consumed).toBe(true);
  });

  it("$40 deposit still earns 40 deposit points (wheel separate)", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);
    const standing = store.standings[0]!;
    expect(standing.depositPoints).toBe(40);
    const spin = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "spin-dep",
      actorUserId: OWNER_A,
      now,
      rng: alwaysPoints(40, [
        { points: 0, weight: 1 },
        { points: 10, weight: 1 },
        { points: 40, weight: 1 }
      ])
    });
    expect(spin.standing.depositPoints).toBe(40);
    expect(spin.standing.wheelPoints).toBe(40);
    expect(spin.standing.totalPoints).toBe(80);
  });

  it("reverse before spin removes availability", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);
    expect(service.getStatus(WS, OWNER_A, CONTACT, now).available).toBe(true);
    reverseDeposit(store, competition, 4000, new Date(now.getTime() + 1000));
    expect(service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 1000)).available).toBe(
      false
    );
  });

  it("post-spin reversal invalidates qualification but does not claw back points", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);
    const spin = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "spin-keep",
      actorUserId: OWNER_A,
      now,
      rng: alwaysPoints(10, [
        { points: 0, weight: 1 },
        { points: 10, weight: 1 },
        { points: 40, weight: 1 }
      ])
    });
    reverseDeposit(store, competition, 4000, new Date(now.getTime() + 1000));
    const cycles = service.ensureCyclesForCompetition(competition);
    const cycle = cycles.find((c) => c.id === spin.spin.cycleId)!;
    service.recomputeQualification(OWNER_A, competition, cycle, CONTACT, new Date(now.getTime() + 1000));
    expect(store.spins[0]!.qualificationInvalidatedAt).not.toBeNull();
    expect(store.standings[0]!.wheelPoints).toBe(10);
    expect(store.standings[0]!.totalPoints).toBe(
      store.standings[0]!.depositPoints + 10
    );
  });

  it("spin idempotency returns same result", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);
    const a = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "same-key",
      actorUserId: OWNER_A,
      now,
      rng: alwaysPoints(10, [
        { points: 0, weight: 1 },
        { points: 10, weight: 1 },
        { points: 40, weight: 1 }
      ])
    });
    const b = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "same-key",
      actorUserId: OWNER_A,
      now: new Date(now.getTime() + 5000),
      rng: fixedRng(0)
    });
    expect(b.replay).toBe(true);
    expect(b.spin.id).toBe(a.spin.id);
    expect(store.spins).toHaveLength(1);
  });

  it("concurrent spin attempts → one win (sequential lock + unique cycle/contact)", () => {
    // True DB concurrency is enforced by unique(cycleId, crmContactId).
    // In-memory simulates FOR UPDATE via sequential recompute + consume.
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);
    const first = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "c1",
      actorUserId: OWNER_A,
      now,
      rng: alwaysPoints(10, [
        { points: 0, weight: 1 },
        { points: 10, weight: 1 },
        { points: 40, weight: 1 }
      ])
    });
    expect(first.replay).toBe(false);
    expect(() =>
      service.spin({
        workspaceId: WS,
        crmContactId: CONTACT,
        idempotencyKey: "c2",
        actorUserId: OWNER_A,
        now,
        rng: alwaysPoints(40, [
          { points: 0, weight: 1 },
          { points: 10, weight: 1 },
          { points: 40, weight: 1 }
        ])
      })
    ).toThrow(/already used/i);
  });

  it("isolates coadmin A/B boards", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const compA = seedCompetition(store, OWNER_A);
    const compB = seedCompetition(store, OWNER_B);
    store.participants.push(
      { workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT },
      { workspaceId: WS, ownerCoadminUserId: OWNER_B, crmContactId: CONTACT_B }
    );
    enableWheel(service, OWNER_A);
    enableWheel(service, OWNER_B);
    const now = new Date(compA.startsAt.getTime() + 60_000);
    addDeposit(store, compA, 4000, now, CONTACT, OWNER_A);
    expect(service.getStatus(WS, OWNER_A, CONTACT, now).available).toBe(true);
    expect(service.getStatus(WS, OWNER_B, CONTACT_B, now).available).toBe(false);
    addDeposit(store, compB, 4000, now, CONTACT_B, OWNER_B);
    expect(service.getStatus(WS, OWNER_B, CONTACT_B, now).available).toBe(true);
  });

  it("refuses disabled / unconfigured wheel", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);

    expect(() =>
      service.spin({
        workspaceId: WS,
        crmContactId: CONTACT,
        idempotencyKey: "x",
        actorUserId: OWNER_A,
        now,
        rng: fixedRng(0)
      })
    ).toThrow(/not enabled/i);
  });

  it("enable auto-activates approved distribution when none active", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    service.patchSettings({
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      enabled: true
    });
    const config = service.ensureConfig(WS, OWNER_A);
    expect(config.enabled).toBe(true);
    expect(config.activeVersionId).not.toBeNull();
    expect(config.qualificationCreditPolicy).toBe("CYCLE_DEPOSITS_ALL");
  });

  it("freeze expires spin (ACTIVE only)", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);
    competition.status = "FROZEN";
    expect(() =>
      service.spin({
        workspaceId: WS,
        crmContactId: CONTACT,
        idempotencyKey: "frozen",
        actorUserId: OWNER_A,
        now,
        rng: fixedRng(0)
      })
    ).toThrow(/ACTIVE/i);
  });

  it("wheelPoints affect totalPoints ranking formula", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push(
      { workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT },
      { workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT_B }
    );
    enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now, CONTACT);
    addDeposit(store, competition, 5000, now, CONTACT_B);
    service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "rank-spin",
      actorUserId: OWNER_A,
      now,
      rng: alwaysPoints(40, [
        { points: 0, weight: 1 },
        { points: 10, weight: 1 },
        { points: 40, weight: 1 }
      ])
    });
    const a = store.standings.find((s) => s.crmContactId === CONTACT)!;
    const b = store.standings.find((s) => s.crmContactId === CONTACT_B)!;
    expect(a.totalPoints).toBe(a.depositPoints + a.wheelPoints);
    expect(a.totalPoints).toBeGreaterThan(b.totalPoints);
  });

  it("stores distribution version on spin", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const version = enableWheel(service);
    const now = new Date(competition.startsAt.getTime() + 60_000);
    addDeposit(store, competition, 4000, now);
    const spin = service.spin({
      workspaceId: WS,
      crmContactId: CONTACT,
      idempotencyKey: "ver",
      actorUserId: OWNER_A,
      now,
      rng: alwaysPoints(10, [
        { points: 0, weight: 1 },
        { points: 10, weight: 1 },
        { points: 40, weight: 1 }
      ])
    });
    expect(spin.spin.configVersionId).toBe(version.id);
  });

  it("defaults have no production distribution", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const config = service.ensureConfig(WS, OWNER_A);
    expect(config.enabled).toBe(false);
    expect(config.activeVersionId).toBeNull();
    expect(config.qualificationCreditPolicy).toBe("CYCLE_DEPOSITS_ALL");
    expect(store.versions).toHaveLength(0);
  });
});
