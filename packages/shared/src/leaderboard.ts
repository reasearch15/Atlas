/**
 * Shared leaderboard / giveaway API contracts (Phase 2).
 * Never expose poolRateBps or contribution formulas to clients.
 */

export type LeaderboardStandingFilter = "TOP_10" | "TOP_50" | "ALL" | "REFERRERS" | "RECENTLY_CHANGED";

export interface LeaderboardCompetitionSummaryDto {
  readonly competitionId: string;
  readonly status: "SCHEDULED" | "ACTIVE" | "FROZEN" | "FINALIZED" | "CANCELLED";
  readonly startsAt: string;
  readonly endsAt: string;
  /** Prize pool in cents. Display as currency; never show contribution %. */
  readonly prizePoolCents: number;
}

export interface LeaderboardCurrentBoardDto {
  readonly competition: LeaderboardCompetitionSummaryDto | null;
  readonly prizePoolCents: number;
}

export interface LeaderboardWheelStatusDto {
  readonly wheelEnabled: boolean;
  readonly configured: boolean;
  readonly competitionId: string | null;
  readonly competitionStatus: string | null;
  readonly cycleSequence: number | null;
  readonly cycleStartsAt: string | null;
  readonly cycleEndsAt: string | null;
  readonly qualifyingDepositCents: number;
  readonly qualificationCentsRequired: number;
  readonly available: boolean;
  readonly consumed: boolean;
  readonly pointsAwarded: number | null;
  readonly qualificationInvalidated: boolean;
  readonly wheelPoints: number;
  readonly reasonCode: string | null;
}

export type LeaderboardWheelQualificationCreditPolicy =
  | "UNSET"
  | "CYCLE_DEPOSITS_ALL"
  | "CYCLE_DEPOSITS_AFTER_ENABLE";

export interface LeaderboardWheelSettingsDto {
  readonly enabled: boolean;
  readonly qualificationCreditPolicy: LeaderboardWheelQualificationCreditPolicy;
  readonly enabledAt: string | null;
  readonly activeVersionId: string | null;
  readonly needsConfiguration: boolean;
  readonly versions: readonly LeaderboardWheelConfigVersionDto[];
}

export interface LeaderboardWheelConfigVersionDto {
  readonly id: string;
  readonly createdAt: string;
  readonly createdByUserId: string;
  readonly activatedAt: string | null;
  readonly distribution: readonly { readonly points: number; readonly weight: number }[];
  readonly isActive: boolean;
}

export interface LeaderboardWheelSpinResultDto {
  readonly pointsAwarded: number;
  readonly totalPoints: number;
  readonly wheelPoints: number;
  readonly previousRank: number | null;
  readonly resultingRank: number | null;
  readonly cycleSequence: number;
  readonly replay: boolean;
  readonly spinId: string;
}

export interface LeaderboardPlayerStatusDto {
  readonly bound: boolean;
  readonly crmContactId: string;
  readonly competition: LeaderboardCompetitionSummaryDto | null;
  readonly rank: number | null;
  readonly totalPoints: number | null;
  readonly depositPoints: number | null;
  readonly referralPoints: number | null;
  readonly promotionPoints: number | null;
  readonly wheelPoints: number | null;
  readonly qualifyingDepositCents: number | null;
  readonly successfulReferralCount: number | null;
  readonly lastEventAt: string | null;
  readonly lastEventReason: string | null;
  readonly unboundReason?: "PARTICIPANT_NOT_BOUND" | null;
  readonly wheel?: LeaderboardWheelStatusDto | null;
}

export interface LeaderboardStandingRowDto {
  readonly rank: number;
  readonly crmContactId: string;
  readonly displayName: string;
  /** Present only when role may view Telegram usernames. */
  readonly telegramUsername: string | null;
  readonly totalPoints: number;
  readonly depositPoints: number;
  readonly referralPoints: number;
  readonly promotionPoints: number;
  readonly wheelPoints: number;
  readonly qualifyingDepositCents: number;
  readonly successfulReferralCount: number;
  readonly lastEventAt: string | null;
  readonly lastEventReason: string | null;
  readonly gapToNextRankPoints: number | null;
  readonly gapToTop3Points: number | null;
}

export interface LeaderboardStandingsPageDto {
  readonly competition: LeaderboardCompetitionSummaryDto;
  readonly filter: LeaderboardStandingFilter;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly rows: readonly LeaderboardStandingRowDto[];
}

export interface LeaderboardPlayerSearchHitDto {
  readonly crmContactId: string;
  readonly displayName: string;
  readonly telegramUsername: string | null;
  /** Stable short disambiguator (non-sensitive contact id prefix). */
  readonly shortId: string;
}

export interface LeaderboardDepositResultDto {
  readonly amountCents: number;
  readonly pointsAdded: number;
  readonly totalPoints: number;
  readonly depositPoints: number;
  readonly qualifyingDepositCents: number;
  readonly prizePoolCents: number;
  readonly previousRank: number | null;
  readonly newRank: number;
  readonly competitionEndsAt: string;
}

export interface LeaderboardReferralResultDto {
  readonly referrerCrmContactId: string;
  readonly referredCrmContactId: string;
  readonly linked: true;
}

export interface LeaderboardPromotionResultDto {
  readonly pointsAwarded: number;
  readonly totalPoints: number;
  readonly previousRank: number | null;
  readonly newRank: number;
  readonly competitionEndsAt: string;
}

