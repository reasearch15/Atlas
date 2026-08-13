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
  | { readonly ok: true; readonly winners: readonly SelectedPrizeWinner[] }
  | {
      readonly ok: false;
      readonly code: "PENDING_REVIEW_BLOCKS_SELECTION";
      readonly pendingCrmContactIds: readonly string[];
    };

/**
 * Walk frozen leaderboard order and pick up to 3 ELIGIBLE prize winners.
 * PENDING_REVIEW ahead of an unfilled prize slot blocks selection (never silent skip).
 * NOT_ELIGIBLE players are skipped for prizes but keep their leaderboard rank.
 */
export function selectPrizeWinnersFromEligibility(
  candidates: readonly EligibilityCandidateView[]
): PrizeSelectionResult {
  const ordered = [...candidates].sort((a, b) => a.leaderboardRank - b.leaderboardRank);
  const winners: SelectedPrizeWinner[] = [];
  const pendingBlocking: string[] = [];

  for (const candidate of ordered) {
    if (winners.length >= 3) break;
    if (candidate.membershipStatus === "PENDING_REVIEW") {
      pendingBlocking.push(candidate.crmContactId);
      break;
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
  return { ok: true, winners };
}
