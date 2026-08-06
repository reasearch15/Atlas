-- Push notification foundation: device tokens, preferences, delivery audit log.

CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'WEB', 'IOS');

CREATE TYPE "NotificationType" AS ENUM (
  'INCOMING_MESSAGE',
  'NEW_CONVERSATION',
  'CONVERSATION_ASSIGNED',
  'CONVERSATION_REASSIGNED',
  'MENTION',
  'CONVERSATION_REOPENED',
  'URGENT_FLAG',
  'SLA_WARNING',
  'FAILED_MESSAGE',
  'TEST'
);

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'QUEUED',
  'SENT',
  'DELIVERED',
  'FAILED',
  'SKIPPED',
  'INVALID_TOKEN'
);

CREATE TABLE "push_device_tokens" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "session_id" UUID,
  "platform" "PushPlatform" NOT NULL,
  "token" VARCHAR(4096) NOT NULL,
  "device_name" VARCHAR(160),
  "app_version" VARCHAR(64),
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_successful_delivery_at" TIMESTAMP(3),
  "last_failed_delivery_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "push_device_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_device_tokens_token_key" ON "push_device_tokens"("token");
CREATE INDEX "push_device_tokens_user_id_workspace_id_revoked_at_idx" ON "push_device_tokens"("user_id", "workspace_id", "revoked_at");
CREATE INDEX "push_device_tokens_workspace_id_revoked_at_idx" ON "push_device_tokens"("workspace_id", "revoked_at");
CREATE INDEX "push_device_tokens_session_id_idx" ON "push_device_tokens"("session_id");

CREATE TABLE "notification_preferences" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "customer_messages" BOOLEAN NOT NULL DEFAULT true,
  "assignments" BOOLEAN NOT NULL DEFAULT true,
  "mentions" BOOLEAN NOT NULL DEFAULT true,
  "urgent_only" BOOLEAN NOT NULL DEFAULT false,
  "sound" BOOLEAN NOT NULL DEFAULT true,
  "vibration" BOOLEAN NOT NULL DEFAULT true,
  "preview_text" BOOLEAN NOT NULL DEFAULT true,
  "show_customer_names" BOOLEAN NOT NULL DEFAULT true,
  "mute_all" BOOLEAN NOT NULL DEFAULT false,
  "do_not_disturb" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");
CREATE INDEX "notification_preferences_workspace_id_idx" ON "notification_preferences"("workspace_id");

CREATE TABLE "notification_delivery_logs" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "device_token_id" UUID,
  "type" "NotificationType" NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL,
  "dedupe_key" VARCHAR(320) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "body" VARCHAR(280) NOT NULL,
  "chat_id" UUID,
  "message_id" UUID,
  "fcm_message_id" VARCHAR(200),
  "error_code" VARCHAR(120),
  "error_message" VARCHAR(500),
  "payload" JSONB,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_delivery_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_delivery_logs_dedupe_key_key" ON "notification_delivery_logs"("dedupe_key");
CREATE INDEX "notification_delivery_logs_workspace_id_created_at_idx" ON "notification_delivery_logs"("workspace_id", "created_at");
CREATE INDEX "notification_delivery_logs_user_id_created_at_idx" ON "notification_delivery_logs"("user_id", "created_at");
CREATE INDEX "notification_delivery_logs_status_created_at_idx" ON "notification_delivery_logs"("status", "created_at");
CREATE INDEX "notification_delivery_logs_type_created_at_idx" ON "notification_delivery_logs"("type", "created_at");

ALTER TABLE "push_device_tokens"
  ADD CONSTRAINT "push_device_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_device_tokens"
  ADD CONSTRAINT "push_device_tokens_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_delivery_logs"
  ADD CONSTRAINT "notification_delivery_logs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_delivery_logs"
  ADD CONSTRAINT "notification_delivery_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_delivery_logs"
  ADD CONSTRAINT "notification_delivery_logs_device_token_id_fkey"
  FOREIGN KEY ("device_token_id") REFERENCES "push_device_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
