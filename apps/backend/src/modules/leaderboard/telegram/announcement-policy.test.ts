import { describe, expect, it } from "vitest";
import {
  detectRankAnnouncements,
  previousTop10ForAnnouncements
} from "./announcement-policy";

function row(id: string, rank: number, displayName = id, totalPoints = 1000 - rank) {
  return { crmContactId: id, rank, displayName, totalPoints };
}

describe("detectRankAnnouncements", () => {
  it("does not announce when ranks are unchanged", () => {
    const board = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)];
    expect(detectRankAnnouncements(board, board)).toEqual([]);
  });

  it("announces enter Top 10", () => {
    const prev = [row("a", 1), row("b", 2), row("c", 3)];
    const next = [row("a", 1), row("b", 2), row("c", 3), row("z", 8, "Zoe")];
    const events = detectRankAnnouncements(prev, next);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "ENTER_TOP_10",
        crmContactId: "z",
        fromRank: null,
        toRank: 8
      })
    ]);
  });

  it("announces enter Top 3 (not also Top 10)", () => {
    const prev = [row("a", 1), row("b", 2), row("c", 3), row("d", 5, "Dana")];
    const next = [row("a", 1), row("b", 2), row("d", 3, "Dana"), row("c", 4)];
    const events = detectRankAnnouncements(prev, next);
    expect(events.some((e) => e.kind === "ENTER_TOP_3" && e.crmContactId === "d")).toBe(true);
    expect(events.some((e) => e.kind === "ENTER_TOP_10" && e.crmContactId === "d")).toBe(false);
  });

  it("announces reach #1 as the most specific event", () => {
    const prev = [row("a", 1), row("b", 2), row("c", 5, "Cara")];
    const next = [row("c", 1, "Cara"), row("a", 2), row("b", 3)];
    const events = detectRankAnnouncements(prev, next);
    expect(events.some((e) => e.kind === "REACHED_NUMBER_1" && e.crmContactId === "c")).toBe(true);
    expect(events.some((e) => e.kind === "ENTER_TOP_3" && e.crmContactId === "c")).toBe(false);
  });

  it("announces Top 3 order change without spamming point-only updates", () => {
    const prev = [row("a", 1), row("b", 2), row("c", 3)];
    const next = [row("a", 1), row("c", 2), row("b", 3)];
    const events = detectRankAnnouncements(prev, next);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === "TOP_3_ORDER_CHANGED")).toBe(true);
    expect(events.map((e) => e.crmContactId).sort()).toEqual(["b", "c"]);
  });

  it("ignores points-only changes that do not cross thresholds or reorder Top 3", () => {
    const prev = [
      { crmContactId: "a", rank: 1, displayName: "A", totalPoints: 100 },
      { crmContactId: "b", rank: 2, displayName: "B", totalPoints: 90 },
      { crmContactId: "c", rank: 3, displayName: "C", totalPoints: 80 },
      { crmContactId: "d", rank: 4, displayName: "D", totalPoints: 70 }
    ];
    const next = [
      { crmContactId: "a", rank: 1, displayName: "A", totalPoints: 105 },
      { crmContactId: "b", rank: 2, displayName: "B", totalPoints: 91 },
      { crmContactId: "c", rank: 3, displayName: "C", totalPoints: 80 },
      { crmContactId: "d", rank: 4, displayName: "D", totalPoints: 72 }
    ];
    expect(detectRankAnnouncements(prev, next)).toEqual([]);
  });

  it("A/B/H: empty previous snapshot (enable / first refresh) emits no achievements for zero standings", () => {
    const next = Array.from({ length: 10 }, (_, i) =>
      row(`p${i}`, i + 1, `Player ${i}`, 0)
    );
    expect(detectRankAnnouncements([], next)).toEqual([]);
  });

  it("B: 73 zero-point first snapshot emits zero movement announcements", () => {
    const next = Array.from({ length: 10 }, (_, i) =>
      row(`c${i}`, i + 1, `Name ${i}`, 0)
    );
    // Top 10 of a 73-player zero board still must not announce on first snapshot.
    expect(detectRankAnnouncements([], next)).toEqual([]);
  });

  it("D: newly bound zero-point player entering Top 10 is not an achievement", () => {
    const prev = [
      row("a", 1, "A", 0),
      row("b", 2, "B", 0),
      row("c", 3, "C", 0),
      row("d", 4, "D", 0),
      row("e", 5, "E", 0)
    ];
    const next = [
      ...prev,
      row("newbie", 6, "Newbie", 0)
    ];
    expect(detectRankAnnouncements(prev, next)).toEqual([]);
  });

  it("H: all-zero board with deterministic ranks never announces from those ranks alone", () => {
    const board = Array.from({ length: 10 }, (_, i) => row(`z${i}`, i + 1, `Z${i}`, 0));
    // Even if prev somehow differs in order but all still zero, suppress.
    const reshuffled = [
      row("z1", 1, "Z1", 0),
      row("z0", 2, "Z0", 0),
      ...board.slice(2)
    ];
    expect(detectRankAnnouncements(board, reshuffled)).toEqual([]);
  });

  it("E: real scoring outside Top 10 → Top 10 still announces", () => {
    const prev = [
      row("a", 1, "A", 200),
      row("b", 2, "B", 180),
      row("c", 3, "C", 160),
      row("d", 4, "D", 140),
      row("e", 5, "E", 120),
      row("f", 6, "F", 100),
      row("g", 7, "G", 90),
      row("h", 8, "H", 80),
      row("i", 9, "I", 70),
      row("j", 10, "J", 60)
    ];
    const next = [
      row("a", 1, "A", 200),
      row("b", 2, "B", 180),
      row("c", 3, "C", 160),
      row("d", 4, "D", 140),
      row("e", 5, "E", 120),
      row("f", 6, "F", 100),
      row("g", 7, "G", 90),
      row("climber", 8, "Climber", 85),
      row("h", 9, "H", 80),
      row("i", 10, "I", 70)
    ];
    const events = detectRankAnnouncements(prev, next);
    expect(events.some((e) => e.kind === "ENTER_TOP_10" && e.crmContactId === "climber")).toBe(
      true
    );
  });

  it("F: real scoring #4 → #3 still announces Top 3", () => {
    const prev = [row("a", 1), row("b", 2), row("c", 3), row("d", 4, "Dana", 50)];
    const next = [row("a", 1), row("b", 2), row("d", 3, "Dana", 80), row("c", 4)];
    const events = detectRankAnnouncements(prev, next);
    expect(events.some((e) => e.kind === "ENTER_TOP_3" && e.crmContactId === "d")).toBe(true);
  });

  it("G: real scoring #2 → #1 still announces #1", () => {
    const prev = [row("a", 1, "A", 100), row("b", 2, "B", 90)];
    const next = [row("b", 1, "B", 120), row("a", 2, "A", 100)];
    const events = detectRankAnnouncements(prev, next);
    expect(events.some((e) => e.kind === "REACHED_NUMBER_1" && e.crmContactId === "b")).toBe(true);
  });
});

describe("previousTop10ForAnnouncements", () => {
  it("treats a different competition as empty baseline prev", () => {
    const snapshot = [row("a", 1, "A", 50)];
    expect(
      previousTop10ForAnnouncements("old-comp", "new-comp", snapshot)
    ).toEqual([]);
  });

  it("keeps snapshot when competition matches", () => {
    const snapshot = [{ crmContactId: "a", rank: 1, displayName: "A", totalPoints: 50 }];
    expect(previousTop10ForAnnouncements("comp-1", "comp-1", snapshot)).toEqual(snapshot);
  });

  it("C: repeated baseline refresh (same empty→zeros) never queues achievements", () => {
    const zeros = Array.from({ length: 10 }, (_, i) => row(`p${i}`, i + 1, `P${i}`, 0));
    expect(detectRankAnnouncements([], zeros)).toEqual([]);
    // After first post, prev === next zeros still yields nothing.
    expect(detectRankAnnouncements(zeros, zeros)).toEqual([]);
  });
});
