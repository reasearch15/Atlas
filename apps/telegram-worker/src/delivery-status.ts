import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import { isRemoteTelegramMessageId, type TelegramMessageDto } from "@atlas/shared";
import { messageUpdatedEvent } from "./update-normalizer";
import { toTelegramMessageDto } from "./message-dto";

const DELIVERY_CONFIRM_TIMEOUT_MS = 12_000;

export { isRemoteTelegramMessageId };

/**
 * After Telegram returns a final Message/Update with a remote id, advance SENT → DELIVERED.
 * Emits a targeted message.updated event so the UI can swap ✓ → ✓✓ without reload.
 * If confirmation cannot be made within the timeout window, leaves SENT and logs why.
 */
export async function confirmOutboundDelivery(input: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly telegramMessageId: string;
  readonly alreadyPublishedSent?: boolean;
}): Promise<"DELIVERED" | "SENT"> {
  const startedAt = Date.now();

  if (!isRemoteTelegramMessageId(input.telegramMessageId)) {
    logDelivery({
      event: "telegram_delivery.confirmation_skipped",
      messageId: input.messageId,
      telegramMessageId: input.telegramMessageId,
      reason: "missing_or_invalid_remote_message_id",
      elapsedMs: Date.now() - startedAt
    });
    return "SENT";
  }

  if (Date.now() - startedAt > DELIVERY_CONFIRM_TIMEOUT_MS) {
    logDelivery({
      event: "telegram_delivery.confirmation_timeout",
      messageId: input.messageId,
      telegramMessageId: input.telegramMessageId,
      reason: "confirmation_exceeded_timeout",
      timeoutMs: DELIVERY_CONFIRM_TIMEOUT_MS
    });
    return "SENT";
  }

  // Brief SENT window so the single tick is observable before ✓✓.
  await sleep(250);

  const updated = await input.prisma.telegramMessage.updateMany({
    where: {
      id: input.messageId,
      sendStatus: { in: ["SENT", "SENDING"] },
      telegramMessageId: input.telegramMessageId
    },
    data: {
      sendStatus: "DELIVERED",
      updatedAt: new Date()
    }
  });

  if (updated.count === 0) {
    const current = await input.prisma.telegramMessage.findUnique({ where: { id: input.messageId } });
    logDelivery({
      event: "telegram_delivery.confirmation_skipped",
      messageId: input.messageId,
      telegramMessageId: input.telegramMessageId,
      reason: "message_not_in_sent_state",
      currentStatus: current?.sendStatus ?? null,
      elapsedMs: Date.now() - startedAt
    });
    return current?.sendStatus === "DELIVERED" ? "DELIVERED" : "SENT";
  }

  const row = await input.prisma.telegramMessage.findUniqueOrThrow({ where: { id: input.messageId } });
  const dto = toTelegramMessageDto(row, {
    direction: "OUTBOUND",
    chatTitle: null,
    chatType: "UNKNOWN",
    chatUsername: null
  });
  await publishMessageUpdated(input.redis, input.workspaceId, dto);
  logDelivery({
    event: "telegram_delivery.confirmed",
    messageId: input.messageId,
    telegramMessageId: input.telegramMessageId,
    sendStatus: "DELIVERED",
    elapsedMs: Date.now() - startedAt
  });
  return "DELIVERED";
}

/**
 * Publishes a message.updated realtime event for a single bubble status change.
 */
export async function publishMessageUpdated(
  redis: Redis,
  workspaceId: string,
  message: TelegramMessageDto
): Promise<void> {
  await redis.publish("atlas.workspace-events", JSON.stringify(messageUpdatedEvent(workspaceId, message)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDelivery(value: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...value, ts: new Date().toISOString() }));
}
