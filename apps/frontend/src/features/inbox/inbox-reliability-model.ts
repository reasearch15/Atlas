/**
 * Pure state-machine model for proving unread race outcomes.
 * Simulates DB unread + UI unread without React/network.
 */

export type UnreadModelMode = "legacy_optimistic_only" | "durable_mark_read_while_viewing";

export interface UnreadModelState {
  readonly dbUnread: number;
  readonly uiUnread: number;
  readonly viewingChatId: string | null;
  readonly windowVisible: boolean;
}

export interface UnreadTimelineStep {
  readonly at: string;
  readonly action: string;
  readonly dbUnread: number;
  readonly uiUnread: number;
  readonly note: string;
}

export interface UnreadModelResult {
  readonly final: UnreadModelState;
  readonly timeline: readonly UnreadTimelineStep[];
}

function nowIso(offsetMs: number): string {
  return new Date(Date.UTC(2026, 7, 4, 12, 0, 0, offsetMs)).toISOString();
}

/**
 * Runs a scripted unread lifecycle and records the full timeline.
 */
export function simulateUnreadLifecycle(options: {
  readonly mode: UnreadModelMode;
  readonly chatId?: string;
  readonly script: ReadonlyArray<
    | { readonly type: "customer_message" }
    | { readonly type: "staff_open" }
    | { readonly type: "staff_background" }
    | { readonly type: "staff_foreground" }
    | { readonly type: "customer_message_while_open" }
    | { readonly type: "mark_read_api" }
    | { readonly type: "realtime_chat_updated"; readonly unreadCount: number }
  >;
}): UnreadModelResult {
  const chatId = options.chatId ?? "chat-1";
  let state: UnreadModelState = {
    dbUnread: 0,
    uiUnread: 0,
    viewingChatId: null,
    windowVisible: true
  };
  const timeline: UnreadTimelineStep[] = [];
  let t = 0;

  const push = (action: string, note: string): void => {
    timeline.push({
      at: nowIso(t),
      action,
      dbUnread: state.dbUnread,
      uiUnread: state.uiUnread,
      note
    });
    t += 1_000;
  };

  const viewingLive = (): boolean => state.viewingChatId === chatId && state.windowVisible;

  const applyWorkerIncrement = (note: string): void => {
    state = { ...state, dbUnread: state.dbUnread + 1 };
    push("worker.unread_increment", note);
  };

  const applyMarkReadApi = (note: string): void => {
    state = { ...state, dbUnread: 0, uiUnread: 0 };
    push("api.mark_read", note);
  };

  for (const step of options.script) {
    switch (step.type) {
      case "customer_message": {
        applyWorkerIncrement("Inbound persisted; durable unread incremented");
        state = { ...state, uiUnread: state.uiUnread + 1 };
        push("ws.message_created_applied", "Browser applied inbound to inbox UI");
        break;
      }
      case "staff_open": {
        state = { ...state, viewingChatId: chatId, windowVisible: true };
        push("staff.open_conversation", "Route activeChatId set");
        // Opening always requests mark-read (both modes).
        applyMarkReadApi("clearUnread on activeChatId change");
        break;
      }
      case "staff_background": {
        state = { ...state, windowVisible: false };
        push("browser.visibility_hidden", "Tab backgrounded");
        break;
      }
      case "staff_foreground": {
        state = { ...state, windowVisible: true };
        push("browser.visibility_visible", "Tab foregrounded");
        if (options.mode === "durable_mark_read_while_viewing" && state.viewingChatId === chatId) {
          applyMarkReadApi("visibility resume re-issues mark-read");
        } else {
          push("browser.no_mark_read_on_resume", "Legacy mode: no mark-read on resume");
        }
        break;
      }
      case "customer_message_while_open": {
        applyWorkerIncrement("Another inbound while staff is on the conversation");
        if (viewingLive()) {
          // UI always shows zero while viewing live.
          state = { ...state, uiUnread: 0 };
          push("ui.optimistic_unread_zero", "React state forced unreadCount=0 for open+visible chat");
          if (options.mode === "durable_mark_read_while_viewing") {
            applyMarkReadApi("Fixed path: clearUnread after viewing-live inbound");
          } else {
            push("ui.skipped_mark_read", "Legacy bug: optimistic zero without mark-read API");
          }
        } else {
          state = { ...state, uiUnread: state.uiUnread + 1 };
          push("ws.message_created_applied", "Chat open but hidden — UI unread bumped");
        }
        break;
      }
      case "mark_read_api": {
        applyMarkReadApi("Explicit mark-read");
        break;
      }
      case "realtime_chat_updated": {
        if (viewingLive() && options.mode === "durable_mark_read_while_viewing" && step.unreadCount > 0) {
          state = { ...state, uiUnread: 0 };
          push("ws.chat_updated_viewing", `Server reported unread=${step.unreadCount}; re-mark-read`);
          applyMarkReadApi("chat.updated while viewing with unread>0");
        } else if (viewingLive()) {
          state = { ...state, uiUnread: 0 };
          push("ws.chat_updated_viewing_mask", `UI masked unread to 0 (server unread=${step.unreadCount})`);
        } else {
          state = { ...state, uiUnread: step.unreadCount, dbUnread: step.unreadCount };
          push("ws.chat_updated_applied", `Applied server unread=${step.unreadCount}`);
        }
        break;
      }
      default:
        break;
    }
  }

  return { final: state, timeline };
}

