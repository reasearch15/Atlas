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

export function votePercentages(counts: readonly number[]): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return [0, 0, 0, 0];
  return counts.map((n) => Math.round((n / total) * 100));
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
  readonly crmContactId: string;
  readonly totalPoints: number;
  readonly pointsReachedAt: Date;
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
