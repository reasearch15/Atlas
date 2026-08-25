CREATE TYPE "PlatformAdminStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "AdminLoginChallengePurpose" AS ENUM ('NEW_DEVICE');

CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "PlatformAdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_login_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "purpose" "AdminLoginChallengePurpose" NOT NULL DEFAULT 'NEW_DEVICE',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requesting_ip" INET NOT NULL,
    "requesting_user_agent" TEXT NOT NULL,

    CONSTRAINT "admin_login_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "admin_trusted_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "admin_id" UUID NOT NULL,
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

    CONSTRAINT "admin_trusted_devices_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "sessions" ADD COLUMN "admin_trusted_device_id" UUID;

CREATE UNIQUE INDEX "platform_admins_user_id_key" ON "platform_admins"("user_id");
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");
CREATE INDEX "admin_login_challenges_admin_id_purpose_consumed_at_expires_at_idx" ON "admin_login_challenges"("admin_id", "purpose", "consumed_at", "expires_at");
CREATE UNIQUE INDEX "admin_trusted_devices_token_hash_key" ON "admin_trusted_devices"("token_hash");
CREATE INDEX "admin_trusted_devices_admin_id_revoked_at_expires_at_idx" ON "admin_trusted_devices"("admin_id", "revoked_at", "expires_at");
CREATE INDEX "sessions_admin_trusted_device_id_idx" ON "sessions"("admin_trusted_device_id");

ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_login_challenges" ADD CONSTRAINT "admin_login_challenges_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_trusted_devices" ADD CONSTRAINT "admin_trusted_devices_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_admin_trusted_device_id_fkey" FOREIGN KEY ("admin_trusted_device_id") REFERENCES "admin_trusted_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
