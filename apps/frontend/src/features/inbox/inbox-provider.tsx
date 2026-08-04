"use client";

import type { TelegramAccountDto, TelegramChatDto, TelegramMessageDto, TelegramWorkspaceRealtimeEvent } from "@atlas/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { api, apiBaseUrl } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import {
  applyChatActivity,
  needsIdentityBackfill,
  sortConversations,
  toInboxConversation,
  type InboxConversation
} from "./inbox-utils";
import { notifyIncomingMessage } from "./desktop-notifications";
import { installAudioUnlockListeners } from "./notification-sound";
import { rememberChatMessage, refreshChatMessagesForced, refreshChatMessagesIfStale, purgeChatMessageCaches } from "./message-cache";
import { logInboxReliability } from "./inbox-reliability-log";
import { toast } from "sonner";

interface InboxContextValue {
  readonly conversations: readonly InboxConversation[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly realtimeConnected: boolean;
  readonly currentUserId: string | null;
  readonly reload: () => Promise<void>;
  readonly findConversation: (chatId: string) => InboxConversation | null;
  readonly applyOutgoingActivity: (chatId: string, text: string, sentAt: string) => void;
  readonly clearUnread: (chatId: string) => void;
  readonly subscribeMessages: (chatId: string, handler: (message: TelegramMessageDto) => void) => () => void;
  readonly requestActiveChatCatchUp: (chatId: string, options?: { readonly force?: boolean }) => void;
}

const InboxContext = createContext<InboxContextValue | null>(null);
const MESSAGE_BUFFER_LIMIT = 50;
const CRM_EVENT_ID_LIMIT = 500;
const MESSAGE_EVENT_ID_LIMIT = 500;
const INBOX_RECONCILE_MIN_INTERVAL_MS = 2_000;
/** Per browser session — avoid re-enqueueing metadata GetDialogs jobs on every inbox reload. */
const metadataBackfillRequested = new Set<string>();

/**
 * Loads inbox conversations once for the persistent inbox layout.
 */
export function InboxProvider({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const messageListenersRef = useRef(new Map<string, Set<(message: TelegramMessageDto) => void>>());
  const messageBufferRef = useRef(new Map<string, TelegramMessageDto[]>());
  const activeChatIdRef = useRef<string | null>(null);
  const catchUpHandlersRef = useRef(new Map<string, () => void>());
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const seenCrmEventIdsRef = useRef<string[]>([]);
  const seenMessageEventIdsRef = useRef<string[]>([]);
  const lastInboxReconcileAtRef = useRef(0);
  const activeChatId = useMemo(() => parseSelectedChatId(pathname), [pathname]);
  activeChatIdRef.current = activeChatId;

  const reloadQuietly = useCallback(async (): Promise<void> => {
    try {
      const flattened = await fetchConversations();
      setConversations(flattened);
      logInboxReliability("inbox.react_state_updated", {
        reason: "quiet_reload",
        meta: { conversationCount: flattened.length }
      });
    } catch {
      // Keep the current list if a quiet refresh fails.
    }
  }, []);

  /**
   * Reconciles the inbox list from REST after reconnect / resume.
   * Throttled so rapid socket flaps cannot stampede the API.
   */
  const reconcileInboxFromServer = useCallback(async (): Promise<void> => {
    const now = Date.now();
    if (now - lastInboxReconcileAtRef.current < INBOX_RECONCILE_MIN_INTERVAL_MS) {
      logInboxReliability("ws.event_dropped", {
        reason: "reconcile_throttled",
        meta: { minIntervalMs: INBOX_RECONCILE_MIN_INTERVAL_MS }
      });
      return;
    }
    lastInboxReconcileAtRef.current = now;
    logInboxReliability("inbox.reconcile_started", { reason: "server_catch_up" });
    await reloadQuietly();
    logInboxReliability("inbox.reconcile_completed", { reason: "server_catch_up", ok: true });
  }, [reloadQuietly]);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const { conversations: flattened, withChats } = await fetchConversationsWithAccounts();
      setConversations(flattened);

      const accountsNeedingBackfill = withChats.filter(
        ({ account, chats }) =>
          !metadataBackfillRequested.has(account.id) && chats.some((chat) => needsIdentityBackfill(chat))
      );
      if (accountsNeedingBackfill.length > 0) {
        void Promise.all(
          accountsNeedingBackfill.map(async ({ account }) => {
            metadataBackfillRequested.add(account.id);
            await api.refreshTelegramChatMetadata(account.id).catch(() => {
              metadataBackfillRequested.delete(account.id);
              return null;
            });
            for (let attempt = 0; attempt < 4; attempt += 1) {
              await wait(2_000);
              const result = await api.telegramChatIdentityBackfillResult(account.id).catch(() => null);
              if (result) {
                if (process.env.NODE_ENV === "development") {
                  console.info("[atlas] chat identity backfill", result);
                }
                break;
              }
            }
          })
        ).then(() => {
          void reloadQuietly();
        });
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load inbox.");
    } finally {
      setLoading(false);
    }
  }, [reloadQuietly]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => installAudioUnlockListeners(), []);

