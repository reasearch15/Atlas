import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_POOL_RATE_BPS,
  LEADERBOARD_TIMEZONE
} from "./leaderboard.constants";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";

type SettingsRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  enabled: boolean;
  poolRateBps: number;
  timezone: string;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type HistoryRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  rateBps: number;
  effectiveFrom: Date;
  changedByUserId: string | null;
  reason: string | null;
};

/**
 * Simulates PostgreSQL interactive-transaction semantics for settings init races:
 * - unique violation aborts the transaction (subsequent queries throw 25P02)
 * - upsert is atomic (INSERT … ON CONFLICT) and does not abort
 */
function createConcurrentSettingsPrisma() {
  const settings = new Map<string, SettingsRow>();
  const history: HistoryRow[] = [];
  /** Per-owner mutex so concurrent upserts serialize like ON CONFLICT. */
  const ownerLocks = new Map<string, Promise<void>>();

  async function withOwnerLock<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = ownerLocks.get(ownerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ownerLocks.set(
      ownerId,
      prev.then(() => gate)
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function createTxClient() {
    let aborted = false;

    function assertNotAborted() {
      if (aborted) {
        const err = new Error(
          "current transaction is aborted, commands ignored until end of transaction block"
        ) as Error & { code: string };
        err.code = "25P02";
        throw err;
      }
    }

    const leaderboardSettings = {
      findUnique: async ({ where }: { where: { ownerCoadminUserId: string } }) => {
        assertNotAborted();
        // Yield so concurrent callers can interleave before create/upsert.
        await Promise.resolve();
        return settings.get(where.ownerCoadminUserId) ?? null;
      },
      findUniqueOrThrow: async ({ where }: { where: { ownerCoadminUserId: string } }) => {
        assertNotAborted();
        const row = settings.get(where.ownerCoadminUserId);
        if (!row) throw new Error("Record to findUniqueOrThrow not found");
        return row;
      },
      create: async ({ data }: { data: Omit<SettingsRow, "id" | "createdAt" | "updatedAt"> }) => {
        assertNotAborted();
        await Promise.resolve();
        if (settings.has(data.ownerCoadminUserId)) {
          aborted = true;
          const err = new Error("Unique constraint failed on owner_coadmin_user_id") as Error & {
            code: string;
          };
          err.code = "P2002";
          throw err;
        }
        const row: SettingsRow = {
          id: randomUUID(),
          workspaceId: data.workspaceId,
          ownerCoadminUserId: data.ownerCoadminUserId,
          enabled: data.enabled,
          poolRateBps: data.poolRateBps,
          timezone: data.timezone,
          updatedByUserId: data.updatedByUserId,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        settings.set(row.ownerCoadminUserId, row);
        return row;
      },
      upsert: async ({
        where,
        create
      }: {
        where: { ownerCoadminUserId: string };
        create: Omit<SettingsRow, "id" | "createdAt" | "updatedAt">;
        update: Record<string, unknown>;
      }) => {
        assertNotAborted();
        return withOwnerLock(where.ownerCoadminUserId, async () => {
          await Promise.resolve();
          const existing = settings.get(where.ownerCoadminUserId);
          if (existing) return existing;
          const row: SettingsRow = {
            id: randomUUID(),
            workspaceId: create.workspaceId,
            ownerCoadminUserId: create.ownerCoadminUserId,
            enabled: create.enabled,
            poolRateBps: create.poolRateBps,
            timezone: create.timezone,
            updatedByUserId: create.updatedByUserId,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          settings.set(row.ownerCoadminUserId, row);
          return row;
        });
      }
    };

    const poolRateHistory = {
      findFirst: async ({ where }: { where: { ownerCoadminUserId: string } }) => {
        assertNotAborted();
        return history.find((h) => h.ownerCoadminUserId === where.ownerCoadminUserId) ?? null;
      },
      create: async ({
        data
      }: {
        data: {
          workspaceId: string;
          ownerCoadminUserId: string;
          rateBps: number;
          effectiveFrom: Date;
          changedByUserId: string | null;
          reason: string | null;
        };
      }) => {
        assertNotAborted();
        const row: HistoryRow = {
          id: randomUUID(),
          workspaceId: data.workspaceId,
          ownerCoadminUserId: data.ownerCoadminUserId,
          rateBps: data.rateBps,
          effectiveFrom: data.effectiveFrom,
          changedByUserId: data.changedByUserId,
          reason: data.reason
        };
        history.push(row);
        return row;
      }
    };

    return { leaderboardSettings, poolRateHistory, get aborted() { return aborted; } };
  }

  const prisma = {
    leaderboardSettings: {
      findUnique: async ({ where }: { where: { ownerCoadminUserId: string } }) =>
        settings.get(where.ownerCoadminUserId) ?? null,
      findMany: async () => [...settings.values()]
    },
    poolRateHistory: {
      findMany: async ({ where }: { where?: { ownerCoadminUserId?: string } } = {}) =>
        where?.ownerCoadminUserId
          ? history.filter((h) => h.ownerCoadminUserId === where.ownerCoadminUserId)
          : [...history]
    },
    $transaction: async <T>(fn: (tx: ReturnType<typeof createTxClient>) => Promise<T>) => {
      const tx = createTxClient();
      return fn(tx);
    },
    _settings: settings,
    _history: history
  };

  return prisma as unknown as PrismaClient & {
    _settings: Map<string, SettingsRow>;
    _history: HistoryRow[];
  };
}

describe("ensureSettings concurrency (PrismaLeaderboardService)", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

  it("20 concurrent ensureSettings for one owner → one row, all succeed, no P2002/25P02", async () => {
    const prisma = createConcurrentSettingsPrisma();
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: async () => undefined } as never
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.ensureSettings(workspaceId, ownerA, ownerA))
    );

    expect(results).toHaveLength(20);
    expect(prisma._settings.size).toBe(1);
    const only = prisma._settings.get(ownerA)!;
    expect(only.ownerCoadminUserId).toBe(ownerA);
    expect(only.workspaceId).toBe(workspaceId);
    expect(only.enabled).toBe(false);
    expect(only.poolRateBps).toBe(DEFAULT_POOL_RATE_BPS);
    expect(only.timezone).toBe(LEADERBOARD_TIMEZONE);
    for (const row of results) {
      expect(row.id).toBe(only.id);
      expect(row.ownerCoadminUserId).toBe(ownerA);
    }
    expect(prisma._history.filter((h) => h.ownerCoadminUserId === ownerA).length).toBeGreaterThanOrEqual(1);
  });

  it("20 A + 20 B concurrent → one settings row each, no cross-owner leakage", async () => {
    const prisma = createConcurrentSettingsPrisma();
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: async () => undefined } as never
    });

    const results = await Promise.all([
      ...Array.from({ length: 20 }, () => service.ensureSettings(workspaceId, ownerA, ownerA)),
      ...Array.from({ length: 20 }, () => service.ensureSettings(workspaceId, ownerB, ownerB))
    ]);

    expect(prisma._settings.size).toBe(2);
    expect(prisma._settings.get(ownerA)?.ownerCoadminUserId).toBe(ownerA);
    expect(prisma._settings.get(ownerB)?.ownerCoadminUserId).toBe(ownerB);
    expect(prisma._settings.get(ownerA)?.id).not.toBe(prisma._settings.get(ownerB)?.id);

    const aResults = results.slice(0, 20);
    const bResults = results.slice(20);
    for (const row of aResults) {
      expect(row.ownerCoadminUserId).toBe(ownerA);
      expect(row.id).toBe(prisma._settings.get(ownerA)!.id);
    }
    for (const row of bResults) {
      expect(row.ownerCoadminUserId).toBe(ownerB);
      expect(row.id).toBe(prisma._settings.get(ownerB)!.id);
    }
  });

  it("documents why create→catch P2002→findUniqueOrThrow fails with 25P02", async () => {
    const prisma = createConcurrentSettingsPrisma();
    // Seed winner row by completing one create transaction first.
    await prisma.$transaction(async (tx: any) => {
      await tx.leaderboardSettings.create({
        data: {
          workspaceId,
          ownerCoadminUserId: ownerA,
          enabled: false,
          poolRateBps: DEFAULT_POOL_RATE_BPS,
          timezone: LEADERBOARD_TIMEZONE,
          updatedByUserId: null
        }
      });
    });

    await expect(
      prisma.$transaction(async (tx: any) => {
        try {
          await tx.leaderboardSettings.create({
            data: {
              workspaceId,
              ownerCoadminUserId: ownerA,
              enabled: false,
              poolRateBps: DEFAULT_POOL_RATE_BPS,
              timezone: LEADERBOARD_TIMEZONE,
              updatedByUserId: null
            }
          });
        } catch (error) {
          expect((error as { code?: string }).code).toBe("P2002");
          // Same anti-pattern as the old ensureSettingsTx recovery path:
          await tx.leaderboardSettings.findUniqueOrThrow({
            where: { ownerCoadminUserId: ownerA }
          });
        }
      })
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
