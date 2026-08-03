-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PLATFORM_ADMIN', 'COADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "TelegramAccountStatus" AS ENUM ('PENDING', 'AUTHORIZING', 'WAITING_FOR_QR', 'WAITING_FOR_PHONE', 'WAITING_FOR_CODE', 'WAITING_FOR_PASSWORD', 'SYNCING', 'CONNECTED', 'DEGRADED', 'REAUTH_REQUIRED', 'DISCONNECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "TelegramAuthorizationState" AS ENUM ('EMPTY', 'QR_REQUESTED', 'PHONE_REQUESTED', 'CODE_REQUESTED', 'PASSWORD_REQUESTED', 'AUTHORIZED', 'EXPIRED', 'CANCELLED', 'REAUTH_REQUIRED');

-- CreateEnum
CREATE TYPE "TelegramSyncState" AS ENUM ('IDLE', 'INITIAL_SYNC', 'LIVE', 'PAUSED', 'FAILED');

-- CreateEnum
CREATE TYPE "TelegramChatType" AS ENUM ('PRIVATE', 'GROUP', 'SUPERGROUP', 'CHANNEL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TelegramMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "TelegramMessageContentType" AS ENUM ('TEXT');

-- CreateEnum
CREATE TYPE "TelegramSendStatus" AS ENUM ('RECEIVED', 'QUEUED', 'SENDING', 'SENT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT');

-- CreateEnum
CREATE TYPE "TelegramOutboundOperation" AS ENUM ('SEND_TEXT_MESSAGE', 'START_AUTH', 'SUBMIT_PHONE', 'SUBMIT_CODE', 'SUBMIT_PASSWORD', 'CANCEL_AUTH', 'DISCONNECT', 'REAUTHORIZE');

-- CreateEnum
CREATE TYPE "TelegramOutboundStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "email" VARCHAR(320) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "telegram_user_id" VARCHAR(64),
    "telegram_username" VARCHAR(120),
    "encrypted_phone_number" JSONB,
    "encrypted_session_data" JSONB,
    "status" "TelegramAccountStatus" NOT NULL DEFAULT 'PENDING',
    "authorization_state" "TelegramAuthorizationState" NOT NULL DEFAULT 'EMPTY',
    "sync_state" "TelegramSyncState" NOT NULL DEFAULT 'IDLE',
    "last_connected_at" TIMESTAMP(3),
    "last_update_at" TIMESTAMP(3),
    "last_error_code" VARCHAR(80),
    "last_error_message" VARCHAR(500),
    "worker_lease_owner" VARCHAR(120),
    "worker_lease_expires_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "disconnected_at" TIMESTAMP(3),

    CONSTRAINT "telegram_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_chats" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "telegram_account_id" UUID NOT NULL,
    "telegram_chat_id" VARCHAR(80) NOT NULL,
    "chat_type" "TelegramChatType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "username" VARCHAR(120),
    "photo_metadata" JSONB,
    "last_message_id" VARCHAR(80),
    "last_message_preview" VARCHAR(500),
    "last_message_at" TIMESTAMP(3),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "raw_metadata_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_messages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "telegram_account_id" UUID NOT NULL,
    "telegram_chat_db_id" UUID NOT NULL,
    "telegram_chat_id" VARCHAR(80) NOT NULL,
    "telegram_message_id" VARCHAR(80) NOT NULL,
    "sender_telegram_user_id" VARCHAR(80),
    "direction" "TelegramMessageDirection" NOT NULL,
    "content_type" "TelegramMessageContentType" NOT NULL,
    "text_content" TEXT NOT NULL,
    "reply_to_telegram_message_id" VARCHAR(80),
    "telegram_created_at" TIMESTAMP(3) NOT NULL,
    "telegram_edited_at" TIMESTAMP(3),
    "internal_sender_user_id" UUID,
    "internal_sender_session_id" UUID,
    "send_status" "TelegramSendStatus" NOT NULL DEFAULT 'RECEIVED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_outbound_commands" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "telegram_account_id" UUID NOT NULL,
    "telegram_chat_db_id" UUID,
    "telegram_chat_id" VARCHAR(80),
    "requested_by_user_id" UUID NOT NULL,
    "requested_by_session_id" UUID NOT NULL,
    "operation" "TelegramOutboundOperation" NOT NULL,
    "payload_json" JSONB NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "status" "TelegramOutboundStatus" NOT NULL DEFAULT 'QUEUED',
    "telegram_message_id" VARCHAR(80),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "telegram_outbound_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "workspace_id" UUID,
    "refresh_hash" TEXT NOT NULL,
    "device_name" VARCHAR(160) NOT NULL,
    "ip_address" INET NOT NULL,
    "user_agent" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "actor_id" UUID,
    "action" VARCHAR(120) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_workspace_id_role_idx" ON "users"("workspace_id", "role");

-- CreateIndex
CREATE INDEX "telegram_accounts_workspace_id_status_idx" ON "telegram_accounts"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "telegram_accounts_worker_lease_expires_at_idx" ON "telegram_accounts"("worker_lease_expires_at");

-- CreateIndex
CREATE INDEX "telegram_chats_workspace_id_last_message_at_idx" ON "telegram_chats"("workspace_id", "last_message_at");

-- CreateIndex
CREATE INDEX "telegram_chats_workspace_id_telegram_account_id_idx" ON "telegram_chats"("workspace_id", "telegram_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_chats_telegram_account_id_telegram_chat_id_key" ON "telegram_chats"("telegram_account_id", "telegram_chat_id");

-- CreateIndex
CREATE INDEX "telegram_messages_workspace_id_telegram_chat_db_id_telegram_idx" ON "telegram_messages"("workspace_id", "telegram_chat_db_id", "telegram_created_at");

-- CreateIndex
CREATE INDEX "telegram_messages_internal_sender_user_id_idx" ON "telegram_messages"("internal_sender_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_messages_telegram_account_id_telegram_chat_id_tele_key" ON "telegram_messages"("telegram_account_id", "telegram_chat_id", "telegram_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_outbound_commands_idempotency_key_key" ON "telegram_outbound_commands"("idempotency_key");

-- CreateIndex
CREATE INDEX "telegram_outbound_commands_workspace_id_status_idx" ON "telegram_outbound_commands"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "telegram_outbound_commands_telegram_account_id_status_idx" ON "telegram_outbound_commands"("telegram_account_id", "status");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sessions_workspace_id_idx" ON "sessions"("workspace_id");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_created_at_idx" ON "audit_logs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_telegram_account_id_fkey" FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_telegram_account_id_fkey" FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_telegram_chat_db_id_fkey" FOREIGN KEY ("telegram_chat_db_id") REFERENCES "telegram_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_internal_sender_user_id_fkey" FOREIGN KEY ("internal_sender_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_outbound_commands" ADD CONSTRAINT "telegram_outbound_commands_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_outbound_commands" ADD CONSTRAINT "telegram_outbound_commands_telegram_account_id_fkey" FOREIGN KEY ("telegram_account_id") REFERENCES "telegram_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_outbound_commands" ADD CONSTRAINT "telegram_outbound_commands_telegram_chat_db_id_fkey" FOREIGN KEY ("telegram_chat_db_id") REFERENCES "telegram_chats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_outbound_commands" ADD CONSTRAINT "telegram_outbound_commands_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

