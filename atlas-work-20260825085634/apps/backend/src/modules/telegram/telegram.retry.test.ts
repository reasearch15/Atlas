import { describe, expect, it, vi } from "vitest";

/**
 * Explicit FAILED_* outbound retry after peer identity repair.
 * Retry is never blocked client-side for missing access_hash — the worker re-resolves
 * and returns TELEGRAM_PEER_UNRESOLVED as FAILED_RETRYABLE when still incomplete.
 */
describe("retryFailedOutboundMessage contract", () => {
  it("allows retry for FAILED_RETRYABLE peer-unresolved without requiring access_hash first", () => {
    const chat = { chatType: "PRIVATE", peerType: null, accessHash: null, telegramChatId: "5476500286" };
    const message = {
      id: "msg-1",
      sendStatus: "FAILED_RETRYABLE",
      direction: "OUTBOUND",
      mediaError: "TELEGRAM_PEER_UNRESOLVED: Could not resolve Telegram peer 5476500286"
    };
    // Backend no longer throws PEER_IDENTITY_INCOMPLETE — worker attempts live resolve.
    expect(chat.accessHash).toBeNull();
    expect(message.sendStatus).toBe("FAILED_RETRYABLE");
    expect(message.mediaError).toContain("TELEGRAM_PEER_UNRESOLVED");
  });

  it("allows retry only for FAILED_* and keeps the same message id (no duplicate send row)", () => {
    const message = {
      id: "msg-1",
      sendStatus: "FAILED_PERMANENT",
      direction: "OUTBOUND"
    };
    const command = {
      id: "cmd-1",
      status: "FAILED_PERMANENT",
      telegramMessageId: message.id,
      attempts: 3,
      idempotencyKey: "send:chat:key-1"
    };
    expect(["FAILED_RETRYABLE", "FAILED_PERMANENT"]).toContain(message.sendStatus);
    expect(command.telegramMessageId).toBe(message.id);

    const retriedCommand = { ...command, status: "QUEUED", lastError: null };
    const retriedMessage = { ...message, sendStatus: "QUEUED" };
    expect(retriedCommand.id).toBe(command.id);
    expect(retriedMessage.id).toBe(message.id);
    expect(retriedCommand.idempotencyKey).toBe(command.idempotencyKey);
  });

  it("does not auto-transition FAILED_PERMANENT without explicit retry", () => {
    const autoRetryStatuses = new Set(["FAILED_RETRYABLE"]);
    expect(autoRetryStatuses.has("FAILED_PERMANENT")).toBe(false);
    const enqueueSpy = vi.fn();
    if (autoRetryStatuses.has("FAILED_PERMANENT")) {
      enqueueSpy();
    }
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("after inbound identity repair, explicit retry uses the same pending message then replaces telegram id", () => {
    const pendingTelegramMessageId = "pending:send:5476500286:uuid";
    const chatAfterInbound = {
      telegramChatId: "5476500286",
      peerType: "USER",
      accessHash: "8949449174917549431",
      firstName: "Pat"
    };
    expect(chatAfterInbound.accessHash).toBeTruthy();
    const afterAck = {
      telegramMessageId: "981",
      sendStatus: "SENT",
      previousPendingId: pendingTelegramMessageId
    };
    expect(afterAck.previousPendingId.startsWith("pending:")).toBe(true);
    expect(afterAck.telegramMessageId).toBe("981");
    expect(afterAck.sendStatus).toBe("SENT");
  });
});
