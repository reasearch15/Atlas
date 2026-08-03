"use client";

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { use, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ConversationSkeleton } from "@/features/inbox/conversation-skeleton";
import { ConversationView } from "@/features/inbox/conversation-view";
import { useInbox } from "@/features/inbox/inbox-provider";
import type { InboxConversation } from "@/features/inbox/inbox-utils";

interface StaffInboxChatPageProps {
  readonly params: Promise<{ readonly chatId: string }>;
}

/**
 * Conversation pane only — Staff shell and chat list remain in parent layouts.
 * Keeps the last known conversation mounted across chat-list refreshes so message
 * state is not remounted/cleared when inbox metadata or ordering updates.
 */
export default function StaffInboxChatPage({ params }: StaffInboxChatPageProps) {
  const { chatId } = use(params);
  const router = useRouter();
  const { findConversation, loading } = useInbox();
  const conversation = findConversation(chatId);
  const stableConversationRef = useRef<InboxConversation | null>(null);

  if (conversation) {
    stableConversationRef.current = conversation;
  }

  const displayConversation =
    conversation ?? (stableConversationRef.current?.chat.id === chatId ? stableConversationRef.current : null);

  if (!displayConversation && loading) {
    return <ConversationSkeleton />;
  }

  if (!displayConversation) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[hsl(210_25%_96%)] px-6 text-center">
        <p className="text-base font-semibold">Conversation not found</p>
        <p className="text-sm text-muted-foreground">This chat is not in the synchronized inbox.</p>
        <Button variant="secondary" onClick={() => router.push("/staff/inbox" as Route)}>
          Back to inbox
        </Button>
      </div>
    );
  }

  return (
    <ConversationView
      conversation={displayConversation}
      onBack={() => router.push("/staff/inbox" as Route)}
    />
  );
}
