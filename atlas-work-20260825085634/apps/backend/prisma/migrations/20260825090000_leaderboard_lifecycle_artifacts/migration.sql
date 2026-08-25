-- Durable leaderboard lifecycle artifacts.
-- Additive only; do not apply to production until deploy time.

DO $$ BEGIN
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'PUBLISH_FINAL_LEADERBOARD';
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'PUBLISH_WINNERS_PICTURE';
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'REMOVE_FINAL_LEADERBOARD_BUTTONS';
END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderboardTelegramArtifactType" AS ENUM (
    'FINAL_LEADERBOARD',
    'WINNERS_PICTURE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderboardTelegramArtifactStatus" AS ENUM (
    'RESERVED',
    'SENT',
    'BUTTONS_REMOVED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "leaderboard_telegram_artifacts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "competition_id" UUID NOT NULL,
  "bot_integration_id" UUID NOT NULL,
  "artifact_type" "LeaderboardTelegramArtifactType" NOT NULL,
  "status" "LeaderboardTelegramArtifactStatus" NOT NULL DEFAULT 'RESERVED',
  "chat_id" VARCHAR(64),
  "message_id" VARCHAR(64),
  "buttons_removed_at" TIMESTAMPTZ,
  "sent_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_telegram_artifacts_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_artifacts_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_artifacts_competition_fkey"
    FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_artifacts_bot_fkey"
    FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_telegram_artifacts_competition_type_unique"
    UNIQUE ("competition_id", "artifact_type")
);

CREATE INDEX IF NOT EXISTS "leaderboard_telegram_artifacts_owner_type_status_idx"
  ON "leaderboard_telegram_artifacts" ("owner_coadmin_user_id", "artifact_type", "status");

CREATE INDEX IF NOT EXISTS "leaderboard_telegram_artifacts_bot_idx"
  ON "leaderboard_telegram_artifacts" ("bot_integration_id");
