import { randomInt } from "node:crypto";
import type { PrizeMembershipStatus } from "./leaderboard.types";

export const LEADERBOARD_RANDOM_FREEPLAY_CENTS = 1_500;
export const LEADERBOARD_RANDOM_FREEPLAY_SOURCE = "LEADERBOARD_RANDOM" as const;

export interface LeaderboardBonusCandidate {
  readonly crmContactId: string;
  readonly leaderboardRank: number;
  readonly membershipStatus: PrizeMembershipStatus;
}

/**
 * By default (`skipUnresolved` false/omitted), any PENDING_REVIEW candidate in
 * the rank 4-10 bonus range blocks the draw entirely (strict — used for manual,
 * human-confirmed finalize). With `skipUnresolved: true`, PENDING_REVIEW
 * candidates are simply excluded from the draw pool (they get no shot at the
 * bonus this cycle) instead of blocking — used by the bounded automatic finalize
 * path so an unresolved rank 4-10 candidate can never keep the whole competition
 * (including its already-decided Top 3) stuck FROZEN.
 */
export function resolveLeaderboardBonusPool(
  candidates: readonly LeaderboardBonusCandidate[],
  options?: { readonly skipUnresolved?: boolean }
):
  | { readonly ok: true; readonly candidates: readonly LeaderboardBonusCandidate[] }
  | { readonly ok: false; readonly pendingCrmContactIds: readonly string[] } {
  const skipUnresolved = options?.skipUnresolved === true;
  const inRange = candidates.filter((candidate) => candidate.leaderboardRank >= 4 && candidate.leaderboardRank <= 10);
  const pendingCrmContactIds = inRange
    .filter((candidate) => candidate.membershipStatus === "PENDING_REVIEW")
    .map((candidate) => candidate.crmContactId);
  if (pendingCrmContactIds.length > 0 && !skipUnresolved) return { ok: false, pendingCrmContactIds };
  return {
    ok: true,
    candidates: inRange.filter((candidate) => candidate.membershipStatus === "ELIGIBLE")
  };
}

export function secureBonusCandidateIndex(candidateCount: number): number {
  if (!Number.isInteger(candidateCount) || candidateCount <= 0) throw new Error("candidateCount must be positive");
  return randomInt(candidateCount);
}

export function leaderboardRandomFreeplayIdempotencyKey(competitionId: string): string {
  return `leaderboard-random-freeplay:${competitionId}`;
}
