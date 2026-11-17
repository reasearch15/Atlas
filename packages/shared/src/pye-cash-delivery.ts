export type PyeCashCommandStatus = "MISSING" | "QUEUED" | "SENDING" | "SENT" | "FAILED_RETRYABLE" | "FAILED_PERMANENT" | "CANCELLED";

export interface PyeCashCommandView {
  readonly status: PyeCashCommandStatus;
  readonly ambiguous: boolean;
}

export type PyeCashDeliveryPlan =
  | { readonly action: "reconcile_sent" }
  | { readonly action: "ensure_job" }
  | { readonly action: "commit" }
  | { readonly action: "retry_same_command" }
  | { readonly action: "reconcile_failed" }
  | { readonly action: "block_ambiguous" };

/**
 * Decides how to attach one invoice to one outbound command.
 * A missing command can be created. An ambiguous or already-sent command is never sent again.
 */
export function planPyeCashDelivery(input: {
  readonly deliveryState: "NOT_SENT" | "QUEUED" | "SENT" | "FAILED";
  readonly errorCategory: string | null;
  readonly command: PyeCashCommandView;
  readonly explicitResend: boolean;
}): PyeCashDeliveryPlan {
  if (input.deliveryState === "SENT" || input.command.status === "SENT") return { action: "reconcile_sent" };
  if (input.errorCategory === "TELEGRAM_AMBIGUOUS" || input.command.ambiguous) return { action: "block_ambiguous" };
  if (input.command.status === "QUEUED" || input.command.status === "SENDING") return { action: "ensure_job" };
  if (input.command.status === "FAILED_RETRYABLE" || input.command.status === "FAILED_PERMANENT" || input.command.status === "CANCELLED") {
    if (input.explicitResend && input.errorCategory === "TELEGRAM_FAILED" && input.command.status !== "CANCELLED") {
      return { action: "retry_same_command" };
    }
    return { action: "reconcile_failed" };
  }
  return { action: "commit" };
}

export type PyeCashDeliveryOutcome = "sent" | "failed" | "ambiguous";

export interface PyeCashDeliveryPatch {
  readonly deliveryState: "QUEUED" | "SENT" | "FAILED";
  readonly errorCategory: "TELEGRAM_AMBIGUOUS" | "TELEGRAM_FAILED" | null;
  readonly telegramMessageId: string | null;
}

/**
 * Maps a worker result onto the invoice. A confirmed send is not overwritten by a later failure.
 */
export function pyeCashDeliveryUpdate(
  currentState: "NOT_SENT" | "QUEUED" | "SENT" | "FAILED",
  outcome: PyeCashDeliveryOutcome,
  telegramMessageId: string | null
): PyeCashDeliveryPatch | null {
  if (currentState === "SENT" && outcome !== "sent") return null;
  if (outcome === "sent") {
    return { deliveryState: "SENT", errorCategory: null, telegramMessageId };
  }
  if (outcome === "ambiguous") {
    return { deliveryState: "FAILED", errorCategory: "TELEGRAM_AMBIGUOUS", telegramMessageId };
  }
  return { deliveryState: "FAILED", errorCategory: "TELEGRAM_FAILED", telegramMessageId: null };
}
