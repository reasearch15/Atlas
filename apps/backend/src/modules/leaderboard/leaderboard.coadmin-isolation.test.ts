import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "./competition-schedule";
import { LeaderboardService, MemoryLeaderboardStore } from "./leaderboard.service";
import { createFixedRandomSource } from "./promotion-points";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const coadminA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const coadminB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const playerA1 = "a1111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const playerA2 = "a2222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const playerB1 = "b1111111-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const playerB2 = "b2222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function setup() {
  const store = new MemoryLeaderboardStore();
  for (const id of [playerA1, playerA2, playerB1, playerB2]) {
    store.registerContact(id, workspaceId);
  }
  const service = new LeaderboardService(store, {
    random: createFixedRandomSource([2, 2, 2, 2]),
    requireEnabled: true
  });
  const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

  await service.ensureSettings(workspaceId, coadminA, coadminA);
  await service.setEnabled(workspaceId, coadminA, true, coadminA, now);
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: coadminA,
    crmContactId: playerA1,
    createdByUserId: coadminA
  });
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: coadminA,
    crmContactId: playerA2,
    createdByUserId: coadminA
  });
  await service.ensureCurrentCompetition(workspaceId, coadminA, now);

  await service.ensureSettings(workspaceId, coadminB, coadminB);
  await service.setEnabled(workspaceId, coadminB, true, coadminB, now);
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: coadminB,
    crmContactId: playerB1,
    createdByUserId: coadminB
  });
  await service.bindParticipant({
    workspaceId,
    ownerCoadminUserId: coadminB,
    crmContactId: playerB2,
    createdByUserId: coadminB
  });
  await service.ensureCurrentCompetition(workspaceId, coadminB, now);

  return { store, service, now };
}

