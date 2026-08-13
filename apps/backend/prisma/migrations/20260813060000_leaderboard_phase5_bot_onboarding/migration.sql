-- Phase 5: Player auto-bind + bot onboarding + personal DMs.
-- Additive only. Does not change scoring constants or GramJS paths.

-- ---------------------------------------------------------------------------
-- Enum extensions
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE 'SEND_PLAYER_DM';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE 'SEND_FINAL_RESULT_DM';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE 'PROCESS_BOT_UPDATE';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- LeaderboardBotIntegration webhook fields
-- ---------------------------------------------------------------------------

ALTER TABLE "leaderboard_bot_integrations"
  ADD COLUMN IF NOT EXISTS "encrypted_webhook_secret" JSONB,
  ADD COLUMN IF NOT EXISTS "webhook_registered_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "last_inbound_at" TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- LeaderboardBotPlayerLink (bot DM identity ↔ CRM contact)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_bot_player_links" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "bot_integration_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "telegram_user_id" VARCHAR(32) NOT NULL,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_rank_requested_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_bot_player_links_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_bot_player_links_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_bot_player_links_bot_fkey"
    FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_bot_player_links_contact_fkey"
    FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_bot_player_links_bot_user_unique"
  ON "leaderboard_bot_player_links" ("bot_integration_id", "telegram_user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_bot_player_links_owner_user_unique"
  ON "leaderboard_bot_player_links" ("owner_coadmin_user_id", "telegram_user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_bot_player_links_bot_contact_unique"
  ON "leaderboard_bot_player_links" ("bot_integration_id", "crm_contact_id");

CREATE INDEX IF NOT EXISTS "leaderboard_bot_player_links_workspace_owner_idx"
  ON "leaderboard_bot_player_links" ("workspace_id", "owner_coadmin_user_id");

CREATE INDEX IF NOT EXISTS "leaderboard_bot_player_links_contact_idx"
  ON "leaderboard_bot_player_links" ("crm_contact_id");

-- ---------------------------------------------------------------------------
-- LeaderboardTelegramUpdate (webhook/polling idempotency)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_telegram_updates" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "bot_integration_id" UUID NOT NULL,
  "update_id" BIGINT NOT NULL,
  "processed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_telegram_updates_bot_fkey"
    FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_telegram_updates_bot_update_unique"
  ON "leaderboard_telegram_updates" ("bot_integration_id", "update_id");
