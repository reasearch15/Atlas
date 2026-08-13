import { describe, expect, it } from "vitest";
import type { RequestUser } from "../auth/auth.types";
import { AppError } from "../../utils/errors";
import {
  decodeDepositHistoryCursor,
  encodeDepositHistoryCursor
} from "./deposit-history";
import { LeaderboardApiService } from "./leaderboard.api-service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const staffA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const staffB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const coadminId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";

const staffUserA: RequestUser = {
  id: staffA,
  email: "a@example.com",
  name: "Staff A",
  role: "STAFF",
  workspaceId,
  sessionId
};

const staffUserB: RequestUser = {
  ...staffUserA,
  id: staffB,
  email: "b@example.com",
  name: "Staff B"
};

const coadminUser: RequestUser = {
  id: coadminId,
  email: "co@example.com",
  name: "Coadmin",
  role: "COADMIN",
  workspaceId,
  sessionId
};

type FakeEvent = {
  id: string;
  crmContactId: string;
  depositAmountCents: number;
  pointsDelta: number;
  createdAt: Date;
  actorUserId: string | null;
  ownerCoadminUserId: string;
  workspaceId: string;
  type: string;
  crmContact: { displayName: string };
};

function makeEvents(): FakeEvent[] {
  const base = Date.UTC(2026, 7, 13, 20, 0, 0);
  const out: FakeEvent[] = [];
  for (let i = 0; i < 75; i++) {
    out.push({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      crmContactId: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      depositAmountCents: (i + 1) * 100,
      pointsDelta: i + 1,
      createdAt: new Date(base - i * 1000),
      actorUserId: staffA,
      ownerCoadminUserId: coadminId,
      workspaceId,
      type: "DEPOSIT",
      crmContact: { displayName: `Player${i}` }
    });
  }
  for (let i = 0; i < 10; i++) {
    out.push({
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
      crmContactId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
      depositAmountCents: 5000,
      pointsDelta: 50,
      createdAt: new Date(base - i * 1000 - 500),
      actorUserId: staffB,
      ownerCoadminUserId: coadminId,
      workspaceId,
      type: "DEPOSIT",
      crmContact: { displayName: `Other${i}` }
    });
  }
  return out;
}

function createPrisma(all: FakeEvent[]) {
  const calls: Array<{ where: unknown; orderBy: unknown; take: number }> = [];
  return {
    calls,
    prisma: {
      leaderboardEvent: {
        findMany: async ({
          where,
          orderBy,
          take
        }: {
          where: Record<string, unknown>;
          orderBy: unknown;
          take: number;
        }) => {
          calls.push({ where, orderBy, take });
          let filtered = all.filter((e) => {
            if (e.workspaceId !== where.workspaceId) return false;
            if (e.type !== where.type) return false;
            if (where.actorUserId && e.actorUserId !== where.actorUserId) return false;
            if (where.ownerCoadminUserId && e.ownerCoadminUserId !== where.ownerCoadminUserId) {
              return false;
            }
            const or = where.OR as
              | Array<{ createdAt?: { lt?: Date } | Date; id?: { lt?: string } }>
              | undefined;
            if (or) {
              const ltCreated = or[0]?.createdAt as { lt?: Date } | undefined;
              const sameCreated = or[1];
              const cursorCreated =
                ltCreated?.lt ??
                (sameCreated?.createdAt instanceof Date ? sameCreated.createdAt : undefined);
              const cursorId =
                typeof sameCreated?.id === "object" && sameCreated.id && "lt" in sameCreated.id
                  ? sameCreated.id.lt
                  : undefined;
              if (!cursorCreated || !cursorId) return false;
              const older =
                e.createdAt.getTime() < cursorCreated.getTime() ||
                (e.createdAt.getTime() === cursorCreated.getTime() && e.id < cursorId);
              if (!older) return false;
            }
            return true;
          });
          filtered = [...filtered].sort((a, b) => {
            const t = b.createdAt.getTime() - a.createdAt.getTime();
            if (t !== 0) return t;
            return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
          });
          return filtered.slice(0, take);
        }
      }
    }
  };
}

