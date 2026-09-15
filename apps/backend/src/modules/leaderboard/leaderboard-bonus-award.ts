import { randomInt } from "node:crypto";
import type { PrizeMembershipStatus } from "./leaderboard.types";

export const LEADERBOARD_RANDOM_FREEPLAY_CENTS = 1_500;
export const LEADERBOARD_RANDOM_FREEPLAY_SOURCE = "LEADERBOARD_RANDOM" as const;

export interface LeaderboardBonusCandidate {
  readonly crmContactId: string;
  readonly leaderboardRank: number;
  readonly membershipStatus: PrizeMembershipStatus;
}

export function resolveLeaderboardBonusPool(candidates: readonly LeaderboardBonusCandidate[]):
  | { readonly ok: true; readonly candidates: readonly LeaderboardBonusCandidate[] }
  | { readonly ok: false; readonly pendingCrmContactIds: readonly string[] } {
  const inRange = candidates.filter((candidate) => candidate.leaderboardRank >= 4 && candidate.leaderboardRank <= 10);
  const pendingCrmContactIds = inRange
    .filter((candidate) => candidate.membershipStatus === "PENDING_REVIEW")
    .map((candidate) => candidate.crmContactId);
  if (pendingCrmContactIds.length > 0) return { ok: false, pendingCrmContactIds };
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
