import { describe, expect, it } from "vitest";
import { detectRankAnnouncements } from "./announcement-policy";

function row(id: string, rank: number, displayName = id) {
  return { crmContactId: id, rank, displayName, totalPoints: 1000 - rank };
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
});
