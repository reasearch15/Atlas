-- Phase 4: Dedicated Telegram Bot API integration per Coadmin + durable outbox.
-- Additive only. Does not rewrite Phase 1–1.2 history or GramJS session tables.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "LeaderboardTelegramJobType" AS ENUM (
    'REFRESH_PUBLIC_LEADERBOARD',
    'POST_RANK_ANNOUNCEMENT',
    'VERIFY_MEMBERSHIP',
    'POST_PUBLIC_RESULTS'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderboardTelegramJobStatus" AS ENUM (
    'QUEUED',
    'DISPATCHING',
    'SUCCEEDED',
    'RETRY_SCHEDULED',
    'FAILED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderboardEligibilityVerificationSource" AS ENUM (
    'MANUAL',
    'TELEGRAM_BOT_API'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- LeaderboardBotIntegration (one per Coadmin)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_bot_integrations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "encrypted_bot_token" JSONB NOT NULL,
  "bot_telegram_user_id" VARCHAR(32),
  "bot_username" VARCHAR(120),
  "bot_display_name" VARCHAR(200),
  "channel_id" VARCHAR(64),
  "channel_title" VARCHAR(255),
  "channel_username" VARCHAR(120),
  "posting_enabled" BOOLEAN NOT NULL DEFAULT false,
  "connected_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_verified_at" TIMESTAMPTZ,
  "last_channel_verified_at" TIMESTAMPTZ,
  "last_successful_post_at" TIMESTAMPTZ,
  "last_membership_check_at" TIMESTAMPTZ,
  "persistent_message_id" VARCHAR(64),
  "persistent_message_competition_id" UUID,
  "last_public_top10_json" JSONB,
  "last_error" VARCHAR(500),
  "disconnected_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_bot_integrations_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_bot_integrations_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_bot_integrations_owner_unique" UNIQUE ("owner_coadmin_user_id")
);

CREATE INDEX IF NOT EXISTS "leaderboard_bot_integrations_workspace_idx"
  ON "leaderboard_bot_integrations" ("workspace_id");

-- ---------------------------------------------------------------------------
-- Durable Telegram outbox (Postgres SoT; BullMQ wake-up only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_telegram_outbox" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "competition_id" UUID,
  "bot_integration_id" UUID,
  "job_type" "LeaderboardTelegramJobType" NOT NULL,
  "status" "LeaderboardTelegramJobStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotency_key" VARCHAR(320) NOT NULL,
  "payload_json" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ,
  "last_error_code" VARCHAR(120),
  "last_error_message" VARCHAR(500),
  "succeeded_at" TIMESTAMPTZ,
  "failed_at" TIMESTAMPTZ,
  "cancelled_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_telegram_outbox_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_outbox_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_outbox_competition_fkey"
    FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_outbox_bot_fkey"
    FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_outbox_idempotency_unique" UNIQUE ("idempotency_key")
);

CREATE INDEX IF NOT EXISTS "leaderboard_telegram_outbox_status_next_idx"
  ON "leaderboard_telegram_outbox" ("status", "next_attempt_at");

CREATE INDEX IF NOT EXISTS "leaderboard_telegram_outbox_owner_status_idx"
  ON "leaderboard_telegram_outbox" ("owner_coadmin_user_id", "status");

CREATE INDEX IF NOT EXISTS "leaderboard_telegram_outbox_competition_idx"
  ON "leaderboard_telegram_outbox" ("competition_id");

-- ---------------------------------------------------------------------------
-- Eligibility audit fields for Telegram membership verification
-- ---------------------------------------------------------------------------

ALTER TABLE "giveaway_eligibility_candidates"
  ADD COLUMN IF NOT EXISTS "verification_source" "LeaderboardEligibilityVerificationSource",
  ADD COLUMN IF NOT EXISTS "telegram_chat_member_status" VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "verified_channel_id" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "bot_integration_id" UUID,
  ADD COLUMN IF NOT EXISTS "verification_checked_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "verification_error_code" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "verification_error_message" VARCHAR(500);

DO $$ BEGIN
  ALTER TABLE "giveaway_eligibility_candidates"
    ADD CONSTRAINT "giveaway_eligibility_candidates_bot_integration_fkey"
    FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