describe("Phase 1.2 cross-coadmin isolation", () => {
  it("isolates deposits, pool, and standings between coadmins", async () => {
    const { service } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    const compA = await service.ensureCurrentCompetition(workspaceId, coadminA, now);
    const compB = await service.ensureCurrentCompetition(workspaceId, coadminB, now);
    expect(compA.id).not.toBe(compB.id);
    expect(compA.status).toBe("ACTIVE");
    expect(compB.status).toBe("ACTIVE");

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA1,
      amountCents: 10000,
      actorUserId: coadminA,
      idempotencyKey: "a1-dep",
      now
    });

    const standingA = service.listStandings(compA.id).find((s) => s.crmContactId === playerA1)!;
    expect(standingA.depositPoints).toBe(100);
    expect(service.getCompetition(compA.id)?.prizePoolCents).toBe(200);

    expect(service.listStandings(compB.id)).toHaveLength(0);
    expect(service.getCompetition(compB.id)?.prizePoolCents).toBe(0);
    expect(service.listEventsForOwner(coadminB)).toHaveLength(0);
    expect(service.listEventsForOwner(coadminA).every((e) => e.ownerCoadminUserId === coadminA)).toBe(true);
  });

  it("keeps settings independent per coadmin", async () => {
    const { service } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    await service.setPoolRate({
      workspaceId,
      ownerCoadminUserId: coadminA,
      poolRateBps: 500,
      actorUserId: coadminA,
      now
    });

    expect(service.getSettings(coadminA)?.poolRateBps).toBe(500);
    expect(service.getSettings(coadminB)?.poolRateBps).toBe(200);
    expect(service.getSettings(coadminB)?.enabled).toBe(true);
  });

  it("does not advance A referrals from B deposits", async () => {
    const { service, store } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    await service.setReferral({
      workspaceId,
      referrerCrmContactId: playerA1,
      referredCrmContactId: playerA2,
      actorUserId: coadminA,
      idempotencyKey: "ref-a",
      now
    });

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB1,
      amountCents: 25000,
      actorUserId: coadminB,
      idempotencyKey: "b-big",
      now
    });

    const referralA = store.referrals.find((r) => r.ownerCoadminUserId === coadminA)!;
    expect(service.getActiveMilestones(referralA.id)).toHaveLength(0);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA2,
      amountCents: 1000,
      actorUserId: coadminA,
      idempotencyKey: "a2-10",
      now: new Date(now.getTime() + 1000)
    });
    expect(service.getActiveMilestones(referralA.id).map((m) => m.milestoneCode)).toEqual(["FIRST_10"]);
  });

  it("keeps lifetime stats owner-scoped", async () => {
    const { service } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA1,
      amountCents: 5000,
      actorUserId: coadminA,
      idempotencyKey: "life-a",
      now
    });

    expect(service.getLifetimeCents(coadminA, playerA1)).toBe(5000);
    expect(service.getLifetimeCents(coadminB, playerA1)).toBe(0);
    expect(service.getLifetimeCents(coadminB, playerB1)).toBe(0);
  });

  it("isolates promotion rolling windows by owner", async () => {
    const { service } = await setup();
    const start = chicagoWallTimeToUtc("2024-01-10T10:00:00");

    const aFirst = await service.recordPromotion({
      workspaceId,
      crmContactId: playerA1,
      actorUserId: coadminA,
      idempotencyKey: "promo-a1",
      now: start
    });
    expect(aFirst.pointsDelta).toBe(2);

    // Same contact cannot exist under B; B1's first promo should still be random (not +1 from A's window).
    const bFirst = await service.recordPromotion({
      workspaceId,
      crmContactId: playerB1,
      actorUserId: coadminB,
      idempotencyKey: "promo-b1",
      now: new Date(start.getTime() + 3600_000)
    });
    expect(bFirst.pointsDelta).toBe(2);

    const aSecond = await service.recordPromotion({
      workspaceId,
      crmContactId: playerA1,
      actorUserId: coadminA,
      idempotencyKey: "promo-a1-2",
      now: new Date(start.getTime() + 2 * 3600_000)
    });
    expect(aSecond.pointsDelta).toBe(1);
  });

  it("freezes only the owner's competition", async () => {
    const { service, store } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA1,
      amountCents: 2000,
      actorUserId: coadminA,
      idempotencyKey: "a-freeze",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB1,
      amountCents: 3000,
      actorUserId: coadminB,
      idempotencyKey: "b-active",
      now
    });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    const nextA = await service.ensureCurrentCompetition(workspaceId, coadminA, boundary);
    const stillB = await service.ensureCurrentCompetition(workspaceId, coadminB, now);

    const frozenA = store.competitions.find(
      (c) => c.ownerCoadminUserId === coadminA && c.status === "FROZEN"
    );
    expect(frozenA).toBeTruthy();
    expect(nextA.status).toBe("ACTIVE");
    expect(stillB.status).toBe("ACTIVE");
    expect(stillB.prizePoolCents).toBe(60);
    expect(store.competitions.filter((c) => c.ownerCoadminUserId === coadminB && c.status === "FROZEN")).toHaveLength(
      0
    );
  });

  it("blocks eligibility ops through the wrong coadmin competition", async () => {
    const { service, store } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA1,
      amountCents: 5000,
      actorUserId: coadminA,
      idempotencyKey: "a-el",
      now
    });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, coadminA, boundary);
    const frozenA = store.competitions.find(
      (c) => c.ownerCoadminUserId === coadminA && c.status === "FROZEN"
    )!;

    await expect(
      service.setMembershipEligibility({
        workspaceId,
        ownerCoadminUserId: coadminB,
        competitionId: frozenA.id,
        crmContactId: playerA1,
        membershipStatus: "ELIGIBLE",
        actorUserId: coadminB,
        idempotencyKey: "tamper-el",
        now: boundary
      })
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    await expect(
      service.finalizeCompetition({
        workspaceId,
        ownerCoadminUserId: coadminB,
        competitionId: frozenA.id,
        actorUserId: coadminB,
        idempotencyKey: "tamper-fin",
        now: boundary
      })
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("rejects participant transfer and cross-owner referral/tampering", async () => {
    const { service, store } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    await expect(
      service.bindParticipant({
        workspaceId,
        ownerCoadminUserId: coadminB,
        crmContactId: playerA1,
        createdByUserId: coadminB
      })
    ).rejects.toMatchObject({ code: "PARTICIPANT_TRANSFER_UNSUPPORTED" });

    expect(service.resolveLeaderboardOwner(workspaceId, playerA1)).toBe(coadminA);

    await expect(
      service.setReferral({
        workspaceId,
        referrerCrmContactId: playerA1,
        referredCrmContactId: playerB1,
        actorUserId: coadminA,
        idempotencyKey: "cross-ref",
        now
      })
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });

    const unbound = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    store.registerContact(unbound, workspaceId);
    try {
      service.resolveLeaderboardOwner(workspaceId, unbound);
      expect.unreachable("expected PARTICIPANT_NOT_BOUND");
    } catch (error) {
      expect(error).toMatchObject({ code: "PARTICIPANT_NOT_BOUND" });
    }
  });

  it("owner-scoped reads never leak the other coadmin's board", async () => {
    const { service } = await setup();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA1,
      amountCents: 1000,
      actorUserId: coadminA,
      idempotencyKey: "leak-a",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB1,
      amountCents: 2000,
      actorUserId: coadminB,
      idempotencyKey: "leak-b",
      now
    });

    const compA = await service.ensureCurrentCompetition(workspaceId, coadminA, now);
    const compB = await service.ensureCurrentCompetition(workspaceId, coadminB, now);

    expect(service.listStandings(compA.id).map((s) => s.crmContactId)).toEqual([playerA1]);
    expect(service.listStandings(compB.id).map((s) => s.crmContactId)).toEqual([playerB1]);
    expect(service.listEventsForOwner(coadminA).every((e) => e.crmContactId === playerA1)).toBe(true);
    expect(service.listEventsForOwner(coadminB).every((e) => e.crmContactId === playerB1)).toBe(true);
    expect(service.getCompetition(compA.id)?.prizePoolCents).toBe(20);
    expect(service.getCompetition(compB.id)?.prizePoolCents).toBe(40);
  });
});
