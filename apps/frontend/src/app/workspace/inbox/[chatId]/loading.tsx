import { ConversationSkeleton } from "@/features/inbox/conversation-skeleton";

/**
 * Route-level loading UI scoped to the conversation panel only.
 */
export default function ConversationLoading() {
  return <ConversationSkeleton />;
}
