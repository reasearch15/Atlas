import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { competitionWindowContaining } from "./competition-schedule";
import { formatPersonalRankMessage } from "./telegram/personal-rank-message";
import { WHEEL_QUALIFICATION_CENTS } from "./leaderboard.constants";
import type { CompetitionRow, EventRow, StandingRow } from "./leaderboard.types";
import { WHEEL_ROLLING_WINDOW_MS } from "./wheel-qualification";
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
const HOUR = 60 * 60 * 1000;

function alwaysPoints(points: number, outcomes: Array<{ points: number; weight: number }>): WheelRng {
  const index = outcomes.findIndex((o) => o.points === points);
  if (index < 0) throw new Error(`points ${points} not in outcomes`);
  let total = 0;
  for (let i = 0; i < index; i += 1) total += Math.round(outcomes[i]!.weight * 1_000_000);
  return { nextInt: () => total };
}

function seedCompetition(
  store: WheelServiceStore,
  at = new Date("2026-08-16T04:51:00.000Z"),
  owner = OWNER_A
): CompetitionRow {
  const window = competitionWindowContaining(at);
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
    } satisfies StandingRow;
    store.standings.push(standing);
  }
  standing.qualifyingDepositCents += cents;
  standing.depositPoints += Math.floor(cents / 100);
  standing.totalPoints =
    standing.depositPoints + standing.referralPoints + standing.promotionPoints + standing.wheelPoints;
}

function reverseDeposit(
  store: WheelServiceStore,
  competition: CompetitionRow,
  cents: number,
  at: Date
): void {
  store.events.push({
    id: randomUUID(),
    workspaceId: WS,
    ownerCoadminUserId: competition.ownerCoadminUserId,
    competitionId: competition.id,
    crmContactId: CONTACT,
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
  });
  const standing = store.standings.find(
    (s) => s.competitionId === competition.id && s.crmContactId === CONTACT
  )!;
  standing.qualifyingDepositCents -= cents;
  standing.depositPoints -= Math.floor(cents / 100);
  standing.totalPoints =
    standing.depositPoints + standing.referralPoints + standing.promotionPoints + standing.wheelPoints;
}

function enableWheel(service: WheelService, now: Date, owner = OWNER_A): void {
  service.ensureApprovedDistributionVersion({
    workspaceId: WS,
    ownerCoadminUserId: owner,
    createdByUserId: owner,
    now
  });
  service.patchSettings({
    workspaceId: WS,
    ownerCoadminUserId: owner,
    enabled: true,
    now
  });
}

function spinTen(service: WheelService, now: Date): void {
  const outcomes = service.ensureApprovedDistributionVersion({
    workspaceId: WS,
    ownerCoadminUserId: OWNER_A,
    createdByUserId: OWNER_A,
    now
  }).rewardDistributionJson;
  service.spin({
    workspaceId: WS,
    crmContactId: CONTACT,
    idempotencyKey: randomUUID(),
    actorUserId: OWNER_A,
    now,
    rng: alwaysPoints(10, [...outcomes])
  });
}

