import { ApiClientError } from "@/lib/api-client-error";

const LEADERBOARD_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  PARTICIPANT_NOT_BOUND: "This player is not connected to a leaderboard yet.",
  PARTICIPANT_TRANSFER_UNSUPPORTED:
    "This player is already connected to another leaderboard and cannot be moved.",
  PARTICIPANT_INTEGRITY_ERROR:
    "This player has conflicting leaderboard bindings. Contact support before continuing.",
  REFERRAL_ALREADY_EXISTS: "This player already has a referrer.",
  SELF_REFERRAL_FORBIDDEN: "A player cannot refer themselves.",
  INVALID_DEPOSIT_AMOUNT: "Enter a valid deposit amount greater than zero.",
  CONTACT_NOT_FOUND: "That contact was not found in this workspace.",
  OWNER_MISMATCH: "You do not have access to this player's leaderboard.",
  LEADERBOARD_DISABLED: "Leaderboard is disabled for this board.",
  LEADERBOARD_OWNER_UNRESOLVED:
    "This workspace has no primary coadmin, so the leaderboard cannot be resolved.",
  IDEMPOTENCY_CONFLICT: "This request was already submitted with different details. Try again.",
  COMPETITION_NOT_FOUND: "No active leaderboard competition was found.",
  CHAT_NOT_FOUND: "Chat was not found in this workspace.",
  FORBIDDEN: "You do not have permission for this leaderboard action.",
  CONFIRM_DISABLE_REQUIRED:
    "An active competition is running. Confirm again to disable the leaderboard.",
  COMPETITION_NOT_FROZEN: "Only frozen competitions can be finalized.",
  COMPETITION_ALREADY_FINALIZED: "This competition is already finalized.",
  EVENT_ALREADY_REVERSED: "This event has already been reversed.",
  EVENT_NOT_REVERSIBLE: "This event type cannot be reversed.",
  PENDING_REVIEW_BLOCKS_FINALIZE:
    "Finalize is blocked while subscription verification is still pending for one or more players.",
  PAYOUT_ALREADY_SETTLED: "This payout has already been settled.",
  INVALID_POOL_RATE: "Choose a prize pool contribution of 2%, 3%, 4%, or 5%.",
  ELIGIBILITY_LOCKED: "Eligibility cannot be changed after winners are finalized.",
  MISSING_REASON: "A reason is required for this action."
};

/**
 * Maps ApiClientError / domain codes to Phase 2 §25 friendly UI strings.
 */
export function mapLeaderboardError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const mapped = LEADERBOARD_ERROR_MESSAGES[error.code];
    if (mapped) return mapped;
    return stripErrorCodePrefix(error.message);
  }
  if (error instanceof Error && error.message.trim()) {
    return stripErrorCodePrefix(error.message);
  }
  return "Something went wrong with the leaderboard.";
}

/**
 * Formats integer cents as USD currency (e.g. `$420.00`).
 */
export function formatMoneyFromCents(cents: number): string {
  const amount = Number.isFinite(cents) ? cents / 100 : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

/**
 * Parses a dollars string (`40`, `40.5`, `40.50`) into positive integer cents.
 * Rejects negatives, empty, and more than 2 decimal places.
 */
export function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const parts = trimmed.split(".");
  const wholePart = parts[0] ?? "";
  const fractionPart = parts[1] ?? "";
  const whole = Number.parseInt(wholePart, 10);
  const fraction = Number.parseInt(`${fractionPart}00`.slice(0, 2), 10);
  if (!Number.isFinite(whole) || !Number.isFinite(fraction)) return null;
  const cents = whole * 100 + fraction;
  if (cents <= 0 || cents > 100_000_000) return null;
  return cents;
}

/**
 * Generates a stable idempotency key for deposit / promotion / give-info retries.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function stripErrorCodePrefix(message: string): string {
  const separator = message.indexOf(": ");
  if (separator > 0 && /^[A-Z][A-Z0-9_]+$/.test(message.slice(0, separator))) {
    return message.slice(separator + 2);
  }
  return message;
}
