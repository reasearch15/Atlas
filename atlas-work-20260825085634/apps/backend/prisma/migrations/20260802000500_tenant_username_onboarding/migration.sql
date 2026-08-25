ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'PENDING_PASSWORD_CHANGE';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';

CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

ALTER TABLE "users" ADD COLUMN "username" VARCHAR(80);
ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "temporary_password_issued_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE INDEX "users_username_idx" ON "users"("username");

ALTER TABLE "workspaces" ADD COLUMN "display_name" VARCHAR(120);
ALTER TABLE "workspaces" ADD COLUMN "admin_notes" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "workspaces" ADD COLUMN "primary_coadmin_id" UUID;
CREATE UNIQUE INDEX "workspaces_primary_coadmin_id_key" ON "workspaces"("primary_coadmin_id");
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_primary_coadmin_id_fkey" FOREIGN KEY ("primary_coadmin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "user_trusted_devices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "display_name" VARCHAR(160) NOT NULL,
  "browser" VARCHAR(80) NOT NULL,
  "operating_system" VARCHAR(80) NOT NULL,
  "first_ip" INET NOT NULL,
  "last_ip" INET NOT NULL,
  "first_trusted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_trusted_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_trusted_devices_token_hash_key" ON "user_trusted_devices"("token_hash");
CREATE INDEX "user_trusted_devices_user_id_revoked_at_expires_at_idx" ON "user_trusted_devices"("user_id", "revoked_at", "expires_at");
ALTER TABLE "user_trusted_devices" ADD CONSTRAINT "user_trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sessions" ADD COLUMN "user_trusted_device_id" UUID;
CREATE INDEX "sessions_user_trusted_device_id_idx" ON "sessions"("user_trusted_device_id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_trusted_device_id_fkey" FOREIGN KEY ("user_trusted_device_id") REFERENCES "user_trusted_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
