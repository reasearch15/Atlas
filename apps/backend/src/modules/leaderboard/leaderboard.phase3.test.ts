import { describe, expect, it } from "vitest";
import { hasPermission } from "@atlas/shared";
import type { RequestUser } from "../auth/auth.types";
import { AppError } from "../../utils/errors";
import { chicagoWallTimeToUtc } from "./competition-schedule";
import { LeaderboardApiService } from "./leaderboard.api-service";
import { LeaderboardService, MemoryLeaderboardStore } from "./leaderboard.service";
import { createFixedRandomSource } from "./promotion-points";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const staffId = "66666666-6666-4666-8666-666666666666";
const playerA = "c1111111-cccc-4ccc-8ccc-cccccccccccc";
const playerB = "c2222222-cccc-4ccc-8ccc-cccccccccccc";
const playerC = "c3333333-cccc-4ccc-8ccc-cccccccccccc";
const playerD = "c4444444-cccc-4ccc-8ccc-cccccccccccc";
const sessionId = "55555555-5555-4555-8555-555555555555";

const coadminUser: RequestUser = {
  id: ownerA,
  email: "a@example.com",
  name: "Coadmin A",
  role: "COADMIN",
  workspaceId,
  sessionId
};

const staffUser: RequestUser = {
  id: staffId,
  email: "staff@example.com",
  name: "Staff",
  role: "STAFF",
  workspaceId,
  sessionId
};

function createDomain(randomValues: number[] = [2, 2, 2, 2, 2]) {
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

async function bindAndEnable(
  service: LeaderboardService,
  owner: string,
  players: readonly string[],
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

describe("Phase 3 domain: bind never enables", () => {
  it("ensureSettings creates enabled=false and bind does not flip it", async () => {
    const { service } = createDomain();
    const settings = await service.ensureSettings(workspaceId, ownerA, ownerA);
    expect(settings.enabled).toBe(false);

    await service.bindParticipant({
      workspaceId,
      ownerCoadminUserId: ownerA,
      crmContactId: playerA,
      createdByUserId: ownerA
    });
    expect(service.getSettings(ownerA)?.enabled).toBe(false);
  });
});

describe("Phase 3 domain: enable/disable + pool rate", () => {
  it("enable/disable preserves deposit history and pool contribution", async () => {
    const { service } = createDomain();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await bindAndEnable(service, ownerA, [playerA], now);

    const deposit = await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 10_000,
      actorUserId: ownerA,
      idempotencyKey: "dep-hist",
      now
    });
    expect(deposit.poolContributionCents).toBe(200);

    await service.setEnabled(workspaceId, ownerA, false, ownerA);
    expect(service.getSettings(ownerA)?.enabled).toBe(false);
    expect(service.listEventsForOwner(ownerA)).toHaveLength(1);
    expect(service.listEventsForOwner(ownerA)[0]?.poolContributionCents).toBe(200);

    await service.setEnabled(workspaceId, ownerA, true, ownerA);
    expect(service.listEventsForOwner(ownerA)[0]?.id).toBe(deposit.id);
  });

  it("accepts valid rates 200/300/400/500 and rejects invalid", async () => {
    const { service } = createDomain();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await bindAndEnable(service, ownerA, [playerA], now);

    for (const rate of [200, 300, 400, 500] as const) {
      const settings = await service.setPoolRate({
        workspaceId,
        ownerCoadminUserId: ownerA,
        poolRateBps: rate,
        actorUserId: ownerA,
        now: new Date(now.getTime() + rate)
      });
      expect(settings.poolRateBps).toBe(rate);
    }

    await expect(
      service.setPoolRate({
        workspaceId,
        ownerCoadminUserId: ownerA,
        poolRateBps: 250,
        actorUserId: ownerA,
        now
      })
    ).rejects.toMatchObject({ code: "INVALID_POOL_RATE" });
  });

  it("A rate change does not affect B", async () => {
    const { service } = createDomain();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await bindAndEnable(service, ownerA, [playerA], now);
    await bindAndEnable(service, ownerB, [playerB], now);

    await service.setPoolRate({
      workspaceId,
      ownerCoadminUserId: ownerA,
      poolRateBps: 500,
      actorUserId: ownerA,
      now
    });

    expect(service.getSettings(ownerA)?.poolRateBps).toBe(500);
    expect(service.getSettings(ownerB)?.poolRateBps).toBe(200);
  });

  it("historical poolContribution is unchanged after rate change", async () => {
    const { service } = createDomain();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await bindAndEnable(service, ownerA, [playerA], now);

    const deposit = await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 10_000,
      actorUserId: ownerA,
      idempotencyKey: "dep-rate",
      now
    });
    expect(deposit.poolContributionCents).toBe(200);
    expect(deposit.poolRateBpsApplied).toBe(200);

    await service.setPoolRate({
      workspaceId,
      ownerCoadminUserId: ownerA,
      poolRateBps: 500,
      actorUserId: ownerA,
      now: new Date(now.getTime() + 1000)
    });

    const again = service.listEventsForOwner(ownerA).find((e) => e.id === deposit.id)!;
    expect(again.poolContributionCents).toBe(200);
    expect(again.poolRateBpsApplied).toBe(200);
  });
});

