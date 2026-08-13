import { describe, expect, it } from "vitest";
import type { RequestUser } from "../auth/auth.types";
import { AppError } from "../../utils/errors";
import {
  decodeDepositHistoryCursor,
  encodeDepositHistoryCursor,
  formatDepositHistoryRecordedBy
} from "./deposit-history";
import { LeaderboardApiService } from "./leaderboard.api-service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const staffA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const staffB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const coadminId = "44444444-4444-4444-8444-444444444444";
const otherCoadminId = "66666666-6666-4666-8666-666666666666";
const sessionId = "55555555-5555-4555-8555-555555555555";
const competitionActive = "77777777-7777-4777-8777-777777777771";
const competitionFrozen = "77777777-7777-4777-8777-777777777772";
const picassoId = "99999999-9999-4999-8999-999999999901";
const jakeId = "99999999-9999-4999-8999-999999999902";

const staffUserA: RequestUser = {
  id: staffA,
  email: "a@example.com",
  name: "Bella",
  role: "STAFF",
  workspaceId,
  sessionId
};

const staffUserB: RequestUser = {
  ...staffUserA,
  id: staffB,
  email: "b@example.com",
  name: "Sakura"
};

const coadminUser: RequestUser = {
  id: coadminId,
  email: "co@example.com",
  name: "Charlie",
  role: "COADMIN",
  workspaceId,
  sessionId
};

const otherCoadminUser: RequestUser = {
  id: otherCoadminId,
  email: "other@example.com",
  name: "Other Coadmin",
  role: "COADMIN",
  workspaceId,
  sessionId
};

type FakeActor = {
  id: string;
  name: string;
  username: string | null;
  role: "STAFF" | "COADMIN";
};

type FakeEvent = {
  id: string;
  crmContactId: string;
  competitionId: string;
  depositAmountCents: number;
  pointsDelta: number;
  createdAt: Date;
  actorUserId: string | null;
  ownerCoadminUserId: string;
  workspaceId: string;
  type: string;
  crmContact: {
    displayName: string;
    username: string | null;
    chats: Array<{
      firstName: string | null;
      lastName: string | null;
      username: string | null;
    }>;
  };
  actor: FakeActor | null;
};

const actors: Record<string, FakeActor> = {
  [staffA]: { id: staffA, name: "Bella", username: "bella", role: "STAFF" },
  [staffB]: { id: staffB, name: "Sakura", username: "sakura", role: "STAFF" },
  [coadminId]: { id: coadminId, name: "Charlie", username: "charlie", role: "COADMIN" },
  [otherCoadminId]: {
    id: otherCoadminId,
    name: "Other Coadmin",
    username: "other",
    role: "COADMIN"
  }
};

function contact(
  displayName: string,
  opts?: {
    username?: string | null;
    chats?: FakeEvent["crmContact"]["chats"];
  }
): FakeEvent["crmContact"] {
  return {
    displayName,
    username: opts?.username ?? null,
    chats: opts?.chats ?? []
  };
}

function makeEvent(
  partial: Omit<FakeEvent, "workspaceId" | "type" | "crmContact" | "actor"> & {
    crmContact?: FakeEvent["crmContact"];
  }
): FakeEvent {
  const actor = partial.actorUserId ? actors[partial.actorUserId] ?? null : null;
  return {
    workspaceId,
    type: "DEPOSIT",
    crmContact: partial.crmContact ?? contact("Player"),
    actor,
    ...partial
  };
}

function makeStaffPages(): FakeEvent[] {
  const base = Date.UTC(2026, 7, 13, 20, 0, 0);
  const out: FakeEvent[] = [];
  for (let i = 0; i < 75; i++) {
    out.push(
      makeEvent({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        crmContactId: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
        competitionId: competitionActive,
        depositAmountCents: (i + 1) * 100,
        pointsDelta: i + 1,
        createdAt: new Date(base - i * 1000),
        actorUserId: staffA,
        ownerCoadminUserId: coadminId,
        crmContact: contact(`Player${i}`)
      })
    );
  }
  for (let i = 0; i < 10; i++) {
    out.push(
      makeEvent({
        id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
        crmContactId: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
        competitionId: competitionActive,
        depositAmountCents: 5000,
        pointsDelta: 50,
        createdAt: new Date(base - i * 1000 - 500),
        actorUserId: staffB,
        ownerCoadminUserId: coadminId,
        crmContact: contact(`Other${i}`)
      })
    );
  }
  return out;
}

