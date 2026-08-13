-- Phase 1.2: Coadmin ownership isolation + LeaderboardParticipant binding.
-- Additive relative to Phase 1 / 1.1. Does not rewrite frozen snapshots or recalculate scores.
-- Backfill uses Workspace.primary_coadmin_id only where deterministic.

-- ---------------------------------------------------------------------------
-- 1) Add nullable owner columns
-- ---------------------------------------------------------------------------

ALTER TABLE "leaderboard_settings"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "leaderboard_competitions"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "leaderboard_events"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "leaderboard_standings"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "leaderboard_referrals"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "leaderboard_player_stats"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "promotion_awards"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "pool_rate_history"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "competition_snapshots"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

ALTER TABLE "giveaway_eligibility_candidates"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "ineligibility_reason" VARCHAR(120);

ALTER TABLE "giveaway_payouts"
  ADD COLUMN IF NOT EXISTS "owner_coadmin_user_id" UUID;

-- ---------------------------------------------------------------------------
-- 2) Backfill from Workspace.primary_coadmin_id (deterministic only)
-- ---------------------------------------------------------------------------

UPDATE "leaderboard_settings" s
SET "owner_coadmin_user_id" = w."primary_coadmin_id"
FROM "workspaces" w
WHERE s."workspace_id" = w."id"
  AND s."owner_coadmin_user_id" IS NULL
  AND w."primary_coadmin_id" IS NOT NULL;

UPDATE "leaderboard_competitions" c
SET "owner_coadmin_user_id" = w."primary_coadmin_id"
FROM "workspaces" w
WHERE c."workspace_id" = w."id"
  AND c."owner_coadmin_user_id" IS NULL
  AND w."primary_coadmin_id" IS NOT NULL;

UPDATE "leaderboard_events" e
SET "owner_coadmin_user_id" = COALESCE(
  (SELECT c."owner_coadmin_user_id" FROM "leaderboard_competitions" c WHERE c."id" = e."competition_id"),
  (SELECT w."primary_coadmin_id" FROM "workspaces" w WHERE w."id" = e."workspace_id")
)
WHERE e."owner_coadmin_user_id" IS NULL;

UPDATE "leaderboard_standings" st
SET "owner_coadmin_user_id" = COALESCE(
  (SELECT c."owner_coadmin_user_id" FROM "leaderboard_competitions" c WHERE c."id" = st."competition_id"),
  (SELECT w."primary_coadmin_id" FROM "workspaces" w WHERE w."id" = st."workspace_id")
)
WHERE st."owner_coadmin_user_id" IS NULL;

UPDATE "leaderboard_referrals" r
SET "owner_coadmin_user_id" = w."primary_coadmin_id"
FROM "workspaces" w
WHERE r."workspace_id" = w."id"
  AND r."owner_coadmin_user_id" IS NULL
  AND w."primary_coadmin_id" IS NOT NULL;

UPDATE "leaderboard_player_stats" ps
SET "owner_coadmin_user_id" = w."primary_coadmin_id"
FROM "workspaces" w
WHERE ps."workspace_id" = w."id"
  AND ps."owner_coadmin_user_id" IS NULL
  AND w."primary_coadmin_id" IS NOT NULL;

UPDATE "promotion_awards" p
SET "owner_coadmin_user_id" = COALESCE(
  (SELECT c."owner_coadmin_user_id" FROM "leaderboard_competitions" c WHERE c."id" = p."competition_id"),
  (SELECT w."primary_coadmin_id" FROM "workspaces" w WHERE w."id" = p."workspace_id")
)
WHERE p."owner_coadmin_user_id" IS NULL;

UPDATE "pool_rate_history" ph
SET "owner_coadmin_user_id" = COALESCE(
  (SELECT c."owner_coadmin_user_id" FROM "leaderboard_competitions" c WHERE c."id" = ph."competition_id"),
  (SELECT w."primary_coadmin_id" FROM "workspaces" w WHERE w."id" = ph."workspace_id")
)
WHERE ph."owner_coadmin_user_id" IS NULL;

