/**
 * Builds the exact confirmation phrase required for permanent Telegram account deletion.
 * Example: @Piccaso47 → "DELETE PICCASO47"
 */
export function buildTelegramAccountDeleteConfirmation(input: {
  readonly telegramUsername?: string | null;
  readonly displayName: string;
}): string {
  const raw = (input.telegramUsername?.trim() || input.displayName).replace(/^@/, "");
  const normalized = raw.replace(/[^a-zA-Z0-9]+/g, "").toUpperCase();
  return `DELETE ${normalized || "ACCOUNT"}`;
}

/**
 * Statuses that may be permanently deleted without an extra disconnect step.
 * Actively connected accounts must be disconnected first.
 */
export const telegramAccountPermanentDeleteEligibleStatuses = [
  "DISCONNECTED",
  "FAILED",
  "REAUTH_REQUIRED",
  "PENDING",
  "AUTHORIZING",
  "WAITING_FOR_QR",
  "WAITING_FOR_PHONE",
  "WAITING_FOR_CODE",
  "WAITING_FOR_PASSWORD",
  "DELETING"
] as const;
