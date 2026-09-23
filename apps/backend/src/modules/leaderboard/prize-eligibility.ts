import type { PrizeMembershipStatus } from "./leaderboard.types";

export interface EligibilityCandidateView {
  readonly crmContactId: string;
  readonly leaderboardRank: number;
  readonly totalPoints: number;
  readonly membershipStatus: PrizeMembershipStatus;
}

export interface SelectedPrizeWinner {
  readonly prizeRank: 1 | 2 | 3;
  readonly leaderboardRank: number;
  readonly crmContactId: string;
  readonly totalPoints: number;
}

export type PrizeSelectionResult =
  | {
      readonly ok: true;
      readonly winners: readonly SelectedPrizeWinner[];
      /**
       * Candidates that were ahead of an unfilled prize slot but still
       * PENDING_REVIEW when selection ran with `skipUnresolved: true`. They were
       * skipped for the prize (never marked ELIGIBLE, never paid) — their stored
       * membershipStatus is untouched, so the fact that verification never
       * resolved them is preserved on the record. Empty unless `skipUnresolved`
       * was used and at least one candidate was actually skipped.
       */
      readonly skippedPendingReviewCrmContactIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: "PENDING_REVIEW_BLOCKS_SELECTION";
      readonly pendingCrmContactIds: readonly string[];
    };

/**
 * Walk frozen leaderboard order and pick up to 3 ELIGIBLE prize winners.
 * NOT_ELIGIBLE players are skipped for prizes but keep their leaderboard rank.
 *
 * By default (`skipUnresolved` false/omitted), PENDING_REVIEW ahead of an
 * unfilled prize slot blocks selection entirely (never silent skip) — this is
 * the strict mode used for admin previews and manual, human-confirmed finalize.
 *
 * With `skipUnresolved: true`, a PENDING_REVIEW candidate is instead skipped
 * for the prize (like NOT_ELIGIBLE) and selection continues down the ranking.
 * This never marks anyone ELIGIBLE who wasn't already — it only stops PRIZE
 * ELIGIBILITY ambiguity from blocking RESULT PUBLICATION. Used by the bounded
 * automatic finalize path so a competition can never remain FROZEN indefinitely
 * merely because Telegram/API verification could not resolve someone in time.
 */
export function selectPrizeWinnersFromEligibility(
  candidates: readonly EligibilityCandidateView[],
  options?: { readonly skipUnresolved?: boolean }
): PrizeSelectionResult {
  const skipUnresolved = options?.skipUnresolved === true;
  const ordered = [...candidates].sort((a, b) => a.leaderboardRank - b.leaderboardRank);
  const winners: SelectedPrizeWinner[] = [];
  const pendingBlocking: string[] = [];
  const skippedPendingReview: string[] = [];

  for (const candidate of ordered) {
    if (winners.length >= 3) break;
    if (candidate.membershipStatus === "PENDING_REVIEW") {
      if (!skipUnresolved) {
        pendingBlocking.push(candidate.crmContactId);
        break;
      }
      skippedPendingReview.push(candidate.crmContactId);
      continue;
    }
    if (candidate.membershipStatus === "NOT_ELIGIBLE") continue;
    if (candidate.membershipStatus === "ELIGIBLE") {
      const prizeRank = (winners.length + 1) as 1 | 2 | 3;
      winners.push({
        prizeRank,
        leaderboardRank: candidate.leaderboardRank,
        crmContactId: candidate.crmContactId,
        totalPoints: candidate.totalPoints
      });
    }
  }

  if (pendingBlocking.length > 0) {
    return { ok: false, code: "PENDING_REVIEW_BLOCKS_SELECTION", pendingCrmContactIds: pendingBlocking };
  }
  return { ok: true, winners, skippedPendingReviewCrmContactIds: skippedPendingReview };
}
