import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../competition-schedule";
import { formatCompetitionEndDisplay } from "./competition-end-display";

describe("formatCompetitionEndDisplay", () => {
  it("formats Aug 26 competition as Tuesday, Aug 26 at 9:00 PM CDT", () => {
    // Tuesday Aug 26, 2025 21:00 America/Chicago (CDT = UTC-5)
    const endsAt = chicagoWallTimeToUtc("2025-08-26T21:00:00");
    expect(endsAt.toISOString()).toBe("2025-08-27T02:00:00.000Z");

    const text = formatCompetitionEndDisplay(endsAt, "America/Chicago", {
      now: chicagoWallTimeToUtc("2025-08-20T12:00:00")
    });

    expect(text).toBe("Tuesday, Aug 26 at 9:00 PM CDT");
  });

  it("displays CST correctly for a winter competition", () => {
    // Tuesday Jan 6, 2026 21:00 America/Chicago (CST = UTC-6)
    const endsAt = chicagoWallTimeToUtc("2026-01-06T21:00:00");
    expect(endsAt.toISOString()).toBe("2026-01-07T03:00:00.000Z");

    const text = formatCompetitionEndDisplay(endsAt, "America/Chicago", {
      now: chicagoWallTimeToUtc("2026-01-02T12:00:00")
    });

    expect(text).toBe("Tuesday, Jan 6 at 9:00 PM CST");
  });

  it("includes the year across a year boundary", () => {
    // Tuesday Jan 5, 2027 21:00 America/Chicago (CST) — year differs from late-2026 "now"
    const endsAt = chicagoWallTimeToUtc("2027-01-05T21:00:00");
    const text = formatCompetitionEndDisplay(endsAt, "America/Chicago", {
      now: chicagoWallTimeToUtc("2026-12-28T12:00:00")
    });

    expect(text).toBe("Tuesday, Jan 5, 2027 at 9:00 PM CST");
  });

  it("uses the provided endsAt instant, not an arbitrary next Tuesday", () => {
    const endsAt = chicagoWallTimeToUtc("2025-09-09T21:00:00");
    const text = formatCompetitionEndDisplay(endsAt, "America/Chicago", {
      now: chicagoWallTimeToUtc("2025-08-20T12:00:00")
    });
    expect(text).toBe("Tuesday, Sep 9 at 9:00 PM CDT");
    expect(text).not.toContain("Aug 26");
  });
});
