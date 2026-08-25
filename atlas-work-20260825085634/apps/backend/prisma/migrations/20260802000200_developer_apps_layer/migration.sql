-- CreateEnum
CREATE TYPE "DeveloperAppProvider" AS ENUM ('TELEGRAM');

-- CreateEnum
CREATE TYPE "DeveloperAppStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "developer_apps" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "provider" "DeveloperAppProvider" NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "api_id" INTEGER NOT NULL,
  "encrypted_api_hash" JSONB NOT NULL,
  "status" "DeveloperAppStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),

  CONSTRAINT "developer_apps_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "telegram_accounts" RENAME COLUMN "encrypted_phone_number" TO "phone_number_encrypted";
ALTER TABLE "telegram_accounts" RENAME COLUMN "encrypted_session_data" TO "session_encrypted";
ALTER TABLE "telegram_accounts" ADD COLUMN "developer_app_id" UUID;

-- Existing Telegram accounts cannot be assigned safely because prior API credentials
-- were process-level values, not tenant-owned database records. Operators must create
-- a Developer App per workspace and backfill developer_app_id before this column
-- becomes required.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "telegram_accounts") THEN
    RAISE EXCEPTION 'Existing telegram_accounts require manual developer_app_id backfill before applying 20260802000200_developer_apps_layer';
  END IF;
END $$;

ALTER TABLE "telegram_accounts" ALTER COLUMN "developer_app_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "developer_apps_workspace_id_provider_display_name_key" ON "developer_apps"("workspace_id", "provider", "display_name");

-- CreateIndex
CREATE INDEX "developer_apps_workspace_id_provider_status_idx" ON "developer_apps"("workspace_id", "provider", "status");

-- CreateIndex
CREATE INDEX "telegram_accounts_workspace_id_developer_app_id_idx" ON "telegram_accounts"("workspace_id", "developer_app_id");

-- AddForeignKey
ALTER TABLE "developer_apps" ADD CONSTRAINT "developer_apps_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "developer_apps" ADD CONSTRAINT "developer_apps_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_developer_app_id_fkey" FOREIGN KEY ("developer_app_id") REFERENCES "developer_apps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
