-- Staff attribution snapshots on Telegram outbound messages
ALTER TABLE "telegram_messages"
  ADD COLUMN IF NOT EXISTS "internal_sender_role" "UserRole",
  ADD COLUMN IF NOT EXISTS "internal_sender_name" VARCHAR(120);

-- CRM activity types for attribution / internal messaging
ALTER TYPE "CrmActivityType" ADD VALUE IF NOT EXISTS 'TELEGRAM_MESSAGE_SENT';
ALTER TYPE "CrmActivityType" ADD VALUE IF NOT EXISTS 'INTERNAL_MESSAGE_SENT';

-- Internal Coadmin↔Staff messaging (never enters Telegram)
CREATE TABLE IF NOT EXISTS "internal_message_threads" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "staff_user_id" UUID NOT NULL,
  "last_message_at" TIMESTAMP(3),
  "last_message_preview" VARCHAR(500),
  "staff_unread_count" INTEGER NOT NULL DEFAULT 0,
  "coadmin_unread_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "internal_message_threads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "internal_message_threads_workspace_id_staff_user_id_key"
  ON "internal_message_threads"("workspace_id", "staff_user_id");

CREATE INDEX IF NOT EXISTS "internal_message_threads_workspace_id_last_message_at_idx"
  ON "internal_message_threads"("workspace_id", "last_message_at");

CREATE TABLE IF NOT EXISTS "internal_messages" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "thread_id" UUID NOT NULL,
  "sender_user_id" UUID NOT NULL,
  "receiver_user_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "read_at" TIMESTAMP(3),
  "edited_at" TIMESTAMP(3),
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "internal_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "internal_messages_thread_id_created_at_idx"
  ON "internal_messages"("thread_id", "created_at");

CREATE INDEX IF NOT EXISTS "internal_messages_workspace_id_receiver_user_id_read_at_idx"
  ON "internal_messages"("workspace_id", "receiver_user_id", "read_at");

DO $$ BEGIN
  ALTER TABLE "internal_message_threads"
    ADD CONSTRAINT "internal_message_threads_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "internal_message_threads"
    ADD CONSTRAINT "internal_message_threads_staff_user_id_fkey"
    FOREIGN KEY ("staff_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "internal_messages"
    ADD CONSTRAINT "internal_messages_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "internal_messages"
    ADD CONSTRAINT "internal_messages_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "internal_message_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "internal_messages"
    ADD CONSTRAINT "internal_messages_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "internal_messages"
    ADD CONSTRAINT "internal_messages_receiver_user_id_fkey"
    FOREIGN KEY ("receiver_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