UPDATE "competition_snapshots" cs
SET "owner_coadmin_user_id" = COALESCE(
  (SELECT c."owner_coadmin_user_id" FROM "leaderboard_competitions" c WHERE c."id" = cs."competition_id"),
  (SELECT w."primary_coadmin_id" FROM "workspaces" w WHERE w."id" = cs."workspace_id")
)
WHERE cs."owner_coadmin_user_id" IS NULL;

UPDATE "giveaway_eligibility_candidates" gec
SET "owner_coadmin_user_id" = COALESCE(
  (SELECT c."owner_coadmin_user_id" FROM "leaderboard_competitions" c WHERE c."id" = gec."competition_id"),
  (SELECT w."primary_coadmin_id" FROM "workspaces" w WHERE w."id" = gec."workspace_id")
)
WHERE gec."owner_coadmin_user_id" IS NULL;

UPDATE "giveaway_payouts" gp
SET "owner_coadmin_user_id" = COALESCE(
  (SELECT c."owner_coadmin_user_id" FROM "leaderboard_competitions" c WHERE c."id" = gp."competition_id"),
  (SELECT w."primary_coadmin_id" FROM "workspaces" w WHERE w."id" = gp."workspace_id")
)
WHERE gp."owner_coadmin_user_id" IS NULL;

-- ---------------------------------------------------------------------------
-- 3) Fail loudly if any row cannot resolve an owner
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  unresolved BIGINT;
BEGIN
  SELECT COUNT(*) INTO unresolved FROM (
    SELECT 1 FROM "leaderboard_settings" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "leaderboard_competitions" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "leaderboard_events" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "leaderboard_standings" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "leaderboard_referrals" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "leaderboard_player_stats" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "promotion_awards" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "pool_rate_history" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "competition_snapshots" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "giveaway_eligibility_candidates" WHERE "owner_coadmin_user_id" IS NULL
    UNION ALL SELECT 1 FROM "giveaway_payouts" WHERE "owner_coadmin_user_id" IS NULL
  ) q;
  IF unresolved > 0 THEN
    RAISE EXCEPTION
      'Phase 1.2 backfill failed: % leaderboard row(s) lack deterministic owner_coadmin_user_id (Workspace.primary_coadmin_id). Resolve manually before re-running.',
      unresolved;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Make owner required
-- ---------------------------------------------------------------------------

ALTER TABLE "leaderboard_settings" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "leaderboard_competitions" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "leaderboard_events" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "leaderboard_standings" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "leaderboard_referrals" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "leaderboard_player_stats" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "promotion_awards" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "pool_rate_history" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "competition_snapshots" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "giveaway_eligibility_candidates" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;
ALTER TABLE "giveaway_payouts" ALTER COLUMN "owner_coadmin_user_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) Replace workspace-level uniques/indexes with owner-scoped ones
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "leaderboard_settings_workspace_id_key";
CREATE UNIQUE INDEX "leaderboard_settings_owner_coadmin_user_id_key"
  ON "leaderboard_settings"("owner_coadmin_user_id");
CREATE INDEX "leaderboard_settings_workspace_id_idx"
  ON "leaderboard_settings"("workspace_id");

DROP INDEX IF EXISTS "leaderboard_competitions_workspace_id_sequence_key";
DROP INDEX IF EXISTS "leaderboard_competitions_one_active_per_workspace";
DROP INDEX IF EXISTS "leaderboard_competitions_workspace_id_status_idx";
DROP INDEX IF EXISTS "leaderboard_competitions_workspace_id_starts_at_ends_at_idx";

CREATE UNIQUE INDEX "leaderboard_competitions_owner_coadmin_user_id_sequence_key"
  ON "leaderboard_competitions"("owner_coadmin_user_id", "sequence");