/**
 * Simulates WS reconnect recovery and whether inbox list reconcile runs.
 */
export function simulateReconnectRecovery(options: {
  readonly forceInboxReconcileOnConnect: boolean;
  readonly forceOpenChatRefreshOnConnect: boolean;
  readonly openChatId: string | null;
}): {
  readonly timeline: readonly UnreadTimelineStep[];
  readonly inboxReconciled: boolean;
  readonly openChatForceRefreshed: boolean;
} {
  const timeline: UnreadTimelineStep[] = [];
  let t = 0;
  const push = (action: string, note: string): void => {
    timeline.push({ at: nowIso(t), action, dbUnread: 0, uiUnread: 0, note });
    t += 500;
  };

  push("ws.disconnected", "Socket closed");
  push("ws.reconnecting", "Client scheduling reconnect");
  push("ws.connected", "Socket open");

  let inboxReconciled = false;
  let openChatForceRefreshed = false;

  if (options.forceInboxReconcileOnConnect) {
    push("inbox.reconcile_started", "REST inbox reload after connect");
    push("inbox.reconcile_completed", "Conversation list replaced from server");
    inboxReconciled = true;
  } else {
    push("inbox.reconcile_skipped", "Legacy: reconnect did not reload inbox list");
  }

  if (options.openChatId) {
    if (options.forceOpenChatRefreshOnConnect) {
      push("chat.force_refresh", `Forced history invalidate for ${options.openChatId}`);
      openChatForceRefreshed = true;
    } else {
      push("chat.stale_refresh_only", "Legacy: soft stale gate may skip refresh");
    }
  }

  push("ws.reconnected", "Realtime channel ready");
  return { timeline, inboxReconciled, openChatForceRefreshed };
}

/**
 * Multi-staff / multi-tab: durable unread is shared; mark-read zeros DB and fans out via chat.updated.
 */
export function simulateSharedUnreadBroadcast(options: {
  readonly mode: UnreadModelMode;
  readonly clientCount: number;
}): {
  readonly timeline: readonly UnreadTimelineStep[];
  readonly finalDbUnread: number;
  readonly finalClientUnreads: readonly number[];
} {
  const timeline: UnreadTimelineStep[] = [];
  let t = 0;
  let dbUnread = 0;
  const clientUnreads = Array.from({ length: options.clientCount }, () => 0);

  const push = (action: string, note: string, uiUnread = clientUnreads[0] ?? 0): void => {
    timeline.push({ at: nowIso(t), action, dbUnread, uiUnread, note });
    t += 1_000;
  };

  // Customer message → worker increment → all clients see unread.
  dbUnread += 1;
  push("worker.unread_increment", "Inbound persisted");
  for (let i = 0; i < clientUnreads.length; i += 1) clientUnreads[i] = dbUnread;
  push("ws.message_created_broadcast", `All ${options.clientCount} clients applied unread=${dbUnread}`);

  // Staff A opens → mark-read → DB 0 → chat.updated fans out.
  push("staff_a.open_conversation", "Client 0 opens conversation");
  dbUnread = 0;
  clientUnreads[0] = 0;
  push("api.mark_read", "Staff A clearUnread persisted unread=0");
  for (let i = 0; i < clientUnreads.length; i += 1) clientUnreads[i] = 0;
  push("ws.chat_updated_broadcast", "unread=0 published to every connected client");

  // Another customer message → unread returns everywhere.
  dbUnread += 1;
  push("worker.unread_increment", "Second inbound");
  for (let i = 0; i < clientUnreads.length; i += 1) {
    // Client 0 is still viewing live — fixed mode remakes-read; legacy leaves DB dirty.
    if (i === 0 && options.mode === "durable_mark_read_while_viewing") {
      clientUnreads[i] = 0;
    } else if (i === 0 && options.mode === "legacy_optimistic_only") {
      clientUnreads[i] = 0; // optimistic UI only
    } else {
      clientUnreads[i] = dbUnread;
    }
  }
  push("ws.message_created_broadcast", "Second inbound applied to all clients");

  if (options.mode === "durable_mark_read_while_viewing") {
    dbUnread = 0;
    for (let i = 0; i < clientUnreads.length; i += 1) clientUnreads[i] = 0;
    push("api.mark_read", "Staff A viewing-live clearUnread");
    push("ws.chat_updated_broadcast", "unread=0 again for every client");
  }

  return {
    timeline,
    finalDbUnread: dbUnread,
    finalClientUnreads: clientUnreads.slice()
  };
}