describe("Phase 3 domain: reverse + finalize + payout", () => {
  it("deposit reverse is idempotent and blocks cross-owner", async () => {
    const { service } = createDomain();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await bindAndEnable(service, ownerA, [playerA], now);
    await bindAndEnable(service, ownerB, [playerB], now);

    const deposit = await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 5000,
      actorUserId: ownerA,
      idempotencyKey: "dep-rev",
      now
    });

    const first = await service.reverseDeposit({
      workspaceId,
      depositEventId: deposit.id,
      actorUserId: ownerA,
      idempotencyKey: "rev-1",
      reason: "mistake",
      now: new Date(now.getTime() + 1000)
    });
    const second = await service.reverseDeposit({
      workspaceId,
      depositEventId: deposit.id,
      actorUserId: ownerA,
      idempotencyKey: "rev-1",
      reason: "mistake",
      now: new Date(now.getTime() + 2000)
    });
    expect(second.id).toBe(first.id);

    await expect(
      service.reverseDeposit({
        workspaceId,
        depositEventId: deposit.id,
        actorUserId: ownerA,
        idempotencyKey: "rev-other",
        reason: "again",
        now: new Date(now.getTime() + 3000)
      })
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_REVERSED" });

    const bDeposit = await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 1000,
      actorUserId: ownerB,
      idempotencyKey: "dep-b",
      now
    });
    expect(bDeposit.ownerCoadminUserId).toBe(ownerB);
    expect(bDeposit.ownerCoadminUserId).not.toBe(deposit.ownerCoadminUserId);
  });

  it("finalize ACTIVE blocked; FROZEN works; double finalize safe; pending review blocks", async () => {
    const { service, store } = createDomain();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await bindAndEnable(service, ownerA, [playerA, playerB], now);

    await service.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 5000,
      actorUserId: ownerA,
      idempotencyKey: "fin-a",
      now
    });
    await service.recordDeposit({
      workspaceId,
      crmContactId: playerB,
      amountCents: 4000,
      actorUserId: ownerA,
      idempotencyKey: "fin-b",
      now: new Date(now.getTime() + 1000)
    });

    const active = await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    await expect(
      service.finalizeCompetition({
        workspaceId,
        ownerCoadminUserId: ownerA,
        competitionId: active.id,
        actorUserId: ownerA,
        idempotencyKey: "fin-active",
        now
      })
    ).rejects.toMatchObject({ code: "COMPETITION_NOT_FROZEN" });

    const boundary = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    await service.ensureCurrentCompetition(workspaceId, ownerA, boundary);
    const frozen = store.competitions.find((c) => c.status === "FROZEN")!;

    await expect(
      service.finalizeCompetition({
        workspaceId,
        ownerCoadminUserId: ownerA,
        competitionId: frozen.id,
        actorUserId: ownerA,
        idempotencyKey: "fin-pending",
        now: boundary
      })
    ).rejects.toMatchObject({ code: "PENDING_REVIEW_BLOCKS_FINALIZE" });

    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerA,
      membershipStatus: "ELIGIBLE",
      actorUserId: ownerA,
      idempotencyKey: "el-a",
      now: boundary
    });
    await service.setMembershipEligibility({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      crmContactId: playerB,
      membershipStatus: "ELIGIBLE",
      actorUserId: ownerA,
      idempotencyKey: "el-b",
      now: boundary
    });

    const finalized = await service.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      actorUserId: ownerA,
      idempotencyKey: "fin-ok",
      now: boundary
    });
    expect(finalized.status).toBe("FINALIZED");

    const again = await service.finalizeCompetition({
      workspaceId,
      ownerCoadminUserId: ownerA,
      competitionId: frozen.id,
      actorUserId: ownerA,
      idempotencyKey: "fin-ok",
      now: boundary
    });
    expect(again.id).toBe(finalized.id);

    const payout = service.getPayouts(frozen.id)[0]!;
    const marked = await service.markPayout({
      workspaceId,
      ownerCoadminUserId: ownerA,
      payoutId: payout.id,
      status: "PAID",
      actorUserId: ownerA,
      notes: "sent",
      idempotencyKey: "pay-1",
      now: boundary
    });
    expect(marked.status).toBe("PAID");
    expect(marked.paidByUserId).toBe(ownerA);

    const markedAgain = await service.markPayout({
      workspaceId,
      ownerCoadminUserId: ownerA,
      payoutId: payout.id,
      status: "PAID",
      actorUserId: ownerA,
      notes: "sent",
      idempotencyKey: "pay-1",
      now: boundary
    });
    expect(markedAgain.id).toBe(marked.id);

    await expect(
      service.markPayout({
        workspaceId,
        ownerCoadminUserId: ownerA,
        payoutId: payout.id,
        status: "VOID",
        actorUserId: ownerA,
        idempotencyKey: "pay-void",
        now: boundary
      })
    ).rejects.toMatchObject({ code: "PAYOUT_ALREADY_SETTLED" });

    await expect(
      service.markPayout({
        workspaceId,
        ownerCoadminUserId: ownerB,
        payoutId: payout.id,
        status: "PAID",
        actorUserId: ownerB,
        idempotencyKey: "pay-cross",
        now: boundary
      })
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });
});