CREATE UNIQUE INDEX "leaderboard_competitions_one_active_per_owner"
  ON "leaderboard_competitions"("owner_coadmin_user_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "leaderboard_competitions_workspace_id_owner_coadmin_user_id_status_idx"
  ON "leaderboard_competitions"("workspace_id", "owner_coadmin_user_id", "status");
CREATE INDEX "leaderboard_competitions_owner_coadmin_user_id_starts_at_ends_at_idx"
  ON "leaderboard_competitions"("owner_coadmin_user_id", "starts_at", "ends_at");

DROP INDEX IF EXISTS "leaderboard_events_workspace_id_competition_id_occurred_at_idx";
CREATE INDEX "leaderboard_events_owner_coadmin_user_id_competition_id_occurred_at_idx"
  ON "leaderboard_events"("owner_coadmin_user_id", "competition_id", "occurred_at");

DROP INDEX IF EXISTS "leaderboard_standings_workspace_id_competition_id_idx";
CREATE INDEX "leaderboard_standings_owner_coadmin_user_id_competition_id_idx"
  ON "leaderboard_standings"("owner_coadmin_user_id", "competition_id");

DROP INDEX IF EXISTS "leaderboard_referrals_referred_crm_contact_id_key";
DROP INDEX IF EXISTS "leaderboard_referrals_workspace_id_referrer_crm_contact_id_idx";
CREATE UNIQUE INDEX "leaderboard_referrals_owner_coadmin_user_id_referred_crm_contact_id_key"
  ON "leaderboard_referrals"("owner_coadmin_user_id", "referred_crm_contact_id");
CREATE INDEX "leaderboard_referrals_owner_coadmin_user_id_referrer_crm_contact_id_idx"
  ON "leaderboard_referrals"("owner_coadmin_user_id", "referrer_crm_contact_id");

DROP INDEX IF EXISTS "leaderboard_player_stats_crm_contact_id_key";
DROP INDEX IF EXISTS "leaderboard_player_stats_workspace_id_crm_contact_id_key";
CREATE UNIQUE INDEX "leaderboard_player_stats_owner_coadmin_user_id_crm_contact_id_key"
  ON "leaderboard_player_stats"("owner_coadmin_user_id", "crm_contact_id");
CREATE INDEX "leaderboard_player_stats_workspace_id_owner_coadmin_user_id_idx"
  ON "leaderboard_player_stats"("workspace_id", "owner_coadmin_user_id");

DROP INDEX IF EXISTS "promotion_awards_workspace_id_crm_contact_id_created_at_idx";
CREATE INDEX "promotion_awards_owner_coadmin_user_id_crm_contact_id_created_at_idx"
  ON "promotion_awards"("owner_coadmin_user_id", "crm_contact_id", "created_at");

DROP INDEX IF EXISTS "pool_rate_history_workspace_id_effective_from_idx";
CREATE INDEX "pool_rate_history_owner_coadmin_user_id_effective_from_idx"
  ON "pool_rate_history"("owner_coadmin_user_id", "effective_from");

CREATE INDEX "competition_snapshots_owner_coadmin_user_id_idx"
  ON "competition_snapshots"("owner_coadmin_user_id");

CREATE INDEX "giveaway_eligibility_candidates_owner_coadmin_user_id_competition_id_idx"
  ON "giveaway_eligibility_candidates"("owner_coadmin_user_id", "competition_id");

DROP INDEX IF EXISTS "giveaway_payouts_workspace_id_competition_id_idx";
CREATE INDEX "giveaway_payouts_owner_coadmin_user_id_competition_id_idx"
  ON "giveaway_payouts"("owner_coadmin_user_id", "competition_id");

-- ---------------------------------------------------------------------------
-- 6) Foreign keys for owner columns
-- ---------------------------------------------------------------------------

