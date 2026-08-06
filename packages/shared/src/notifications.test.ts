import { describe, expect, it } from "vitest";
import {
  buildNotificationDeepLinkPath,
  buildNotificationIdempotencyKey,
  buildUniqueNotificationTag,
  nextNotificationRetryDelayMs,
  notificationPriorityForType,
  truncateNotificationPreview
} from "./notifications";

describe("truncateNotificationPreview", () => {
  it("keeps short text intact", () => {
    expect(truncateNotificationPreview("Hello there")).toBe("Hello there");
  });

  it("avoids mid-word truncation when possible", () => {
    const input = "Need help with my order please call me back as soon as you can today thanks";
    const out = truncateNotificationPreview(input, 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out.includes(" ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
  });
});

describe("buildNotificationDeepLinkPath", () => {
  it("opens staff inbox conversation with highlight", () => {
    expect(
      buildNotificationDeepLinkPath({
        workspaceId: "ws",
        chatId: "chat-1",
        messageId: "msg-1",
        rolePath: "staff"
      })
    ).toBe("/staff/inbox/chat-1?from=push&messageId=msg-1&highlight=1");
  });

  it("opens workspace inbox conversation", () => {
    expect(
      buildNotificationDeepLinkPath({
        workspaceId: "ws",
        chatId: "chat-2",
        rolePath: "workspace"
      })
    ).toBe("/workspace/inbox/chat-2?from=push&highlight=1");
  });
});

describe("notificationPriorityForType", () => {
  it("marks customer messages as HIGH", () => {
    expect(notificationPriorityForType("INCOMING_MESSAGE")).toBe("HIGH");
    expect(notificationPriorityForType("NEW_CONVERSATION")).toBe("HIGH");
  });

  it("marks assignments as DEFAULT", () => {
    expect(notificationPriorityForType("CONVERSATION_ASSIGNED")).toBe("DEFAULT");
  });

  it("marks SLA as LOW", () => {
    expect(notificationPriorityForType("SLA_WARNING")).toBe("LOW");
  });
});

describe("retry + uniqueness helpers", () => {
  it("uses exponential backoff schedule", () => {
    expect(nextNotificationRetryDelayMs(1)).toBe(30_000);
    expect(nextNotificationRetryDelayMs(2)).toBe(120_000);
    expect(nextNotificationRetryDelayMs(3)).toBe(300_000);
    expect(nextNotificationRetryDelayMs(6)).toBe(3_600_000);
    expect(nextNotificationRetryDelayMs(20)).toBe(3_600_000);
  });

  it("builds stable unique tags and idempotency keys", () => {
    expect(buildUniqueNotificationTag("abc")).toBe("atlas-n-abc");
    expect(
      buildNotificationIdempotencyKey({
        type: "INCOMING_MESSAGE",
        eventKey: "evt-1",
        userId: "u1",
        deviceTokenId: "d1"
      })
    ).toBe("INCOMING_MESSAGE:evt-1:u1:d1");
  });
});
