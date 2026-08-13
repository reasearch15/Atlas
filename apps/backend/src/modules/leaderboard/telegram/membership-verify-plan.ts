import type { PrizeMembershipStatus } from "../leaderboard.types";

export interface MembershipVerifyCandidate {
  readonly crmContactId: string;
  readonly leaderboardRank: number;
  readonly membershipStatus: PrizeMembershipStatus;
}

export interface MembershipVerifyPlan {
  /** Candidates that still need a Telegram membership check to resolve prize Top 3. */
  readonly toVerify: readonly MembershipVerifyCandidate[];
  /** True when no further membership checks are required for prize Top 3. */
  readonly resolved: boolean;
  readonly eligibleCount: number;
}

/**
 * Walks frozen eligibility order and returns who still needs verification
 * to determine prize Top 3. PENDING candidates reserve a potential prize slot
 * (they may become ELIGIBLE); NOT_ELIGIBLE are skipped.
 *
 * Stops once 3 ELIGIBLE winners are secured or enough PENDING checks are queued
 * to fill the remaining prize slots.
 */
export function planMembershipVerification(
  candidates: readonly MembershipVerifyCandidate[]
): MembershipVerifyPlan {
  const ordered = [...candidates].sort((a, b) => a.leaderboardRank - b.leaderboardRank);
  const toVerify: MembershipVerifyCandidate[] = [];
  let slotsNeeded = 3;
  let eligibleCount = 0;

  for (const candidate of ordered) {
    if (slotsNeeded <= 0) break;

    if (candidate.membershipStatus === "ELIGIBLE") {
      eligibleCount += 1;
      slotsNeeded -= 1;
      continue;
    }

    if (candidate.membershipStatus === "NOT_ELIGIBLE") {
      continue;
    }

    // PENDING_REVIEW: must verify; reserves a potential prize slot.
    toVerify.push(candidate);
    slotsNeeded -= 1;
  }

  return {
    toVerify,
    resolved: toVerify.length === 0,
    eligibleCount
  };
}
