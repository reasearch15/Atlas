import { describe, expect, it } from "vitest";
import { AppError } from "../../utils/errors";
import {
  idempotencyConflict,
  invalidDepositAmount,
  leaderboardDisabled,
  missingReason,
  ownerMismatch,
  participantIntegrityError,
  participantNotBound,
  participantTransferUnsupported,
  payoutAlreadySettled,
  referralAlreadyExists,
  selfReferralForbidden,
  contactNotFound,
  eventNotReversible
} from "./leaderboard.errors";
import {
  leaderboardOwnerUnresolved,
  mapLeaderboardError,
  wrapLeaderboardErrors
} from "./leaderboard.http-errors";

describe("mapLeaderboardError", () => {
  it("maps PARTICIPANT_NOT_BOUND to friendly 404", () => {
    const mapped = mapLeaderboardError(participantNotBound());
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.statusCode).toBe(404);
    expect(mapped.code).toBe("PARTICIPANT_NOT_BOUND");
    expect(mapped.message).toBe("This player is not connected to a leaderboard yet.");
  });

  it("maps ownership and conflict codes to expected statuses", () => {
    expect(mapLeaderboardError(ownerMismatch()).statusCode).toBe(403);
    expect(mapLeaderboardError(selfReferralForbidden()).statusCode).toBe(400);
    expect(mapLeaderboardError(invalidDepositAmount()).statusCode).toBe(400);
    expect(mapLeaderboardError(referralAlreadyExists()).statusCode).toBe(409);
    expect(mapLeaderboardError(leaderboardDisabled()).statusCode).toBe(409);
    expect(mapLeaderboardError(idempotencyConflict()).statusCode).toBe(409);
    expect(mapLeaderboardError(participantIntegrityError()).statusCode).toBe(409);
    expect(mapLeaderboardError(participantTransferUnsupported()).statusCode).toBe(409);
    expect(mapLeaderboardError(contactNotFound()).statusCode).toBe(404);
    expect(mapLeaderboardError(missingReason()).statusCode).toBe(400);
    expect(mapLeaderboardError(eventNotReversible("REFERRAL_MILESTONE")).statusCode).toBe(400);
    expect(mapLeaderboardError(payoutAlreadySettled()).statusCode).toBe(409);
  });

  it("exposes LEADERBOARD_OWNER_UNRESOLVED as 409", () => {
    const error = leaderboardOwnerUnresolved();
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("LEADERBOARD_OWNER_UNRESOLVED");
  });

  it("wrapLeaderboardErrors maps domain errors and passes AppError", async () => {
    await expect(
      wrapLeaderboardErrors(async () => {
        throw participantNotBound();
      })
    ).rejects.toMatchObject({ statusCode: 404, code: "PARTICIPANT_NOT_BOUND" });

    const passthrough = new AppError(418, "TEAPOT", "nope");
    await expect(
      wrapLeaderboardErrors(async () => {
        throw passthrough;
      })
    ).rejects.toBe(passthrough);

    await expect(wrapLeaderboardErrors(async () => 42)).resolves.toBe(42);
  });
});
