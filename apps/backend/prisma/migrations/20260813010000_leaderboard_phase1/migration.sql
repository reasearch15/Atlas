-- Phase 1 leaderboard/giveaway schema (additive only).
-- Raw SQL notes:
-- 1) Partial unique index: at most one ACTIVE competition per workspace.
-- 2) Partial unique index: at most one ACTIVE milestone award per (referral, code).
-- 3) CHECK constraints for self-referral ban and pool rate bounds.

CREATE TYPE "LeaderboardCompetitionStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'FROZEN', 'FINALIZED', 'CANCELLED');
CREATE TYPE "LeaderboardEventType" AS ENUM ('DEPOSIT', 'DEPOSIT_REVERSAL', 'REFERRAL_MILESTONE', 'REFERRAL_MILESTONE_REVERSAL', 'PROMOTION', 'PROMOTION_REVERSAL');
CREATE TYPE "ReferralMilestoneCode" AS ENUM ('FIRST_10', 'CUM_50', 'CUM_100', 'CUM_250');
CREATE TYPE "ReferralMilestoneAwardStatus" AS ENUM ('ACTIVE', 'REVERSED');
CREATE TYPE "GiveawayPayoutStatus" AS ENUM ('UNPAID', 'PAID', 'VOID');

CREATE TABLE "leaderboard_settings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "pool_rate_bps" INTEGER NOT NULL DEFAULT 200,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'America/Chicago',
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leaderboard_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leaderboard_competitions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "LeaderboardCompetitionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "prize_pool_cents" INTEGER NOT NULL DEFAULT 0,
    "frozen_at" TIMESTAMP(3),
    "finalized_at" TIMESTAMP(3),
    "finalized_by_user_id" UUID,
    "finalization_idempotency_key" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leaderboard_competitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leaderboard_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "type" "LeaderboardEventType" NOT NULL,
    "points_delta" INTEGER NOT NULL,
    "deposit_amount_cents" INTEGER,
    "pool_contribution_cents" INTEGER,
    "pool_rate_bps_applied" INTEGER,
    "actor_user_id" UUID,
    "reason" VARCHAR(500),
    "metadata_json" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "reverses_event_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "leaderboard_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leaderboard_standings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "total_points" INTEGER NOT NULL DEFAULT 0,
    "deposit_points" INTEGER NOT NULL DEFAULT 0,
    "referral_points" INTEGER NOT NULL DEFAULT 0,
    "promotion_points" INTEGER NOT NULL DEFAULT 0,
    "qualifying_deposit_cents" INTEGER NOT NULL DEFAULT 0,
    "successful_referral_count" INTEGER NOT NULL DEFAULT 0,
    "points_reached_at" TIMESTAMP(3) NOT NULL,
    "last_event_id" UUID,
    "last_event_at" TIMESTAMP(3),
    "last_event_type" "LeaderboardEventType",
    "last_event_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leaderboard_standings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "leaderboard_referrals" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "referrer_crm_contact_id" UUID NOT NULL,
    "referred_crm_contact_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "original_referrer_crm_contact_id" UUID,
    "overridden_at" TIMESTAMP(3),
    "overridden_by_user_id" UUID,
    "override_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leaderboard_referrals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leaderboard_referrals_no_self_referral" CHECK ("referrer_crm_contact_id" <> "referred_crm_contact_id")
);

CREATE TABLE "leaderboard_player_stats" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "lifetime_qualifying_deposit_cents" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leaderboard_player_stats_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "referral_milestone_awards" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "referral_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "milestone_code" "ReferralMilestoneCode" NOT NULL,
    "threshold_cents" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "status" "ReferralMilestoneAwardStatus" NOT NULL DEFAULT 'ACTIVE',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "award_event_id" UUID NOT NULL,
    "reversal_event_id" UUID,
    "awarded_at" TIMESTAMP(3) NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referral_milestone_awards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "promotion_awards" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "event_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "promotion_awards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pool_rate_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "competition_id" UUID,
    "rate_bps" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "changed_by_user_id" UUID,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pool_rate_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pool_rate_history_rate_bounds" CHECK ("rate_bps" >= 200 AND "rate_bps" <= 500)
);

