/**
 * Structured inbox reliability diagnostics.
 * Never logs tokens, passwords, message bodies, or PII beyond opaque chat IDs.
 */

export type InboxReliabilityEvent =
  | "ws.connected"
  | "ws.disconnected"
  | "ws.reconnecting"
  | "ws.reconnected"
  | "ws.event_received"
  | "ws.event_dropped"
  | "inbox.reconcile_started"
  | "inbox.reconcile_completed"
  | "inbox.react_state_updated"
  | "inbox.mark_read_requested"
  | "inbox.mark_read_succeeded"
  | "inbox.mark_read_failed"
  | "inbox.viewing_inbound_cleared"
  | "proof.timeline_step";

export interface InboxReliabilityLogEntry {
  readonly at: string;
  readonly event: InboxReliabilityEvent;
  readonly chatId?: string;
  readonly eventId?: string;
  readonly eventType?: string;
  readonly unreadCount?: number;
  readonly reason?: string;
  readonly attempt?: number;
  readonly ok?: boolean;
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
}

const RING_LIMIT = 200;
const ring: InboxReliabilityLogEntry[] = [];
const listeners = new Set<(entry: InboxReliabilityLogEntry) => void>();

/**
 * Appends a reliability diagnostic event to the in-memory ring and console.
 */
export function logInboxReliability(
  event: InboxReliabilityEvent,
  details: Omit<InboxReliabilityLogEntry, "at" | "event"> = {}
): InboxReliabilityLogEntry {
  const entry: InboxReliabilityLogEntry = {
    at: new Date().toISOString(),
    event,
    ...details
  };
  ring.push(entry);
  if (ring.length > RING_LIMIT) {
    ring.splice(0, ring.length - RING_LIMIT);
  }
  // Operator-visible breadcrumb (no secrets).
  console.info(JSON.stringify({ channel: "atlas.inbox.reliability", ...entry }));
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Ignore listener failures.
    }
  }
  return entry;
}

/** Test/operator helper: recent diagnostic entries (newest last). */
export function getInboxReliabilityLog(): readonly InboxReliabilityLogEntry[] {
  return ring.slice();
}

/** Test helper: clears the ring buffer. */
export function resetInboxReliabilityLogForTests(): void {
  ring.length = 0;
}

/** Test helper: subscribe to live diagnostic entries. */
export function subscribeInboxReliabilityLog(listener: (entry: InboxReliabilityLogEntry) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
