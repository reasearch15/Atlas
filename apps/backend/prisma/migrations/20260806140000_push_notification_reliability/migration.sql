-- Enterprise reliability: durable push queue + expanded lifecycle states.

ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'DISPATCHING';
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'OPENED';
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'DISMISSED';
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'RETRY_SCHEDULED';
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE "NotificationDeliveryStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE TABLE "push_notifications" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "device_token_id" UUID,
  "type" "NotificationType" NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "priority" VARCHAR(16) NOT NULL,
  "idempotency_key" VARCHAR(320) NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "body" VARCHAR(280) NOT NULL,
  "customer_name" VARCHAR(160),
  "chat_id" UUID,
  "message_id" UUID,
  "deep_link_path" VARCHAR(500) NOT NULL,
  "image_url" VARCHAR(1000),
  "badge_count" INTEGER,
  "sound" BOOLEAN NOT NULL DEFAULT true,
  "vibration" BOOLEAN NOT NULL DEFAULT true,
  "fcm_message_id" VARCHAR(200),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "last_error_code" VARCHAR(120),
  "last_error_message" VARCHAR(500),
  "sent_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "opened_at" TIMESTAMP(3),
  "dismissed_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "push_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_notifications_idempotency_key_key" ON "push_notifications"("idempotency_key");
CREATE INDEX "push_notifications_status_next_attempt_at_idx" ON "push_notifications"("status", "next_attempt_at");
CREATE INDEX "push_notifications_user_id_created_at_idx" ON "push_notifications"("user_id", "created_at");
CREATE INDEX "push_notifications_workspace_id_created_at_idx" ON "push_notifications"("workspace_id", "created_at");
CREATE INDEX "push_notifications_user_id_status_created_at_idx" ON "push_notifications"("user_id", "status", "created_at");
CREATE INDEX "push_notifications_expires_at_status_idx" ON "push_notifications"("expires_at", "status");
CREATE INDEX "push_notifications_device_token_id_status_idx" ON "push_notifications"("device_token_id", "status");

ALTER TABLE "push_notifications"
  ADD CONSTRAINT "push_notifications_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_notifications"
  ADD CONSTRAINT "push_notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "push_notifications"
  ADD CONSTRAINT "push_notifications_device_token_id_fkey"
  FOREIGN KEY ("device_token_id") REFERENCES "push_device_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Event log: drop unique dedupe (lifecycle emits many events per notification),
-- add notification_id linkage + non-unique index for lookups.
ALTER TABLE "notification_delivery_logs" ADD COLUMN IF NOT EXISTS "notification_id" UUID;

DROP INDEX IF EXISTS "notification_delivery_logs_dedupe_key_key";
CREATE INDEX IF NOT EXISTS "notification_delivery_logs_dedupe_key_idx" ON "notification_delivery_logs"("dedupe_key");
CREATE INDEX IF NOT EXISTS "notification_delivery_logs_notification_id_created_at_idx"
  ON "notification_delivery_logs"("notification_id", "created_at");

ALTER TABLE "notification_delivery_logs"
  DROP CONSTRAINT IF EXISTS "notification_delivery_logs_notification_id_fkey";

ALTER TABLE "notification_delivery_logs"
  ADD CONSTRAINT "notification_delivery_logs_notification_id_fkey"
  FOREIGN KEY ("notification_id") REFERENCES "push_notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
