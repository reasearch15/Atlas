-- CRM conversation ownership, status, contacts, tags, notes, activity

CREATE TYPE "CrmConversationStatus" AS ENUM ('NEW', 'OPEN', 'WAITING', 'RESOLVED', 'CLOSED');
CREATE TYPE "CrmContactKind" AS ENUM ('PRIVATE', 'GROUP', 'CHANNEL', 'UNKNOWN');
CREATE TYPE "CrmActivityType" AS ENUM (
  'CLAIMED',
  'ASSIGNED',
  'REASSIGNED',
  'RELEASED',
  'STATUS_CHANGED',
  'TAG_ADDED',
  'TAG_REMOVED',
  'NOTE_CREATED',
  'NOTE_EDITED',
  'REOPENED'
);

CREATE TABLE "crm_contacts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "telegram_peer_id" VARCHAR(80) NOT NULL,
    "kind" "CrmContactKind" NOT NULL DEFAULT 'UNKNOWN',
    "display_name" VARCHAR(255) NOT NULL,
    "username" VARCHAR(120),
    "phone_masked" VARCHAR(32),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "crm_contacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workspace_tags" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "color" VARCHAR(16) NOT NULL,
    "archived_at" TIMESTAMP(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workspace_tags_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "telegram_chats"
  ADD COLUMN "crm_contact_id" UUID,
  ADD COLUMN "crm_status" "CrmConversationStatus" NOT NULL DEFAULT 'NEW',
  ADD COLUMN "assigned_user_id" UUID,
  ADD COLUMN "assigned_at" TIMESTAMP(3),
  ADD COLUMN "assigned_by_user_id" UUID,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "last_assignment_change_at" TIMESTAMP(3),
  ADD COLUMN "needs_crm_attention" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "crm_attention_at" TIMESTAMP(3);

CREATE TABLE "telegram_chat_tags" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "added_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "telegram_chat_tags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_internal_notes" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    CONSTRAINT "crm_internal_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_activity_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "type" "CrmActivityType" NOT NULL,
    "payload_json" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_activity_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crm_status_history" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "from_status" "CrmConversationStatus" NOT NULL,
    "to_status" "CrmConversationStatus" NOT NULL,
    "actor_user_id" UUID,
    "reason" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crm_status_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crm_contacts_workspace_id_telegram_peer_id_key" ON "crm_contacts"("workspace_id", "telegram_peer_id");
CREATE INDEX "crm_contacts_workspace_id_last_seen_at_idx" ON "crm_contacts"("workspace_id", "last_seen_at");
CREATE UNIQUE INDEX "workspace_tags_workspace_id_name_key" ON "workspace_tags"("workspace_id", "name");
CREATE INDEX "workspace_tags_workspace_id_archived_at_idx" ON "workspace_tags"("workspace_id", "archived_at");
CREATE UNIQUE INDEX "telegram_chat_tags_chat_id_tag_id_key" ON "telegram_chat_tags"("chat_id", "tag_id");
CREATE INDEX "telegram_chat_tags_workspace_id_tag_id_idx" ON "telegram_chat_tags"("workspace_id", "tag_id");
CREATE INDEX "crm_internal_notes_workspace_id_chat_id_created_at_idx" ON "crm_internal_notes"("workspace_id", "chat_id", "created_at");
CREATE INDEX "crm_activity_events_workspace_id_chat_id_created_at_idx" ON "crm_activity_events"("workspace_id", "chat_id", "created_at");
CREATE INDEX "crm_status_history_workspace_id_chat_id_created_at_idx" ON "crm_status_history"("workspace_id", "chat_id", "created_at");
CREATE INDEX "telegram_chats_workspace_id_crm_status_assigned_user_id_idx" ON "telegram_chats"("workspace_id", "crm_status", "assigned_user_id");
CREATE INDEX "telegram_chats_workspace_id_needs_crm_attention_last_message_at_idx" ON "telegram_chats"("workspace_id", "needs_crm_attention", "last_message_at");
CREATE INDEX "telegram_chats_assigned_user_id_idx" ON "telegram_chats"("assigned_user_id");
CREATE INDEX "telegram_chats_crm_contact_id_idx" ON "telegram_chats"("crm_contact_id");

ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_tags" ADD CONSTRAINT "workspace_tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_tags" ADD CONSTRAINT "workspace_tags_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_crm_contact_id_fkey" FOREIGN KEY ("crm_contact_id") REFERENCES "crm_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_chats" ADD CONSTRAINT "telegram_chats_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_tags" ADD CONSTRAINT "telegram_chat_tags_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "telegram_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_tags" ADD CONSTRAINT "telegram_chat_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "workspace_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_tags" ADD CONSTRAINT "telegram_chat_tags_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_internal_notes" ADD CONSTRAINT "crm_internal_notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_internal_notes" ADD CONSTRAINT "crm_internal_notes_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "telegram_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_internal_notes" ADD CONSTRAINT "crm_internal_notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crm_activity_events" ADD CONSTRAINT "crm_activity_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_activity_events" ADD CONSTRAINT "crm_activity_events_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "telegram_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_activity_events" ADD CONSTRAINT "crm_activity_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "crm_status_history" ADD CONSTRAINT "crm_status_history_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_status_history" ADD CONSTRAINT "crm_status_history_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "telegram_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crm_status_history" ADD CONSTRAINT "crm_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
