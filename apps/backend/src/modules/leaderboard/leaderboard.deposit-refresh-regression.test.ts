import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the sequence-70 -> sequence-71 rollover bug: the first
 * deposit into a new ACTIVE competition enqueues best-effort cleanup of the
 * PREVIOUS competition's final leaderboard message
 * (REMOVE_FINAL_LEADERBOARD_BUTTONS). That cleanup must never gate refreshing the
 * CURRENT competition's live Telegram leaderboard (REFRESH_PUBLIC_LEADERBOARD) —
 * they are independent outcomes. Before the fix, `recordDeposit` used an
 * if/else that only ran the current-competition refresh when the cleanup job was
 * NOT created, so once a first-deposit cleanup job existed (even permanently
 * FAILED, e.g. "message to edit not found" retried 12 times), every subsequent
 * deposit into that competition silently stopped refreshing the live board too.
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const playerId = "b1e1e379-82bf-494c-aa45-0de204e72209";
const competitionId = "67683d90-6517-4616-a481-b7c1b51a5487";
const staffActor = "staff111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type RequestUser = import("../auth/auth.types").RequestUser;

function makeStandingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    crmContactId: playerId,
    rank: 1,
    totalPoints: 10,
    depositPoints: 10,
    qualifyingDepositCents: 1000,
    ...overrides
  };
}

async function buildService(options: {
  readonly firstDepositTransitionId: string | null;
  readonly processJobShouldThrow?: boolean;
  readonly depositAmountCents?: number;
}) {
  const { LeaderboardApiService } = await import("./leaderboard.api-service");
  const staffUser = { id: staffActor, role: "STAFF", workspaceId } as RequestUser;

  const projectCalls: Array<{ workspaceId: string; ownerCoadminUserId: string; competitionId: string | null | undefined }> = [];
  const firstDepositTransitionCalls: string[] = [];
  const processJobCalls: string[] = [];
  const warnLogs: Array<{ msg: string }> = [];

  const app = {
    prisma: {
      leaderboardCompetition: {
        findUniqueOrThrow: async () => ({
          id: competitionId,
          workspaceId,
          ownerCoadminUserId: ownerA,
          prizePoolCents: 500,
          endsAt: new Date("2026-10-01T00:00:00Z")
        })
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ $queryRaw: async () => [] as Array<{ id: string }> })
    },
    log: {
      warn: (_obj: unknown, msg?: string) => {
        warnLogs.push({ msg: msg ?? "" });
      },
      info: () => undefined,
      error: () => undefined
    }
  };

  const service = new LeaderboardApiService(app as never);
  const amountCents = options.depositAmountCents ?? 1000;

  (service as unknown as { domain: Record<string, unknown> }).domain = {
    resolveLeaderboardOwner: async () => ownerA,
    recordDeposit: async () => ({
      id: randomUUID(),
      competitionId,
      pointsDelta: 10,
      depositAmountCents: amountCents,
      occurredAt: new Date()
    })
  };
  (service as unknown as { assertActorMayMutatePlayer: () => Promise<void> }).assertActorMayMutatePlayer =
    async () => undefined;
  (service as unknown as { rankForContact: () => Promise<number | null> }).rankForContact = async () => 2;
  (service as unknown as {
    loadRankedStandings: () => Promise<ReturnType<typeof makeStandingRow>[]>;
  }).loadRankedStandings = async () => [makeStandingRow()];
  (service as unknown as {
    projectAfterMutation: (ws: string, owner: string, competitionId: string | null | undefined) => Promise<void>;
  }).projectAfterMutation = async (ws, owner, cid) => {
    projectCalls.push({ workspaceId: ws, ownerCoadminUserId: owner, competitionId: cid });
  };
  (service as unknown as { enqueueRecentReferralMilestoneDms: () => Promise<void> }).enqueueRecentReferralMilestoneDms =
    async () => undefined;
  (service as unknown as { safeRecomputeWheelQualification: () => Promise<void> }).safeRecomputeWheelQualification =
    async () => undefined;
  (service as unknown as {
    outbox: { enqueueFirstDepositTransition: (...args: unknown[]) => Promise<string | null> };
  }).outbox = {
    enqueueFirstDepositTransition: async (...args: unknown[]) => {
      firstDepositTransitionCalls.push(String(args[args.length - 1]));
      return options.firstDepositTransitionId;
    }
  };
  (service as unknown as { telegramProcessor: { processJob: (id: string) => Promise<void> } | undefined }).telegramProcessor =
    options.firstDepositTransitionId
      ? {
          processJob: async (id: string) => {
            processJobCalls.push(id);
            if (options.processJobShouldThrow) throw new Error("Bad Request: message to edit not found");
          }
        }
      : undefined;

  return { service, staffUser, projectCalls, firstDepositTransitionCalls, processJobCalls, warnLogs };
}

