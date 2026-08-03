"use client";

import { ConversationEmptyState } from "@/features/inbox/conversation-view";

/**
 * Staff inbox index — empty conversation pane when no chat is selected.
 */
export default function StaffInboxPage() {
  return <ConversationEmptyState />;
}
