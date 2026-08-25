"use client";

import { AlertCircle, Check, CheckCheck, Loader2 } from "lucide-react";
import { cn } from "@atlas/ui";

type DeliveryVisual = "sending" | "sent" | "delivered" | "read" | "failed";

/**
 * Maps persisted send_status values to Telegram-style delivery visuals.
 * Double ticks are only shown for explicit DELIVERED/READ — never inferred.
 */
export function resolveDeliveryVisual(sendStatus: string): DeliveryVisual | null {
  switch (sendStatus) {
    case "QUEUED":
    case "UPLOADING":
    case "SENDING":
      return "sending";
    case "SENT":
      return "sent";
    case "DELIVERED":
      return "delivered";
    case "READ":
      return "read";
    case "FAILED_RETRYABLE":
    case "FAILED_PERMANENT":
      return "failed";
    default:
      return null;
  }
}

function tooltipFor(visual: DeliveryVisual): string {
  switch (visual) {
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "read":
      return "Read";
    case "failed":
      return "Failed";
  }
}

interface OutgoingDeliveryStatusProps {
  readonly sendStatus: string;
  readonly onRetry?: () => void;
}

/**
 * Compact Telegram-style delivery indicator for outgoing bubbles.
 */
export function OutgoingDeliveryStatus({ sendStatus, onRetry }: OutgoingDeliveryStatusProps) {
  const visual = resolveDeliveryVisual(sendStatus);
  if (!visual) return null;

  const title = tooltipFor(visual);
  const iconClass = "size-3.5 shrink-0";

  if (visual === "failed") {
    return (
      <button
        type="button"
        title={`${title} · Retry`}
        aria-label="Failed to send. Retry"
        onClick={(event) => {
          event.stopPropagation();
          onRetry?.();
        }}
        className="inline-flex items-center text-red-600 hover:text-red-700"
      >
        <AlertCircle className={iconClass} aria-hidden="true" />
      </button>
    );
  }

  return (
    <span title={title} aria-label={title} className="inline-flex items-center text-muted-foreground">
      {visual === "sending" ? <Loader2 className={cn(iconClass, "animate-spin opacity-80")} aria-hidden="true" /> : null}
      {visual === "sent" ? <Check className={cn(iconClass, "stroke-[2.5]")} aria-hidden="true" /> : null}
      {visual === "delivered" ? <CheckCheck className={cn(iconClass, "stroke-[2.5]")} aria-hidden="true" /> : null}
      {visual === "read" ? <CheckCheck className={cn(iconClass, "stroke-[2.5] text-[#53bdeb]")} aria-hidden="true" /> : null}
    </span>
  );
}
