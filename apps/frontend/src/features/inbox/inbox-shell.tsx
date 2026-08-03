"use client";

import type { CrmInboxCountsDto } from "@atlas/shared";
import type { Route } from "next";
import { Inbox, RefreshCw, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAtlasBreakpoint } from "@/hooks/use-atlas-breakpoint";
import {
  captureSelectedRowAnchor,
  ensureSelectedRowNearestVisible,
  restoreSelectedRowAnchor,
  type SelectedRowAnchor
} from "./inbox-list-anchor";
import { ConversationRow } from "./conversation-row";
import { useInbox } from "./inbox-provider";
import { computeInboxCounts, filterConversations, type InboxFilter } from "./inbox-utils";

const FILTERS: ReadonlyArray<{ readonly id: InboxFilter; readonly label: string; readonly countKey: keyof CrmInboxCountsDto | null }> = [
  { id: "all", label: "All", countKey: "all" },
  { id: "unassigned", label: "Unassigned", countKey: "unassigned" },
  { id: "mine", label: "Mine", countKey: "mine" },
  { id: "new", label: "New", countKey: "new" },
  { id: "open", label: "Open", countKey: "open" },
  { id: "waiting", label: "Waiting", countKey: "waiting" },
  { id: "unread", label: "Unread", countKey: "unread" },
  { id: "resolved", label: "Resolved", countKey: "resolved" }
];

/**
 * Inbox chrome: mobile list↔chat screens; tablet list+chat; desktop list+chat(+CRM in conversation).
 */
export function InboxShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const breakpoint = useAtlasBreakpoint();
  const { conversations, loading, error, reload, currentUserId } = useInbox();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [, startTransition] = useTransition();
  const basePath = pathname.startsWith("/staff/inbox") ? "/staff/inbox" : "/workspace/inbox";
  const selectedFromUrl = useMemo(() => parseSelectedChatId(pathname), [pathname]);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTop = useRef(0);
  const visibleOrderKeyRef = useRef("");
  const pendingListAnchorRef = useRef<SelectedRowAnchor | null>(null);

  useEffect(() => {
    setPendingChatId(null);
  }, [selectedFromUrl]);

  useEffect(() => {
    // Restore list scroll when returning from a chat on mobile.
    if (breakpoint === "mobile" && !selectedFromUrl && listScrollRef.current) {
      listScrollRef.current.scrollTop = savedScrollTop.current;
    }
  }, [breakpoint, selectedFromUrl]);

  const counts = useMemo(() => computeInboxCounts(conversations, currentUserId), [conversations, currentUserId]);
  const selectedChatId = pendingChatId ?? selectedFromUrl;
  const visible = useMemo(
    () => filterConversations(conversations, filter, deferredQuery, currentUserId),
    [conversations, currentUserId, deferredQuery, filter]
  );
  // Selection is URL/id based — never pick another row when the selected chat
  // leaves the active filter (row simply disappears from the filtered list).
  const selectedVisibleInFilter = Boolean(
    selectedChatId && visible.some((row) => row.chat.id === selectedChatId)
  );

  const visibleOrderKey = visible.map((row) => row.chat.id).join("\0");
  // Capture selected-row viewport offset before React commits the reordered DOM.
  if (visibleOrderKey !== visibleOrderKeyRef.current) {
    if (selectedChatId && selectedVisibleInFilter && listScrollRef.current) {
      pendingListAnchorRef.current = captureSelectedRowAnchor(listScrollRef.current, selectedChatId);
    } else {
      pendingListAnchorRef.current = null;
    }
    visibleOrderKeyRef.current = visibleOrderKey;
  }

  useLayoutEffect(() => {
    const anchor = pendingListAnchorRef.current;
    pendingListAnchorRef.current = null;
    const container = listScrollRef.current;
    if (!anchor || !container || !selectedChatId) return;
    restoreSelectedRowAnchor(container, anchor);
    ensureSelectedRowNearestVisible(container, selectedChatId);
  }, [visibleOrderKey, selectedChatId]);

  const isMobile = breakpoint === "mobile";
  const showList = !isMobile || !selectedFromUrl;
  const showChat = !isMobile || Boolean(selectedFromUrl);

  function selectConversation(chatId: string): void {
    if (listScrollRef.current) {
      savedScrollTop.current = listScrollRef.current.scrollTop;
    }
    if (chatId === selectedFromUrl) return;
    setPendingChatId(chatId);
    startTransition(() => {
      router.push(`${basePath}/${chatId}` as Route);
    });
  }

  function prefetchConversation(chatId: string): void {
    router.prefetch(`${basePath}/${chatId}` as Route);
  }

  return (
    <main className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-background">
      <section
        className={`flex h-full min-h-0 flex-col overflow-hidden border-r bg-white ${
          isMobile ? "w-full" : "w-[320px] shrink-0 grow-0"
        } ${showList ? "flex" : "hidden"}`}
      >
        <header className="shrink-0 space-y-3 border-b px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">Inbox</h1>
              <p className="text-xs text-muted-foreground">
                {loading && conversations.length === 0
                  ? "Loading…"
                  : `${visible.length} conversation${visible.length === 1 ? "" : "s"}`}
              </p>
            </div>
            <Button variant="ghost" className="size-11 shrink-0 px-0" onClick={() => void reload()} aria-label="Refresh inbox">
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            </Button>
          </div>

          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats"
              className="h-11 bg-muted/40 pl-9"
              aria-label="Search conversations"
            />
          </label>

          <div className="flex gap-1 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Conversation filters">
            {FILTERS.map((item) => {
              const active = filter === item.id;
              const count = item.countKey ? counts[item.countKey] : undefined;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(item.id)}
                  className={`min-h-9 shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                    active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                  {typeof count === "number" ? (
                    <span className={`ml-1 ${active ? "text-primary-foreground/80" : "text-muted-foreground/70"}`}>{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </header>

        <div ref={listScrollRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {error ? <div className="m-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

          {loading && conversations.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
              Loading inbox...
            </div>
          ) : null}

          {!loading && conversations.length === 0 && !error ? (
            <div className="flex flex-col items-start gap-3 px-5 py-8">
              <div className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Inbox className="size-5" aria-hidden="true" />
              </div>
              <div>
                <p className="font-medium">No synchronized chats yet.</p>
                <p className="mt-1 text-sm text-muted-foreground">Chats appear after a connected Telegram account completes initial sync.</p>
              </div>
            </div>
          ) : null}

          {!loading && conversations.length > 0 && visible.length === 0 ? (
            <div className="px-5 py-8 text-sm text-muted-foreground">No conversations match this filter.</div>
          ) : null}

          {visible.map((conversation) => (
            <ConversationRow
              key={conversation.chat.id}
              conversation={conversation}
              selected={conversation.chat.id === selectedChatId}
              onSelect={() => selectConversation(conversation.chat.id)}
              onPrefetch={() => prefetchConversation(conversation.chat.id)}
            />
          ))}
        </div>
      </section>

      <section className={`flex h-full min-h-0 flex-1 flex-col overflow-hidden ${showChat ? "flex" : "hidden"} ${isMobile ? "w-full" : "min-w-0"}`}>
        {children}
      </section>
    </main>
  );
}

function parseSelectedChatId(pathname: string): string | null {
  const match = pathname.match(/^\/(?:workspace|staff)\/inbox\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
