-- Phase 1.1: prize eligibility + immutable frozen ranking vs locked winners.
-- Additive relative to 20260813010000_leaderboard_phase1.

CREATE TYPE "PrizeMembershipStatus" AS ENUM ('ELIGIBLE', 'NOT_ELIGIBLE', 'PENDING_REVIEW');

ALTER TABLE "competition_snapshots"
  ADD COLUMN IF NOT EXISTS "winners_json" JSONB,
  ADD COLUMN IF NOT EXISTS "winners_locked_at" TIMESTAMP(3);

CREATE TABLE "giveaway_eligibility_candidates" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "leaderboard_rank" INTEGER NOT NULL,
    "total_points" INTEGER NOT NULL,
    "membership_status" "PrizeMembershipStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" UUID,
    "resolution_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "giveaway_eligibility_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "giveaway_eligibility_candidates_competition_id_crm_contact_id_key"
  ON "giveaway_eligibility_candidates"("competition_id", "crm_contact_id");
CREATE UNIQUE INDEX "giveaway_eligibility_candidates_competition_id_leaderboard_rank_key"
  ON "giveaway_eligibility_candidates"("competition_id", "leaderboard_rank");
CREATE INDEX "giveaway_eligibility_candidates_competition_id_membership_status_leaderboard_rank_idx"
  ON "giveaway_eligibility_candidates"("competition_id", "membership_status", "leaderboard_rank");

ALTER TABLE "giveaway_eligibility_candidates"
  ADD CONSTRAINT "giveaway_eligibility_candidates_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "giveaway_eligibility_candidates"
  ADD CONSTRAINT "giveaway_eligibility_candidates_competition_id_fkey"
  FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "giveaway_eligibility_candidates"
  ADD CONSTRAINT "giveaway_eligibility_candidates_crm_contact_id_fkey"
  FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "giveaway_eligibility_candidates"
  ADD CONSTRAINT "giveaway_eligibility_candidates_resolved_by_user_id_fkey"
  FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Separate prize rank from leaderboard rank on payouts.
ALTER TABLE "giveaway_payouts" ADD COLUMN IF NOT EXISTS "prize_rank" INTEGER;
ALTER TABLE "giveaway_payouts" ADD COLUMN IF NOT EXISTS "leaderboard_rank" INTEGER;

UPDATE "giveaway_payouts"
SET "prize_rank" = COALESCE("prize_rank", "rank"),
    "leaderboard_rank" = COALESCE("leaderboard_rank", "rank")
WHERE "prize_rank" IS NULL OR "leaderboard_rank" IS NULL;

ALTER TABLE "giveaway_payouts" ALTER COLUMN "prize_rank" SET NOT NULL;
ALTER TABLE "giveaway_payouts" ALTER COLUMN "leaderboard_rank" SET NOT NULL;

ALTER TABLE "giveaway_payouts" DROP CONSTRAINT IF EXISTS "giveaway_payouts_competition_id_rank_key";
ALTER TABLE "giveaway_payouts" DROP CONSTRAINT IF EXISTS "giveaway_payouts_rank_bounds";

DROP INDEX IF EXISTS "giveaway_payouts_competition_id_rank_key";

ALTER TABLE "giveaway_payouts" DROP COLUMN IF EXISTS "rank";

ALTER TABLE "giveaway_payouts"
  ADD CONSTRAINT "giveaway_payouts_prize_rank_bounds" CHECK ("prize_rank" >= 1 AND "prize_rank" <= 3);

CREATE UNIQUE INDEX "giveaway_payouts_competition_id_prize_rank_key"
  ON "giveaway_payouts"("competition_id", "prize_rank");
