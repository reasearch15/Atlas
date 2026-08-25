import {
  DRAW_BASE_WEIGHT,
  DRAW_REFERRAL_FLOOR_WEIGHT,
  DRAW_REFERRAL_START_WEIGHT,
  DRAW_REFERRAL_STEP_WEIGHT,
  DRAW_WINNER_COOLDOWN_DRAWS
} from "./engagement.constants";
import { chicagoDateDiffDays } from "./engagement.schedule";
import { referralDecaySteps } from "./engagement.scoring";
import type { WheelRng } from "../leaderboard/wheel-rng";

/**
 * Daily $5 Freeplay draw eligibility (documented product boundary):
 *
 * Telegram Bot API cannot list every channel subscriber. Atlas therefore does
 * not pretend to know the full Sayu Gaming Hub audience.
 *
 * A candidate is an Atlas-known registered player (LeaderboardBotPlayerLink
 * by stable Telegram user ID, never username) whose current channel membership
 * is positively verified via getChatMember as a non-bot `member` or
 * `restricted` subscriber. Creators, administrators, left/kicked, deleted,
 * unknown, and failed lookups are excluded.
 */
export interface DailyDrawCandidate {
  readonly crmContactId: string;
  readonly telegramUserId: string;
  readonly displayName: string;
  readonly baseWeight: number;
  readonly referralWeight: number;
  readonly totalWeight: number;
  readonly activeReferralCount: number;
}

export interface DailyDrawCandidateSnapshot {
  readonly crmContactId: string;
  readonly telegramUserId: string;
  readonly baseWeight: number;
  readonly referralWeight: number;
  readonly totalWeight: number;
  readonly activeReferralCount: number;
}

export interface WeightedDrawPick<T extends { readonly totalWeight: number }> {
  readonly index: number;
  readonly pick: number;
  readonly totalWeight: number;
  readonly selected: T;
}

export function dailyDrawOutboxKey(ownerCoadminUserId: string, chicagoDate: string): string {
  return `eng:draw:${ownerCoadminUserId}:${chicagoDate}`;
}

export function dailyDrawAnnounceOutboxKey(ownerCoadminUserId: string, chicagoDate: string): string {
  return `eng:draw-announce:${ownerCoadminUserId}:${chicagoDate}`;
}

export function dailyDrawFreeplayIdempotencyKey(ownerCoadminUserId: string, chicagoDate: string): string {
  return `eng:daily-fp:${ownerCoadminUserId}:${chicagoDate}`;
}

export function drawReferralWeight(steps: number): number {
  return Math.max(
    DRAW_REFERRAL_FLOOR_WEIGHT,
    DRAW_REFERRAL_START_WEIGHT - DRAW_REFERRAL_STEP_WEIGHT * Math.max(0, steps)
  );
}

export function drawReferralWeightAtDeclaration(qualifiedAt: Date, declarationAt: Date): number {
  if (qualifiedAt.getTime() >= declarationAt.getTime()) return 0;
  return drawReferralWeight(referralDecaySteps(qualifiedAt, declarationAt));
}

export function candidateDrawWeight(referralWeight: number): number {
  return DRAW_BASE_WEIGHT + Math.max(0, referralWeight);
}

export function isDailyDrawEligibleChatMember(member: {
  readonly status: string;
  readonly user: { readonly isBot?: boolean };
}): boolean {
  if (member.user.isBot) return false;
  const status = member.status.trim().toLowerCase();
  return status === "member" || status === "restricted";
}

export function isInDailyDrawWinnerCooldown(
  lastWinChicagoDates: readonly string[],
  drawChicagoDate: string,
  cooldownDraws = DRAW_WINNER_COOLDOWN_DRAWS
): boolean {
  return lastWinChicagoDates.some((winDate) => {
    const diff = chicagoDateDiffDays(winDate, drawChicagoDate);
    return diff >= 1 && diff <= cooldownDraws;
  });
}

export function snapshotDailyDrawCandidates(
  candidates: readonly DailyDrawCandidate[]
): DailyDrawCandidateSnapshot[] {
  return candidates.map((candidate) => ({
    crmContactId: candidate.crmContactId,
    telegramUserId: candidate.telegramUserId,
    baseWeight: candidate.baseWeight,
    referralWeight: candidate.referralWeight,
    totalWeight: candidate.totalWeight,
    activeReferralCount: candidate.activeReferralCount
  }));
}

/**
 * Weighted random selection. Probability is proportional to totalWeight.
 * Does not pick the highest-weight candidate unless the RNG lands in that range.
 */
export function selectWeightedDailyDrawCandidate<T extends { readonly totalWeight: number }>(
  candidates: readonly T[],
  rng: WheelRng
): WeightedDrawPick<T> {
  const eligible = candidates.filter((candidate) => candidate.totalWeight > 0);
  if (eligible.length === 0) {
    throw new Error("Cannot draw from an empty or zero-weight candidate set");
  }
  let totalWeight = 0;
  for (const candidate of eligible) {
    if (!Number.isInteger(candidate.totalWeight)) {
      throw new Error("Daily draw weights must be integers");
    }
    totalWeight += candidate.totalWeight;
  }
  const pick = rng.nextInt(totalWeight);
  let remaining = pick;
  for (let index = 0; index < eligible.length; index += 1) {
    const selected = eligible[index]!;
    if (remaining < selected.totalWeight) {
      return { index, pick, totalWeight, selected };
    }
    remaining -= selected.totalWeight;
  }
  const last = eligible[eligible.length - 1]!;
  return { index: eligible.length - 1, pick, totalWeight, selected: last };
}

export function stackReferralWeights(weights: readonly number[]): number {
  return weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
}
