"use client";

import { memo } from "react";
import { Bot, Hash, Pin, Users } from "lucide-react";
import { cn } from "@atlas/ui";
import type { InboxChatKind, InboxConversation } from "./inbox-utils";
import { avatarColor, avatarInitials, crmStatusLabels, crmStatusStyles, formatInboxTime, needsIdentityBackfill } from "./inbox-utils";

interface ConversationRowProps {
  readonly conversation: InboxConversation;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onPrefetch?: () => void;
}

const isDev = process.env.NODE_ENV === "development";

/**
 * Renders a compact Telegram-style conversation list row with CRM indicators
 * (status pill, assignee initial, up to 2 tags, unassigned/attention markers).
 */
export const ConversationRow = memo(function ConversationRow({
  conversation,
  selected,
  onSelect,
  onPrefetch
}: ConversationRowProps) {
  const { chat, displayTitle, preview, kind } = conversation;
  const time = formatInboxTime(chat.lastMessageAt);
  const color = avatarColor(chat.id || displayTitle);
  const unresolved = needsIdentityBackfill(chat);
  const isUnassigned = chat.assignedUserId === null && chat.crmStatus !== "RESOLVED" && chat.crmStatus !== "CLOSED";
  const visibleTags = chat.tags.filter((tag) => !tag.archivedAt).slice(0, 2);
  const hasUnread = chat.unreadCount > 0;

  return (
    <button
      type="button"
      data-chat-id={chat.id}
      onClick={onSelect}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      title={displayTitle}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/40 px-2.5 py-2 text-left transition-colors duration-100",
        selected ? "bg-primary/10" : "hover:bg-muted/50 active:bg-muted/70"
      )}
      aria-current={selected ? "true" : undefined}
    >
      <span className="relative shrink-0 self-center">
        <span
          className="flex size-10 items-center justify-center rounded-full text-[13px] font-semibold text-white"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        >
          {avatarInitials(displayTitle)}
        </span>
        <span className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border border-white bg-white text-muted-foreground">
          <ChatKindIcon kind={kind} />
        </span>
      </span>

      <span className="min-w-0 self-center overflow-hidden">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13.5px] leading-tight text-foreground",
              hasUnread ? "font-semibold" : "font-medium"
            )}
            title={displayTitle}
          >
            {displayTitle}
          </span>
          {chat.isPinned ? <Pin className="size-2.5 shrink-0 self-center text-muted-foreground" aria-label="Pinned" /> : null}
        </span>

        <span
          className={cn(
            "mt-0.5 block truncate text-[12.5px] leading-tight",
            hasUnread ? "font-medium text-foreground/80" : "text-muted-foreground"
          )}
          title={preview}
        >
          {preview}
        </span>

        <span className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-[9px] font-medium leading-[14px]",
              crmStatusStyles[chat.crmStatus]
            )}
          >
            {crmStatusLabels[chat.crmStatus]}
          </span>

          {isUnassigned ? (
            <span
              className="shrink-0 rounded bg-orange-100 px-1 py-px text-[9px] font-medium leading-[14px] text-orange-700"
              title="Unassigned"
            >
              Unassigned
            </span>
          ) : chat.assignedUserName ? (
            <span
              className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[8px] font-semibold text-slate-700"
              title={`Assigned to ${chat.assignedUserName}`}
            >
              {chat.assignedUserName.trim().slice(0, 1).toUpperCase()}
            </span>
          ) : null}

          {visibleTags.map((tag) => (
            <span
              key={tag.id}
              className="flex min-w-0 shrink-0 items-center gap-0.5 truncate rounded px-1 py-px text-[9px] font-medium leading-[14px]"
              style={{ backgroundColor: `${tag.color}1a`, color: tag.color }}
              title={tag.name}
            >
              <span className="size-1 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
              <span className="max-w-12 truncate">{tag.name}</span>
            </span>
          ))}
        </span>

        {isDev && unresolved ? (
          <span className="mt-0.5 block truncate font-mono text-[9px] text-amber-700" title="Development identity diagnostics">
            id:{chat.id.slice(0, 8)} · type:{chat.chatType} · title:{chat.title ? "yes" : "no"} · user:{chat.username ? "yes" : "no"} ·
            resolved:{chat.identityResolved ? "yes" : "no"}
          </span>
        ) : null}
      </span>

      <span className="flex h-10 shrink-0 flex-col items-end justify-between self-center py-0.5">
        <span className={cn("text-[11px] leading-none", hasUnread ? "font-medium text-primary" : "text-muted-foreground")}>
          {time}
        </span>
        {hasUnread ? (
          <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-primary px-1 py-px text-[10px] font-semibold leading-4 text-primary-foreground">
            {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
          </span>
        ) : (
          <span className="h-4" />
        )}
      </span>
    </button>
  );
});

function ChatKindIcon({ kind }: { readonly kind: InboxChatKind }) {
  const className = "size-2";
  switch (kind) {
    case "group":
      return <Users className={className} aria-hidden="true" />;
    case "channel":
      return <Hash className={className} aria-hidden="true" />;
    case "bot":
      return <Bot className={className} aria-hidden="true" />;
    default:
      return <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />;
  }
}
