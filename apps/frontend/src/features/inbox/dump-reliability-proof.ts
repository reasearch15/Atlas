/**
 * Prints failing vs fixed unread timelines + reconnect proof to stdout.
 * Run: pnpm --filter @atlas/frontend exec vitest run src/features/inbox/inbox-reliability-model.test.ts
 * Or:  npx tsx apps/frontend/src/features/inbox/dump-reliability-proof.ts
 */
import {
  simulateReconnectRecovery,
  simulateSharedUnreadBroadcast,
  simulateUnreadLifecycle,
  type UnreadTimelineStep
} from "./inbox-reliability-model";

function printTimeline(title: string, timeline: readonly UnreadTimelineStep[]): void {
  console.log(`\n=== ${title} ===`);
  for (const step of timeline) {
    console.log(
      `${step.at}  ${step.action.padEnd(32)}  db=${step.dbUnread} ui=${step.uiUnread}  ${step.note}`
    );
  }
  const last = timeline[timeline.length - 1];
  if (last) {
    console.log(`FINAL  dbUnread=${last.dbUnread}  uiUnread=${last.uiUnread}`);
  }
}

const failing = simulateUnreadLifecycle({
  mode: "legacy_optimistic_only",
  script: [{ type: "customer_message" }, { type: "staff_open" }, { type: "customer_message_while_open" }]
});
printTimeline("1a FAILING — optimistic zero without mark-read", failing.timeline);

const fixed = simulateUnreadLifecycle({
  mode: "durable_mark_read_while_viewing",
  script: [{ type: "customer_message" }, { type: "staff_open" }, { type: "customer_message_while_open" }]
});
printTimeline("1b FIXED — durable mark-read while viewing", fixed.timeline);

const race = simulateUnreadLifecycle({
  mode: "durable_mark_read_while_viewing",
  script: [
    { type: "customer_message" },
    { type: "staff_open" },
    { type: "customer_message_while_open" },
    { type: "customer_message_while_open" },
    { type: "realtime_chat_updated", unreadCount: 1 }
  ]
});
printTimeline("2 RACE ORDERING — final unread must be 0", race.timeline);

const reconnectLegacy = simulateReconnectRecovery({
  forceInboxReconcileOnConnect: false,
  forceOpenChatRefreshOnConnect: false,
  openChatId: "chat-1"
});
printTimeline("3a FAILING reconnect — no inbox reconcile", reconnectLegacy.timeline);

const reconnectFixed = simulateReconnectRecovery({
  forceInboxReconcileOnConnect: true,
  forceOpenChatRefreshOnConnect: true,
  openChatId: "chat-1"
});
printTimeline("3b FIXED reconnect — reconcile on every connect", reconnectFixed.timeline);

const multi = simulateSharedUnreadBroadcast({
  mode: "durable_mark_read_while_viewing",
  clientCount: 3
});
printTimeline("4/5 MULTI-STAFF+TAB — shared clear + re-unread", multi.timeline);
console.log(`finalDb=${multi.finalDbUnread} clients=${JSON.stringify(multi.finalClientUnreads)}`);