describe("rolling 48h points-wheel qualification", () => {
  it("1. $10 deposit → $10/$40", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, now);
    addDeposit(store, competition, 1000, now);
    const status = service.getStatus(WS, OWNER_A, CONTACT, now);
    expect(status.qualifyingDepositCents).toBe(1000);
    expect(status.qualified).toBe(false);
    expect(status.available).toBe(false);
  });

  it("Picasso: global cycle 2→3 does not drop a 15h-old $10 deposit", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const depositAt = new Date("2026-08-15T13:29:00.000Z"); // 2026-08-15 19:14 Nepal
    const oldCycleBoundary = new Date("2026-08-16T02:00:00.000Z"); // 2026-08-16 07:45 Nepal
    const observedAt = new Date("2026-08-16T04:51:00.000Z"); // 2026-08-16 10:36 Nepal
    const priorSpinAt = new Date("2026-08-13T04:15:00.000Z");
    const competition = seedCompetition(store, observedAt);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    enableWheel(service, priorSpinAt);
    addDeposit(store, competition, 4000, new Date(priorSpinAt.getTime() - HOUR));
    spinTen(service, priorSpinAt);
    addDeposit(store, competition, 1000, depositAt);

    const beforeBoundary = service.getStatus(
      WS,
      OWNER_A,
      CONTACT,
      new Date(oldCycleBoundary.getTime() - 1)
    );
    expect(beforeBoundary.cycleSequence).toBe(2);
    expect(beforeBoundary.qualifyingDepositCents).toBe(1000);

    const afterBoundary = service.getStatus(WS, OWNER_A, CONTACT, oldCycleBoundary);
    expect(afterBoundary.cycleSequence).toBe(3);
    expect(afterBoundary.qualifyingDepositCents).toBe(1000);

    const later = service.getStatus(WS, OWNER_A, CONTACT, observedAt);
    expect(later.qualifyingDepositCents).toBe(1000);
    expect(later.qualified).toBe(false);
    expect(later.available).toBe(false);
    expect(store.events.filter((e) => e.type === "DEPOSIT" && e.depositAmountCents === 1000)).toHaveLength(
      1
    );

    const expiredAt = new Date(depositAt.getTime() + WHEEL_ROLLING_WINDOW_MS + 1);
    const expired = service.getStatus(WS, OWNER_A, CONTACT, expiredAt);
    expect(expired.qualifyingDepositCents).toBe(0);
  });

  it("3. $10+$15+$15 within 48h is available when cooldown is clear", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const t0 = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, t0);
    addDeposit(store, competition, 1000, t0);
    addDeposit(store, competition, 1500, new Date(t0.getTime() + 16 * HOUR));
    const t2 = new Date(t0.getTime() + 22 * HOUR);
    addDeposit(store, competition, 1500, t2);
    const status = service.getStatus(WS, OWNER_A, CONTACT, t2);
    expect(status.qualifyingDepositCents).toBe(4000);
    expect(status.qualified).toBe(true);
    expect(status.available).toBe(true);
  });

  it("4-5. first deposit older than 48h drops; exact 48h still counts", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const first = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, first);
    addDeposit(store, competition, 1000, first);
    addDeposit(store, competition, 1500, new Date(first.getTime() + HOUR));
    const at48h = new Date(first.getTime() + WHEEL_ROLLING_WINDOW_MS);
    expect(service.getStatus(WS, OWNER_A, CONTACT, at48h).qualifyingDepositCents).toBe(2500);
    expect(
      service.getStatus(WS, OWNER_A, CONTACT, new Date(at48h.getTime() + 1)).qualifyingDepositCents
    ).toBe(1500);
  });

  it("6-8. spin consumes qualification; same deposits cannot unlock again; new deposits start fresh", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, now);
    addDeposit(store, competition, 4000, now);
    spinTen(service, now);
    const afterSpin = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 1000));
    expect(afterSpin.available).toBe(false);
    expect(afterSpin.consumed).toBe(true);
    expect(afterSpin.qualifyingDepositCents).toBe(0);
    expect(() =>
      service.spin({
        workspaceId: WS,
        crmContactId: CONTACT,
        idempotencyKey: "second",
        actorUserId: OWNER_A,
        now: new Date(now.getTime() + 2000),
        rng: alwaysPoints(10, [{ points: 10, weight: 1 }])
      })
    ).toThrow(/last 48 hours/i);

    addDeposit(store, competition, 2000, new Date(now.getTime() + 3000));
    const building = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 4000));
    expect(building.qualifyingDepositCents).toBe(2000);
    expect(building.available).toBe(false);
  });

  it("9-10. $40 during cooldown is retained and becomes available after 48h without another deposit", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const spinAt = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, spinAt);
    addDeposit(store, competition, 4000, new Date(spinAt.getTime() - 1000));
    spinTen(service, spinAt);
    const topUpAt = new Date(spinAt.getTime() + HOUR);
    addDeposit(store, competition, 4000, topUpAt);
    const duringCooldown = service.getStatus(WS, OWNER_A, CONTACT, topUpAt);
    expect(duringCooldown.qualified).toBe(true);
    expect(duringCooldown.available).toBe(false);
    expect(duringCooldown.consumed).toBe(true);
    expect(duringCooldown.nextSpinAt).toBe(new Date(spinAt.getTime() + WHEEL_ROLLING_WINDOW_MS).toISOString());

    const readyAt = new Date(spinAt.getTime() + WHEEL_ROLLING_WINDOW_MS);
    const ready = service.getStatus(WS, OWNER_A, CONTACT, readyAt);
    expect(ready.qualifyingDepositCents).toBe(4000);
    expect(ready.qualified).toBe(true);
    expect(ready.available).toBe(true);
    expect(ready.consumed).toBe(false);
  });

  it("11. pre-spin reversal reduces rolling progress", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, now);
    addDeposit(store, competition, 4000, now);
    reverseDeposit(store, competition, 1000, new Date(now.getTime() + 1000));
    const status = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 1000));
    expect(status.qualifyingDepositCents).toBe(3000);
    expect(status.available).toBe(false);
  });

  it("12. post-spin reversal keeps awarded wheel points", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, now);
    addDeposit(store, competition, 4000, now);
    spinTen(service, now);
    reverseDeposit(store, competition, 4000, new Date(now.getTime() + 1000));
    const status = service.getStatus(WS, OWNER_A, CONTACT, new Date(now.getTime() + 1000));
    expect(status.qualificationInvalidated).toBe(true);
    expect(store.standings[0]!.wheelPoints).toBe(10);
  });

  it("13. refresh/re-read does not change valid progress", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, now);
    addDeposit(store, competition, 2500, now);
    const a = service.getStatus(WS, OWNER_A, CONTACT, now);
    const b = service.getStatus(WS, OWNER_A, CONTACT, now);
    expect(b.qualifyingDepositCents).toBe(2500);
    expect(b.qualifyingDepositCents).toBe(a.qualifyingDepositCents);
    expect(store.events.filter((e) => e.type === "DEPOSIT")).toHaveLength(1);
  });

  it("14. competition rollover keeps unconsumed rolling deposits and does not double-consume after a spin", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const firstWindow = competitionWindowContaining(new Date("2026-08-16T04:51:00.000Z"));
    const first: CompetitionRow = {
      id: randomUUID(),
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      sequence: firstWindow.sequence,
      startsAt: firstWindow.startsAt,
      endsAt: firstWindow.endsAt,
      status: "FINALIZED",
      prizePoolCents: 0,
      frozenAt: firstWindow.endsAt,
      finalizedAt: firstWindow.endsAt,
      finalizedByUserId: OWNER_A,
      finalizationIdempotencyKey: "fin",
      createdAt: firstWindow.startsAt,
      updatedAt: firstWindow.endsAt
    };
    store.competitions.push(first);
    const nextWindow = competitionWindowContaining(firstWindow.endsAt);
    const second: CompetitionRow = {
      id: randomUUID(),
      workspaceId: WS,
      ownerCoadminUserId: OWNER_A,
      sequence: nextWindow.sequence,
      startsAt: nextWindow.startsAt,
      endsAt: nextWindow.endsAt,
      status: "ACTIVE",
      prizePoolCents: 0,
      frozenAt: null,
      finalizedAt: null,
      finalizedByUserId: null,
      finalizationIdempotencyKey: null,
      createdAt: nextWindow.startsAt,
      updatedAt: nextWindow.startsAt
    };
    store.competitions.push(second);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const depositAt = new Date(firstWindow.endsAt.getTime() - 6 * HOUR);
    enableWheel(service, depositAt);
    addDeposit(store, first, 4000, depositAt);
    const justAfterRollover = new Date(second.startsAt.getTime() + 1000);
    const kept = service.getStatus(WS, OWNER_A, CONTACT, justAfterRollover);
    expect(kept.competitionId).toBe(second.id);
    expect(kept.qualifyingDepositCents).toBe(4000);
    expect(kept.available).toBe(true);

    spinTen(service, justAfterRollover);
    expect(store.spins).toHaveLength(1);
    expect(store.spins[0]!.competitionId).toBe(second.id);
    const afterSpin = service.getStatus(
      WS,
      OWNER_A,
      CONTACT,
      new Date(justAfterRollover.getTime() + 1000)
    );
    expect(afterSpin.qualifyingDepositCents).toBe(0);
    expect(afterSpin.available).toBe(false);
  });

  it("15. another Coadmin's deposits never affect this player", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const compA = seedCompetition(store, new Date("2026-08-16T04:51:00.000Z"), OWNER_A);
    const compB = seedCompetition(store, new Date("2026-08-16T04:51:00.000Z"), OWNER_B);
    store.participants.push(
      { workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT },
      { workspaceId: WS, ownerCoadminUserId: OWNER_B, crmContactId: CONTACT_B }
    );
    const now = new Date(compA.startsAt.getTime() + HOUR);
    enableWheel(service, now, OWNER_A);
    enableWheel(service, now, OWNER_B);
    addDeposit(store, compB, 4000, now, CONTACT_B, OWNER_B);
    addDeposit(store, compA, 1000, now, CONTACT, OWNER_A);
    expect(service.getStatus(WS, OWNER_A, CONTACT, now).qualifyingDepositCents).toBe(1000);
    expect(service.getStatus(WS, OWNER_B, CONTACT_B, now).qualifyingDepositCents).toBe(4000);
  });

  it("18. Telegram /rank copy and CRM status share the same backend fields", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, now);
    addDeposit(store, competition, 1000, now);
    const status = service.getStatus(WS, OWNER_A, CONTACT, now);
    const text = formatPersonalRankMessage({
      rank: 4,
      totalPoints: 10,
      pointsAbove: 5,
      pointsToTop3: 20,
      prizePoolCents: 10_000,
      endsAt: competition.endsAt,
      timezone: "America/Chicago",
      isFirst: false,
      wheelStatus: {
        qualifyingDepositCents: status.qualifyingDepositCents,
        qualificationCentsRequired: status.qualificationCentsRequired,
        available: status.available,
        consumed: status.consumed,
        qualified: status.qualified,
        nextSpinAt: status.nextSpinAt,
        pointsAwarded: status.pointsAwarded,
        cycleSequence: status.cycleSequence
      }
    });
    expect(text).toContain("$10 / $40");
    expect(text).toContain("$30 more qualifying deposits needed.");
    expect(text).not.toContain("Cycle");
    expect(text).not.toContain("this cycle");
  });

  it("17. leaderboard deposit-point scoring stays on the standing, not the wheel bar", () => {
    const store = createEmptyWheelStore();
    const service = new WheelService(store);
    const competition = seedCompetition(store);
    store.participants.push({ workspaceId: WS, ownerCoadminUserId: OWNER_A, crmContactId: CONTACT });
    const now = new Date(competition.startsAt.getTime() + HOUR);
    enableWheel(service, now);
    addDeposit(store, competition, 4000, now);
    expect(store.standings[0]!.depositPoints).toBe(40);
    expect(store.standings[0]!.qualifyingDepositCents).toBe(4000);
    expect(service.getStatus(WS, OWNER_A, CONTACT, now).qualificationCentsRequired).toBe(
      WHEEL_QUALIFICATION_CENTS
    );
  });
});