ALTER TABLE "leaderboard_settings"
  ADD CONSTRAINT "leaderboard_settings_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leaderboard_competitions"
  ADD CONSTRAINT "leaderboard_competitions_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leaderboard_events"
  ADD CONSTRAINT "leaderboard_events_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leaderboard_standings"
  ADD CONSTRAINT "leaderboard_standings_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leaderboard_referrals"
  ADD CONSTRAINT "leaderboard_referrals_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leaderboard_player_stats"
  ADD CONSTRAINT "leaderboard_player_stats_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "promotion_awards"
  ADD CONSTRAINT "promotion_awards_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pool_rate_history"
  ADD CONSTRAINT "pool_rate_history_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "competition_snapshots"
  ADD CONSTRAINT "competition_snapshots_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "giveaway_eligibility_candidates"
  ADD CONSTRAINT "giveaway_eligibility_candidates_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "giveaway_payouts"
  ADD CONSTRAINT "giveaway_payouts_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7) LeaderboardParticipant binding table
-- ---------------------------------------------------------------------------

CREATE TABLE "leaderboard_participants" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_coadmin_user_id" UUID NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leaderboard_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "leaderboard_participants_workspace_id_crm_contact_id_key"
  ON "leaderboard_participants"("workspace_id", "crm_contact_id");
CREATE UNIQUE INDEX "leaderboard_participants_owner_coadmin_user_id_crm_contact_id_key"
  ON "leaderboard_participants"("owner_coadmin_user_id", "crm_contact_id");
CREATE INDEX "leaderboard_participants_workspace_id_owner_coadmin_user_id_idx"
  ON "leaderboard_participants"("workspace_id", "owner_coadmin_user_id");

ALTER TABLE "leaderboard_participants"
  ADD CONSTRAINT "leaderboard_participants_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_participants"
  ADD CONSTRAINT "leaderboard_participants_owner_coadmin_user_id_fkey"
  FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_participants"
  ADD CONSTRAINT "leaderboard_participants_crm_contact_id_fkey"
  FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_participants"
  ADD CONSTRAINT "leaderboard_participants_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 8) Backfill participants only where ownership is deterministic
--    Prefer contacts that already appear in owner-scoped leaderboard activity.
-- ---------------------------------------------------------------------------

-- Ambiguous multi-owner contact activity: fail rather than guess (before insert).
DO $$
DECLARE
  ambiguous BIGINT;
BEGIN
  SELECT COUNT(*) INTO ambiguous FROM (
    SELECT "workspace_id", "crm_contact_id"
    FROM (
      SELECT DISTINCT e."workspace_id", e."owner_coadmin_user_id", e."crm_contact_id"
      FROM "leaderboard_events" e
      UNION
      SELECT DISTINCT st."workspace_id", st."owner_coadmin_user_id", st."crm_contact_id"
      FROM "leaderboard_standings" st
      UNION
      SELECT DISTINCT ps."workspace_id", ps."owner_coadmin_user_id", ps."crm_contact_id"
      FROM "leaderboard_player_stats" ps
    ) owners
    GROUP BY "workspace_id", "crm_contact_id"
    HAVING COUNT(DISTINCT "owner_coadmin_user_id") > 1
  ) q;
  IF ambiguous > 0 THEN
    RAISE EXCEPTION
      'Phase 1.2 participant backfill failed: % contact(s) have activity under multiple owners. Resolve manually; transfer is unsupported.',
      ambiguous;
  END IF;
END $$;

INSERT INTO "leaderboard_participants" (
  "id",
  "workspace_id",
  "owner_coadmin_user_id",
  "crm_contact_id",
  "created_by_user_id",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  x."workspace_id",
  x."owner_coadmin_user_id",
  x."crm_contact_id",
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT e."workspace_id", e."owner_coadmin_user_id", e."crm_contact_id"
  FROM "leaderboard_events" e
  UNION
  SELECT DISTINCT st."workspace_id", st."owner_coadmin_user_id", st."crm_contact_id"
  FROM "leaderboard_standings" st
  UNION
  SELECT DISTINCT ps."workspace_id", ps."owner_coadmin_user_id", ps."crm_contact_id"
  FROM "leaderboard_player_stats" ps
) x
ON CONFLICT ("workspace_id", "crm_contact_id") DO NOTHING;
