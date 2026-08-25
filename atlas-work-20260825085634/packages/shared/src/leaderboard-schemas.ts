import { z } from "zod";

export const leaderboardDepositBodySchema = z.object({
  crmContactId: z.string().uuid(),
  amountCents: z.number().int().positive().max(100_000_000),
  idempotencyKey: z.string().min(8).max(160),
  reason: z.string().max(500).optional()
});

export const leaderboardReferralBodySchema = z.object({
  referrerCrmContactId: z.string().uuid(),
  referredCrmContactId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(160)
});

export const leaderboardPromotionBodySchema = z.object({
  crmContactId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(160),
  reason: z.string().max(500).optional()
});

export const leaderboardGiveInfoBodySchema = z.object({
  crmContactId: z.string().uuid(),
  chatId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(160)
});

export const leaderboardStandingsQuerySchema = z.object({
  filter: z.enum(["TOP_10", "TOP_50", "ALL", "REFERRERS", "RECENTLY_CHANGED"]).default("TOP_50"),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50)
});

export const leaderboardPlayerSearchQuerySchema = z.object({
  /** Empty string browses eligible players; 1+ chars runs contains search. */
  q: z.string().trim().max(120).default(""),
  excludeContactId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25)
});

export const leaderboardContactParamsSchema = z.object({
  crmContactId: z.string().uuid()
});

export const leaderboardEnabledBodySchema = z.object({
  enabled: z.boolean(),
  confirmDisable: z.boolean().optional()
});

export const leaderboardPoolRateBodySchema = z.object({
  poolRateBps: z.union([z.literal(200), z.literal(300), z.literal(400), z.literal(500)]),
  reason: z.string().trim().min(1).max(500).optional()
});

export const leaderboardEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  type: z.string().trim().max(64).optional(),
  crmContactId: z.string().uuid().optional()
});

export const leaderboardDepositHistoryQuerySchema = z.object({
  /** Opaque keyset cursor from a previous page's nextCursor. */
  cursor: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(30).default(30),
  /**
   * Coadmin-only: filter to deposits recorded by this Atlas user.
   * Ignored for Staff (Staff is always scoped to self).
   */
  actorUserId: z.string().uuid().optional(),
  /**
   * Coadmin-only: filter to deposits for this CRM contact under the coadmin board.
   * Ignored for Staff authorization scope (still applied only within Staff's own deposits).
   */
  crmContactId: z.string().uuid().optional()
});

export const leaderboardReverseEventBodySchema = z.object({
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().min(8).max(160)
});

export const leaderboardReferralOverrideBodySchema = z.object({
  newReferrerCrmContactId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().min(8).max(160)
});

export const leaderboardFinalizeBodySchema = z.object({
  idempotencyKey: z.string().min(8).max(160),
  confirm: z.literal(true)
});

export const leaderboardEligibilityBodySchema = z.object({
  membershipStatus: z.enum(["ELIGIBLE", "NOT_ELIGIBLE", "PENDING_REVIEW"]),
  reason: z.string().trim().min(1).max(500).optional(),
  ineligibilityReason: z.string().trim().max(120).optional(),
  idempotencyKey: z.string().min(8).max(160),
  /** Required to override a prior TELEGRAM_BOT_API ELIGIBLE/NOT_ELIGIBLE decision. */
  explicitOverride: z.boolean().optional()
});

export const leaderboardTelegramConnectBodySchema = z.object({
  token: z.string().trim().min(20).max(200)
});

export const leaderboardTelegramRotateTokenBodySchema = z.object({
  token: z.string().trim().min(20).max(200)
});

export const leaderboardTelegramChannelBodySchema = z.object({
  channelRef: z.string().trim().min(1).max(120)
});

export const leaderboardTelegramPostingBodySchema = z.object({
  postingEnabled: z.boolean()
});

export const leaderboardTelegramPlayDestinationBodySchema = z.object({
  playTelegramUsername: z.string().trim().max(120).nullable().optional()
});

export const leaderboardTelegramDisconnectBodySchema = z.object({
  confirm: z.literal(true)
});

export const leaderboardEnsureAutoBindBodySchema = z.object({
  crmContactId: z.string().uuid()
});

export const leaderboardParticipantsBackfillBodySchema = z.object({
  dryRun: z.boolean().optional().default(true)
});

export const leaderboardPayoutMarkBodySchema = z.object({
  status: z.enum(["PAID", "VOID"]),
  notes: z.string().trim().max(500).optional(),
  confirm: z.literal(true),
  idempotencyKey: z.string().min(8).max(160)
});

export const leaderboardIdParamsSchema = z.object({
  id: z.string().uuid()
});

export const leaderboardEventParamsSchema = z.object({
  eventId: z.string().uuid()
});

export const leaderboardCompetitionParamsSchema = z.object({
  competitionId: z.string().uuid()
});

export const leaderboardReferralParamsSchema = z.object({
  referralId: z.string().uuid()
});

export const leaderboardPayoutParamsSchema = z.object({
  payoutId: z.string().uuid()
});

export const leaderboardWheelSpinBodySchema = z.object({
  crmContactId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(160)
});

export const leaderboardWheelSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  qualificationCreditPolicy: z
    .enum(["UNSET", "CYCLE_DEPOSITS_ALL", "CYCLE_DEPOSITS_AFTER_ENABLE"])
    .optional()
});

export const leaderboardWheelDistributionOutcomeSchema = z.object({
  points: z.number().int().min(0).max(40),
  weight: z.number().positive()
});

export const leaderboardWheelConfigVersionBodySchema = z.object({
  distribution: z.array(leaderboardWheelDistributionOutcomeSchema).min(1)
});

export const leaderboardWheelVersionParamsSchema = z.object({
  id: z.string().uuid()
});
