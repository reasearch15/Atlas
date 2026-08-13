-- Phase 6: 48-hour Wheel.
-- NO PRODUCTION DISTRIBUTION SELECTED — config defaults disabled / policy UNSET.
-- PRODUCT DECISION REQUIRED: qualificationCreditPolicy must be set before enable.

-- ---------------------------------------------------------------------------
-- Enum extensions
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  ALTER TYPE "LeaderboardEventType" ADD VALUE 'WHEEL_SPIN';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeaderboardWheelQualificationCreditPolicy" AS ENUM (
    'UNSET',
    'CYCLE_DEPOSITS_ALL',
    'CYCLE_DEPOSITS_AFTER_ENABLE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Standings: wheel_points
-- ---------------------------------------------------------------------------

ALTER TABLE "leaderboard_standings"
  ADD COLUMN IF NOT EXISTS "wheel_points" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- LeaderboardWheelConfigVersion (create before config FK)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_wheel_config_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_coadmin_user_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "reward_distribution_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by_user_id" UUID NOT NULL,
  "activated_at" TIMESTAMPTZ,
  CONSTRAINT "leaderboard_wheel_config_versions_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_config_versions_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_config_versions_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "leaderboard_wheel_config_versions_owner_idx"
  ON "leaderboard_wheel_config_versions" ("owner_coadmin_user_id", "created_at");

CREATE INDEX IF NOT EXISTS "leaderboard_wheel_config_versions_workspace_idx"
  ON "leaderboard_wheel_config_versions" ("workspace_id");

-- ---------------------------------------------------------------------------
-- LeaderboardWheelConfig
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_wheel_configs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "qualification_credit_policy" "LeaderboardWheelQualificationCreditPolicy" NOT NULL DEFAULT 'UNSET',
  "enabled_at" TIMESTAMPTZ,
  "active_version_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_wheel_configs_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_configs_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_configs_active_version_fkey"
    FOREIGN KEY ("active_version_id") REFERENCES "leaderboard_wheel_config_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_wheel_configs_owner_unique"
  ON "leaderboard_wheel_configs" ("owner_coadmin_user_id");

CREATE INDEX IF NOT EXISTS "leaderboard_wheel_configs_workspace_idx"
  ON "leaderboard_wheel_configs" ("workspace_id");

-- ---------------------------------------------------------------------------
-- LeaderboardWheelCycle
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_wheel_cycles" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "competition_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "starts_at" TIMESTAMPTZ NOT NULL,
  "ends_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_wheel_cycles_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_cycles_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_cycles_competition_fkey"
    FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_cycles_sequence_check"
    CHECK ("sequence" >= 1 AND "sequence" <= 7)
);

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_wheel_cycles_competition_sequence_unique"
  ON "leaderboard_wheel_cycles" ("competition_id", "sequence");

CREATE INDEX IF NOT EXISTS "leaderboard_wheel_cycles_owner_comp_idx"
  ON "leaderboard_wheel_cycles" ("owner_coadmin_user_id", "competition_id");

-- ---------------------------------------------------------------------------
-- LeaderboardWheelSpin (before qualification spin FK)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_wheel_spins" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "competition_id" UUID NOT NULL,
  "cycle_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "points_awarded" INTEGER NOT NULL,
  "config_version_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "spun_at" TIMESTAMPTZ NOT NULL,
  "leaderboard_event_id" UUID NOT NULL,
  "previous_rank" INTEGER,
  "resulting_rank" INTEGER,
  "rng_meta_json" JSONB,
  "qualification_invalidated_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_wheel_spins_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_spins_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_spins_competition_fkey"
    FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_spins_cycle_fkey"
    FOREIGN KEY ("cycle_id") REFERENCES "leaderboard_wheel_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_spins_contact_fkey"
    FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_spins_version_fkey"
    FOREIGN KEY ("config_version_id") REFERENCES "leaderboard_wheel_config_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_spins_event_fkey"
    FOREIGN KEY ("leaderboard_event_id") REFERENCES "leaderboard_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_spins_points_check"
    CHECK ("points_awarded" >= 0 AND "points_awarded" <= 40)
);

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_wheel_spins_cycle_contact_unique"
  ON "leaderboard_wheel_spins" ("cycle_id", "crm_contact_id");

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_wheel_spins_idempotency_unique"
  ON "leaderboard_wheel_spins" ("idempotency_key");

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_wheel_spins_event_unique"
  ON "leaderboard_wheel_spins" ("leaderboard_event_id");

CREATE INDEX IF NOT EXISTS "leaderboard_wheel_spins_owner_comp_idx"
  ON "leaderboard_wheel_spins" ("owner_coadmin_user_id", "competition_id");

-- ---------------------------------------------------------------------------
-- LeaderboardWheelQualification
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "leaderboard_wheel_qualifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "competition_id" UUID NOT NULL,
  "cycle_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "qualifying_deposit_cents" INTEGER NOT NULL DEFAULT 0,
  "qualified_at" TIMESTAMPTZ,
  "available" BOOLEAN NOT NULL DEFAULT FALSE,
  "consumed_at" TIMESTAMPTZ,
  "spin_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "leaderboard_wheel_qualifications_workspace_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_qualifications_owner_fkey"
    FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_qualifications_competition_fkey"
    FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_qualifications_cycle_fkey"
    FOREIGN KEY ("cycle_id") REFERENCES "leaderboard_wheel_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_qualifications_contact_fkey"
    FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "leaderboard_wheel_qualifications_spin_fkey"
    FOREIGN KEY ("spin_id") REFERENCES "leaderboard_wheel_spins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "leaderboard_wheel_qualifications_cycle_contact_unique"
  ON "leaderboard_wheel_qualifications" ("cycle_id", "crm_contact_id");

CREATE INDEX IF NOT EXISTS "leaderboard_wheel_qualifications_owner_comp_idx"
  ON "leaderboard_wheel_qualifications" ("owner_coadmin_user_id", "competition_id");
