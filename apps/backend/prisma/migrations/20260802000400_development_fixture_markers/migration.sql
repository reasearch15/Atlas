ALTER TABLE "workspaces" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspaces" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "workspaces_fixture_key_key" ON "workspaces"("fixture_key");

ALTER TABLE "users" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "users_fixture_key_key" ON "users"("fixture_key");

ALTER TABLE "developer_apps" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "developer_apps" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "developer_apps_fixture_key_key" ON "developer_apps"("fixture_key");

ALTER TABLE "telegram_accounts" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "telegram_accounts" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "telegram_accounts_fixture_key_key" ON "telegram_accounts"("fixture_key");

ALTER TABLE "telegram_chats" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "telegram_chats" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "telegram_chats_fixture_key_key" ON "telegram_chats"("fixture_key");

ALTER TABLE "telegram_messages" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "telegram_messages" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "telegram_messages_fixture_key_key" ON "telegram_messages"("fixture_key");

ALTER TABLE "telegram_outbound_commands" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "telegram_outbound_commands" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "telegram_outbound_commands_fixture_key_key" ON "telegram_outbound_commands"("fixture_key");

ALTER TABLE "sessions" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sessions" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "sessions_fixture_key_key" ON "sessions"("fixture_key");

ALTER TABLE "audit_logs" ADD COLUMN "is_development_fixture" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "audit_logs" ADD COLUMN "fixture_key" VARCHAR(120);
CREATE UNIQUE INDEX "audit_logs_fixture_key_key" ON "audit_logs"("fixture_key");
