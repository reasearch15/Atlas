-- Permanent Telegram account deletion: DELETING status, PERMANENT_DELETE op, durable deletion jobs.

ALTER TYPE "TelegramAccountStatus" ADD VALUE 'DELETING';
ALTER TYPE "TelegramOutboundOperation" ADD VALUE 'PERMANENT_DELETE';

CREATE TYPE "TelegramAccountDeletionStage" AS ENUM (
  'REQUESTED',
  'STOPPING_WORKER',
  'DELETING_DATABASE',
  'DELETING_MEDIA',
  'COMPLETED',
  'FAILED'
);

CREATE TABLE "telegram_account_deletions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "telegram_account_id" UUID NOT NULL,
    "safe_display_name" VARCHAR(255) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "stage" "TelegramAccountDeletionStage" NOT NULL DEFAULT 'REQUESTED',
    "conversation_count" INTEGER NOT NULL DEFAULT 0,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "media_count" INTEGER NOT NULL DEFAULT 0,
    "chat_ids_json" JSONB NOT NULL DEFAULT '[]',
    "media_keys_json" JSONB NOT NULL DEFAULT '[]',
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "last_error" VARCHAR(500),
    "outcome" VARCHAR(40),

    CONSTRAINT "telegram_account_deletions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_account_deletions_telegram_account_id_key" ON "telegram_account_deletions"("telegram_account_id");
CREATE INDEX "telegram_account_deletions_workspace_id_stage_idx" ON "telegram_account_deletions"("workspace_id", "stage");

ALTER TABLE "telegram_account_deletions" ADD CONSTRAINT "telegram_account_deletions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_account_deletions" ADD CONSTRAINT "telegram_account_deletions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
