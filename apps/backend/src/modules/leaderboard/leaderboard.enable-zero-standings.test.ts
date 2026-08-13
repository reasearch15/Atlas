import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "./competition-schedule";
import { LeaderboardService, MemoryLeaderboardStore } from "./leaderboard.service";
import { sortStandings } from "./ranking";
import { createFixedRandomSource } from "./promotion-points";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

function createService(contactIds: readonly string[]) {
  const store = new MemoryLeaderboardStore();
  for (const id of contactIds) {
    store.registerContact(id, workspaceId);
  }
  const service = new LeaderboardService(store, {
    random: createFixedRandomSource([2, 2, 2, 2, 2]),
    requireEnabled: true
  });
  return { store, service };
}

function playerIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const n1 = (0xc1000000 + i).toString(16).padStart(8, "0");
    const n2 = (0xcccc0000 + i).toString(16).padStart(8, "0").slice(0, 4);
    const n3 = (0x8ccc0000 + i).toString(16).padStart(8, "0").slice(0, 4);
    const n4 = (0xc00000000000 + i).toString(16).padStart(12, "0");
    return `${n1}-${n2}-4ccc-${n3}-${n4}`;
  });
}

describe("enable initializes ACTIVE competition + zero-point standings", () => {
  it("enabling with 10 bound players creates ACTIVE competition + 10 zero standings; pool=0; idempotent", async () => {
    const players = playerIds(10);
    const { store, service } = createService(players);
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    for (const crmContactId of players) {
      await service.bindParticipant({
        workspaceId,
        ownerCoadminUserId: ownerA,
        crmContactId,
        createdByUserId: ownerA
      });
    }

    expect(store.competitions).toHaveLength(0);
    expect(store.standings).toHaveLength(0);
    expect(store.events).toHaveLength(0);

    await service.setEnabled(workspaceId, ownerA, true, ownerA, now);

    const competitions = store.competitions.filter((c) => c.ownerCoadminUserId === ownerA);
    expect(competitions).toHaveLength(1);
    expect(competitions[0]!.status).toBe("ACTIVE");
    expect(competitions[0]!.prizePoolCents).toBe(0);
    expect(isInWindow(competitions[0]!, now)).toBe(true);

    const standings = store.standings.filter(
      (s) => s.ownerCoadminUserId === ownerA && s.competitionId === competitions[0]!.id
    );
    expect(standings).toHaveLength(10);
    for (const standing of standings) {
      expect(standing.totalPoints).toBe(0);
      expect(standing.depositPoints).toBe(0);
      expect(standing.referralPoints).toBe(0);
      expect(standing.promotionPoints).toBe(0);
      expect(standing.wheelPoints).toBe(0);
    }
    expect(store.events).toHaveLength(0);

    const ranked = sortStandings(standings);
    expect(ranked).toHaveLength(10);
    expect(new Set(ranked.map((s) => s.crmContactId)).size).toBe(10);

    // Repeated enable remains idempotent.
    await service.setEnabled(workspaceId, ownerA, true, ownerA, now);
    expect(store.competitions.filter((c) => c.ownerCoadminUserId === ownerA)).toHaveLength(1);
    expect(
      store.standings.filter((s) => s.ownerCoadminUserId === ownerA && s.competitionId === competitions[0]!.id)
    ).toHaveLength(10);
    expect(store.events).toHaveLength(0);
  });

  it("new participant while ACTIVE gets a zero standing immediately", async () => {
    const existing = playerIds(3);
    const newbie = "c9999999-cccc-4ccc-8ccc-999999999999";
    const { store, service } = createService([...existing, newbie]);
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    for (const crmContactId of existing) {
      await service.bindParticipant({
        workspaceId,
        ownerCoadminUserId: ownerA,
        crmContactId,
        createdByUserId: ownerA
      });
    }
    await service.setEnabled(workspaceId, ownerA, true, ownerA, now);
    const competitionId = store.competitions.find((c) => c.ownerCoadminUserId === ownerA)!.id;
    expect(store.standings.filter((s) => s.competitionId === competitionId)).toHaveLength(3);

    await service.bindParticipant({
      workspaceId,
      ownerCoadminUserId: ownerA,
      crmContactId: newbie,
      createdByUserId: ownerA,
      now
    });

    const standings = store.standings.filter((s) => s.competitionId === competitionId);
    expect(standings).toHaveLength(4);
    const newbieStanding = standings.find((s) => s.crmContactId === newbie)!;
    expect(newbieStanding.totalPoints).toBe(0);
    expect(store.events).toHaveLength(0);
    void now;
  });

  it("scoring one player leaves other zero-point standings unchanged", async () => {
    const players = playerIds(5);
    const { store, service } = createService(players);
    const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");

    for (const crmContactId of players) {
      await service.bindParticipant({
        workspaceId,
        ownerCoadminUserId: ownerA,
        crmContactId,
        createdByUserId: ownerA
      });
    }
    await service.setEnabled(workspaceId, ownerA, true, ownerA, now);

    await service.recordDeposit({
      workspaceId,
      crmContactId: players[0]!,
      amountCents: 5_000,
      actorUserId: ownerA,
      idempotencyKey: randomUUID(),
      now
    });

    const competition = store.competitions.find((c) => c.ownerCoadminUserId === ownerA)!;
    expect(competition.prizePoolCents).toBeGreaterThan(0);

    const standings = store.standings.filter((s) => s.competitionId === competition.id);
    expect(standings).toHaveLength(5);
    const scored = standings.find((s) => s.crmContactId === players[0]!)!;
    expect(scored.totalPoints).toBe(50);
    expect(scored.depositPoints).toBe(50);

    for (const id of players.slice(1)) {
      const row = standings.find((s) => s.crmContactId === id)!;
      expect(row.totalPoints).toBe(0);
      expect(row.depositPoints).toBe(0);
    }
  });

  it("Coadmin A cannot initialize or see Coadmin B players", async () => {
    const playersA = playerIds(4);
    const playersB = [
      "cbbbbbb1-cccc-4ccc-8ccc-bbbbbbbbbbb1",
      "cbbbbbb2-cccc-4ccc-8ccc-bbbbbbbbbbb2",
      "cbbbbbb3-cccc-4ccc-8ccc-bbbbbbbbbbb3"
    ];
    const { store, service } = createService([...playersA, ...playersB]);

    for (const crmContactId of playersA) {
      await service.bindParticipant({
        workspaceId,
        ownerCoadminUserId: ownerA,
        crmContactId,
        createdByUserId: ownerA
      });
    }
    for (const crmContactId of playersB) {
      await service.bindParticipant({
        workspaceId,
        ownerCoadminUserId: ownerB,
        crmContactId,
        createdByUserId: ownerB
      });
    }

    await service.setEnabled(workspaceId, ownerA, true, ownerA, chicagoWallTimeToUtc("2024-01-10T12:00:00"));
    await service.setEnabled(workspaceId, ownerB, true, ownerB, chicagoWallTimeToUtc("2024-01-10T12:00:00"));

    const compA = store.competitions.find((c) => c.ownerCoadminUserId === ownerA)!;
    const compB = store.competitions.find((c) => c.ownerCoadminUserId === ownerB)!;
    expect(compA.id).not.toBe(compB.id);

    const standingsA = store.standings.filter((s) => s.ownerCoadminUserId === ownerA);
    const standingsB = store.standings.filter((s) => s.ownerCoadminUserId === ownerB);
    expect(standingsA).toHaveLength(4);
    expect(standingsB).toHaveLength(3);
    expect(standingsA.every((s) => playersA.includes(s.crmContactId))).toBe(true);
    expect(standingsB.every((s) => playersB.includes(s.crmContactId))).toBe(true);
    expect(standingsA.some((s) => playersB.includes(s.crmContactId))).toBe(false);
    expect(standingsB.some((s) => playersA.includes(s.crmContactId))).toBe(false);
  });
});

function isInWindow(
  competition: { startsAt: Date; endsAt: Date },
  now: Date
): boolean {
  return competition.startsAt.getTime() <= now.getTime() && competition.endsAt.getTime() > now.getTime();
}
