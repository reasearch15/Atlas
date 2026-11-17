import type { PrizeMembershipStatus } from "../leaderboard.types";

export const PRIZE_SLOTS = 3;
export const FREEPLAY_RANK_MIN = 4;
export const FREEPLAY_RANK_MAX = 10;
/** Extra pending players checked below an unresolved prize slot so a Telegram failure cannot hide the next ranked player. */
export const MEMBERSHIP_REPLACEMENT_LOOKAHEAD = 5;
export const MAX_MEMBERSHIP_VERIFY_QUEUE = PRIZE_SLOTS + MEMBERSHIP_REPLACEMENT_LOOKAHEAD;

export interface MembershipVerifyCandidate {
  readonly crmContactId: string;
  readonly leaderboardRank: number;
  readonly membershipStatus: PrizeMembershipStatus;
}

export interface MembershipVerifyPlan {
  /** Pending candidates whose checks are still required for prizes or the freeplay draw. */
  readonly toVerify: readonly MembershipVerifyCandidate[];
  /**
   * True when every candidate who could still take a prize slot is conclusive.
   * Pending players below a locked Top 3 do not clear this flag.
   */
  readonly prizeResolved: boolean;
  /** True when ranks 4–10 have no PENDING_REVIEW player left. */
  readonly freeplayResolved: boolean;
  /** True only when both the prize set and the freeplay range are conclusive. */
  readonly resolved: boolean;
  readonly eligibleCount: number;
}

/**
 * Walks frozen rank order.
 *
 * Prize checks stay bounded. A pending player does not stop the planner from
 * also queuing later pending players who could replace them, up to 8.
 * Ranks 4–10 are always added when still pending so the freeplay draw can be
 * verified without holding back a conclusive prize result.
 */
export function planMembershipVerification(
  candidates: readonly MembershipVerifyCandidate[]
): MembershipVerifyPlan {
  const ordered = [...candidates].sort((a, b) => a.leaderboardRank - b.leaderboardRank);
  const prizeQueue: MembershipVerifyCandidate[] = [];
  let eligibleCount = 0;
  let blockingPending = 0;

  for (const candidate of ordered) {
    if (eligibleCount >= PRIZE_SLOTS && blockingPending === 0) break;

    if (candidate.membershipStatus === "ELIGIBLE") {
      eligibleCount += 1;
      continue;
    }

    if (candidate.membershipStatus === "NOT_ELIGIBLE") {
      continue;
    }

    if (prizeQueue.length >= MAX_MEMBERSHIP_VERIFY_QUEUE) break;
    prizeQueue.push(candidate);
    blockingPending += 1;
  }

  const prizeResolved = prizeQueue.length === 0;
  const freeplayPending = ordered.filter(
    (candidate) =>
      candidate.leaderboardRank >= FREEPLAY_RANK_MIN &&
      candidate.leaderboardRank <= FREEPLAY_RANK_MAX &&
      candidate.membershipStatus !== "ELIGIBLE" &&
      candidate.membershipStatus !== "NOT_ELIGIBLE"
  );
  const seen = new Set(prizeQueue.map((candidate) => candidate.crmContactId));
  const toVerify = [...prizeQueue];
  for (const candidate of freeplayPending) {
    if (seen.has(candidate.crmContactId)) continue;
    seen.add(candidate.crmContactId);
    toVerify.push(candidate);
  }

  const freeplayResolved = freeplayPending.length === 0;
  return {
    toVerify,
    prizeResolved,
    freeplayResolved,
    resolved: prizeResolved && freeplayResolved,
    eligibleCount
  };
}
