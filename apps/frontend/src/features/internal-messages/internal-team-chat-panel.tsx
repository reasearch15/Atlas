"use client";

import type { InternalMessageDto } from "@atlas/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, apiBaseUrl } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { playTeamMessageBeep } from "@/features/inbox/team-notification-sound";

interface InternalTeamChatPanelProps {
  readonly staffUserId: string;
  readonly staffName: string;
  readonly onClose?: () => void;
  readonly embedded?: boolean;
}

/**
 * Compact Atlas-only Coadmin↔Staff chat. Never sends to Telegram.
 */
export function InternalTeamChatPanel({
  staffUserId,
  staffName,
  onClose,
  embedded = false
}: InternalTeamChatPanelProps) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const [messages, setMessages] = useState<InternalMessageDto[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const rows = await api.internalThreadMessages(staffUserId);
      setMessages(rows);
      setError(null);
      for (const row of rows) {
        if (row.receiverUserId === currentUserId && !row.readAt) {
          void api.markInternalMessageRead(row.id).catch(() => undefined);
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load team messages.");
    } finally {
      setLoading(false);
    }
  }, [currentUserId, staffUserId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!accessToken) return;
    let closed = false;
    const wsBase = apiBaseUrl.replace(/^http/, "ws");
    const socket = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(accessToken)}`);
    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          type?: string;
          staffUserId?: string;
          message?: InternalMessageDto;
        };
        if (payload.type === "internal_message.created" && payload.staffUserId === staffUserId && payload.message) {
          setMessages((current) => {
            if (current.some((row) => row.id === payload.message!.id)) return current;
            return [...current, payload.message!];
          });
          if (payload.message.senderUserId !== currentUserId) {
            playTeamMessageBeep();
            if (typeof Notification !== "undefined" && Notification.permission === "granted") {
              new Notification(`${payload.message.senderName} sent you a team message`, {
                body: payload.message.body.slice(0, 120)
              });
            }
          }
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    socket.onclose = () => {
      if (!closed) {
        // Soft reconnect is handled by remount / next open.
      }
    };
    return () => {
      closed = true;
      socket.close();
    };
  }, [accessToken, currentUserId, staffUserId]);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const message = await api.sendInternalMessage(staffUserId, body);
      setDraft("");
      setMessages((current) => (current.some((row) => row.id === message.id) ? current : [...current, message]));
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Failed to send team message.");
      toast.error("Team message failed. Retry.");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div
      className={`flex flex-col overflow-hidden border bg-[#f7f3ea] ${
        embedded ? "h-[28rem] rounded-lg" : "fixed bottom-4 right-4 z-40 h-[28rem] w-[22rem] rounded-xl shadow-xl"
      }`}
    >
      <header className="flex items-center justify-between border-b bg-[#efe6d6] px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">Internal Team Message</p>
          <p className="truncate text-[11px] text-muted-foreground">with {staffName} · Atlas only</p>
        </div>
        {onClose ? (
          <Button type="button" variant="ghost" className="h-7 px-2 text-xs" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
        {error ? <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{error}</p> : null}
        {!loading && messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">No team messages yet. Say hello.</p>
        ) : null}
        {messages.map((message) => {
          const mine = message.senderUserId === currentUserId;
          return (
            <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm shadow-sm ${
                  mine ? "bg-[#d9ecff] text-foreground" : "bg-white text-foreground"
                }`}
              >
                <p className="text-[10px] font-semibold text-amber-800/80">{message.label}</p>
                {!mine ? <p className="text-[11px] font-medium text-[#0b63ce]">{message.senderName}</p> : null}
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
                <p className="mt-1 text-right text-[10px] text-muted-foreground">
                  {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form className="border-t bg-white p-2" onSubmit={(event) => void send(event)}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="Write an internal team message…"
          className="w-full resize-none rounded-md border bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#0b63ce]/40"
          disabled={sending}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-[10px] text-muted-foreground">Enter send · Shift+Enter newline</p>
          <Button type="submit" disabled={sending || !draft.trim()} className="h-8 px-3 text-xs">
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  );
}
