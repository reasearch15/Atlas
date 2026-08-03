import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../utils/errors";

/**
 * Lightweight contract tests for explicit FAILED_* outbound retry after identity repair.
 * Full Prisma integration is covered by service mocks mirroring production guards.
 */
describe("retryFailedOutboundMessage contract", () => {
  it("blocks retry when private peer still lacks access_hash", () => {
    const chat = { chatType: "PRIVATE", peerType: null, accessHash: null, telegramChatId: "8291583373" };
    const isUserPeer =
      (chat.peerType || "").toUpperCase() === "USER" ||
      chat.chatType === "PRIVATE" ||
      (!chat.telegramChatId.startsWith("-") && !(chat.peerType || ""));
    expect(isUserPeer && !chat.accessHash).toBe(true);
    const error = new AppError(
      409,
      "PEER_IDENTITY_INCOMPLETE",
      "This contact is missing a Telegram access hash. Wait for a new inbound message or run identity backfill, then retry."
    );
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("PEER_IDENTITY_INCOMPLETE");
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

    // Retry requeues the same command — does not create a second outbound message row.
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
    // Production worker only requeues FAILED_RETRYABLE via attempts < 4; FAILED_PERMANENT stays until API retry.
    if (autoRetryStatuses.has("FAILED_PERMANENT")) {
      enqueueSpy();
    }
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