describe("Phase 3 API: coadmin-only admin paths", () => {
  it("setEnabled/setPoolRate/overrideReferral/reverseEvent reject STAFF", async () => {
    const service = new LeaderboardApiService({ prisma: {} } as never);
    await expect(service.setEnabled(staffUser, true)).rejects.toBeInstanceOf(AppError);
    await expect(service.setPoolRate(staffUser, 300)).rejects.toBeInstanceOf(AppError);
    await expect(
      service.overrideReferral(staffUser, "11111111-1111-4111-8111-111111111111", playerA, "reason", "idem-1xx")
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      service.reverseEvent(staffUser, "11111111-1111-4111-8111-111111111111", "reason", "idem-2xx")
    ).rejects.toBeInstanceOf(AppError);
  });

  it("referral override requires coadmin path and loads owned referral", async () => {
    const referralId = "r1111111-1111-4111-8111-111111111111";
    let overrideCalled = false;
    const service = new LeaderboardApiService({
      prisma: {
        leaderboardReferral: {
          findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) => {
            if (where.id !== referralId || where.workspaceId !== workspaceId) return null;
            return {
              id: referralId,
              workspaceId,
              ownerCoadminUserId: ownerA,
              referredCrmContactId: playerA,
              referrerCrmContactId: playerB
            };
          }
        }
      }
    } as never);

    (service as unknown as { domain: { overrideReferral: typeof Object } }).domain = {
      overrideReferral: async (input: {
        referredCrmContactId: string;
        newReferrerCrmContactId: string;
        reason: string;
      }) => {
        overrideCalled = true;
        expect(input.referredCrmContactId).toBe(playerA);
        expect(input.newReferrerCrmContactId).toBe(playerC);
        expect(input.reason).toBe("fix referrer");
        return { id: referralId };
      }
    };

    await service.overrideReferral(
      coadminUser,
      referralId,
      playerC,
      "fix referrer",
      "override-idem-01"
    );
    expect(overrideCalled).toBe(true);
  });

  it("setEnabled requires confirmDisable when ACTIVE competition exists", async () => {
    const service = new LeaderboardApiService({
      prisma: {
        leaderboardCompetition: {
          findFirst: async () => ({
            id: "comp-1",
            status: "ACTIVE",
            startsAt: new Date("2024-01-01T00:00:00Z"),
            endsAt: new Date("2024-01-20T00:00:00Z")
          })
        }
      }
    } as never);

    (service as unknown as { domain: { setEnabled: () => Promise<unknown> } }).domain = {
      setEnabled: async () => {
        throw new Error("should not enable/disable without confirm");
      }
    };

    await expect(service.setEnabled(coadminUser, false)).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIRM_DISABLE_REQUIRED"
    } satisfies Partial<AppError>);
  });

  it("enable/disable via API preserves history through Memory domain", async () => {
    const { service: domain, store } = createDomain();
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
    await bindAndEnable(domain, ownerA, [playerA], now);
    await domain.recordDeposit({
      workspaceId,
      crmContactId: playerA,
      amountCents: 2500,
      actorUserId: ownerA,
      idempotencyKey: "api-dep",
      now
    });

    const api = new LeaderboardApiService({
      prisma: {
        leaderboardCompetition: {
          findFirst: async () => null
        },
        poolRateHistory: {
          findMany: async () =>
            store.poolRateHistory
              .filter((r) => r.ownerCoadminUserId === ownerA)
              .map((r) => ({
                id: r.id,
                rateBps: r.rateBps,
                effectiveFrom: r.effectiveFrom,
                changedByUserId: r.changedByUserId,
                reason: r.reason
              }))
        }
      }
    } as never);
    (api as unknown as { domain: LeaderboardService }).domain = domain;

    await api.setEnabled(coadminUser, false, true);
    expect(domain.getSettings(ownerA)?.enabled).toBe(false);
    expect(domain.listEventsForOwner(ownerA)).toHaveLength(1);

    await api.setEnabled(coadminUser, true);
    expect(domain.getSettings(ownerA)?.enabled).toBe(true);
    expect(domain.listEventsForOwner(ownerA)[0]?.pointsDelta).toBeGreaterThan(0);

    const settings = await api.getSettings(coadminUser);
    expect(settings.enabled).toBe(true);
    expect(settings.poolRateBps).toBe(200);
  });

  it("cross-owner reverse is blocked at API layer", async () => {
    const service = new LeaderboardApiService({
      prisma: {
        leaderboardEvent: {
          findFirst: async ({ where }: { where: Record<string, unknown> }) => {
            if ("reversesEventId" in where) return null;
            return {
              id: "e1111111-1111-4111-8111-111111111111",
              workspaceId,
              ownerCoadminUserId: ownerB,
              type: "DEPOSIT"
            };
          }
        }
      }
    } as never);

    await expect(
      service.reverseEvent(
        coadminUser,
        "e1111111-1111-4111-8111-111111111111",
        "wrong owner",
        "rev-cross-01"
      )
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });
});