CREATE TABLE "competition_snapshots" (
    "id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "frozen_at" TIMESTAMP(3) NOT NULL,
    "prize_pool_cents" INTEGER NOT NULL,
    "top10_json" JSONB NOT NULL,
    "top3_json" JSONB NOT NULL,
    "standings_hash" VARCHAR(128) NOT NULL,
    "metrics_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "competition_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "giveaway_payouts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "payout_cents" INTEGER NOT NULL,
    "status" "GiveawayPayoutStatus" NOT NULL DEFAULT 'UNPAID',
    "paid_at" TIMESTAMP(3),
    "paid_by_user_id" UUID,
    "notes" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "giveaway_payouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "giveaway_payouts_rank_bounds" CHECK ("rank" >= 1 AND "rank" <= 3)
);

CREATE UNIQUE INDEX "leaderboard_settings_workspace_id_key" ON "leaderboard_settings"("workspace_id");
CREATE UNIQUE INDEX "leaderboard_competitions_workspace_id_sequence_key" ON "leaderboard_competitions"("workspace_id", "sequence");
CREATE UNIQUE INDEX "leaderboard_competitions_finalization_idempotency_key_key" ON "leaderboard_competitions"("finalization_idempotency_key");
CREATE UNIQUE INDEX "leaderboard_competitions_one_active_per_workspace" ON "leaderboard_competitions"("workspace_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "leaderboard_competitions_workspace_id_status_idx" ON "leaderboard_competitions"("workspace_id", "status");
CREATE INDEX "leaderboard_competitions_workspace_id_starts_at_ends_at_idx" ON "leaderboard_competitions"("workspace_id", "starts_at", "ends_at");

CREATE UNIQUE INDEX "leaderboard_events_idempotency_key_key" ON "leaderboard_events"("idempotency_key");
CREATE UNIQUE INDEX "leaderboard_events_reverses_event_id_key" ON "leaderboard_events"("reverses_event_id");
CREATE INDEX "leaderboard_events_workspace_id_competition_id_occurred_at_idx" ON "leaderboard_events"("workspace_id", "competition_id", "occurred_at");
CREATE INDEX "leaderboard_events_competition_id_crm_contact_id_occurred_at_idx" ON "leaderboard_events"("competition_id", "crm_contact_id", "occurred_at");
CREATE INDEX "leaderboard_events_competition_id_type_idx" ON "leaderboard_events"("competition_id", "type");

CREATE UNIQUE INDEX "leaderboard_standings_competition_id_crm_contact_id_key" ON "leaderboard_standings"("competition_id", "crm_contact_id");
CREATE INDEX "leaderboard_standings_competition_id_total_points_points_reached_at_idx" ON "leaderboard_standings"("competition_id", "total_points", "points_reached_at");
CREATE INDEX "leaderboard_standings_workspace_id_competition_id_idx" ON "leaderboard_standings"("workspace_id", "competition_id");

CREATE UNIQUE INDEX "leaderboard_referrals_referred_crm_contact_id_key" ON "leaderboard_referrals"("referred_crm_contact_id");
CREATE INDEX "leaderboard_referrals_workspace_id_referrer_crm_contact_id_idx" ON "leaderboard_referrals"("workspace_id", "referrer_crm_contact_id");

CREATE UNIQUE INDEX "leaderboard_player_stats_crm_contact_id_key" ON "leaderboard_player_stats"("crm_contact_id");
CREATE UNIQUE INDEX "leaderboard_player_stats_workspace_id_crm_contact_id_key" ON "leaderboard_player_stats"("workspace_id", "crm_contact_id");

CREATE UNIQUE INDEX "referral_milestone_awards_referral_id_milestone_code_generation_key" ON "referral_milestone_awards"("referral_id", "milestone_code", "generation");
CREATE UNIQUE INDEX "referral_milestone_awards_one_active" ON "referral_milestone_awards"("referral_id", "milestone_code") WHERE "status" = 'ACTIVE';
CREATE INDEX "referral_milestone_awards_referral_id_status_idx" ON "referral_milestone_awards"("referral_id", "status");
CREATE INDEX "referral_milestone_awards_competition_id_idx" ON "referral_milestone_awards"("competition_id");

CREATE UNIQUE INDEX "promotion_awards_event_id_key" ON "promotion_awards"("event_id");
CREATE UNIQUE INDEX "promotion_awards_idempotency_key_key" ON "promotion_awards"("idempotency_key");
CREATE INDEX "promotion_awards_workspace_id_crm_contact_id_created_at_idx" ON "promotion_awards"("workspace_id", "crm_contact_id", "created_at");
CREATE INDEX "promotion_awards_competition_id_crm_contact_id_created_at_idx" ON "promotion_awards"("competition_id", "crm_contact_id", "created_at");

CREATE INDEX "pool_rate_history_workspace_id_effective_from_idx" ON "pool_rate_history"("workspace_id", "effective_from");

CREATE UNIQUE INDEX "competition_snapshots_competition_id_key" ON "competition_snapshots"("competition_id");
CREATE UNIQUE INDEX "giveaway_payouts_competition_id_rank_key" ON "giveaway_payouts"("competition_id", "rank");
CREATE INDEX "giveaway_payouts_workspace_id_competition_id_idx" ON "giveaway_payouts"("workspace_id", "competition_id");

ALTER TABLE "leaderboard_settings" ADD CONSTRAINT "leaderboard_settings_pool_rate_bounds" CHECK ("pool_rate_bps" >= 200 AND "pool_rate_bps" <= 500);
ALTER TABLE "leaderboard_settings" ADD CONSTRAINT "leaderboard_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_settings" ADD CONSTRAINT "leaderboard_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leaderboard_competitions" ADD CONSTRAINT "leaderboard_competitions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_competitions" ADD CONSTRAINT "leaderboard_competitions_finalized_by_user_id_fkey" FOREIGN KEY ("finalized_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leaderboard_events" ADD CONSTRAINT "leaderboard_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_events" ADD CONSTRAINT "leaderboard_events_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_events" ADD CONSTRAINT "leaderboard_events_crm_contact_id_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_events" ADD CONSTRAINT "leaderboard_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leaderboard_events" ADD CONSTRAINT "leaderboard_events_reverses_event_id_fkey" FOREIGN KEY ("reverses_event_id") REFERENCES "leaderboard_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leaderboard_standings" ADD CONSTRAINT "leaderboard_standings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_standings" ADD CONSTRAINT "leaderboard_standings_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_standings" ADD CONSTRAINT "leaderboard_standings_crm_contact_id_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_standings" ADD CONSTRAINT "leaderboard_standings_last_event_id_fkey" FOREIGN KEY ("last_event_id") REFERENCES "leaderboard_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leaderboard_referrals" ADD CONSTRAINT "leaderboard_referrals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_referrals" ADD CONSTRAINT "leaderboard_referrals_referrer_crm_contact_id_fkey" FOREIGN KEY ("referrer_crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_referrals" ADD CONSTRAINT "leaderboard_referrals_referred_crm_contact_id_fkey" FOREIGN KEY ("referred_crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_referrals" ADD CONSTRAINT "leaderboard_referrals_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "leaderboard_referrals" ADD CONSTRAINT "leaderboard_referrals_overridden_by_user_id_fkey" FOREIGN KEY ("overridden_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "leaderboard_player_stats" ADD CONSTRAINT "leaderboard_player_stats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_player_stats" ADD CONSTRAINT "leaderboard_player_stats_crm_contact_id_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "referral_milestone_awards" ADD CONSTRAINT "referral_milestone_awards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_milestone_awards" ADD CONSTRAINT "referral_milestone_awards_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "leaderboard_referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_milestone_awards" ADD CONSTRAINT "referral_milestone_awards_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_milestone_awards" ADD CONSTRAINT "referral_milestone_awards_award_event_id_fkey" FOREIGN KEY ("award_event_id") REFERENCES "leaderboard_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referral_milestone_awards" ADD CONSTRAINT "referral_milestone_awards_reversal_event_id_fkey" FOREIGN KEY ("reversal_event_id") REFERENCES "leaderboard_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "promotion_awards" ADD CONSTRAINT "promotion_awards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "promotion_awards" ADD CONSTRAINT "promotion_awards_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "promotion_awards" ADD CONSTRAINT "promotion_awards_crm_contact_id_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_awards" ADD CONSTRAINT "promotion_awards_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "leaderboard_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promotion_awards" ADD CONSTRAINT "promotion_awards_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "pool_rate_history" ADD CONSTRAINT "pool_rate_history_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pool_rate_history" ADD CONSTRAINT "pool_rate_history_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pool_rate_history" ADD CONSTRAINT "pool_rate_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "competition_snapshots" ADD CONSTRAINT "competition_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competition_snapshots" ADD CONSTRAINT "competition_snapshots_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "giveaway_payouts" ADD CONSTRAINT "giveaway_payouts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "giveaway_payouts" ADD CONSTRAINT "giveaway_payouts_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "giveaway_payouts" ADD CONSTRAINT "giveaway_payouts_crm_contact_id_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "giveaway_payouts" ADD CONSTRAINT "giveaway_payouts_paid_by_user_id_fkey" FOREIGN KEY ("paid_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
