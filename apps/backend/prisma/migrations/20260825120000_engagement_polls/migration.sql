-- Isolated Telegram engagement polls, hidden daily scores, and engagement Freeplay grants.
-- Additive only. Do not apply to production until deploy time.

-- Leaderboard outbox job types used for durable poll post/close/announce.
DO $$ BEGIN
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'POST_ENGAGEMENT_POLL';
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'CLOSE_ENGAGEMENT_POLL';
  ALTER TYPE "LeaderboardTelegramJobType" ADD VALUE IF NOT EXISTS 'ANNOUNCE_ENGAGEMENT_WINNERS';
END $$;

DO $$ BEGIN
  CREATE TYPE "FreeplayClaimSource" AS ENUM ('WHEEL', 'ENGAGEMENT_DAILY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "EngagementPollStatus" AS ENUM (
    'SCHEDULED',
    'POSTING',
    'OPEN',
    'CLOSING',
    'CLOSED',
    'SETTLED',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "EngagementPointKind" AS ENUM (
    'POLL_PARTICIPATION',
    'REFERRAL_CONTRIBUTION'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "EngagementDailyResultStatus" AS ENUM (
    'SNAPSHOTTED',
    'ANNOUNCED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Allow $5 engagement Freeplay without breaking existing $1/$2/$3 wheel claims.
ALTER TABLE "freeplay_claims" DROP CONSTRAINT IF EXISTS "freeplay_claims_positive_reward_check";
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_positive_reward_check"
  CHECK ("reward_amount_cents" IN (100, 200, 300, 500));

ALTER TABLE "freeplay_claims" ALTER COLUMN "spin_id" DROP NOT NULL;

ALTER TABLE "freeplay_claims"
  ADD COLUMN IF NOT EXISTS "source" "FreeplayClaimSource" NOT NULL DEFAULT 'WHEEL';

ALTER TABLE "freeplay_claims"
  ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(160);

UPDATE "freeplay_claims"
SET "idempotency_key" = 'wheel:' || "spin_id"::text
WHERE "idempotency_key" IS NULL AND "spin_id" IS NOT NULL;

UPDATE "freeplay_claims"
SET "idempotency_key" = 'legacy:' || "id"::text
WHERE "idempotency_key" IS NULL;

ALTER TABLE "freeplay_claims" ALTER COLUMN "idempotency_key" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "freeplay_claims_idempotency_key_key"
  ON "freeplay_claims"("idempotency_key");

CREATE INDEX IF NOT EXISTS "freeplay_claims_source_idx"
  ON "freeplay_claims"("source");

ALTER TABLE "freeplay_claims" DROP CONSTRAINT IF EXISTS "freeplay_claims_source_spin_check";
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_source_spin_check"
  CHECK (
    ("source" = 'WHEEL' AND "spin_id" IS NOT NULL)
    OR ("source" = 'ENGAGEMENT_DAILY' AND "spin_id" IS NULL)
  );

CREATE TABLE IF NOT EXISTS "engagement_questions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "external_id" VARCHAR(32) NOT NULL,
  "category" VARCHAR(80) NOT NULL,
  "question" VARCHAR(300) NOT NULL,
  "option1" VARCHAR(64) NOT NULL,
  "option2" VARCHAR(64) NOT NULL,
  "option3" VARCHAR(64) NOT NULL,
  "option4" VARCHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_questions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_questions_external_id_key"
  ON "engagement_questions"("external_id");
CREATE INDEX IF NOT EXISTS "engagement_questions_active_category_idx"
  ON "engagement_questions"("active", "category");

CREATE TABLE IF NOT EXISTS "engagement_question_cycles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "cycle_number" INTEGER NOT NULL,
  "shuffled_at" TIMESTAMP(3) NOT NULL,
  "exhausted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_question_cycles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_question_cycles_owner_number_key"
  ON "engagement_question_cycles"("owner_coadmin_user_id", "cycle_number");
CREATE INDEX IF NOT EXISTS "engagement_question_cycles_owner_exhausted_idx"
  ON "engagement_question_cycles"("owner_coadmin_user_id", "exhausted_at");

CREATE TABLE IF NOT EXISTS "engagement_question_cycle_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "cycle_id" UUID NOT NULL,
  "question_id" UUID NOT NULL,
  "draw_order" INTEGER NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_question_cycle_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_question_cycle_items_cycle_question_key"
  ON "engagement_question_cycle_items"("cycle_id", "question_id");
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_question_cycle_items_cycle_order_key"
  ON "engagement_question_cycle_items"("cycle_id", "draw_order");
CREATE INDEX IF NOT EXISTS "engagement_question_cycle_items_unused_idx"
  ON "engagement_question_cycle_items"("cycle_id", "used_at", "draw_order");

CREATE TABLE IF NOT EXISTS "engagement_polls" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "bot_integration_id" UUID NOT NULL,
  "slot_key" VARCHAR(32) NOT NULL,
  "opens_at" TIMESTAMP(3) NOT NULL,
  "closes_at" TIMESTAMP(3) NOT NULL,
  "chicago_date" VARCHAR(10) NOT NULL,
  "status" "EngagementPollStatus" NOT NULL DEFAULT 'SCHEDULED',
  "question_id" UUID,
  "cycle_id" UUID,
  "question_text" VARCHAR(300),
  "option1" VARCHAR(64),
  "option2" VARCHAR(64),
  "option3" VARCHAR(64),
  "option4" VARCHAR(64),
  "category" VARCHAR(80),
  "channel_id" VARCHAR(64),
  "telegram_message_id" VARCHAR(64),
  "posted_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "close_edited_at" TIMESTAMP(3),
  "settled_at" TIMESTAMP(3),
  "option_counts_json" JSONB,
  "winning_option_index" INTEGER,
  "last_error" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_polls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engagement_polls_winning_option_check"
    CHECK ("winning_option_index" IS NULL OR ("winning_option_index" >= 0 AND "winning_option_index" <= 3))
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_polls_owner_slot_key"
  ON "engagement_polls"("owner_coadmin_user_id", "slot_key");
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_polls_cycle_question_key"
  ON "engagement_polls"("cycle_id", "question_id")
  WHERE "cycle_id" IS NOT NULL AND "question_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "engagement_polls_owner_status_opens_idx"
  ON "engagement_polls"("owner_coadmin_user_id", "status", "opens_at");
CREATE INDEX IF NOT EXISTS "engagement_polls_owner_status_closes_idx"
  ON "engagement_polls"("owner_coadmin_user_id", "status", "closes_at");
CREATE INDEX IF NOT EXISTS "engagement_polls_owner_chicago_date_idx"
  ON "engagement_polls"("owner_coadmin_user_id", "chicago_date");
CREATE INDEX IF NOT EXISTS "engagement_polls_bot_status_idx"
  ON "engagement_polls"("bot_integration_id", "status");

CREATE TABLE IF NOT EXISTS "engagement_votes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "poll_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "telegram_user_id" VARCHAR(32) NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "option_index" INTEGER NOT NULL,
  "voted_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_votes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engagement_votes_option_check"
    CHECK ("option_index" >= 0 AND "option_index" <= 3)
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_votes_poll_telegram_user_key"
  ON "engagement_votes"("poll_id", "telegram_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_votes_poll_contact_key"
  ON "engagement_votes"("poll_id", "crm_contact_id");
CREATE INDEX IF NOT EXISTS "engagement_votes_owner_contact_idx"
  ON "engagement_votes"("owner_coadmin_user_id", "crm_contact_id");

CREATE TABLE IF NOT EXISTS "engagement_point_ledger" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "chicago_date" VARCHAR(10) NOT NULL,
  "kind" "EngagementPointKind" NOT NULL,
  "points" INTEGER NOT NULL,
  "poll_id" UUID,
  "referral_id" UUID,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_point_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engagement_point_ledger_points_check" CHECK ("points" > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_point_ledger_idempotency_key_key"
  ON "engagement_point_ledger"("idempotency_key");
CREATE INDEX IF NOT EXISTS "engagement_point_ledger_owner_date_contact_idx"
  ON "engagement_point_ledger"("owner_coadmin_user_id", "chicago_date", "crm_contact_id");
CREATE INDEX IF NOT EXISTS "engagement_point_ledger_poll_idx"
  ON "engagement_point_ledger"("poll_id");

CREATE TABLE IF NOT EXISTS "engagement_daily_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "bot_integration_id" UUID NOT NULL,
  "chicago_date" VARCHAR(10) NOT NULL,
  "declared_at" TIMESTAMP(3) NOT NULL,
  "status" "EngagementDailyResultStatus" NOT NULL DEFAULT 'SNAPSHOTTED',
  "first_crm_contact_id" UUID,
  "second_crm_contact_id" UUID,
  "third_crm_contact_id" UUID,
  "snapshot_json" JSONB NOT NULL,
  "channel_id" VARCHAR(64),
  "telegram_message_id" VARCHAR(64),
  "announced_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_daily_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_daily_results_owner_date_key"
  ON "engagement_daily_results"("owner_coadmin_user_id", "chicago_date");
CREATE INDEX IF NOT EXISTS "engagement_daily_results_owner_declared_idx"
  ON "engagement_daily_results"("owner_coadmin_user_id", "declared_at");

CREATE TABLE IF NOT EXISTS "engagement_daily_prizes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "daily_result_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "prize_rank" INTEGER NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "freeplay_claim_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "engagement_daily_prizes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engagement_daily_prizes_rank_check" CHECK ("prize_rank" >= 1 AND "prize_rank" <= 3),
  CONSTRAINT "engagement_daily_prizes_amount_check" CHECK ("amount_cents" IN (100, 200, 500))
);

CREATE UNIQUE INDEX IF NOT EXISTS "engagement_daily_prizes_result_rank_key"
  ON "engagement_daily_prizes"("daily_result_id", "prize_rank");
CREATE UNIQUE INDEX IF NOT EXISTS "engagement_daily_prizes_claim_key"
  ON "engagement_daily_prizes"("freeplay_claim_id");
CREATE INDEX IF NOT EXISTS "engagement_daily_prizes_owner_contact_idx"
  ON "engagement_daily_prizes"("owner_coadmin_user_id", "crm_contact_id");

ALTER TABLE "engagement_question_cycles"
  ADD CONSTRAINT "engagement_question_cycles_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_question_cycles"
  ADD CONSTRAINT "engagement_question_cycles_owner_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engagement_question_cycle_items"
  ADD CONSTRAINT "engagement_question_cycle_items_cycle_fkey"
  FOREIGN KEY ("cycle_id") REFERENCES "engagement_question_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_question_cycle_items"
  ADD CONSTRAINT "engagement_question_cycle_items_question_fkey"
  FOREIGN KEY ("question_id") REFERENCES "engagement_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engagement_polls"
  ADD CONSTRAINT "engagement_polls_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_polls"
  ADD CONSTRAINT "engagement_polls_owner_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_polls"
  ADD CONSTRAINT "engagement_polls_bot_fkey"
  FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_polls"
  ADD CONSTRAINT "engagement_polls_question_fkey"
  FOREIGN KEY ("question_id") REFERENCES "engagement_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_polls"
  ADD CONSTRAINT "engagement_polls_cycle_fkey"
  FOREIGN KEY ("cycle_id") REFERENCES "engagement_question_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "engagement_votes"
  ADD CONSTRAINT "engagement_votes_poll_fkey"
  FOREIGN KEY ("poll_id") REFERENCES "engagement_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_votes"
  ADD CONSTRAINT "engagement_votes_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_votes"
  ADD CONSTRAINT "engagement_votes_owner_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_votes"
  ADD CONSTRAINT "engagement_votes_contact_fkey"
  FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engagement_point_ledger"
  ADD CONSTRAINT "engagement_point_ledger_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_point_ledger"
  ADD CONSTRAINT "engagement_point_ledger_owner_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_point_ledger"
  ADD CONSTRAINT "engagement_point_ledger_contact_fkey"
  FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_point_ledger"
  ADD CONSTRAINT "engagement_point_ledger_poll_fkey"
  FOREIGN KEY ("poll_id") REFERENCES "engagement_polls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "engagement_daily_results"
  ADD CONSTRAINT "engagement_daily_results_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_results"
  ADD CONSTRAINT "engagement_daily_results_owner_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_results"
  ADD CONSTRAINT "engagement_daily_results_bot_fkey"
  FOREIGN KEY ("bot_integration_id") REFERENCES "leaderboard_bot_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_results"
  ADD CONSTRAINT "engagement_daily_results_first_fkey"
  FOREIGN KEY ("first_crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_results"
  ADD CONSTRAINT "engagement_daily_results_second_fkey"
  FOREIGN KEY ("second_crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_results"
  ADD CONSTRAINT "engagement_daily_results_third_fkey"
  FOREIGN KEY ("third_crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "engagement_daily_prizes"
  ADD CONSTRAINT "engagement_daily_prizes_result_fkey"
  FOREIGN KEY ("daily_result_id") REFERENCES "engagement_daily_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_prizes"
  ADD CONSTRAINT "engagement_daily_prizes_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_prizes"
  ADD CONSTRAINT "engagement_daily_prizes_owner_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_prizes"
  ADD CONSTRAINT "engagement_daily_prizes_contact_fkey"
  FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "engagement_daily_prizes"
  ADD CONSTRAINT "engagement_daily_prizes_claim_fkey"
  FOREIGN KEY ("freeplay_claim_id") REFERENCES "freeplay_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
