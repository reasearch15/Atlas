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
  scoringChicagoDateForInstant,
  addChicagoDays,
  chicagoDateDiffDays
} from "./engagement.schedule";

describe("engagement schedule", () => {
  it("posts only at 6 and 18, twelve wall-clock hours apart, outside quiet hours", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => hour).filter(isEngagementPostHour);
    expect(hours).toEqual([6, 18]);
    expect(hours[1]! - hours[0]!).toBe(12);
    expect(hours.every((hour) => !isEngagementQuietHour(hour))).toBe(true);
    expect(isEngagementQuietHour(2)).toBe(true);
    expect(isEngagementQuietHour(5)).toBe(true);
    expect(isEngagementQuietHour(6)).toBe(false);
  });

  it("builds exactly two Chicago wall slots per normal calendar day", () => {
    const date = "2026-08-25";
    const from = chicagoWallTimeToUtc(`${date}T00:00:00`);
    const to = chicagoWallTimeToUtc("2026-08-26T00:00:00");
    const slots = listSlotsInRange(from, to).filter((slot) => slot.chicagoWallDate === date);
    expect(slots.map((slot) => slot.slotKey)).toEqual(["2026-08-25T06:00", "2026-08-25T18:00"]);
    expect(slots).toHaveLength(2);
  });

  it("never lists a 2 AM post", () => {
    const from = chicagoWallTimeToUtc("2026-08-25T00:00:00");
    const to = chicagoWallTimeToUtc("2026-08-26T12:00:00");
    const hours = listSlotsInRange(from, to).map((slot) => slot.hour);
    expect(hours).not.toContain(2);
  });

  it("closes each poll exactly 4 elapsed hours later", () => {
    const opens = pollOpensAt("2026-08-25", 18);
    const closes = pollClosesAt(opens);
    expect(closes.getTime() - opens.getTime()).toBe(4 * 60 * 60 * 1000);
  });

  it("assigns the 6 PM poll to the same 11 PM declaration day", () => {
    const sixPm = buildSlot("2026-08-25", 18);
    expect(scoringChicagoDateForInstant(sixPm.closesAt)).toBe("2026-08-25");
    expect(latestDeclarationChicagoDate(chicagoWallTimeToUtc("2026-08-25T23:00:00"))).toBe("2026-08-25");
    expect(latestDeclarationChicagoDate(chicagoWallTimeToUtc("2026-08-25T22:59:59"))).toBe("2026-08-24");
  });

  it("keeps four elapsed hours across Chicago spring-forward", () => {
    const opens = pollOpensAt("2026-03-08", 6);
    const closes = pollClosesAt(opens);
    expect(closes.getTime() - opens.getTime()).toBe(4 * 60 * 60 * 1000);
    expect(closes.getTime()).toBe(pollOpensAt("2026-03-08", 10).getTime());
  });

  it("keeps four elapsed hours across Chicago fall-back without creating removed slots", () => {
    const opens = pollOpensAt("2026-11-01", 6);
    const closes = pollClosesAt(opens);
    expect(closes.getTime() - opens.getTime()).toBe(4 * 60 * 60 * 1000);
    expect([10, 14, 22].some(isEngagementPostHour)).toBe(false);
  });

  it("derives the first eligible declaration date from poll scoring dates", () => {
    expect(firstEligibleDeclarationChicagoDate([])).toBeNull();
    expect(isEligibleEngagementDeclarationDate("2026-08-24", [])).toBe(false);
    expect(firstEligibleDeclarationChicagoDate(["2026-08-26", "2026-08-25"])).toBe("2026-08-25");
    expect(isEligibleEngagementDeclarationDate("2026-08-24", ["2026-08-25"])).toBe(false);
    expect(isEligibleEngagementDeclarationDate("2026-08-25", ["2026-08-25", "2026-08-26"])).toBe(true);
    expect(isEligibleEngagementDeclarationDate("2026-08-26", ["2026-08-25"])).toBe(true);
  });

  it("computes Chicago date differences for the 7-draw cooldown window", () => {
    expect(chicagoDateDiffDays("2026-08-25", "2026-08-26")).toBe(1);
    expect(chicagoDateDiffDays("2026-08-25", "2026-09-01")).toBe(7);
    expect(addChicagoDays("2026-08-25", 8)).toBe("2026-09-02");
  });
});
