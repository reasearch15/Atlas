export type CompetitionStatus = "SCHEDULED" | "ACTIVE" | "FROZEN" | "FINALIZED" | "CANCELLED";
export type EventType =
  | "DEPOSIT"
  | "DEPOSIT_REVERSAL"
  | "REFERRAL_MILESTONE"
  | "REFERRAL_MILESTONE_REVERSAL"
  | "PROMOTION"
  | "PROMOTION_REVERSAL"
  | "MANUAL_ADJUSTMENT";
export type MilestoneCode = "FIRST_10" | "CUM_50" | "CUM_100" | "CUM_250";
export type MilestoneStatus = "ACTIVE" | "REVERSED";
export type PayoutStatus = "UNPAID" | "PAID" | "VOID";
export type PrizeMembershipStatus = "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW";

export interface LeaderboardSettingsRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  enabled: boolean;
  poolRateBps: number;
  timezone: string;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeaderboardParticipantRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompetitionRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  sequence: number;
  startsAt: Date;
  endsAt: Date;
  status: CompetitionStatus;
  prizePoolCents: number;
  frozenAt: Date | null;
  finalizedAt: Date | null;
  finalizedByUserId: string | null;
  finalizationIdempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  type: EventType;
  pointsDelta: number;
  depositAmountCents: number | null;
  poolContributionCents: number | null;
  poolRateBpsApplied: number | null;
  actorUserId: string | null;
  reason: string | null;
  metadataJson: Record<string, unknown>;
  occurredAt: Date;
  idempotencyKey: string;
  reversesEventId: string | null;
  createdAt: Date;
}

export interface StandingRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  totalPoints: number;
  depositPoints: number;
  referralPoints: number;
  promotionPoints: number;
  qualifyingDepositCents: number;
  successfulReferralCount: number;
  pointsReachedAt: Date;
  lastEventId: string | null;
  lastEventAt: Date | null;
  lastEventType: EventType | null;
  lastEventReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReferralRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  referrerCrmContactId: string;
  referredCrmContactId: string;
  createdByUserId: string | null;
  originalReferrerCrmContactId: string | null;
  overriddenAt: Date | null;
  overriddenByUserId: string | null;
  overrideReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlayerStatsRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  lifetimeQualifyingDepositCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MilestoneAwardRow {
  id: string;
  workspaceId: string;
  referralId: string;
  competitionId: string;
  milestoneCode: MilestoneCode;
  thresholdCents: number;
  points: number;
  status: MilestoneStatus;
  generation: number;
  awardEventId: string;
  reversalEventId: string | null;
  awardedAt: Date;
  reversedAt: Date | null;
  createdAt: Date;
}

export interface PromotionAwardRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  points: number;
  eventId: string;
  actorUserId: string | null;
  idempotencyKey: string;
  createdAt: Date;
}

export interface PoolRateHistoryRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string | null;
  rateBps: number;
  effectiveFrom: Date;
  changedByUserId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface SnapshotRow {
  id: string;
  competitionId: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  frozenAt: Date;
  prizePoolCents: number;
  top10Json: unknown;
  top3Json: unknown;
  standingsHash: string;
  metricsJson: Record<string, unknown>;
  winnersJson: unknown | null;
  winnersLockedAt: Date | null;
  createdAt: Date;
}

export type EligibilityVerificationSource = "MANUAL" | "TELEGRAM_BOT_API";

export interface EligibilityCandidateRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  leaderboardRank: number;
  totalPoints: number;
  membershipStatus: PrizeMembershipStatus;
  ineligibilityReason: string | null;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolutionReason: string | null;
  verificationSource: EligibilityVerificationSource | null;
  telegramChatMemberStatus: string | null;
  verifiedChannelId: string | null;
  botIntegrationId: string | null;
  verificationCheckedAt: Date | null;
  verificationErrorCode: string | null;
  verificationErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PayoutRow {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  prizeRank: number;
  leaderboardRank: number;
  crmContactId: string;
  points: number;
  payoutCents: number;
  status: PayoutStatus;
  paidAt: Date | null;
  paidByUserId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditRecord {
  workspaceId: string | null;
  actorId: string | null;
  action: string;
  metadata: Record<string, unknown>;
}

export interface BindParticipantInput {
  readonly workspaceId: string;
  readonly ownerCoadminUserId: string;
  readonly crmContactId: string;
  readonly createdByUserId?: string;
}

/** Deposit / referral / promotion resolve owner from participant binding. */
export interface DepositInput {
  readonly workspaceId: string;
  readonly crmContactId: string;
  readonly amountCents: number;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface ReverseDepositInput {
  readonly workspaceId: string;
  readonly depositEventId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface SetReferralInput {
  readonly workspaceId: string;
  readonly referrerCrmContactId: string;
  readonly referredCrmContactId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export interface OverrideReferralInput {
  readonly workspaceId: string;
  readonly referredCrmContactId: string;
  readonly newReferrerCrmContactId: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export interface PromotionInput {
  readonly workspaceId: string;
  readonly crmContactId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface ReversePromotionInput {
  readonly workspaceId: string;
  readonly promotionEventId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
  readonly now?: Date;
}

/** Authenticated coadmin operates on their own board. */
export interface SetPoolRateInput {
  readonly workspaceId: string;
  readonly ownerCoadminUserId: string;
  readonly poolRateBps: number;
  readonly actorUserId: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface FinalizeInput {
  readonly workspaceId: string;
  readonly ownerCoadminUserId: string;
  readonly competitionId: string;
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export interface MarkPayoutInput {
  readonly workspaceId: string;
  readonly ownerCoadminUserId: string;
  readonly payoutId: string;
  readonly status: "PAID" | "VOID";
  readonly actorUserId: string;
  readonly notes?: string;
  readonly idempotencyKey: string;
  readonly now?: Date;
}

export interface SetMembershipEligibilityInput {
  readonly workspaceId: string;
  readonly ownerCoadminUserId: string;
  readonly competitionId: string;
  readonly crmContactId: string;
  readonly membershipStatus: PrizeMembershipStatus;
  readonly actorUserId: string;
  readonly reason?: string;
  /** Stored when membershipStatus is NOT_ELIGIBLE (e.g. NOT_SUBSCRIBED). */
  readonly ineligibilityReason?: string | null;
  readonly idempotencyKey: string;
  readonly now?: Date;
  readonly verificationSource?: EligibilityVerificationSource | null;
  readonly telegramChatMemberStatus?: string | null;
  readonly verifiedChannelId?: string | null;
  readonly botIntegrationId?: string | null;
  readonly verificationErrorCode?: string | null;
  readonly verificationErrorMessage?: string | null;
  /** Processor path may overwrite prior Bot API results. */
  readonly allowTelegramOverwrite?: boolean;
  /** Manual API override of a prior TELEGRAM_BOT_API ELIGIBLE/NOT_ELIGIBLE decision. */
  readonly explicitOverride?: boolean;
}

/** Optional post-commit projection hooks (Telegram outbox, etc.). */
export interface LeaderboardProjectionHooks {
  onFrozen?(info: {
    readonly workspaceId: string;
    readonly ownerCoadminUserId: string;
    readonly competitionId: string;
  }): Promise<void>;
}

/** Explicit one-time ACTIVE deposit-scoring reconciliation ($5=1 → $1=1). */
export interface ReconcileActiveDepositScoringInput {
  readonly ownerCoadminUserId: string;
  /** When set, only this competition is considered (must be ACTIVE and owned by the coadmin). */
  readonly competitionId?: string;
  readonly actorUserId?: string | null;
  readonly now?: Date;
}
