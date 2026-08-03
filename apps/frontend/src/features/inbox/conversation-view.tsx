"use client";

import type { TelegramMessageDto } from "@atlas/shared";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BottomSheet } from "@/components/layout/bottom-sheet";
import { Button } from "@/components/ui/button";
import { useAtlasBreakpoint } from "@/hooks/use-atlas-breakpoint";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import type { InboxConversation } from "./inbox-utils";
import { avatarColor, avatarInitials, mergeAndDeduplicate } from "./inbox-utils";
import { identityFromChatAndContact } from "./contact-identity";
import { useInbox, useRegisterChatCatchUp } from "./inbox-provider";
import { rememberChatMessages, refreshChatMessagesIfStale } from "./message-cache";
import { useChatMessages } from "./use-chat-messages";
import { ConversationSkeleton } from "./conversation-skeleton";
import { CrmConversationControls } from "./crm-conversation-controls";
import { CrmPanel, useCrmConversationPanel } from "./crm-panel";
import { MediaMessageBody } from "./media-message-body";
import { MessageComposer } from "./message-composer";
import { MessageHoverActions } from "./message-hover-actions";
import { DeleteMessageDialog, type DeleteMessageScope } from "./delete-message-dialog";
import { OutgoingDeliveryStatus } from "./outgoing-delivery-status";
import { OutgoingAttribution } from "./outgoing-attribution";

interface ConversationViewProps {
  readonly conversation: InboxConversation;
  readonly onBack?: () => void;
}

const NEAR_BOTTOM_PX = 96;

/**
 * Renders a Telegram-style conversation with message history and composer.
 * Mobile: full-screen chat + CRM bottom sheet. Desktop: chat + optional CRM column.
 */