  const applyOutgoingActivity = useCallback((chatId: string, text: string, sentAt: string) => {
    setConversations((current) =>
      applyChatActivity(current, {
        chatId,
        previewText: text,
        sentAt,
        direction: "OUTBOUND"
      })
    );
  }, []);

  const clearUnread = useCallback((chatId: string) => {
    const prior = conversationsRef.current.find((row) => row.chat.id === chatId)?.chat.unreadCount ?? null;
    setConversations((current) =>
      current.map((item) => {
        if (item.chat.id !== chatId || item.chat.unreadCount === 0) return item;
        return toInboxConversation({ ...item.chat, unreadCount: 0 }, item.accountLabel);
      })
    );
    logInboxReliability("inbox.mark_read_requested", {
      chatId,
      reason: "clearUnread",
      ...(prior !== null ? { unreadCount: prior } : {})
    });
    // Durable persistence is required — optimistic UI alone leaves DB unread after concurrent inbound.
    void api
      .telegramMarkChatRead(chatId)
      .then(() => {
        logInboxReliability("inbox.mark_read_succeeded", { chatId, unreadCount: 0, attempt: 1, ok: true });
        setConversations((current) =>
          current.map((item) => {
            if (item.chat.id !== chatId || item.chat.unreadCount === 0) return item;
            return toInboxConversation({ ...item.chat, unreadCount: 0 }, item.accountLabel);
          })
        );
      })
      .catch(() => {
        logInboxReliability("inbox.mark_read_failed", { chatId, attempt: 1, ok: false, reason: "retrying" });
        // Retry once; if still failing, quiet reconcile restores truth from the server.
        void api
          .telegramMarkChatRead(chatId)
          .then(() => {
            logInboxReliability("inbox.mark_read_succeeded", { chatId, unreadCount: 0, attempt: 2, ok: true });
          })
          .catch(() => {
            logInboxReliability("inbox.mark_read_failed", {
              chatId,
              attempt: 2,
              ok: false,
              reason: "reconcile_fallback"
            });
            void reloadQuietly();
          });
      });
  }, [reloadQuietly]);

