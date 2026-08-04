"use client";

import { memo, useEffect, useState } from "react";
import { Bot, Hash, Pin, Users } from "lucide-react";
import { cn } from "@atlas/ui";
import type { InboxChatKind, InboxConversation, UnreadUrgency } from "./inbox-utils";
import {
  avatarColor,
  avatarInitials,
  crmStatusLabels,
  crmStatusStyles,
  formatInboxTime,
  isUnreadArrivalPulseActive,
  needsIdentityBackfill,
  resolveUnreadUrgency
} from "./inbox-utils";

interface ConversationRowProps {
  readonly conversation: InboxConversation;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onPrefetch?: () => void;
}

const isDev = process.env.NODE_ENV === "development";

/**
 * Renders a compact Telegram-style conversation list row with CRM indicators
 * and unread-age urgency styling (fresh / waiting / urgent).
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
  const nowMs = useUnreadClock(hasUnread, chat.lastMessageAt);
  const urgency = resolveUnreadUrgency(chat.unreadCount, chat.lastMessageAt, nowMs);
  const arrivalPulse = hasUnread && isUnreadArrivalPulseActive(chat.lastMessageAt, nowMs);

  return (
    <button
      type="button"
      data-chat-id={chat.id}
      data-unread-urgency={urgency}
      onClick={onSelect}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      title={displayTitle}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/40 px-2.5 py-2 text-left transition-colors duration-100",
        urgencyRowClass(urgency, selected),
        arrivalPulse && "inbox-row-arrival-pulse",
        urgency === "urgent" && "inbox-row-urgent-pulse border-l-[3px] border-l-red-400 pl-[7px]"
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
              hasUnread || urgency !== "none" ? "font-semibold" : "font-medium"
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
            urgency === "fresh" || urgency === "waiting" || urgency === "urgent"
              ? "font-semibold text-foreground/85"
              : hasUnread
                ? "font-medium text-foreground/80"
                : "text-muted-foreground"
          )}
          title={preview}
        >
          {preview}
        </span>

        <span className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
          {urgency === "waiting" ? (
            <span className="shrink-0 rounded bg-amber-200/80 px-1 py-px text-[9px] font-semibold leading-[14px] text-amber-900">
              Waiting
            </span>
          ) : null}
          {urgency === "urgent" ? (
            <span className="shrink-0 rounded bg-red-200/90 px-1 py-px text-[9px] font-semibold leading-[14px] text-red-800">
              Urgent
            </span>
          ) : null}

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
        <span
          className={cn(
            "text-[11px] leading-none",
            urgency === "waiting" || urgency === "urgent"
              ? "font-semibold text-foreground"
              : hasUnread
                ? "font-medium text-primary"
                : "text-muted-foreground"
          )}
        >
          {time}
        </span>
        {hasUnread ? (
          <span
            className={cn(
              "inline-flex items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground",
              urgency === "urgent"
                ? "min-w-[22px] px-1.5 py-0.5 text-[12px] leading-4"
                : "min-w-[18px] px-1 py-px text-[10px] leading-4",
              urgency === "fresh" && "bg-emerald-600",
              urgency === "waiting" && "bg-amber-600",
              urgency === "urgent" && "bg-red-600"
            )}
          >
            {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
          </span>
        ) : (
          <span className="h-4" />
        )}
      </span>
    </button>
  );
});

function urgencyRowClass(urgency: UnreadUrgency, selected: boolean): string {
  if (selected) {
    switch (urgency) {
      case "fresh":
        return "bg-emerald-100/90";
      case "waiting":
        return "bg-amber-100/90";
      case "urgent":
        return "bg-red-100/90";
      default:
        return "bg-primary/10";
    }
  }
  switch (urgency) {
    case "fresh":
      return "bg-emerald-50 hover:bg-emerald-100/80 active:bg-emerald-100";
    case "waiting":
      return "bg-amber-50 hover:bg-amber-100/80 active:bg-amber-100";
    case "urgent":
      return "bg-red-50 hover:bg-red-100/80 active:bg-red-100";
    default:
      return "hover:bg-muted/50 active:bg-muted/70";
  }
}

/**
 * Ticks while a row is unread so urgency bands advance without inbox reloads.
 */
function useUnreadClock(hasUnread: boolean, lastMessageAt: string | null): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasUnread) return;
    setNowMs(Date.now());

    const arrivalActive = isUnreadArrivalPulseActive(lastMessageAt, Date.now());
    const tickMs = arrivalActive ? 500 : 15_000;
    const timer = window.setInterval(() => setNowMs(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [hasUnread, lastMessageAt]);

  return nowMs;
}

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