describe("recordDeposit: current-competition refresh is independent of previous-competition cleanup", () => {
  it("1) first deposit in a new ACTIVE competition enqueues cleanup AND still refreshes the current competition", async () => {
    const { service, staffUser, projectCalls, firstDepositTransitionCalls, processJobCalls } = await buildService({
      firstDepositTransitionId: "cleanup-job-1"
    });

    await service.recordDeposit(staffUser, { crmContactId: playerId, amountCents: 1000, idempotencyKey: "dep-1" });

    expect(firstDepositTransitionCalls).toEqual([competitionId]);
    expect(processJobCalls).toEqual(["cleanup-job-1"]); // cleanup was attempted
    expect(projectCalls).toEqual([{ workspaceId, ownerCoadminUserId: ownerA, competitionId }]); // AND refresh ran
  });

  it("2) previous Telegram final message missing (cleanup throws) — current leaderboard still refreshes, no blocking/throw to the caller", async () => {
    const { service, staffUser, projectCalls, processJobCalls, warnLogs } = await buildService({
      firstDepositTransitionId: "cleanup-job-2",
      processJobShouldThrow: true
    });

    const result = await service.recordDeposit(staffUser, {
      crmContactId: playerId,
      amountCents: 1000,
      idempotencyKey: "dep-2"
    });

    expect(result.pointsAdded).toBe(10);
    expect(processJobCalls).toEqual(["cleanup-job-2"]);
    expect(projectCalls).toEqual([{ workspaceId, ownerCoadminUserId: ownerA, competitionId }]);
    expect(warnLogs.some((l) => l.msg === "leaderboard.first_deposit_transition.immediate_process_failed")).toBe(true);
  });

  it("3) second/subsequent deposit into the same competition keeps refreshing (cleanup job already exists/failed)", async () => {
    // enqueueFirstDepositTransition keeps returning the same (now-terminal, e.g.
    // permanently FAILED) job id on every later call — this must never suppress
    // the independent current-competition refresh.
    const { service, staffUser, projectCalls } = await buildService({
      firstDepositTransitionId: "cleanup-job-3",
      processJobShouldThrow: true
    });

    await service.recordDeposit(staffUser, { crmContactId: playerId, amountCents: 1000, idempotencyKey: "dep-3a" });
    await service.recordDeposit(staffUser, { crmContactId: playerId, amountCents: 2400, idempotencyKey: "dep-3b" });

    expect(projectCalls).toHaveLength(2);
    expect(projectCalls.every((c) => c.competitionId === competitionId)).toBe(true);
  });

  it("no cleanup needed (no previous final message) — refresh still runs exactly once", async () => {
    const { service, staffUser, projectCalls, processJobCalls } = await buildService({
      firstDepositTransitionId: null
    });

    await service.recordDeposit(staffUser, { crmContactId: playerId, amountCents: 1000, idempotencyKey: "dep-4" });

    expect(processJobCalls).toEqual([]);
    expect(projectCalls).toEqual([{ workspaceId, ownerCoadminUserId: ownerA, competitionId }]);
  });
});

describe("4) other score mutations keep triggering refresh unconditionally (unaffected by the deposit fix)", () => {
  it("recordPromotion always calls projectAfterMutation directly (no cleanup gating exists on this path)", async () => {
    const { LeaderboardApiService } = await import("./leaderboard.api-service");
    const staffUser = { id: staffActor, role: "STAFF", workspaceId } as RequestUser;
    const projectCalls: string[] = [];

    const app = {
      prisma: {
        leaderboardCompetition: {
          findUniqueOrThrow: async () => ({
            id: competitionId,
            workspaceId,
            ownerCoadminUserId: ownerA,
            prizePoolCents: 0,
            endsAt: new Date("2026-10-01T00:00:00Z")
          })
        }
      },
      log: { warn: () => undefined, info: () => undefined, error: () => undefined }
    };
    const service = new LeaderboardApiService(app as never);

    (service as unknown as { domain: Record<string, unknown> }).domain = {
      resolveLeaderboardOwner: async () => ownerA,
      recordPromotion: async () => ({ id: randomUUID(), competitionId, pointsDelta: 2 })
    };
    (service as unknown as { assertActorMayMutatePlayer: () => Promise<void> }).assertActorMayMutatePlayer =
      async () => undefined;
    (service as unknown as { rankForContact: () => Promise<number | null> }).rankForContact = async () => 3;
    (service as unknown as {
      loadRankedStandings: () => Promise<ReturnType<typeof makeStandingRow>[]>;
    }).loadRankedStandings = async () => [makeStandingRow({ totalPoints: 2, depositPoints: 0 })];
    (service as unknown as {
      projectAfterMutation: (ws: string, owner: string, competitionId: string | null | undefined) => Promise<void>;
    }).projectAfterMutation = async (_ws, owner, cid) => {
      projectCalls.push(`${owner}:${cid}`);
    };

    await service.recordPromotion(staffUser, { crmContactId: playerId, idempotencyKey: "promo-1" });
    expect(projectCalls).toEqual([`${ownerA}:${competitionId}`]);
  });
});
