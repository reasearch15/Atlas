import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import {
  buildSlot,
  firstEligibleDeclarationChicagoDate,
  isEligibleEngagementDeclarationDate,
  isEngagementPostHour,
  isEngagementQuietHour,
  latestDeclarationChicagoDate,
  listSlotsInRange,
  pollClosesAt,
  pollOpensAt,
  scoringChicagoDateForInstant
} from "./engagement.schedule";

describe("engagement schedule", () => {
  it("posts only at 6/10/14/18/22 and keeps 2-6 quiet", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10, 14, 18, 22].filter(isEngagementPostHour)).toEqual([6, 10, 14, 18, 22]);
    expect(isEngagementQuietHour(2)).toBe(true);
    expect(isEngagementQuietHour(5)).toBe(true);
    expect(isEngagementQuietHour(6)).toBe(false);
  });

  it("builds the five Chicago wall slots", () => {
    const date = "2026-08-25";
    expect(buildSlot(date, 6).slotKey).toBe("2026-08-25T06:00");
    expect(buildSlot(date, 10).opensAt).toEqual(pollOpensAt(date, 10));
    expect(buildSlot(date, 14).closesAt).toEqual(pollClosesAt(buildSlot(date, 14).opensAt));
    expect(buildSlot(date, 18).chicagoDate).toBe("2026-08-25");
    expect(buildSlot(date, 22).chicagoDate).toBe("2026-08-26");
  });

  it("never lists a 2 AM post", () => {
    const from = chicagoWallTimeToUtc("2026-08-25T00:00:00");
    const to = chicagoWallTimeToUtc("2026-08-26T12:00:00");
    const hours = listSlotsInRange(from, to).map((slot) => slot.hour);
    expect(hours).not.toContain(2);
  });

  it("closes 4 elapsed hours later, including the 10 PM poll", () => {
    const opens = pollOpensAt("2026-08-25", 22);
    const closes = pollClosesAt(opens);
    expect(closes.getTime() - opens.getTime()).toBe(4 * 60 * 60 * 1000);
  });

  it("assigns the 10 PM poll to the next 11 PM declaration day", () => {
    const tenPm = buildSlot("2026-08-25", 22);
    expect(scoringChicagoDateForInstant(tenPm.closesAt)).toBe("2026-08-26");
    expect(latestDeclarationChicagoDate(chicagoWallTimeToUtc("2026-08-25T23:00:00"))).toBe("2026-08-25");
    expect(latestDeclarationChicagoDate(chicagoWallTimeToUtc("2026-08-25T22:59:59"))).toBe("2026-08-24");
  });

  it("handles Chicago spring-forward for the 10 PM close", () => {
    // 2026-03-08 02:00 does not exist; 22:00 March 7 + 4 elapsed hours lands at 03:00 CDT.
    const opens = pollOpensAt("2026-03-07", 22);
    const closes = pollClosesAt(opens);
    expect(closes.getTime() - opens.getTime()).toBe(4 * 60 * 60 * 1000);
    expect(scoringChicagoDateForInstant(closes)).toBe("2026-03-08");
  });

  it("handles Chicago fall-back without double-counting 2 AM", () => {
    const opens = pollOpensAt("2026-10-31", 22);
    const closes = pollClosesAt(opens);
    expect(closes.getTime() - opens.getTime()).toBe(4 * 60 * 60 * 1000);
    expect(scoringChicagoDateForInstant(closes)).toBe("2026-11-01");
  });

  it("derives the first eligible declaration date from poll scoring dates", () => {
    expect(firstEligibleDeclarationChicagoDate([])).toBeNull();
    expect(isEligibleEngagementDeclarationDate("2026-08-24", [])).toBe(false);
    expect(firstEligibleDeclarationChicagoDate(["2026-08-26", "2026-08-25"])).toBe("2026-08-25");
    expect(isEligibleEngagementDeclarationDate("2026-08-24", ["2026-08-25"])).toBe(false);
    expect(isEligibleEngagementDeclarationDate("2026-08-25", ["2026-08-25", "2026-08-26"])).toBe(true);
    expect(isEligibleEngagementDeclarationDate("2026-08-26", ["2026-08-25"])).toBe(true);
  });
});
