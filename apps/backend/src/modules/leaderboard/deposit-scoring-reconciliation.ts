import { depositPointsFromCumulativeCents } from "./points-math";
import type { EventRow, EventType } from "./leaderboard.types";

/** Idempotent marker for ACTIVE competition deposit-scoring migration to $1 = 1 point. */
export const DEPOSIT_SCORING_RECONCILIATION_PREFIX = "ACTIVE_DEPOSIT_SCORING_V2_RECONCILIATION" as const;

export function depositScoringReconciliationIdempotencyKey(
  competitionId: string,
  crmContactId: string
): string {
  return `${DEPOSIT_SCORING_RECONCILIATION_PREFIX}:${competitionId}:${crmContactId}`;
}

export function isDepositScoringReconciliationKey(idempotencyKey: string): boolean {
  return idempotencyKey.startsWith(`${DEPOSIT_SCORING_RECONCILIATION_PREFIX}:`);
}

/**
 * Valid qualifying deposit cents from append-only ledger.
 * Uses DEPOSIT / DEPOSIT_REVERSAL amounts only (reversals store negative cents).
 * Ignores MANUAL_ADJUSTMENT and non-deposit event types.
 */
export function validQualifyingDepositCentsFromLedger(
  events: readonly Pick<EventRow, "type" | "depositAmountCents">[]
): number {
  let cents = 0;
  for (const event of events) {
    if (event.type === "DEPOSIT" || event.type === "DEPOSIT_REVERSAL") {
      cents += event.depositAmountCents ?? 0;
    }
  }
  if (cents < 0) {
    throw new Error("qualifying deposits reconstructed from ledger cannot be negative");
  }
  return cents;
}

export function correctDepositPointsFromLedger(
  events: readonly Pick<EventRow, "type" | "depositAmountCents">[]
): number {
  return depositPointsFromCumulativeCents(validQualifyingDepositCentsFromLedger(events));
}

/** Mutable timeline step for historical score reconstruction under v2 deposit math. */
export function stepReconcileTimeline(
  state: { cents: number; referral: number; promotion: number },
  event: Pick<EventRow, "type" | "pointsDelta" | "depositAmountCents">
): void {
  const type = event.type as EventType;
  if (type === "DEPOSIT" || type === "DEPOSIT_REVERSAL") {
    state.cents += event.depositAmountCents ?? 0;
    return;
  }
  if (type === "REFERRAL_MILESTONE" || type === "REFERRAL_MILESTONE_REVERSAL") {
    state.referral += event.pointsDelta;
    return;
  }
  if (type === "PROMOTION" || type === "PROMOTION_REVERSAL") {
    state.promotion += event.pointsDelta;
  }
  // MANUAL_ADJUSTMENT ignored — migration artifact, not a player action.
}

/**
 * Earliest historical time the reconciled total would have been reached under v2 deposit scoring,
 * using referral/promotion ledger deltas as-is and recomputing deposit points from cumulative cents.
 */
export function reconstructPointsReachedAt(input: {
  readonly events: readonly Pick<EventRow, "id" | "type" | "pointsDelta" | "depositAmountCents" | "occurredAt">[];
  readonly correctDepositPoints: number;
  readonly referralPoints: number;
  readonly promotionPoints: number;
  readonly fallback: Date;
}): Date {
  const targetTotal = input.correctDepositPoints + input.referralPoints + input.promotionPoints;
  if (targetTotal <= 0) return input.fallback;

  const sorted = [...input.events].sort((a, b) => {
    const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });

  const state = { cents: 0, referral: 0, promotion: 0 };
  for (const event of sorted) {
    stepReconcileTimeline(state, event);
    const total =
      depositPointsFromCumulativeCents(state.cents) + state.referral + state.promotion;
    if (total === targetTotal) {
      return event.occurredAt;
    }
  }

  return input.fallback;
}

export interface DepositScoringReconciliationAdjustment {
  readonly competitionId: string;
  readonly ownerCoadminUserId: string;
  readonly crmContactId: string;
  readonly qualifyingDepositCents: number;
  readonly fromDepositPoints: number;
  readonly toDepositPoints: number;
  readonly pointsDelta: number;
  readonly alreadyReconciled: boolean;
}

export interface DepositScoringReconciliationResult {
  readonly competitionsProcessed: number;
  readonly playersVisited: number;
  readonly playersAdjusted: number;
  readonly playersAlreadyCorrect: number;
  readonly playersSkippedIdempotent: number;
  readonly adjustments: readonly DepositScoringReconciliationAdjustment[];
}
