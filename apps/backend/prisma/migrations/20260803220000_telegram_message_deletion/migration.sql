-- Telegram message soft-deletion (Atlas Coadmin / Platform Admin)

ALTER TYPE "TelegramOutboundOperation" ADD VALUE IF NOT EXISTS 'DELETE_MESSAGE';

DO $$ BEGIN
  CREATE TYPE "TelegramDeletionScope" AS ENUM ('EVERYONE', 'ATLAS_ONLY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "TelegramDeleteStatus" AS ENUM ('NONE', 'QUEUED', 'DELETING', 'DELETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "telegram_messages"
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deleted_by_user_id" UUID,
  ADD COLUMN IF NOT EXISTS "deletion_scope" "TelegramDeletionScope",
  ADD COLUMN IF NOT EXISTS "telegram_delete_status" "TelegramDeleteStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "telegram_delete_error" VARCHAR(500);

DO $$ BEGIN
  ALTER TABLE "telegram_messages"
    ADD CONSTRAINT "telegram_messages_deleted_by_user_id_fkey"
    FOREIGN KEY ("deleted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "telegram_messages_deleted_at_idx" ON "telegram_messages"("deleted_at");
