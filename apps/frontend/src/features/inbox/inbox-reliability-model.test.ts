import { describe, expect, it } from "vitest";
import {
  simulateReconnectRecovery,
  simulateSharedUnreadBroadcast,
  simulateUnreadLifecycle
} from "./inbox-reliability-model";

describe("Issue A — unread root-cause proof timelines", () => {
  it("FAILING CASE: open chat + inbound while viewing leaves DB unread (legacy optimistic-only)", () => {
    const result = simulateUnreadLifecycle({
      mode: "legacy_optimistic_only",
      script: [
        { type: "customer_message" },
        { type: "staff_open" },
        { type: "customer_message_while_open" }
      ]
    });

    // Evidence: UI looks read, DB is not.
    expect(result.final.uiUnread).toBe(0);
    expect(result.final.dbUnread).toBe(1);

    const actions = result.timeline.map((step) => step.action);
    expect(actions).toContain("worker.unread_increment");
    expect(actions).toContain("ui.optimistic_unread_zero");
    expect(actions).toContain("ui.skipped_mark_read");
    expect(actions.filter((action) => action === "api.mark_read")).toHaveLength(1); // only on open, not on second inbound

    // Printable timeline for the engineering report.
    expect(result.timeline.length).toBeGreaterThan(5);
  });

  it("FIXED CASE: open chat + inbound while viewing ends with DB unread=0", () => {
    const result = simulateUnreadLifecycle({
      mode: "durable_mark_read_while_viewing",
      script: [
        { type: "customer_message" },
        { type: "staff_open" },
        { type: "customer_message_while_open" }
      ]
    });

    expect(result.final.uiUnread).toBe(0);
    expect(result.final.dbUnread).toBe(0);

    const markReads = result.timeline.filter((step) => step.action === "api.mark_read");
    // open + viewing-live inbound
    expect(markReads.length).toBeGreaterThanOrEqual(2);
    expect(result.timeline.some((step) => step.action === "ui.skipped_mark_read")).toBe(false);
  });
});

describe("Issue A — race ordering proof", () => {
  it("message → increment → open/mark-read → another message → mark-read → final unread always 0", () => {
    const result = simulateUnreadLifecycle({
      mode: "durable_mark_read_while_viewing",
      script: [
        { type: "customer_message" },
        { type: "staff_open" },
        { type: "customer_message_while_open" },
        { type: "customer_message_while_open" },
        { type: "realtime_chat_updated", unreadCount: 1 }
      ]
    });

    expect(result.final.dbUnread).toBe(0);
    expect(result.final.uiUnread).toBe(0);

    // Ordering markers present in timeline.
    const actions = result.timeline.map((step) => step.action);
    const firstIncrement = actions.indexOf("worker.unread_increment");
    const firstMark = actions.indexOf("api.mark_read");
    expect(firstIncrement).toBeGreaterThanOrEqual(0);
    expect(firstMark).toBeGreaterThan(firstIncrement);

    // Every worker increment that occurs while viewing live is followed by a later mark-read.
    let viewing = false;
    let pendingIncrementsWhileViewing = 0;
    let markReadsAfterViewingIncrements = 0;
    for (const step of result.timeline) {
      if (step.action === "staff.open_conversation") viewing = true;
      if (viewing && step.action === "worker.unread_increment") pendingIncrementsWhileViewing += 1;
      if (viewing && step.action === "api.mark_read" && pendingIncrementsWhileViewing > 0) {
        markReadsAfterViewingIncrements += 1;
        pendingIncrementsWhileViewing -= 1;
      }
    }
    expect(markReadsAfterViewingIncrements).toBeGreaterThan(0);
    expect(pendingIncrementsWhileViewing).toBe(0);
  });

  it("background inbound then foreground re-mark-read clears durable unread", () => {
    const legacy = simulateUnreadLifecycle({
      mode: "legacy_optimistic_only",
      script: [
        { type: "customer_message" },
        { type: "staff_open" },
        { type: "staff_background" },
        { type: "customer_message_while_open" },
        { type: "staff_foreground" }
      ]
    });
    expect(legacy.final.dbUnread).toBe(1);

    const fixed = simulateUnreadLifecycle({
      mode: "durable_mark_read_while_viewing",
      script: [
        { type: "customer_message" },
        { type: "staff_open" },
        { type: "staff_background" },
        { type: "customer_message_while_open" },
        { type: "staff_foreground" }
      ]
    });
    expect(fixed.final.dbUnread).toBe(0);
    expect(fixed.final.uiUnread).toBe(0);
  });
});

describe("Issue B — reconnect reconciliation proof", () => {
  it("FAILING CASE: legacy reconnect skips inbox list reconcile", () => {
    const result = simulateReconnectRecovery({
      forceInboxReconcileOnConnect: false,
      forceOpenChatRefreshOnConnect: false,
      openChatId: "chat-1"
    });
    expect(result.inboxReconciled).toBe(false);
    expect(result.openChatForceRefreshed).toBe(false);
    expect(result.timeline.some((step) => step.action === "inbox.reconcile_skipped")).toBe(true);
  });

  it("FIXED CASE: every reconnect performs inbox reconcile + forced open-chat refresh", () => {
    const result = simulateReconnectRecovery({
      forceInboxReconcileOnConnect: true,
      forceOpenChatRefreshOnConnect: true,
      openChatId: "chat-1"
    });
    expect(result.inboxReconciled).toBe(true);
    expect(result.openChatForceRefreshed).toBe(true);

    const actions = result.timeline.map((step) => step.action);
    expect(actions).toEqual([
      "ws.disconnected",
      "ws.reconnecting",
      "ws.connected",
      "inbox.reconcile_started",
      "inbox.reconcile_completed",
      "chat.force_refresh",
      "ws.reconnected"
    ]);
  });
});

describe("Multi-staff / multi-tab shared unread broadcast", () => {
  it("Staff A open clears unread for every connected client (2 staff + same-account tabs)", () => {
    const result = simulateSharedUnreadBroadcast({
      mode: "durable_mark_read_while_viewing",
      clientCount: 3
    });
    expect(result.finalDbUnread).toBe(0);
    expect(result.finalClientUnreads.every((n) => n === 0)).toBe(true);
    expect(result.timeline.some((step) => step.action === "ws.chat_updated_broadcast")).toBe(true);
  });

  it("legacy mode leaves DB dirty when second inbound arrives while Staff A is viewing", () => {
    const result = simulateSharedUnreadBroadcast({
      mode: "legacy_optimistic_only",
      clientCount: 2
    });
    expect(result.finalDbUnread).toBe(1);
    expect(result.finalClientUnreads[0]).toBe(0);
    expect(result.finalClientUnreads[1]).toBe(1);
  });
});