function makeCharlieBoard(): FakeEvent[] {
  const base = Date.UTC(2026, 7, 13, 20, 0, 0);
  const out: FakeEvent[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(
      makeEvent({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
        crmContactId: i === 0 ? picassoId : `aaaaaaaa-1111-4111-8111-${String(i).padStart(12, "0")}`,
        competitionId: competitionActive,
        depositAmountCents: 4000,
        pointsDelta: 40,
        createdAt: new Date(base - i * 60_000),
        actorUserId: staffA,
        ownerCoadminUserId: coadminId,
        crmContact:
          i === 0
            ? contact("Unknown User", {
                chats: [{ firstName: "Picasso", lastName: null, username: "picasso_tg" }]
              })
            : contact(`BellaPlayer${i}`)
      })
    );
  }
  for (let i = 0; i < 15; i++) {
    out.push(
      makeEvent({
        id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
        crmContactId: jakeId,
        competitionId: i < 5 ? competitionFrozen : competitionActive,
        depositAmountCents: 2000,
        pointsDelta: 20,
        createdAt: new Date(base - (10 + i) * 60_000),
        actorUserId: staffB,
        ownerCoadminUserId: coadminId,
        crmContact: contact("Jake")
      })
    );
  }
  for (let i = 0; i < 2; i++) {
    out.push(
      makeEvent({
        id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}`,
        crmContactId: `cccccccc-1111-4111-8111-${String(i).padStart(12, "0")}`,
        competitionId: competitionFrozen,
        depositAmountCents: 1000,
        pointsDelta: 10,
        createdAt: new Date(base - (30 + i) * 60_000),
        actorUserId: coadminId,
        ownerCoadminUserId: coadminId,
        crmContact: contact(`CharliePlayer${i}`)
      })
    );
  }
  // Foreign coadmin deposits — must never leak.
  for (let i = 0; i < 5; i++) {
    out.push(
      makeEvent({
        id: `dddddddd-dddd-4ddd-8ddd-${String(i).padStart(12, "0")}`,
        crmContactId: `dddddddd-1111-4111-8111-${String(i).padStart(12, "0")}`,
        competitionId: competitionActive,
        depositAmountCents: 99900,
        pointsDelta: 999,
        createdAt: new Date(base - i * 1000),
        actorUserId: otherCoadminId,
        ownerCoadminUserId: otherCoadminId,
        crmContact: contact(`Foreign${i}`)
      })
    );
  }
  return out;
}

function createPrisma(all: FakeEvent[], participants: string[] = [picassoId, jakeId]) {
  const calls: Array<{ where: unknown; orderBy: unknown; take: number }> = [];
  return {
    calls,
    prisma: {
      user: {
        findFirst: async ({
          where
        }: {
          where: { id?: string; workspaceId?: string; role?: string };
        }) => {
          const actor = where.id ? actors[where.id] : null;
          if (!actor) return null;
          if (where.workspaceId && where.workspaceId !== workspaceId) return null;
          if (where.role && actor.role !== where.role) return null;
          return { id: actor.id };
        }
      },
      leaderboardParticipant: {
        findFirst: async ({
          where
        }: {
          where: { workspaceId: string; ownerCoadminUserId: string; crmContactId: string };
        }) => {
          if (where.workspaceId !== workspaceId) return null;
          if (where.ownerCoadminUserId !== coadminId) return null;
          if (!participants.includes(where.crmContactId)) return null;
          return { id: `part-${where.crmContactId}` };
        }
      },
      leaderboardEvent: {
        findFirst: async ({
          where
        }: {
          where: Record<string, unknown>;
        }) => {
          return (
            all.find(
              (e) =>
                e.workspaceId === where.workspaceId &&
                e.ownerCoadminUserId === where.ownerCoadminUserId &&
                e.crmContactId === where.crmContactId &&
                e.type === where.type
            ) ?? null
          );
        },
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
            if (where.crmContactId && e.crmContactId !== where.crmContactId) return false;
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

describe("formatDepositHistoryRecordedBy", () => {
  it("labels coadmin actors and falls back to Unknown", () => {
    expect(formatDepositHistoryRecordedBy({ name: "Charlie", role: "COADMIN" })).toEqual({
      recordedByDisplayName: "Charlie (Coadmin)",
      recordedByIsCoadmin: true
    });
    expect(formatDepositHistoryRecordedBy({ name: "Bella", role: "STAFF" })).toEqual({
      recordedByDisplayName: "Bella",
      recordedByIsCoadmin: false
    });
    expect(formatDepositHistoryRecordedBy(null)).toEqual({
      recordedByDisplayName: "Unknown",
      recordedByIsCoadmin: false
    });
  });
});

describe("LeaderboardApiService.listDepositHistory", () => {
  it("A: Staff isolation — Bella never sees Sakura deposits", async () => {
    const all = makeStaffPages();
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
    expect(page.items[0]!.recordedByDisplayName).toBe("Bella");

    // Staff cannot widen via foreign cursor or actorUserId query param.
    const bNewest = all
      .filter((e) => e.actorUserId === staffB)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    const foreignCursor = encodeDepositHistoryCursor({
      createdAt: bNewest.createdAt,
      id: bNewest.id
    });
    const page2 = await service.listDepositHistory(staffUserA, {
      cursor: foreignCursor,
      limit: 30,
      actorUserId: staffB
    });
    expect(page2.items.every((i) => !i.displayName.startsWith("Other"))).toBe(true);
    expect(calls[1]!.where).toMatchObject({ actorUserId: staffA });
  });

  it("A: Sakura history is isolated", async () => {
    const { prisma } = createPrisma(makeStaffPages());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserB, { limit: 30 });
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    expect(page.items.every((i) => i.displayName.startsWith("Other"))).toBe(true);
    expect(page.items.every((i) => i.recordedByDisplayName === "Sakura")).toBe(true);
  });

  it("B: Coadmin aggregation includes Bella + Sakura + Charlie with Recorded by", async () => {
    const { prisma, calls } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const p1 = await service.listDepositHistory(coadminUser, { limit: 30 });
    expect(calls[0]!.where).toMatchObject({
      workspaceId,
      type: "DEPOSIT",
      ownerCoadminUserId: coadminId
    });
    expect((calls[0]!.where as { actorUserId?: string }).actorUserId).toBeUndefined();
    expect(p1.items).toHaveLength(27);
    expect(p1.hasMore).toBe(false);

    const recorded = new Set(p1.items.map((i) => i.recordedByDisplayName));
    expect(recorded.has("Bella")).toBe(true);
    expect(recorded.has("Sakura")).toBe(true);
    expect(recorded.has("Charlie (Coadmin)")).toBe(true);
    expect(p1.items.some((i) => i.displayName.startsWith("Foreign"))).toBe(false);
  });

  it("C: Cross-coadmin isolation", async () => {
    const { prisma } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(otherCoadminUser, { limit: 30 });
    expect(page.items).toHaveLength(5);
    expect(page.items.every((i) => i.displayName.startsWith("Foreign"))).toBe(true);
    expect(page.items.every((i) => i.recordedByDisplayName === "Other Coadmin (Coadmin)")).toBe(
      true
    );
  });

  it("D: 10 deposits → single page hasMore false", async () => {
    const all = makeStaffPages()
      .filter((e) => e.actorUserId === staffA)
      .slice(0, 10);
    const { prisma } = createPrisma(all);
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserA, { limit: 30 });
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
  });

  it("E: exactly 30 → no second page", async () => {
    const all = makeStaffPages()
      .filter((e) => e.actorUserId === staffA)
      .slice(0, 30);
    const { prisma } = createPrisma(all);
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserA, { limit: 30 });
    expect(page.items).toHaveLength(30);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("F: 31 → 30 then 1", async () => {
    const all = makeStaffPages()
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

  it("G: 75 → 30 + 30 + 15 without duplicates", async () => {
    const { prisma } = createPrisma(makeStaffPages());
    const service = new LeaderboardApiService({ prisma } as never);

    const p1 = await service.listDepositHistory(staffUserA, { limit: 30 });
    const p2 = await service.listDepositHistory(staffUserA, {
      cursor: p1.nextCursor!,
      limit: 30
    });
    const p3 = await service.listDepositHistory(staffUserA, {
      cursor: p2.nextCursor!,
      limit: 30
    });
    expect(p1.items).toHaveLength(30);
    expect(p2.items).toHaveLength(30);
    expect(p3.items).toHaveLength(15);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id);
    expect(ids).toHaveLength(75);
    expect(new Set(ids).size).toBe(75);
  });

  it("H: newest deposit first", async () => {
    const { prisma } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, { limit: 30 });
    for (let i = 1; i < page.items.length; i++) {
      expect(page.items[i - 1]!.createdAt >= page.items[i]!.createdAt).toBe(true);
    }
  });

  it("I: Coadmin staff filter = Bella only", async () => {
    const { prisma, calls } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, {
      limit: 30,
      actorUserId: staffA
    });
    expect(calls[0]!.where).toMatchObject({
      ownerCoadminUserId: coadminId,
      actorUserId: staffA
    });
    expect(page.items).toHaveLength(10);
    expect(page.items.every((i) => i.recordedByDisplayName === "Bella")).toBe(true);
  });

  it("J: Coadmin player filter = Picasso only", async () => {
    const { prisma, calls } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, {
      limit: 30,
      crmContactId: picassoId
    });
    expect(calls[0]!.where).toMatchObject({
      ownerCoadminUserId: coadminId,
      crmContactId: picassoId
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.crmContactId).toBe(picassoId);
  });

  it("K: Combined Bella + Picasso filter", async () => {
    const { prisma } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, {
      limit: 30,
      actorUserId: staffA,
      crmContactId: picassoId
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.recordedByDisplayName).toBe("Bella");
    expect(page.items[0]!.crmContactId).toBe(picassoId);

    const miss = await service.listDepositHistory(coadminUser, {
      limit: 30,
      actorUserId: staffB,
      crmContactId: picassoId
    });
    expect(miss.items).toHaveLength(0);
  });

  it("L: frozen competition deposits remain in history", async () => {
    const { prisma } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, { limit: 30 });
    expect(page.items.some((i) => i.competitionId === competitionFrozen)).toBe(true);
  });

  it("M: Unknown User CRM falls back to Telegram first name", async () => {
    const { prisma } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, {
      limit: 30,
      crmContactId: picassoId
    });
    expect(page.items[0]!.displayName).toBe("Picasso");
  });

  it("N: actor display names never expose UUIDs", async () => {
    const { prisma } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(coadminUser, { limit: 30 });
    for (const row of page.items) {
      expect(row.recordedByDisplayName).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );
      expect(row.displayName).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );
    }
  });

  it("rejects foreign actor filter for Coadmin", async () => {
    const { prisma } = createPrisma(makeCharlieBoard());
    const service = new LeaderboardApiService({ prisma } as never);
    await expect(
      service.listDepositHistory(coadminUser, {
        actorUserId: otherCoadminId
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_ACTOR_FILTER"
    } satisfies Partial<AppError>);
  });

  it("rejects player filter outside Coadmin board", async () => {
    const { prisma } = createPrisma(makeCharlieBoard(), []);
    const service = new LeaderboardApiService({ prisma } as never);
    await expect(
      service.listDepositHistory(coadminUser, {
        crmContactId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_PLAYER_FILTER"
    } satisfies Partial<AppError>);
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

  it("cursor round-trip matches last item of page", async () => {
    const { prisma } = createPrisma(makeStaffPages());
    const service = new LeaderboardApiService({ prisma } as never);
    const page = await service.listDepositHistory(staffUserA, { limit: 30 });
    const decoded = decodeDepositHistoryCursor(page.nextCursor!);
    expect(decoded.id).toBe(page.items[29]!.id);
    expect(decoded.createdAt.toISOString()).toBe(page.items[29]!.createdAt);
  });
});
