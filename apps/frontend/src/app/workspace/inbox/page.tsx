"use client";

import { ConversationEmptyState } from "@/features/inbox/conversation-view";

/**
 * Inbox index — empty conversation pane when no chat is selected.
 */
export default function WorkspaceInboxPage() {
  return <ConversationEmptyState />;
}
