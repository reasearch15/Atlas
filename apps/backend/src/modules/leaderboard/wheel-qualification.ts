import { WHEEL_CYCLE_HOURS, WHEEL_QUALIFICATION_CENTS } from "./leaderboard.constants";

/** Player-relative rolling window and spin cooldown. */
export const WHEEL_ROLLING_WINDOW_MS = WHEEL_CYCLE_HOURS * 60 * 60 * 1000;

export interface WheelDepositLike {
  readonly type: string;
  readonly depositAmountCents: number | null;
  readonly occurredAt: Date;
}

/**
 * Inclusive rolling floor: a deposit at T still counts at T+48h,
 * and drops out at T+48h+1ms.
 */
export function wheelRollingStart(now: Date): Date {
  return new Date(now.getTime() - WHEEL_ROLLING_WINDOW_MS);
}

export function nextWheelSpinAt(lastSpinAt: Date | null | undefined): Date | null {
  if (!lastSpinAt) return null;
  return new Date(lastSpinAt.getTime() + WHEEL_ROLLING_WINDOW_MS);
}

export function wheelCooldownSatisfied(
  now: Date,
  lastSpinAt: Date | null | undefined
): boolean {
  const next = nextWheelSpinAt(lastSpinAt);
  return next == null || now.getTime() >= next.getTime();
}

/**
 * Prisma/in-memory filter for deposits that currently count toward the next spin.
 *
 * lastSpinAt is exclusive so consumed deposits cannot be reused.
 * The 48h floor is inclusive.
 */
export function qualificationOccurredAtFilter(
  now: Date,
  lastSpinAt: Date | null | undefined
): { readonly gte?: Date; readonly gt?: Date; readonly lte: Date } {
  const rollingStart = wheelRollingStart(now);
  if (lastSpinAt && lastSpinAt.getTime() >= rollingStart.getTime()) {
    return { gt: lastSpinAt, lte: now };
  }
  return { gte: rollingStart, lte: now };
}

export function eventCountsTowardQualification(
  occurredAt: Date,
  now: Date,
  lastSpinAt: Date | null | undefined
): boolean {
  const t = occurredAt.getTime();
  if (t > now.getTime()) return false;
  if (t < wheelRollingStart(now).getTime()) return false;
  if (lastSpinAt && t <= lastSpinAt.getTime()) return false;
  return true;
}

export function sumQualifyingDepositCents(
  events: readonly WheelDepositLike[],
  now: Date,
  lastSpinAt: Date | null | undefined
): number {
  let cents = 0;
  for (const event of events) {
    if (event.type !== "DEPOSIT" && event.type !== "DEPOSIT_REVERSAL") continue;
    if (!eventCountsTowardQualification(event.occurredAt, now, lastSpinAt)) continue;
    cents += event.depositAmountCents ?? 0;
  }
  return Math.max(0, cents);
}

/**
 * Net of the window that unlocked the last spin, plus later reversals.
 * Used only to mark qualificationInvalidatedAt — points are never clawed back.
 */
export function sumConsumedQualificationCents(
  events: readonly WheelDepositLike[],
  lastSpinAt: Date,
  previousSpinAt: Date | null | undefined
): number {
  const windowStart = wheelRollingStart(lastSpinAt);
  let cents = 0;
  for (const event of events) {
    if (event.type !== "DEPOSIT" && event.type !== "DEPOSIT_REVERSAL") continue;
    const t = event.occurredAt.getTime();
    if (previousSpinAt && t <= previousSpinAt.getTime()) continue;
    if (t <= lastSpinAt.getTime()) {
      if (t < windowStart.getTime()) continue;
      cents += event.depositAmountCents ?? 0;
      continue;
    }
    if (event.type === "DEPOSIT_REVERSAL") {
      cents += event.depositAmountCents ?? 0;
    }
  }
  return Math.max(0, cents);
}

export function isWheelQualified(cents: number): boolean {
  return cents >= WHEEL_QUALIFICATION_CENTS;
}
