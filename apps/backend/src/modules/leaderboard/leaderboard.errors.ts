/**
 * Domain errors for the isolated leaderboard engine.
 * These never touch Telegram/CRM messaging paths.
 */
export class LeaderboardError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "LeaderboardError";
    this.code = code;
  }
}

export function leaderboardDisabled(): LeaderboardError {
  return new LeaderboardError("LEADERBOARD_DISABLED", "Leaderboard processing is disabled for this coadmin.");
}

export function invalidPoolRate(bps: number): LeaderboardError {
  return new LeaderboardError("INVALID_POOL_RATE", `Pool rate ${bps} bps is outside allowed values 200/300/400/500.`);
}

export function selfReferralForbidden(): LeaderboardError {
  return new LeaderboardError("SELF_REFERRAL_FORBIDDEN", "A player cannot refer themselves.");
}

export function referralAlreadyExists(): LeaderboardError {
  return new LeaderboardError("REFERRAL_ALREADY_EXISTS", "This player already has a referrer.");
}

export function referralNotFound(): LeaderboardError {
  return new LeaderboardError("REFERRAL_NOT_FOUND", "Referral relationship was not found.");
}

export function contactNotFound(): LeaderboardError {
  return new LeaderboardError("CONTACT_NOT_FOUND", "CrmContact was not found in this workspace.");
}

export function eventNotFound(): LeaderboardError {
  return new LeaderboardError("EVENT_NOT_FOUND", "Leaderboard event was not found.");
}

export function eventAlreadyReversed(): LeaderboardError {
  return new LeaderboardError("EVENT_ALREADY_REVERSED", "This event has already been reversed.");
}

export function invalidEventType(expected: string): LeaderboardError {
  return new LeaderboardError("INVALID_EVENT_TYPE", `Expected event type ${expected}.`);
}

export function invalidDepositAmount(): LeaderboardError {
  return new LeaderboardError("INVALID_DEPOSIT_AMOUNT", "Deposit amount must be a positive integer number of cents.");
}

export function competitionNotFrozen(): LeaderboardError {
  return new LeaderboardError("COMPETITION_NOT_FROZEN", "Only FROZEN competitions can be finalized.");
}

export function competitionAlreadyFinalized(): LeaderboardError {
  return new LeaderboardError("COMPETITION_ALREADY_FINALIZED", "Competition is already finalized.");
}

export function idempotencyConflict(): LeaderboardError {
  return new LeaderboardError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different payload.");
}

export function pendingReviewBlocksFinalize(contactIds: readonly string[]): LeaderboardError {
  return new LeaderboardError(
    "PENDING_REVIEW_BLOCKS_FINALIZE",
    `Cannot finalize while membership is PENDING_REVIEW for: ${contactIds.join(", ")}`
  );
}

export function eligibilityLocked(): LeaderboardError {
  return new LeaderboardError(
    "ELIGIBILITY_LOCKED",
    "Membership eligibility cannot change after giveaway winners are finalized."
  );
}

export function candidateNotFound(): LeaderboardError {
  return new LeaderboardError("ELIGIBILITY_CANDIDATE_NOT_FOUND", "Eligibility candidate was not found.");
}

export function invalidMembershipStatus(): LeaderboardError {
  return new LeaderboardError(
    "INVALID_MEMBERSHIP_STATUS",
    "Membership status must be ELIGIBLE, NOT_ELIGIBLE, or PENDING_REVIEW."
  );
}

export function telegramEligibilityOverrideRequired(): LeaderboardError {
  return new LeaderboardError(
    "TELEGRAM_ELIGIBILITY_OVERRIDE_REQUIRED",
    "This eligibility was set by Telegram Bot API. Pass explicitOverride=true with a reason to change it."
  );
}

export function participantNotBound(): LeaderboardError {
  return new LeaderboardError(
    "PARTICIPANT_NOT_BOUND",
    "CrmContact is not bound to a coadmin leaderboard in this workspace."
  );
}

export function participantIntegrityError(): LeaderboardError {
  return new LeaderboardError(
    "PARTICIPANT_INTEGRITY_ERROR",
    "Multiple leaderboard participant bindings exist for this contact; expected exactly one."
  );
}

export function participantTransferUnsupported(): LeaderboardError {
  return new LeaderboardError(
    "PARTICIPANT_TRANSFER_UNSUPPORTED",
    "Transferring a participant to a different coadmin leaderboard is not supported."
  );
}

export function ownerMismatch(): LeaderboardError {
  return new LeaderboardError(
    "OWNER_MISMATCH",
    "Operation owner does not match the competition, participant, or resource owner."
  );
}

export function payoutAlreadySettled(): LeaderboardError {
  return new LeaderboardError(
    "PAYOUT_ALREADY_SETTLED",
    "This payout has already been settled to a different status."
  );
}

export function payoutNotFound(): LeaderboardError {
  return new LeaderboardError("PAYOUT_NOT_FOUND", "Giveaway payout was not found.");
}

export function competitionNotFinalized(): LeaderboardError {
  return new LeaderboardError(
    "COMPETITION_NOT_FINALIZED",
    "Only FINALIZED competitions allow payout marking."
  );
}

export function missingReason(): LeaderboardError {
  return new LeaderboardError("MISSING_REASON", "A reason is required for this operation.");
}

export function eventNotReversible(type: string): LeaderboardError {
  return new LeaderboardError("EVENT_NOT_REVERSIBLE", `Event type ${type} cannot be reversed.`);
}
