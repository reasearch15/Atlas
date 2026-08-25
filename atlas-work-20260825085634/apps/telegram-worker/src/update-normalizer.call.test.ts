import { describe, expect, it } from "vitest";
import { buildIncomingCallDedupeKey } from "@atlas/shared";
import { callIncomingEvent } from "./update-normalizer";

describe("callIncomingEvent", () => {
  it("uses stable eventId from account+call for dedupe", () => {
    const event = callIncomingEvent({
      workspaceId: "ws-1",
      telegramAccountId: "acc-1",
      callId: "call-9",
      callerTelegramUserId: "42",
      callerName: "John Smith",
      callerUsername: "john",
      video: false,
      timestamp: "2026-08-08T00:00:00.000Z",
      chatId: "chat-1"
    });
    expect(event.type).toBe("telegram.call.incoming");
    expect(event.eventId).toBe(buildIncomingCallDedupeKey("acc-1", "call-9"));
    expect(event.eventId).toBe("call:acc-1:call-9");
    expect(event.workspaceId).toBe("ws-1");
    expect(event.callerUsername).toBe("john");
  });
});
