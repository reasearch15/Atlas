import { REFERRAL_MILESTONES, type ReferralMilestoneCodeValue } from "./leaderboard.constants";

export interface MilestoneDefinition {
  readonly code: ReferralMilestoneCodeValue;
  readonly thresholdCents: number;
  readonly points: number;
}

export function milestoneDefinitions(): readonly MilestoneDefinition[] {
  return REFERRAL_MILESTONES;
}

/**
 * Returns milestones that should be ACTIVE given lifetime qualifying cents,
 * comparing against currently active milestone codes.
 */
export function milestonesToAward(
  lifetimeQualifyingDepositCents: number,
  activeCodes: ReadonlySet<string>
): readonly MilestoneDefinition[] {
  return REFERRAL_MILESTONES.filter(
    (m) => lifetimeQualifyingDepositCents >= m.thresholdCents && !activeCodes.has(m.code)
  );
}

/**
 * Returns active milestones that are no longer valid after lifetime cents dropped.
 */
export function milestonesToReverse(
  lifetimeQualifyingDepositCents: number,
  active: readonly { code: string; thresholdCents: number; points: number }[]
): readonly { code: string; thresholdCents: number; points: number }[] {
  return active.filter((m) => lifetimeQualifyingDepositCents < m.thresholdCents);
}