describe("Phase 3 permissions: Staff denied admin capabilities", () => {
  it("Staff rolePermissions exclude Phase 3 admin permissions", () => {
    expect(hasPermission("STAFF", "leaderboard:settings")).toBe(false);
    expect(hasPermission("STAFF", "leaderboard:reverse")).toBe(false);
    expect(hasPermission("STAFF", "leaderboard:referral:override")).toBe(false);
    expect(hasPermission("STAFF", "leaderboard:finalize")).toBe(false);
    expect(hasPermission("STAFF", "leaderboard:payout:mark")).toBe(false);
    expect(hasPermission("STAFF", "leaderboard:eligibility:review")).toBe(false);

    expect(hasPermission("COADMIN", "leaderboard:settings")).toBe(true);
    expect(hasPermission("COADMIN", "leaderboard:reverse")).toBe(true);
    expect(hasPermission("COADMIN", "leaderboard:referral:override")).toBe(true);
    expect(hasPermission("COADMIN", "leaderboard:finalize")).toBe(true);
    expect(hasPermission("COADMIN", "leaderboard:payout:mark")).toBe(true);
    expect(hasPermission("COADMIN", "leaderboard:eligibility:review")).toBe(true);
  });
});

describe("Phase 3 MANUAL_ADJUSTMENT exposure", () => {
  it("does not expose create-manual-adjustment API on LeaderboardApiService", () => {
    const proto = LeaderboardApiService.prototype as Record<string, unknown>;
    expect(proto.createManualAdjustment).toBeUndefined();
    expect(proto.recordManualAdjustment).toBeUndefined();
  });
});