  const deliverMessageToChat = useCallback((chatId: string, message: TelegramMessageDto) => {
    if (message.isDeleted) {
      const buffer = messageBufferRef.current.get(chatId) ?? [];
      messageBufferRef.current.set(
        chatId,
        buffer.filter((row) => row.id !== message.id && row.telegramMessageId !== message.telegramMessageId)
      );
      const listeners = messageListenersRef.current.get(chatId);
      if (listeners) {
        for (const listener of listeners) {
          try {
            listener({ ...message, isDeleted: true });
          } catch {
            // Keep delivering.
          }
        }
      }
      return;
    }
    rememberChatMessage(chatId, message);
    const buffer = messageBufferRef.current.get(chatId) ?? [];
    const deduped = buffer.filter(
      (row) => row.id !== message.id && row.telegramMessageId !== message.telegramMessageId
    );
    deduped.push(message);
    messageBufferRef.current.set(chatId, deduped.slice(-MESSAGE_BUFFER_LIMIT));

    const listeners = messageListenersRef.current.get(chatId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(message);
      } catch {
        // Keep delivering to remaining listeners.
      }
    }
  }, []);

  const deliverMessageDeleted = useCallback(
    (event: Extract<TelegramWorkspaceRealtimeEvent, { type: "telegram.message.deleted" }>) => {
      const chatDbId = event.chatDbId || event.chatId;
      deliverMessageToChat(chatDbId, {
        id: event.messageId,
        telegramAccountId: event.telegramAccountId,
        chatId: chatDbId,
        telegramMessageId: event.telegramMessageId,
        direction: "OUTBOUND",
        contentType: "TEXT",
        mediaType: "TEXT",
        text: "",
        caption: null,
        mimeType: null,
        fileName: null,
        fileSizeBytes: null,
        width: null,
        height: null,
        durationSeconds: null,
        waveform: null,
        mediaMetadata: null,
        mediaUrl: null,
        thumbnailUrl: null,
        mediaDownloadState: "NONE",
        mediaUploadState: "NONE",
        mediaError: null,
        sentAt: event.deletedAt,
        editedAt: null,
        isEdited: false,
        isDeleted: true,
        deletedAt: event.deletedAt,
        deletionScope: event.scope,
        senderDisplayName: null,
        replyToTelegramMessageId: null,
        replyPreview: null,
        webPreview: null,
        internalSenderUserId: null,
        sendStatus: "SENT"
      });

      setConversations((current) =>
        applyChatActivity(current, {
          chatId: chatDbId,
          previewText: event.lastMessagePreview ?? "",
          sentAt: event.lastMessageAt ?? event.deletedAt,
          direction: event.lastMessageDirection ?? "INBOUND",
          unreadCount: current.find((row) => row.chat.id === chatDbId)?.chat.unreadCount ?? 0
        })
      );
    },
    [deliverMessageToChat]
  );
  const subscribeMessages = useCallback((chatId: string, handler: (message: TelegramMessageDto) => void) => {
    const bucket = messageListenersRef.current.get(chatId) ?? new Set();
    bucket.add(handler);
    messageListenersRef.current.set(chatId, bucket);

    const buffered = messageBufferRef.current.get(chatId) ?? [];
    for (const message of buffered) {
      try {
        handler(message);
      } catch {
        // Ignore individual handler failures while flushing.
      }
    }

    return () => {
      const current = messageListenersRef.current.get(chatId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) messageListenersRef.current.delete(chatId);
    };
  }, []);

  const requestActiveChatCatchUp = useCallback((chatId: string, options?: { readonly force?: boolean }) => {
    if (options?.force) {
      refreshChatMessagesForced(chatId);
    } else {
      refreshChatMessagesIfStale(chatId);
    }
    catchUpHandlersRef.current.get(chatId)?.();
  }, []);

  const handleRealtimeEvent = useCallback(
    (event: TelegramWorkspaceRealtimeEvent) => {
      logInboxReliability("ws.event_received", {
        eventType: event.type,
        ...("eventId" in event && event.eventId ? { eventId: event.eventId } : {}),
        ...((): { chatId?: string } => {
          if ("chatDbId" in event && event.chatDbId) return { chatId: event.chatDbId };
          if ("chatId" in event && event.chatId) return { chatId: event.chatId };
          return {};
        })()
      });

      if (event.type === "telegram.message.created" || event.type === "telegram.message.updated") {
        const chatDbId = event.chatDbId || event.chatId || event.message.chatId;
        const open = activeChatIdRef.current === chatDbId;
        const windowActive = typeof document === "undefined" ? true : document.visibilityState === "visible";
        deliverMessageToChat(chatDbId, event.message);

        if (event.type === "telegram.message.created") {
          const seen = seenMessageEventIdsRef.current;
          if (seen.includes(event.eventId)) {
            logInboxReliability("ws.event_dropped", {
              eventId: event.eventId,
              eventType: event.type,
              chatId: chatDbId,
              reason: "duplicate_event_id"
            });
            return;
          }
          seen.push(event.eventId);
          if (seen.length > MESSAGE_EVENT_ID_LIMIT) seen.splice(0, seen.length - MESSAGE_EVENT_ID_LIMIT);

          const existing = conversationsRef.current.find((row) => row.chat.id === chatDbId);
          const previewText =
            event.message.caption || event.message.text || existing?.chat.lastMessagePreview || "";
          const viewingLive = open && windowActive;
          if (event.message.direction === "INBOUND") {
            notifyIncomingMessage({
              direction: event.message.direction,
              chatId: chatDbId,
              chatTitle: existing?.displayTitle || "Telegram",
              preview: previewText,
              isChatOpen: open
            });
          }
          setConversations((current) =>
            applyChatActivity(current, {
              chatId: chatDbId,
              previewText,
              sentAt: event.message.sentAt,
              direction: event.message.direction,
              bumpUnread: event.message.direction === "INBOUND" && !viewingLive,
              ...(viewingLive ? { unreadCount: 0 } : {}),
              telegramAccountId: event.telegramAccountId || event.message.telegramAccountId,
              accountLabel: existing?.accountLabel ?? "Telegram"
            })
          );
          logInboxReliability("inbox.react_state_updated", {
            chatId: chatDbId,
            eventId: event.eventId,
            eventType: event.type,
            reason: viewingLive ? "viewing_live_zero" : "activity_applied",
            meta: {
              direction: event.message.direction,
              viewingLive,
              bumpUnread: event.message.direction === "INBOUND" && !viewingLive
            }
          });
          // Worker already incremented durable unread — re-issue mark-read while staff is actively viewing.
          if (viewingLive && event.message.direction === "INBOUND") {
            logInboxReliability("inbox.viewing_inbound_cleared", {
              chatId: chatDbId,
              eventId: event.eventId,
              reason: "viewing_live_inbound"
            });
            clearUnread(chatDbId);
          }
        }
        return;
      }

      if (event.type === "telegram.message.deleted") {
        deliverMessageDeleted(event);
        return;
      }

      if (event.type === "telegram.chat.updated") {
        // Chat-list metadata only — never clears open conversation message state.
        const open = activeChatIdRef.current === event.chatId;
        const windowActive = typeof document === "undefined" ? true : document.visibilityState === "visible";
        const viewingLive = open && windowActive;
        setConversations((current) => {
          const existing = current.find((row) => row.chat.id === event.chatId);
          return applyChatActivity(current, {
            chatId: event.chatId,
            previewText: event.lastMessagePreview ?? existing?.chat.lastMessagePreview ?? "",
            sentAt: event.lastMessageAt ?? existing?.chat.lastMessageAt ?? new Date().toISOString(),
            direction: event.lastMessageDirection ?? existing?.chat.lastMessageDirection ?? "INBOUND",
            unreadCount: viewingLive ? 0 : event.unreadCount,
            telegramAccountId: event.telegramAccountId,
            ...(event.title !== undefined ? { title: event.title } : {}),
            ...(event.firstName !== undefined ? { firstName: event.firstName } : {}),
            ...(event.lastName !== undefined ? { lastName: event.lastName } : {}),
            ...(event.username !== undefined ? { username: event.username } : {}),
            ...(event.phone !== undefined ? { phone: event.phone } : {}),
            ...(event.chatType !== undefined ? { chatType: event.chatType } : {}),
            ...(event.isBot !== undefined ? { isBot: event.isBot } : {}),
            ...(event.isPinned !== undefined ? { isPinned: event.isPinned } : {}),
            ...(event.identityResolved !== undefined ? { identityResolved: event.identityResolved } : {}),
            ...(event.needsCrmAttention !== undefined ? { needsCrmAttention: event.needsCrmAttention } : {}),
            ...(event.telegramChatId !== undefined ? { telegramChatId: event.telegramChatId } : {}),
            ...(event.crmStatus !== undefined ? { crmStatus: event.crmStatus } : {}),
            ...(event.assignedUserId !== undefined ? { assignedUserId: event.assignedUserId } : {}),
            ...(event.assignedUserName !== undefined ? { assignedUserName: event.assignedUserName } : {}),
            ...(event.assignedAt !== undefined ? { assignedAt: event.assignedAt } : {}),
            ...(event.claimedAt !== undefined ? { claimedAt: event.claimedAt } : {}),
            ...(existing ? { accountLabel: existing.accountLabel } : { accountLabel: "Telegram" })
          });
        });
        logInboxReliability("inbox.react_state_updated", {
          chatId: event.chatId,
          eventId: event.eventId,
          eventType: event.type,
          unreadCount: viewingLive ? 0 : event.unreadCount,
          reason: viewingLive ? "chat_updated_viewing_mask" : "chat_updated_applied"
        });
        // If the server still reports unread while this chat is open and visible, persist read again.
        if (viewingLive && event.unreadCount > 0) {
          clearUnread(event.chatId);
        }
        // Chat-list metadata only — message bodies arrive via WS message events.
        // Soft stale refresh for media hydration if needed; never force-download history.
        if (open) {
          refreshChatMessagesIfStale(event.chatId);
        }
        return;
      }

      if (event.type === "crm.conversation.updated") {
        const seen = seenCrmEventIdsRef.current;
        if (seen.includes(event.eventId)) {
          logInboxReliability("ws.event_dropped", {
            eventId: event.eventId,
            eventType: event.type,
            chatId: event.chatId,
            reason: "duplicate_crm_event_id"
          });
          return;
        }
        seen.push(event.eventId);
        if (seen.length > CRM_EVENT_ID_LIMIT) seen.splice(0, seen.length - CRM_EVENT_ID_LIMIT);

        // CRM-only patch — merges status/assignment/tag fields without touching
        // message state, so an open conversation never remounts on a CRM update.
        setConversations((current) =>
          current.map((item) => {
            if (item.chat.id !== event.chatId) return item;
            return toInboxConversation(
              {
                ...item.chat,
                crmStatus: event.crmStatus,
                assignedUserId: event.assignedUserId,
                assignedUserName: event.assignedUserName,
                assignedAt: event.assignedAt,
                claimedAt: event.claimedAt,
                needsCrmAttention: event.needsCrmAttention,
                tags: event.tags
              },
              item.accountLabel
            );
          })
        );
        return;
      }

      if (event.type === "conversations.deleted" || event.type === "telegram_account.deleted") {
        const chatIds =
          event.type === "conversations.deleted"
            ? [...event.chatIds]
            : conversationsRef.current
                .filter((row) => row.chat.telegramAccountId === event.telegramAccountId)
                .map((row) => row.chat.id);
        purgeChatMessageCaches(chatIds);
        const remove = new Set(chatIds);
        setConversations((current) =>
          current.filter((row) => !remove.has(row.chat.id) && row.chat.telegramAccountId !== event.telegramAccountId)
        );
        if (event.type === "telegram_account.deleted") {
          toast.success("Telegram account and associated inbox data permanently deleted.");
        }
      }
    },
    [clearUnread, deliverMessageToChat, deliverMessageDeleted]
  );

  const handleRealtimeEventRef = useRef(handleRealtimeEvent);
  handleRealtimeEventRef.current = handleRealtimeEvent;

  useEffect(() => {
    if (!accessToken) {
      setRealtimeConnected(false);
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let hadPriorConnection = false;

    const connect = (): void => {
      if (closed) return;
      if (hadPriorConnection) {
        logInboxReliability("ws.reconnecting", { reason: "schedule_reconnect" });
      }
      const wsBase = apiBaseUrl.replace(/^http/, "ws");
      socket = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(accessToken)}`);

      socket.onopen = () => {
        if (closed) return;
        setRealtimeConnected(true);
        logInboxReliability(hadPriorConnection ? "ws.reconnected" : "ws.connected", {
          reason: hadPriorConnection ? "reconnect" : "initial",
          ok: true
        });
        hadPriorConnection = true;
        // Pub/Sub has no replay — reconcile inbox list + force-refresh open chat after every connect.
        void reconcileInboxFromServer();
        const openChatId = activeChatIdRef.current;
        if (openChatId) {
          refreshChatMessagesForced(openChatId);
          catchUpHandlersRef.current.get(openChatId)?.();
        }
      };

      socket.onmessage = (messageEvent) => {
        try {
          const payload = JSON.parse(String(messageEvent.data)) as TelegramWorkspaceRealtimeEvent | { type?: string };
          if (
            payload.type === "telegram.message.created" ||
            payload.type === "telegram.message.updated" ||
            payload.type === "telegram.message.deleted" ||
            payload.type === "telegram.chat.updated" ||
            payload.type === "crm.conversation.updated" ||
            payload.type === "conversations.deleted" ||
            payload.type === "telegram_account.deleted" ||
            payload.type === "telegram_account.deletion_started"
          ) {
            handleRealtimeEventRef.current(payload as TelegramWorkspaceRealtimeEvent);
          } else if (payload.type && payload.type !== "connected" && payload.type !== "pong") {
            logInboxReliability("ws.event_dropped", {
              eventType: payload.type,
              reason: "unhandled_frame_type"
            });
          }
        } catch {
          logInboxReliability("ws.event_dropped", { reason: "malformed_frame" });
        }
      };

      socket.onerror = () => {
        setRealtimeConnected(false);
      };

      socket.onclose = () => {
        setRealtimeConnected(false);
        logInboxReliability("ws.disconnected", { reason: closed ? "provider_unmount" : "socket_close" });
        if (closed) return;
        reconnectTimer = setTimeout(connect, 2_000);
      };
    };

    connect();
    heartbeatTimer = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);

    return () => {
      closed = true;
      setRealtimeConnected(false);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      socket?.close();
    };
  }, [accessToken, reconcileInboxFromServer]);

  useEffect(() => {
    if (activeChatId) clearUnread(activeChatId);
  }, [activeChatId, clearUnread]);

  // Resume from background / network restore: re-mark open chat read + reconcile list.
  useEffect(() => {
    function onVisibleOrOnline(): void {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      logInboxReliability("proof.timeline_step", {
        reason: "browser_resume_or_online",
        meta: { visibility: typeof document === "undefined" ? "ssr" : document.visibilityState }
      });
      const openChatId = activeChatIdRef.current;
      if (openChatId && (typeof document === "undefined" || document.visibilityState === "visible")) {
        clearUnread(openChatId);
      }
      void reconcileInboxFromServer();
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") onVisibleOrOnline();
    }

    window.addEventListener("online", onVisibleOrOnline);
    window.addEventListener("pageshow", onVisibleOrOnline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("online", onVisibleOrOnline);
      window.removeEventListener("pageshow", onVisibleOrOnline);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [clearUnread, reconcileInboxFromServer]);

  const registerCatchUpHandler = useCallback((chatId: string, handler: () => void) => {
    catchUpHandlersRef.current.set(chatId, handler);
    return () => {
      if (catchUpHandlersRef.current.get(chatId) === handler) {
        catchUpHandlersRef.current.delete(chatId);
      }
    };
  }, []);

  const value = useMemo<InboxContextValue>(
    () => ({
      conversations,
      loading,
      error,
      realtimeConnected,
      currentUserId,
      reload,
      findConversation: (chatId: string) => conversations.find((item) => item.chat.id === chatId) ?? null,
      applyOutgoingActivity,
      clearUnread,
      subscribeMessages,
      requestActiveChatCatchUp
    }),
    [
      applyOutgoingActivity,
      clearUnread,
      conversations,
      currentUserId,
      error,
      loading,
      realtimeConnected,
      reload,
      requestActiveChatCatchUp,
      subscribeMessages
    ]
  );

  return (
    <InboxContext.Provider value={value}>
      <CatchUpRegistrarContext.Provider value={registerCatchUpHandler}>{children}</CatchUpRegistrarContext.Provider>
    </InboxContext.Provider>
  );
}

const CatchUpRegistrarContext = createContext<(chatId: string, handler: () => void) => () => void>(() => () => undefined);

/**
 * Registers a catch-up callback for the open conversation when realtime reconnects or chat.updated arrives.
 */
export function useRegisterChatCatchUp(chatId: string, handler: () => void): void {
  const register = useContext(CatchUpRegistrarContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => register(chatId, () => handlerRef.current()), [chatId, register]);
}

/**
 * Reads the inbox conversation catalog from the nearest provider.
 */
export function useInbox(): InboxContextValue {
  const value = useContext(InboxContext);
  if (!value) {
    throw new Error("useInbox must be used within InboxProvider");
  }
  return value;
}

async function fetchConversations(): Promise<InboxConversation[]> {
  const { conversations } = await fetchConversationsWithAccounts();
  return conversations;
}

async function fetchConversationsWithAccounts(): Promise<{
  readonly conversations: InboxConversation[];
  readonly withChats: ReadonlyArray<{ readonly account: TelegramAccountDto; readonly chats: TelegramChatDto[] }>;
}> {
  const telegramAccounts = await api.telegramAccounts();
  const connected = telegramAccounts.filter((account) => account.authorizationState === "AUTHORIZED");
  const withChats = await Promise.all(
    connected.map(async (account) => ({
      account,
      chats: await api.telegramChats(account.id)
    }))
  );
  return {
    conversations: flattenConversations(withChats),
    withChats
  };
}

function flattenConversations(
  accounts: ReadonlyArray<{ readonly account: TelegramAccountDto; readonly chats: TelegramChatDto[] }>
): InboxConversation[] {
  return sortConversations(
    accounts.flatMap(({ account, chats }) => {
      const accountLabel = account.displayName || "Workspace account";
      return chats.map((chat) => toInboxConversation(chat, accountLabel));
    })
  );
}

function parseSelectedChatId(pathname: string): string | null {
  const match = pathname.match(/^\/(?:workspace|staff)\/inbox\/([^/]+)\/?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
