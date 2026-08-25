import {
  PARTICIPATION_POINTS,
  REFERRAL_FLOOR_POINTS,
  REFERRAL_START_POINTS,
  REFERRAL_STEP_POINTS,
  WINNING_OPTION_POINTS
} from "./engagement.constants";
import { firstDeclarationAfter } from "./engagement.schedule";
import { compareStandings } from "../leaderboard/ranking";

export function pollPointsForVote(optionIndex: number, winningOptionIndex: number): number {
  return optionIndex === winningOptionIndex ? WINNING_OPTION_POINTS : PARTICIPATION_POINTS;
}

export function countOptionVotes(optionIndexes: readonly number[]): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (const index of optionIndexes) {
    if (index >= 0 && index < 4) counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

export function parseStoredOptionCounts(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    const n = value[i];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    counts[i] = n;
  }
  return counts;
}

export function nativeCountsFromPollOptions(
  options: readonly { readonly voterCount: number }[]
): [number, number, number, number] | null {
  if (options.length < 4) return null;
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    const n = options[i]?.voterCount;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    counts[i] = n;
  }
  return counts;
}

export function winningOptionIndex(counts: readonly number[]): number {
  if (counts.length !== 4) {
    throw new Error("Engagement polls require exactly 4 option counts");
  }
  let winner = 0;
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i]! > counts[winner]!) winner = i;
  }
  return winner;
}

/**
 * Largest-remainder percentages so displayed integers sum to 100.
 * Remainder ties go to the lowest option index. Winner is still chosen from raw counts.
 */
export function votePercentages(counts: readonly number[]): number[] {
  if (counts.length !== 4) {
    throw new Error("Engagement polls require exactly 4 option counts");
  }
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return [0, 0, 0, 0];
  const exact = counts.map((n) => (n / total) * 100);
  const floors = exact.map((value) => Math.floor(value));
  const remaining = 100 - floors.reduce((sum, n) => sum + n, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const result = [...floors];
  for (let i = 0; i < remaining && i < order.length; i += 1) {
    const optionIndex = order[i]?.index;
    if (optionIndex == null) continue;
    result[optionIndex] = (result[optionIndex] ?? 0) + 1;
  }
  return result;
}

export function referralDecaySteps(qualifiedAt: Date, declarationAt: Date): number {
  if (qualifiedAt.getTime() >= declarationAt.getTime()) return 0;
  let steps = 0;
  let boundary = firstDeclarationAfter(qualifiedAt);
  while (boundary.getTime() < declarationAt.getTime()) {
    steps += 1;
    boundary = firstDeclarationAfter(boundary);
  }
  return steps;
}

export function referralEngagementPoints(steps: number): number {
  return Math.max(REFERRAL_FLOOR_POINTS, REFERRAL_START_POINTS - REFERRAL_STEP_POINTS * steps);
}

export function referralContributionAtDeclaration(qualifiedAt: Date, declarationAt: Date): number {
  if (qualifiedAt.getTime() >= declarationAt.getTime()) return 0;
  return referralEngagementPoints(referralDecaySteps(qualifiedAt, declarationAt));
}

export interface EngagementRankable {
  crmContactId: string;
  totalPoints: number;
  pointsReachedAt: Date;
}

export interface EngagementScoreTotal extends EngagementRankable {
  pollPoints: number;
  referralPoints: number;
}

export function rankEngagementPlayers<T extends EngagementRankable>(rows: readonly T[]): T[] {
  return [...rows].sort(compareStandings);
}

export function top3EngagementPlayers<T extends EngagementRankable>(rows: readonly T[]): T[] {
  return rankEngagementPlayers(rows).slice(0, 3);
}

export function pollParticipationIdempotencyKey(pollId: string, crmContactId: string): string {
  return `eng:vote:${pollId}:${crmContactId}`;
}

export function referralContributionIdempotencyKey(
  ownerCoadminUserId: string,
  chicagoDate: string,
  referralId: string
): string {
  return `eng:ref:${ownerCoadminUserId}:${chicagoDate}:${referralId}`;
}

export function freeplayGrantIdempotencyKey(
  ownerCoadminUserId: string,
  chicagoDate: string,
  prizeRank: number
): string {
  return `eng:fp:${ownerCoadminUserId}:${chicagoDate}:${prizeRank}`;
}

export function postPollOutboxKey(pollId: string): string {
  return `eng:post:${pollId}`;
}

export function closePollOutboxKey(pollId: string): string {
  return `eng:close:${pollId}`;
}

export function announceOutboxKey(ownerCoadminUserId: string, chicagoDate: string): string {
  return `eng:announce:${ownerCoadminUserId}:${chicagoDate}`;
}
