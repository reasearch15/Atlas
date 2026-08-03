/**
 * Formats outbound message attribution for Atlas operators.
 * Customers never see these labels — they are Atlas-only UI.
 */
export function formatOutboundAttribution(input: {
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly internalSenderUserId?: string | null;
  readonly internalSenderName?: string | null;
  readonly attributionSource?: "ATLAS" | "TELEGRAM_EXTERNAL" | null;
  readonly viewerUserId?: string | null;
}): string | null {
  if (input.direction !== "OUTBOUND") return null;
  if (input.internalSenderUserId) {
    if (input.viewerUserId && input.viewerUserId === input.internalSenderUserId) {
      return "You";
    }
    const name = input.internalSenderName?.trim();
    return name ? `Sent by ${name}` : "Sent by Atlas operator";
  }
  if (input.attributionSource === "TELEGRAM_EXTERNAL" || !input.internalSenderUserId) {
    return "Sent from Telegram";
  }
  return null;
}

/**
 * Resolves attribution source for persistence/serialization.
 */
export function resolveAttributionSource(internalSenderUserId: string | null | undefined): "ATLAS" | "TELEGRAM_EXTERNAL" | null {
  if (internalSenderUserId) return "ATLAS";
  return "TELEGRAM_EXTERNAL";
}