export interface LeaderboardGiveInfoResultDto {
  readonly chatId: string;
  readonly messageText: string;
  readonly sendStatusCode: 200 | 202;
}

/** Coadmin-only settings (may include pool rate). Never send to Staff/player surfaces. */
export interface LeaderboardSettingsDto {
  readonly enabled: boolean;
  readonly poolRateBps: 200 | 300 | 400 | 500;
  readonly timezone: string;
  readonly updatedAt: string;
}

export interface LeaderboardPoolRateHistoryDto {
  readonly id: string;
  readonly rateBps: number;
  readonly effectiveFrom: string;
  readonly changedByUserId: string | null;
  readonly reason: string | null;
}

export interface LeaderboardAdminCompetitionDto {
  readonly competitionId: string;
  readonly sequence: number;
  readonly status: "SCHEDULED" | "ACTIVE" | "FROZEN" | "FINALIZED" | "CANCELLED";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly prizePoolCents: number;
  readonly playerCount: number;
  readonly totalQualifyingDepositCents: number;
  readonly top3: readonly LeaderboardStandingRowDto[];
  readonly top10: readonly LeaderboardStandingRowDto[];
}

export interface LeaderboardEventRowDto {
  readonly id: string;
  readonly occurredAt: string;
  readonly crmContactId: string;
  readonly displayName: string;
  readonly type: string;
  readonly pointsDelta: number;
  readonly depositAmountCents: number | null;
  /** Coadmin-only; never include on Staff/player DTOs. */
  readonly poolContributionCents: number | null;
  readonly poolRateBpsApplied: number | null;
  readonly actorUserId: string | null;
  readonly reason: string | null;
  readonly reversesEventId: string | null;
  readonly reversed: boolean;
}

export interface LeaderboardEventsPageDto {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly rows: readonly LeaderboardEventRowDto[];
}

export interface LeaderboardReferralAdminRowDto {
  readonly id: string;
  readonly referrerCrmContactId: string;
  readonly referrerDisplayName: string;
  readonly referredCrmContactId: string;
  readonly referredDisplayName: string;
  readonly createdAt: string;
  readonly lifetimeQualifyingDepositCents: number;
  readonly milestones: readonly {
    readonly code: string;
    readonly points: number;
    readonly status: string;
    readonly awardedAt: string;
  }[];
  readonly overriddenAt: string | null;
  readonly overrideReason: string | null;
}

export interface LeaderboardEligibilityCandidateDto {
  readonly crmContactId: string;
  readonly displayName: string;
  readonly leaderboardRank: number;
  readonly totalPoints: number;
  readonly membershipStatus: "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW";
  readonly ineligibilityReason: string | null;
  readonly prizeRank: number | null;
  readonly verificationSource: "MANUAL" | "TELEGRAM_BOT_API" | null;
  readonly telegramChatMemberStatus: string | null;
  readonly verificationCheckedAt: string | null;
  readonly verificationErrorCode: string | null;
}

/** Coadmin Telegram Bot API integration (never includes token). */
export interface LeaderboardTelegramIntegrationDto {
  readonly connected: boolean;
  readonly botUsername: string | null;
  readonly botDisplayName: string | null;
  readonly botTelegramUserId: string | null;
  readonly channelId: string | null;
  readonly channelTitle: string | null;
  readonly channelUsername: string | null;
  readonly postingEnabled: boolean;
  readonly channelVerified: boolean;
  readonly connectedAt: string | null;
  readonly lastVerifiedAt: string | null;
  readonly lastChannelVerifiedAt: string | null;
  readonly lastSuccessfulPostAt: string | null;
  readonly lastMembershipCheckAt: string | null;
  readonly lastError: string | null;
  readonly hasPersistentMessage: boolean;
  readonly disconnectWarning: string | null;
  /** Deep link to this coadmin's bot when username is known. */
  readonly botDeepLink: string | null;
  readonly webhookRegisteredAt: string | null;
  readonly lastInboundAt: string | null;
  readonly webhookConfigured: boolean;
}

/** Result of Coadmin manual "Send Leaderboard" (queues snapshot-only outbox refresh). */
export interface LeaderboardTelegramSendLatestDto {
  readonly queued: true;
  readonly jobId: string;
  readonly competitionId: string;
  /** edit = persistent message exists for this channel; send = new message path */
  readonly mode: "edit" | "send";
  /** Verified channel title when available (for UI success copy). */
  readonly channelTitle: string | null;
  readonly message: string;
}

export interface LeaderboardCompetitionReviewDto {
  readonly competition: LeaderboardAdminCompetitionDto;
  readonly frozenAt: string | null;
  readonly prizePoolCents: number;
  readonly leaderboardTop10: readonly LeaderboardStandingRowDto[];
  readonly eligibilityCandidates: readonly LeaderboardEligibilityCandidateDto[];
  readonly prizeWinnersPreview: readonly LeaderboardEligibilityCandidateDto[];
  readonly canFinalize: boolean;
  readonly finalizeBlockReason: string | null;
  readonly winnersLocked: boolean;
}

export interface LeaderboardPayoutDto {
  readonly id: string;
  readonly competitionId: string;
  readonly prizeRank: number;
  readonly leaderboardRank: number;
  readonly crmContactId: string;
  readonly displayName: string;
  readonly points: number;
  readonly payoutCents: number;
  readonly status: "UNPAID" | "PAID" | "VOID";
  readonly paidAt: string | null;
  readonly paidByUserId: string | null;
  readonly notes: string | null;
}
