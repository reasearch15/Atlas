"use client";

import { formatOutboundAttribution } from "@atlas/shared";
import type { TelegramMessageDto } from "@atlas/shared";

/**
 * Compact Atlas-only attribution under outgoing customer bubbles.
 * Never shown to the Telegram customer.
 */
export function OutgoingAttribution({
  message,
  viewerUserId
}: {
  readonly message: TelegramMessageDto;
  readonly viewerUserId: string | null;
}) {
  const label = formatOutboundAttribution({
    direction: message.direction,
    internalSenderUserId: message.internalSenderUserId,
    internalSenderName: message.internalSenderName ?? null,
    attributionSource: message.attributionSource ?? null,
    viewerUserId
  });
  if (!label) return null;
  return <span className="mr-auto text-[10px] font-medium text-muted-foreground/90">{label}</span>;
}
