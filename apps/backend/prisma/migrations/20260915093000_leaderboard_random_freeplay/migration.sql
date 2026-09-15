ALTER TYPE "FreeplayClaimSource" ADD VALUE IF NOT EXISTS 'LEADERBOARD_RANDOM';

CREATE TABLE "leaderboard_bonus_awards" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "owner_coadmin_user_id" UUID NOT NULL,
    "competition_id" UUID NOT NULL,
    "crm_contact_id" UUID NOT NULL,
    "leaderboard_rank" INTEGER NOT NULL,
    "reward_amount_cents" INTEGER NOT NULL,
    "freeplay_claim_id" UUID NOT NULL,
    "selected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_bonus_awards_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leaderboard_bonus_awards_rank_check" CHECK ("leaderboard_rank" BETWEEN 4 AND 10),
    CONSTRAINT "leaderboard_bonus_awards_reward_check" CHECK ("reward_amount_cents" = 1500)
);

CREATE UNIQUE INDEX "leaderboard_bonus_awards_competition_id_key" ON "leaderboard_bonus_awards"("competition_id");
CREATE UNIQUE INDEX "leaderboard_bonus_awards_freeplay_claim_id_key" ON "leaderboard_bonus_awards"("freeplay_claim_id");
CREATE INDEX "leaderboard_bonus_awards_workspace_id_owner_coadmin_user_id_idx" ON "leaderboard_bonus_awards"("workspace_id", "owner_coadmin_user_id");
CREATE INDEX "leaderboard_bonus_awards_owner_coadmin_user_id_crm_contact_id_idx" ON "leaderboard_bonus_awards"("owner_coadmin_user_id", "crm_contact_id");

ALTER TABLE "leaderboard_bonus_awards" ADD CONSTRAINT "leaderboard_bonus_awards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_bonus_awards" ADD CONSTRAINT "leaderboard_bonus_awards_owner_coadmin_user_id_fkey" FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_bonus_awards" ADD CONSTRAINT "leaderboard_bonus_awards_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "leaderboard_competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "leaderboard_bonus_awards" ADD CONSTRAINT "leaderboard_bonus_awards_crm_contact_id_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leaderboard_bonus_awards" ADD CONSTRAINT "leaderboard_bonus_awards_freeplay_claim_id_fkey" FOREIGN KEY ("freeplay_claim_id") REFERENCES "freeplay_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
