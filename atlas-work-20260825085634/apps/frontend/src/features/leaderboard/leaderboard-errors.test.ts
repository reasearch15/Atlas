import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/api-client-error";
import {
  formatMoneyFromCents,
  mapLeaderboardError,
  newIdempotencyKey,
  parseDollarsToCents
} from "./leaderboard-errors";

describe("mapLeaderboardError", () => {
  it("maps PARTICIPANT_NOT_BOUND to the Phase 2 friendly string", () => {
    const error = new ApiClientError(
      "PARTICIPANT_NOT_BOUND",
      "CrmContact is not bound to a coadmin leaderboard in this workspace.",
      404
    );
    expect(mapLeaderboardError(error)).toBe("This player is not connected to a leaderboard yet.");
  });

  it("maps duplicate and self-referral codes", () => {
    expect(
      mapLeaderboardError(new ApiClientError("REFERRAL_ALREADY_EXISTS", "exists", 409))
    ).toBe("This player already has a referrer.");
    expect(
      mapLeaderboardError(new ApiClientError("SELF_REFERRAL_FORBIDDEN", "self", 400))
    ).toBe("A player cannot refer themselves.");
  });

  it("maps transfer-unsupported without suggesting a silent move", () => {
    expect(
      mapLeaderboardError(new ApiClientError("PARTICIPANT_TRANSFER_UNSUPPORTED", "xfer", 409))
    ).toContain("cannot be moved");
  });

  it("falls back to the server message for unknown codes", () => {
    expect(mapLeaderboardError(new ApiClientError("SOME_NEW_CODE", "Custom detail.", 400))).toBe(
      "Custom detail."
    );
  });

  it("handles non-ApiClientError values", () => {
    expect(mapLeaderboardError(new Error("Network down"))).toBe("Network down");
    expect(mapLeaderboardError(null)).toBe("Something went wrong with the leaderboard.");
  });

  it("maps Phase 3 admin error codes", () => {
    expect(
      mapLeaderboardError(new ApiClientError("CONFIRM_DISABLE_REQUIRED", "confirm", 400))
    ).toContain("Confirm again to disable");
    expect(
      mapLeaderboardError(new ApiClientError("COMPETITION_NOT_FROZEN", "frozen", 400))
    ).toBe("Only frozen competitions can be finalized.");
    expect(
      mapLeaderboardError(new ApiClientError("COMPETITION_ALREADY_FINALIZED", "done", 409))
    ).toBe("This competition is already finalized.");
    expect(
      mapLeaderboardError(new ApiClientError("EVENT_ALREADY_REVERSED", "rev", 409))
    ).toBe("This event has already been reversed.");
    expect(
      mapLeaderboardError(new ApiClientError("EVENT_NOT_REVERSIBLE", "type", 400))
    ).toBe("This event type cannot be reversed.");
    expect(
      mapLeaderboardError(new ApiClientError("PENDING_REVIEW_BLOCKS_FINALIZE", "pending", 409))
    ).toContain("subscription verification");
    expect(
      mapLeaderboardError(new ApiClientError("PAYOUT_ALREADY_SETTLED", "settled", 409))
    ).toBe("This payout has already been settled.");
    expect(
      mapLeaderboardError(new ApiClientError("INVALID_POOL_RATE", "rate", 400))
    ).toContain("2%, 3%, 4%, or 5%");
    expect(
      mapLeaderboardError(new ApiClientError("ELIGIBILITY_LOCKED", "locked", 409))
    ).toContain("cannot be changed");
    expect(
      mapLeaderboardError(new ApiClientError("MISSING_REASON", "reason", 400))
    ).toBe("A reason is required for this action.");
  });
});

describe("formatMoneyFromCents", () => {
  it("formats cents as USD with two decimals", () => {
    expect(formatMoneyFromCents(42000)).toBe("$420.00");
    expect(formatMoneyFromCents(5)).toBe("$0.05");
    expect(formatMoneyFromCents(0)).toBe("$0.00");
  });
});

describe("parseDollarsToCents", () => {
  it("parses whole and fractional dollars into cents", () => {
    expect(parseDollarsToCents("40")).toBe(4000);
    expect(parseDollarsToCents("40.5")).toBe(4050);
    expect(parseDollarsToCents("40.50")).toBe(4050);
    expect(parseDollarsToCents("0.01")).toBe(1);
  });

  it("rejects invalid money input", () => {
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("-1")).toBeNull();
    expect(parseDollarsToCents("1.234")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("0")).toBeNull();
    expect(parseDollarsToCents("0.00")).toBeNull();
  });
});

describe("newIdempotencyKey", () => {
  it("returns a UUID-looking string", () => {
    const key = newIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});
