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
  resolveUnreadUrgency,
  UNREAD_ARRIVAL_PULSE_MS,
  UNREAD_FRESH_MS,
  UNREAD_WAITING_MS
} from "./inbox-utils";

interface ConversationRowProps {
  readonly conversation: InboxConversation;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onPrefetch?: () => void;
}

const isDev = process.env.NODE_ENV === "development";

const URGENCY_BADGE: Record<Exclude<UnreadUrgency, "none">, { readonly label: string; readonly className: string }> = {
  fresh: { label: "New", className: "bg-emerald-500 text-white" },
  waiting: { label: "Waiting", className: "bg-amber-500 text-white" },
  urgent: { label: "Urgent", className: "bg-red-500 text-white" }
};

/**
 * Renders a compact conversation row with high-visibility unread urgency.
 * Opening/selecting a chat suppresses urgency styling immediately.
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
  // Selected/open chat clears urgency chrome immediately (unread also cleared by provider).
  const showUrgency = !selected && chat.unreadCount > 0;
  const nowMs = useUnreadClock(showUrgency, chat.lastMessageAt);
  const urgency = showUrgency ? resolveUnreadUrgency(chat.unreadCount, chat.lastMessageAt, nowMs) : "none";
  const arrivalPulse = showUrgency && urgency === "fresh" && isUnreadArrivalPulseActive(chat.lastMessageAt, nowMs);
  const urgencyMeta = urgency === "none" ? null : URGENCY_BADGE[urgency];

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
        "inbox-row-urgency relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/40 py-2 pr-2.5 text-left",
        urgency === "none" ? "px-2.5" : "pl-2",
        selected && urgency === "none" && "bg-primary/10",
        !selected && urgency === "none" && "hover:bg-muted/50 active:bg-muted/70",
        urgency === "fresh" && "inbox-row-urgency-fresh",
        urgency === "waiting" && "inbox-row-urgency-waiting",
        urgency === "urgent" && "inbox-row-urgency-urgent inbox-row-urgent-pulse",
        arrivalPulse && "inbox-row-arrival-pulse"
      )}
      aria-current={selected ? "true" : undefined}
    >
      {urgency !== "none" ? (
        <span
          className={cn(
            "absolute inset-y-0 left-0 w-[5px]",
            urgency === "fresh" && "bg-emerald-500",
            urgency === "waiting" && "bg-amber-500",
            urgency === "urgent" && "bg-red-500"
          )}
          aria-hidden="true"
        />
      ) : null}

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
              urgency !== "none" ? "font-bold" : "font-medium"
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
            urgency !== "none" ? "font-bold text-foreground" : "text-muted-foreground"
          )}
          title={preview}
        >
          {preview}
        </span>

        <span className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
          {urgencyMeta ? (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-wide",
                urgencyMeta.className
              )}
            >
              {urgencyMeta.label}
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
            urgency !== "none" ? "font-bold text-foreground" : "text-muted-foreground"
          )}
        >
          {time}
        </span>
        {showUrgency ? (
          <span
            className={cn(
              "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[12px] font-bold leading-none text-white",
              urgency === "fresh" && "bg-emerald-600",
              urgency === "waiting" && "bg-amber-600",
              urgency === "urgent" && "bg-red-600"
            )}
          >
            {chat.unreadCount > 99 ? "99+" : chat.unreadCount}
          </span>
        ) : chat.unreadCount > 0 && selected ? (
          <span className="h-6" />
        ) : (
          <span className="h-6" />
        )}
      </span>
    </button>
  );
});

/**
 * Live clock for unread rows — ticks often during arrival, then at band boundaries.
 */
function useUnreadClock(active: boolean, lastMessageAt: string | null): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !lastMessageAt) return;
    setNowMs(Date.now());

    const timers: number[] = [];
    const schedule = (): void => {
      const now = Date.now();
      setNowMs(now);
      const at = Date.parse(lastMessageAt);
      if (!Number.isFinite(at)) return;
      const age = Math.max(0, now - at);

      if (age < UNREAD_ARRIVAL_PULSE_MS) {
        timers.push(window.setTimeout(schedule, 400));
        return;
      }
      if (age < UNREAD_FRESH_MS) {
        timers.push(window.setTimeout(schedule, Math.min(5_000, UNREAD_FRESH_MS - age + 50)));
        return;
      }
      if (age < UNREAD_WAITING_MS) {
        timers.push(window.setTimeout(schedule, Math.min(15_000, UNREAD_WAITING_MS - age + 50)));
        return;
      }
      timers.push(window.setTimeout(schedule, 30_000));
    };

    schedule();
    return () => {
      for (const id of timers) window.clearTimeout(id);
    };
  }, [active, lastMessageAt]);

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