export function ConversationView({ conversation, onBack }: ConversationViewProps) {
  const { chat, kind } = conversation;
  const breakpoint = useAtlasBreakpoint();
  const isMobile = breakpoint === "mobile";
  const isDesktop = breakpoint === "desktop";
  const { applyOutgoingActivity, subscribeMessages, realtimeConnected, currentUserId } = useInbox();
  const role = useAuthStore((state) => state.user?.role);
  const {
    messages,
    loading,
    error: queryError,
    setMessages
  } = useChatMessages(chat.id);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<TelegramMessageDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TelegramMessageDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const crm = useCrmConversationPanel(chat.id);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const chatIdRef = useRef(chat.id);
  const pendingMessageIdRef = useRef<string | null>(null);
  chatIdRef.current = chat.id;

  useEffect(() => {
    // Desktop defaults to CRM open; mobile/tablet keep it closed until requested.
    setPanelOpen(isDesktop);
  }, [isDesktop, chat.id]);

  const isNearBottom = useCallback((): boolean => {
    const list = listRef.current;
    if (!list) return true;
    return list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior });
    stickToBottomRef.current = true;
    setNewMessageCount(0);
  }, []);

  const applyIncomingMessage = useCallback(
    (incoming: TelegramMessageDto) => {
      if (incoming.chatId !== chatIdRef.current) return;
      if (incoming.isDeleted) {
        setMessages((current) => {
          const next = current.filter(
            (row) => row.id !== incoming.id && row.telegramMessageId !== incoming.telegramMessageId
          );
          rememberChatMessages(chatIdRef.current, next);
          return next;
        });
        if (replyTo?.id === incoming.id) {
          setReplyTo(null);
        }
        return;
      }
      const nearBottom = isNearBottom();
      stickToBottomRef.current = nearBottom;
      setMessages((current) => {
        const next = mergeAndDeduplicate(current, incoming);
        rememberChatMessages(chatIdRef.current, next);
        return next;
      });
      if (pendingMessageIdRef.current && incoming.id === pendingMessageIdRef.current) {
        if (
          incoming.sendStatus === "DELIVERED" ||
          incoming.sendStatus === "READ" ||
          incoming.sendStatus === "FAILED_RETRYABLE" ||
          incoming.sendStatus === "FAILED_PERMANENT" ||
          incoming.sendStatus === "SENT"
        ) {
          pendingMessageIdRef.current = null;
        }
      }
      if (nearBottom) {
        requestAnimationFrame(() => scrollToBottom("smooth"));
      } else if (incoming.direction === "INBOUND") {
        setNewMessageCount((count) => count + 1);
      }
    },
    [isNearBottom, replyTo?.id, scrollToBottom, setMessages]
  );

  const applyIncomingRef = useRef(applyIncomingMessage);
  applyIncomingRef.current = applyIncomingMessage;

  // Soft catch-up for reconnect / media hydration — only if cache is stale.
  useRegisterChatCatchUp(chat.id, () => {
    refreshChatMessagesIfStale(chat.id);
  });

  useEffect(() => {
    setReplyTo(null);
    setNewMessageCount(0);
    setError(null);
    stickToBottomRef.current = true;
    pendingMessageIdRef.current = null;
  }, [chat.id]);

  useEffect(() => {
    setError(queryError);
  }, [queryError]);

  useEffect(() => {
    let replayingBuffer = true;
    const unsubscribe = subscribeMessages(chat.id, (message) => {
      if (replayingBuffer) {
        setMessages((current) => {
          const next = mergeAndDeduplicate(current, message);
          rememberChatMessages(chat.id, next);
          return next;
        });
        return;
      }
      applyIncomingRef.current(message);
    });
    replayingBuffer = false;
    return unsubscribe;
  }, [chat.id, setMessages, subscribeMessages]);

  // No GET polling while live — WebSocket delivers message updates.
  // One stale-aware refresh only after reconnect gaps.
  useEffect(() => {
    if (realtimeConnected) return;
    const timer = setTimeout(() => {
      refreshChatMessagesIfStale(chat.id);
    }, 12_000);
    return () => clearTimeout(timer);
  }, [chat.id, realtimeConnected]);

  useLayoutEffect(() => {
    if (loading) return;
    if (stickToBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [loading, chat.id, scrollToBottom]);

  function watchPendingMessage(messageId: string): void {
    pendingMessageIdRef.current = messageId;
  }

  async function handleSend(text: string): Promise<void> {
    const idempotencyKey = `send:${chat.id}:${crypto.randomUUID()}`;
    const optimisticAt = new Date().toISOString();
    const replyId = replyTo?.telegramMessageId;
    applyOutgoingActivity(chat.id, text, optimisticAt);
    stickToBottomRef.current = true;
    setNewMessageCount(0);
    setSending(true);
    setError(null);
    try {
      const pending = await api.sendChatText(chat.id, text, idempotencyKey, replyId);
      setReplyTo(null);
      applyOutgoingActivity(chat.id, pending.text, pending.sentAt);
      setMessages((current) => {
        const next = mergeAndDeduplicate(current, pending);
        rememberChatMessages(chat.id, next);
        return next;
      });
      requestAnimationFrame(() => scrollToBottom("smooth"));
      watchPendingMessage(pending.id);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  async function handleRetry(message: TelegramMessageDto): Promise<void> {
    if (message.sendStatus !== "FAILED_RETRYABLE" && message.sendStatus !== "FAILED_PERMANENT") {
      return;
    }
    try {
      const retried = await api.retryFailedMessage(message.id);
      setMessages((current) => mergeAndDeduplicate(current, retried));
      toast.message("Retry queued");
    } catch (retryError) {
      const text = retryError instanceof Error ? retryError.message : "Retry failed.";
      toast.error(text);
      setError(text);
    }
  }

  async function handleDeleteConfirm(scope: DeleteMessageScope): Promise<void> {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      const idempotencyKey = `delete:${target.id}:${scope}:${crypto.randomUUID()}`;
      const result = await api.deleteMessage(target.id, scope, idempotencyKey);
      if (result.status === "DELETED") {
        setMessages((current) => {
          const next = current.filter((row) => row.id !== target.id);
          rememberChatMessages(chat.id, next);
          return next;
        });
        toast.success(scope === "ATLAS_ONLY" ? "Removed from Atlas" : "Message deleted");
      } else {
        toast.message("Delete queued — waiting for Telegram…");
      }
      setDeleteTarget(null);
    } catch (deleteError) {
      const text = deleteError instanceof Error ? deleteError.message : "Delete failed.";
      toast.error(text);
      setError(text);
    } finally {
      setDeleting(false);
    }
  }

  function copyMessage(message: TelegramMessageDto): void {
    const body = message.text || message.caption || "";
    if (!body) {
      toast.message("Nothing to copy");
      return;
    }
    void navigator.clipboard.writeText(body).then(
      () => toast.success("Copied"),
      () => toast.error("Unable to copy")
    );
  }

  const timeline = useMemo(() => buildTimeline(messages), [messages]);
  const identity = useMemo(
    () => identityFromChatAndContact(chat, crm.panel?.contact ?? null),
    [chat, crm.panel?.contact]
  );
  const color = avatarColor(chat.id || identity.displayName);

  if (loading && messages.length === 0) {
    return <ConversationSkeleton />;
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 overflow-hidden">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[hsl(210_25%_96%)]">
        <header
          className="z-10 flex min-h-14 shrink-0 items-center gap-2 border-b bg-white px-2 py-2 shadow-sm sm:gap-3 sm:px-4 sm:py-2.5"
          style={isMobile ? { paddingTop: "max(0.5rem, env(safe-area-inset-top))" } : undefined}
        >
          {onBack ? (
            <Button type="button" variant="ghost" className="size-11 shrink-0 px-0 lg:hidden" onClick={onBack} aria-label="Back to conversations">
              <ChevronLeft className="size-6" aria-hidden="true" />
            </Button>
          ) : null}
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white shadow-sm"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          >
            {avatarInitials(identity.displayName)}
          </span>
          <button
            type="button"
            className="min-w-0 flex-1 text-left lg:pointer-events-none"
            onClick={() => {
              if (!isDesktop) setPanelOpen(true);
            }}
            aria-label={isDesktop ? undefined : "Open conversation details"}
          >
            <h2 className="truncate text-[15px] font-semibold leading-tight text-foreground">{identity.displayName}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {identity.presenceLabel ?? identity.subtitle ?? kindLabel(kind)}
            </p>
          </button>

          <div className="hidden min-w-0 sm:block">
            <CrmConversationControls
              panel={crm.panel}
              loading={crm.loading}
              busy={crm.busy}
              tagCatalog={crm.tagCatalog}
              assignees={crm.assignees}
              currentUserId={currentUserId}
              role={role}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((open) => !open)}
              onClaim={() => void crm.claim()}
              onRelease={() => void crm.release()}
              onAssign={(userId) => void crm.assign(userId)}
              onSetStatus={(status) => void crm.setStatus(status)}
              onAddTag={(tagId) => void crm.addTag(tagId)}
              onRemoveTag={(tagId) => void crm.removeTag(tagId)}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            className="size-11 px-0 sm:hidden"
            onClick={() => setPanelOpen(true)}
            aria-label="Conversation details"
          >
            <span className="text-lg leading-none" aria-hidden="true">
              ···
            </span>
          </Button>
        </header>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={listRef}
            className="h-full overflow-x-hidden overflow-y-auto overscroll-contain px-3 py-3 sm:px-5"
            onScroll={() => {
              const nearBottom = isNearBottom();
              stickToBottomRef.current = nearBottom;
              if (nearBottom && newMessageCount > 0) {
                setNewMessageCount(0);
              }
            }}
          >
            {error ? (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-center text-sm text-red-700" role="alert">
                {error}
              </div>
            ) : null}
            {!loading && messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm font-medium text-foreground">No messages yet</p>
                <p className="max-w-xs text-sm text-muted-foreground">Send a message to start the conversation.</p>
              </div>
            ) : null}

            {timeline.map((item) => {
              if (item.type === "date") {
                return (
                  <div key={item.id} className="my-3 flex justify-center">
                    <span className="rounded-full bg-white/90 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                      {item.label}
                    </span>
                  </div>
                );
              }
              const message = item.message;
              if (message.isDeleted) return null;
              const outgoing = message.direction === "OUTBOUND";
              const canDelete = role === "COADMIN" || role === "PLATFORM_ADMIN";
              return (
                <article
                  key={message.id}
                  className={`group relative mb-1.5 flex ${outgoing ? "justify-end" : "justify-start"}`}
                >
                  <div className={`relative max-w-[85%] sm:max-w-[65%] ${outgoing ? "ml-auto" : "mr-auto"}`}>
                    <MessageHoverActions
                      outgoing={outgoing}
                      canDelete={canDelete}
                      onReply={() => setReplyTo(message)}
                      onCopy={() => copyMessage(message)}
                      onForward={() => {
                        toast.message("Forward stays in the CRM roadmap — copy or reply for now.");
                      }}
                      {...(canDelete
                        ? {
                            onDelete: () => {
                              setDeleteTarget(message);
                            }
                          }
                        : {})}
                    />
                    <div
                      className={`rounded-2xl px-3 py-2 text-sm shadow-[0_1px_1px_rgba(0,0,0,0.06)] ${
                        outgoing
                          ? "rounded-br-md bg-[#dcf8c6] text-foreground"
                          : "rounded-bl-md bg-white text-foreground"
                      }`}
                    >
                      {!outgoing && message.senderDisplayName ? (
                        <p className="mb-0.5 text-xs font-semibold text-[#229ED9]">{message.senderDisplayName}</p>
                      ) : null}
                      <MediaMessageBody message={message} />
                      <p className="mt-1 flex items-center justify-end gap-1 text-[10px] leading-none text-muted-foreground">
                        {outgoing ? <OutgoingAttribution message={message} viewerUserId={currentUserId} /> : null}
                        {message.isEdited ? <span className="mr-0.5">edited</span> : null}
                        <span>{formatMessageTime(message.sentAt)}</span>
                        {outgoing ? (
                          <OutgoingDeliveryStatus
                            sendStatus={message.sendStatus}
                            onRetry={() => void handleRetry(message)}
                          />
                        ) : null}
                      </p>
                    </div>
                  </div>
                </article>
              );
            })}
            <div ref={bottomRef} />
          </div>

          {newMessageCount > 0 ? (
            <button
              type="button"
              onClick={() => scrollToBottom("smooth")}
              className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-[#229ED9] px-3 py-1.5 text-xs font-medium text-white shadow-md transition-transform hover:scale-[1.02]"
            >
              New messages{newMessageCount > 1 ? ` (${newMessageCount})` : ""}
            </button>
          ) : null}
        </div>

        <div style={{ paddingBottom: isMobile ? "env(safe-area-inset-bottom)" : undefined }}>
          <MessageComposer
            chatId={chat.id}
            disabled={loading}
            sending={sending}
            replyTo={
              replyTo
                ? {
                    telegramMessageId: replyTo.telegramMessageId,
                    preview: replyTo.text || replyTo.caption || "Message"
                  }
                : null
            }
            onClearReply={() => setReplyTo(null)}
            onSend={handleSend}
            onMediaActivity={(previewText, sentAt) => applyOutgoingActivity(chat.id, previewText, sentAt)}
            onMediaSent={(pending) => {
              stickToBottomRef.current = true;
              setNewMessageCount(0);
              setMessages((current) => {
                const next = mergeAndDeduplicate(current, pending);
                rememberChatMessages(chat.id, next);
                return next;
              });
              requestAnimationFrame(() => scrollToBottom("smooth"));
              watchPendingMessage(pending.id);
            }}
          />
        </div>
      </div>

      {isDesktop && panelOpen ? (
        <CrmPanel state={crm} identity={identity} avatarColor={color} onClose={() => setPanelOpen(false)} />
      ) : null}

      {!isDesktop ? (
        <BottomSheet open={panelOpen} title="Conversation details" onClose={() => setPanelOpen(false)}>
          <div className="mb-4 space-y-3">
            <CrmConversationControls
              panel={crm.panel}
              loading={crm.loading}
              busy={crm.busy}
              tagCatalog={crm.tagCatalog}
              assignees={crm.assignees}
              currentUserId={currentUserId}
              role={role}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen(false)}
              onClaim={() => void crm.claim()}
              onRelease={() => void crm.release()}
              onAssign={(userId) => void crm.assign(userId)}
              onSetStatus={(status) => void crm.setStatus(status)}
              onAddTag={(tagId) => void crm.addTag(tagId)}
              onRemoveTag={(tagId) => void crm.removeTag(tagId)}
            />
          </div>
          <CrmPanel state={crm} identity={identity} avatarColor={color} onClose={() => setPanelOpen(false)} embedded />
        </BottomSheet>
      ) : null}

      <DeleteMessageDialog
        open={deleteTarget !== null}
        loading={deleting}
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={(scope) => void handleDeleteConfirm(scope)}
      />
    </div>
  );
}

