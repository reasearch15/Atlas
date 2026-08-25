-- Daily $5 Freeplay lucky-subscriber draw, independent of native channel polls.

ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'RUN_ENGAGEMENT_DAILY_DRAW';
ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'ANNOUNCE_ENGAGEMENT_DAILY_DRAW';
ALTER TYPE "FreeplayClaimSource" ADD VALUE IF NOT EXISTS 'ENGAGEMENT_DAILY_DRAW';

DO $$ BEGIN
  CREATE TYPE "EngagementDailyDrawStatus" AS ENUM ('DRAWN', 'ANNOUNCED', 'NO_ELIGIBLE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "engagement_daily_draws" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "bot_integration_id" UUID NOT NULL,
  "chicago_date" VARCHAR(10) NOT NULL,
  "status" "EngagementDailyDrawStatus" NOT NULL,
  "winner_crm_contact_id" UUID,
  "winner_telegram_user_id" VARCHAR(32),
  "winner_base_weight" INTEGER,
  "winner_referral_weight" INTEGER,
  "winner_total_weight" INTEGER,
  "winner_active_referral_count" INTEGER,
  "candidate_count" INTEGER NOT NULL,
  "total_weight" INTEGER NOT NULL,
  "random_pick" INTEGER,
  "snapshot_json" JSONB NOT NULL,
  "freeplay_claim_id" UUID,
  "channel_id" VARCHAR(64),
  "telegram_message_id" VARCHAR(64),
  "drawn_at" TIMESTAMP(3) NOT NULL,
  "announced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "engagement_daily_draws_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_daily_draws_owner_coadmin_user_id_chicago_date_key"
  ON "engagement_daily_draws"("owner_coadmin_user_id", "chicago_date");

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_daily_draws_freeplay_claim_id_key"
  ON "engagement_daily_draws"("freeplay_claim_id");

CREATE INDEX IF NOT EXISTS "engagement_daily_draws_owner_coadmin_user_id_drawn_at_idx"
  ON "engagement_daily_draws"("owner_coadmin_user_id", "drawn_at");

ALTER TABLE "engagement_daily_draws"
  ADD CONSTRAINT "engagement_daily_draws_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "engagement_daily_draws"
  ADD CONSTRAINT "engagement_daily_draws_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engagement_daily_draws"
  ADD CONSTRAINT "engagement_daily_draws_bot_integration_id_fkey"
  FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "engagement_daily_draws"
  ADD CONSTRAINT "engagement_daily_draws_winner_crm_contact_id_fkey"
  FOREIGN KEY ("winner_crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engagement_daily_draws"
  ADD CONSTRAINT "engagement_daily_draws_freeplay_claim_id_fkey"
  FOREIGN KEY ("freeplay_claim_id") REFERENCES "freeplay_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
