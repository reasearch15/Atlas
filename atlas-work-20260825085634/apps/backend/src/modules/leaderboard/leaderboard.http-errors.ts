import { AppError } from "../../utils/errors";
import { LeaderboardError } from "./leaderboard.errors";

/**
 * Maps domain LeaderboardError codes to HTTP AppError responses.
 * Routes should catch LeaderboardError (or use wrapLeaderboardErrors) so these
 * never surface as unhandled 500s.
 */
export function mapLeaderboardError(error: LeaderboardError): AppError {
  switch (error.code) {
    case "PARTICIPANT_NOT_BOUND":
      return new AppError(
        404,
        error.code,
        "This player is not connected to a leaderboard yet."
      );
    case "CONTACT_NOT_FOUND":
    case "EVENT_NOT_FOUND":
    case "REFERRAL_NOT_FOUND":
    case "ELIGIBILITY_CANDIDATE_NOT_FOUND":
    case "PAYOUT_NOT_FOUND":
      return new AppError(404, error.code, error.message);
    case "OWNER_MISMATCH":
      return new AppError(403, error.code, error.message);
    case "SELF_REFERRAL_FORBIDDEN":
    case "INVALID_DEPOSIT_AMOUNT":
    case "INVALID_POOL_RATE":
    case "INVALID_EVENT_TYPE":
    case "INVALID_MEMBERSHIP_STATUS":
    case "MISSING_REASON":
    case "EVENT_NOT_REVERSIBLE":
    case "TELEGRAM_ELIGIBILITY_OVERRIDE_REQUIRED":
      return new AppError(400, error.code, error.message);
    case "PARTICIPANT_INTEGRITY_ERROR":
    case "PARTICIPANT_TRANSFER_UNSUPPORTED":
    case "REFERRAL_ALREADY_EXISTS":
    case "LEADERBOARD_DISABLED":
    case "IDEMPOTENCY_CONFLICT":
    case "LEADERBOARD_OWNER_UNRESOLVED":
    case "COMPETITION_NOT_FROZEN":
    case "COMPETITION_NOT_FINALIZED":
    case "COMPETITION_ALREADY_FINALIZED":
    case "EVENT_ALREADY_REVERSED":
    case "PENDING_REVIEW_BLOCKS_FINALIZE":
    case "ELIGIBILITY_LOCKED":
    case "PAYOUT_ALREADY_SETTLED":
      return new AppError(409, error.code, error.message);
    default:
      if (error.code.startsWith("INVALID_") || error.code.endsWith("_FORBIDDEN")) {
        return new AppError(400, error.code, error.message);
      }
      return new AppError(409, error.code, error.message);
  }
}

/**
 * Staff workspace has no primaryCoadminId — board owner cannot be resolved.
 */
export function leaderboardOwnerUnresolved(
  message = "This workspace has no primary coadmin; leaderboard owner cannot be resolved."
): AppError {
  return new AppError(409, "LEADERBOARD_OWNER_UNRESOLVED", message);
}

/**
 * Converts LeaderboardError → AppError; passes AppError through; rethrows others.
 */
export function toLeaderboardHttpError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof LeaderboardError) return mapLeaderboardError(error);
  return error;
}

/**
 * Runs an async route/service handler and maps LeaderboardError to AppError.
 */
export async function wrapLeaderboardErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toLeaderboardHttpError(error);
  }
}
