CREATE TYPE "FreeplayClaimStatus" AS ENUM ('UNCLAIMED', 'CLAIMED');

CREATE TABLE "freeplay_deposit_credits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "leaderboard_event_id" UUID NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "freeplay_deposit_credits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "freeplay_player_balances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "qualifying_remainder_cents" INTEGER NOT NULL DEFAULT 0,
  "earned_spin_credits" INTEGER NOT NULL DEFAULT 0,
  "consumed_spin_credits" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "freeplay_player_balances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "freeplay_wheel_spins" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "chat_id" UUID,
  "reward_amount_cents" INTEGER NOT NULL,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "spun_at" TIMESTAMP(3) NOT NULL,
  "claim_id" UUID,
  "rng_meta_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "freeplay_wheel_spins_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "freeplay_wheel_spins_reward_amount_check" CHECK ("reward_amount_cents" IN (0, 100, 200, 300))
);

CREATE TABLE "freeplay_claims" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspace_id" UUID NOT NULL,
  "owner_coadmin_user_id" UUID NOT NULL,
  "crm_contact_id" UUID NOT NULL,
  "chat_id" UUID,
  "spin_id" UUID NOT NULL,
  "reward_amount_cents" INTEGER NOT NULL,
  "status" "FreeplayClaimStatus" NOT NULL DEFAULT 'UNCLAIMED',
  "claimed_at" TIMESTAMP(3),
  "claimed_by_user_id" UUID,
  "fulfillment_note" VARCHAR(500),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "freeplay_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "freeplay_claims_positive_reward_check" CHECK ("reward_amount_cents" IN (100, 200, 300))
);

CREATE UNIQUE INDEX "freeplay_deposit_credits_leaderboard_event_id_key" ON "freeplay_deposit_credits"("leaderboard_event_id");
CREATE INDEX "freeplay_deposit_credits_owner_contact_occurred_idx" ON "freeplay_deposit_credits"("owner_coadmin_user_id", "crm_contact_id", "occurred_at");
CREATE UNIQUE INDEX "freeplay_player_balances_owner_contact_key" ON "freeplay_player_balances"("owner_coadmin_user_id", "crm_contact_id");
CREATE INDEX "freeplay_player_balances_workspace_owner_idx" ON "freeplay_player_balances"("workspace_id", "owner_coadmin_user_id");
CREATE UNIQUE INDEX "freeplay_wheel_spins_idempotency_key_key" ON "freeplay_wheel_spins"("idempotency_key");
CREATE UNIQUE INDEX "freeplay_wheel_spins_claim_id_key" ON "freeplay_wheel_spins"("claim_id");
CREATE INDEX "freeplay_wheel_spins_owner_contact_spun_idx" ON "freeplay_wheel_spins"("owner_coadmin_user_id", "crm_contact_id", "spun_at");
CREATE INDEX "freeplay_wheel_spins_workspace_owner_idx" ON "freeplay_wheel_spins"("workspace_id", "owner_coadmin_user_id");
CREATE UNIQUE INDEX "freeplay_claims_spin_id_key" ON "freeplay_claims"("spin_id");
CREATE INDEX "freeplay_claims_owner_contact_status_created_idx" ON "freeplay_claims"("owner_coadmin_user_id", "crm_contact_id", "status", "created_at");
CREATE INDEX "freeplay_claims_workspace_owner_idx" ON "freeplay_claims"("workspace_id", "owner_coadmin_user_id");

ALTER TABLE "freeplay_deposit_credits" ADD CONSTRAINT "freeplay_deposit_credits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "freeplay_deposit_credits" ADD CONSTRAINT "freeplay_deposit_credits_owner_fkey" FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_deposit_credits" ADD CONSTRAINT "freeplay_deposit_credits_crm_contact_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_deposit_credits" ADD CONSTRAINT "freeplay_deposit_credits_leaderboard_event_fkey" FOREIGN KEY ("leaderboard_event_id") REFERENCES "leaderboard_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_player_balances" ADD CONSTRAINT "freeplay_player_balances_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "freeplay_player_balances" ADD CONSTRAINT "freeplay_player_balances_owner_fkey" FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_player_balances" ADD CONSTRAINT "freeplay_player_balances_crm_contact_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_wheel_spins" ADD CONSTRAINT "freeplay_wheel_spins_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "freeplay_wheel_spins" ADD CONSTRAINT "freeplay_wheel_spins_owner_fkey" FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_wheel_spins" ADD CONSTRAINT "freeplay_wheel_spins_crm_contact_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_wheel_spins" ADD CONSTRAINT "freeplay_wheel_spins_chat_fkey" FOREIGN KEY ("chat_id") REFERENCES "telegram_chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_owner_fkey" FOREIGN KEY ("owner_coadmin_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_crm_contact_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_chat_fkey" FOREIGN KEY ("chat_id") REFERENCES "telegram_chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_spin_fkey" FOREIGN KEY ("spin_id") REFERENCES "freeplay_wheel_spins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "freeplay_claims" ADD CONSTRAINT "freeplay_claims_claimed_by_fkey" FOREIGN KEY ("claimed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "freeplay_wheel_spins" ADD CONSTRAINT "freeplay_wheel_spins_claim_fkey" FOREIGN KEY ("claim_id") REFERENCES "freeplay_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;