describe("LeaderboardApiService.listDepositHistory", () => {
  it("Staff A never sees Staff B deposits (including cursor tampering)", async () => {
    const all = makeEvents();
    const { prisma, calls } = createPrisma(all);
    const service = new LeaderboardApiService({ prisma } as never);

    const page = await service.listDepositHistory(staffUserA, { limit: 30 });
    expect(page.items.every((i) => !i.displayName.startsWith("Other"))).toBe(true);
    expect(calls[0]!.where).toMatchObject({
      workspaceId,
      type: "DEPOSIT",
      actorUserId: staffA
    });
    expect((calls[0]!.where as { ownerCoadminUserId?: string }).ownerCoadminUserId).toBeUndefined();

    // Staff A cannot widen scope via cursor belonging to Staff B's newest row.
    const bNewest = all.filter((e) => e.actorUserId === staffB).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    )[0]!;
    const foreignCursor = encodeDepositHistoryCursor({
      createdAt: bNewest.createdAt,
      id: bNewest.id
    });
    const page2 = await service.listDepositHistory(staffUserA, {
      cursor: foreignCursor,
      limit: 30
    });
    expect(page2.items.every((i) => !i.displayName.startsWith("Other"))).toBe(true);
    expect(calls[1]!.where).toMatchObject({ actorUserId: staffA });
  });

  it("Staff B history is isolated", async () => {
    const { prisma } = createPrisma(makeEvents());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserB, { limit: 30 });
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    expect(page.items.every((i) => i.displayName.startsWith("Other"))).toBe(true);
  });

  it("paginates 75 Staff A deposits as 30 + 30 + 15 without duplicates", async () => {
    const { prisma } = createPrisma(makeEvents());
    const service = new LeaderboardApiService({ prisma } as never);

    const p1 = await service.listDepositHistory(staffUserA, { limit: 30 });
    expect(p1.items).toHaveLength(30);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).toBeTruthy();

    const p2 = await service.listDepositHistory(staffUserA, {
      cursor: p1.nextCursor!,
      limit: 30
    });
    expect(p2.items).toHaveLength(30);
    expect(p2.hasMore).toBe(true);

    const p3 = await service.listDepositHistory(staffUserA, {
      cursor: p2.nextCursor!,
      limit: 30
    });
    expect(p3.items).toHaveLength(15);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();

    const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
    expect(ids).toHaveLength(75);
    expect(new Set(ids).size).toBe(75);
    // Newest first across pages
    expect(p1.items[0]!.createdAt >= p1.items[29]!.createdAt).toBe(true);
    expect(p1.items[29]!.createdAt >= p2.items[0]!.createdAt).toBe(true);
  });

  it("exactly 30 returns no second page", async () => {
    const all = makeEvents()
      .filter((e) => e.actorUserId === staffA)
      .slice(0, 30);
    const { prisma } = createPrisma(all);
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserA, { limit: 30 });
    expect(page.items).toHaveLength(30);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("10 deposits → single page", async () => {
    const all = makeEvents()
      .filter((e) => e.actorUserId === staffA)
      .slice(0, 10);
    const { prisma } = createPrisma(all);
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserA, { limit: 30 });
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
  });

  it("31 deposits → 30 then 1", async () => {
    const all = makeEvents()
      .filter((e) => e.actorUserId === staffA)
      .slice(0, 31);
    const { prisma } = createPrisma(all);
    const service = new LeaderboardApiService({ prisma } as never);
    const p1 = await service.listDepositHistory(staffUserA, { limit: 30 });
    expect(p1.items).toHaveLength(30);
    expect(p1.hasMore).toBe(true);
    const p2 = await service.listDepositHistory(staffUserA, {
      cursor: p1.nextCursor!,
      limit: 30
    });
    expect(p2.items).toHaveLength(1);
    expect(p2.hasMore).toBe(false);
    expect(p1.items.map((i) => i.id)).not.toContain(p2.items[0]!.id);
  });

  it("empty history returns empty page", async () => {
    const { prisma } = createPrisma([]);
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserA, {});
    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it("invalid cursor yields 400", async () => {
    const { prisma } = createPrisma([]);
    const service = new LeaderboardApiService({ prisma } as never);
    await expect(service.listDepositHistory(staffUserA, { cursor: "bad" })).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_CURSOR"
    } satisfies Partial<AppError>);
  });

  it("Coadmin scopes by ownerCoadminUserId (board-wide deposits)", async () => {
    const { prisma, calls } = createPrisma(makeEvents());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, { limit: 30 });
    expect(calls[0]!.where).toMatchObject({
      workspaceId,
      type: "DEPOSIT",
      ownerCoadminUserId: coadminId
    });
    expect((calls[0]!.where as { actorUserId?: string }).actorUserId).toBeUndefined();
    expect(page.items.length).toBe(30);
    expect(page.hasMore).toBe(true);
  });

  it("cursor round-trip matches last item of page", async () => {
    const { prisma } = createPrisma(makeEvents());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserA, { limit: 30 });
    const decoded = decodeDepositHistoryCursor(page.nextCursor!);
    expect(decoded.id).toBe(page.items[29]!.id);
    expect(decoded.createdAt.toISOString()).toBe(page.items[29]!.createdAt);
  });
});