/**
 * Empty conversation pane when no chat is selected.
 */
export function ConversationEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[hsl(210_25%_96%)] px-6 text-center">
      <div className="flex size-20 items-center justify-center rounded-full bg-[#229ED9]/15 text-[#229ED9]">
        <TelegramGlyph className="size-10" />
      </div>
      <div>
        <p className="text-lg font-semibold text-foreground">Select a conversation</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">Choose a chat from the inbox to view messages.</p>
      </div>
    </div>
  );
}

type TimelineItem =
  | { readonly type: "date"; readonly id: string; readonly label: string }
  | { readonly type: "message"; readonly message: TelegramMessageDto };

function buildTimeline(messages: readonly TelegramMessageDto[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDateKey = "";
  for (const message of messages) {
    const dateKey = new Date(message.sentAt).toDateString();
    if (dateKey !== lastDateKey) {
      items.push({ type: "date", id: `date-${dateKey}`, label: formatDateSeparator(message.sentAt) });
      lastDateKey = dateKey;
    }
    items.push({ type: "message", message });
  }
  return items;
}

function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateSeparator(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric"
  });
}

function kindLabel(kind: InboxConversation["kind"]): string {
  switch (kind) {
    case "bot":
      return "Bot";
    case "group":
      return "Group";
    case "channel":
      return "Channel";
    default:
      return "Private chat";
  }
}

function TelegramGlyph({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M21.5 3.1 2.9 10.3c-1.3.5-1.3 1.2-.2 1.5l4.7 1.5 1.8 5.5c.2.7.4.9 1 .9.6 0 .9-.3 1.2-.6l2.8-2.7 5.8 4.3c.1.1 1.8.3 2.1-1L23.4 4.7c.3-1.3-.5-1.9-1.9-1.6Zm-3 3.4-10.4 9.3-.4 4.2-2-5.5L19.4 6l-.9.5Z" />
    </svg>
  );
}
