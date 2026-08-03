import type { TelegramAccountDto } from "./api";
import { telegramAccountPermanentDeleteEligibleStatuses } from "./telegram-account-deletion";

export type TelegramAccountActionKind = "active" | "inactive" | "deleting";

/**
 * Classifies which primary actions the Coadmin Telegram account card should expose.
 */
export function getTelegramAccountActionKind(account: TelegramAccountDto): TelegramAccountActionKind {
  if (account.status === "DELETING") return "deleting";
  if (account.status === "CONNECTED" || account.status === "SYNCING" || account.status === "DEGRADED") {
    return "active";
  }
  if (account.authorizationState === "AUTHORIZED" && account.status !== "DISCONNECTED") {
    return "active";
  }
  // Backend still requires disconnect before permanent delete for these statuses.
  if (!(telegramAccountPermanentDeleteEligibleStatuses as readonly string[]).includes(account.status)) {
    return "active";
  }
  return "inactive";
}

/**
 * Whether permanent delete needs a successful disconnect first.
 */
export function telegramAccountNeedsDisconnectBeforeDelete(account: TelegramAccountDto): boolean {
  return !(telegramAccountPermanentDeleteEligibleStatuses as readonly string[]).includes(account.status);
}

/**
 * Whether the account is ready for the permanent-delete confirmation submit.
 */
export function telegramAccountIsReadyForPermanentDelete(account: TelegramAccountDto): boolean {
  return !telegramAccountNeedsDisconnectBeforeDelete(account) && account.status !== "DELETING";
}

export interface TelegramAccountDisplayState {
  readonly status: string;
  readonly authorizationState: string;
  readonly syncState: string;
  readonly progressLabel: string | null;
}

/**
 * Normalizes contradictory status/auth/sync triples for display only.
 * Actions always use the raw backend account fields.
 */
export function normalizeTelegramAccountDisplay(account: TelegramAccountDto): TelegramAccountDisplayState {
  if (account.status === "DELETING") {
    return {
      status: "DELETING",
      authorizationState: account.authorizationState,
      syncState: account.syncState,
      progressLabel: "Deletion in progress…"
    };
  }

  if (account.status === "DISCONNECTED") {
    return {
      status: "DISCONNECTED",
      authorizationState: "CANCELLED",
      syncState: "PAUSED",
      progressLabel: null
    };
  }

  // Contradictory live badge with cancelled auth → present as disconnected for operators.
  if (account.authorizationState === "CANCELLED" && (account.status === "CONNECTED" || account.status === "SYNCING" || account.status === "DEGRADED")) {
    return {
      status: account.status,
      authorizationState: account.authorizationState,
      syncState: account.syncState === "LIVE" ? "PAUSED" : account.syncState,
      progressLabel: "Disconnect required before permanent delete"
    };
  }

  if (account.status === "REAUTH_REQUIRED" || account.authorizationState === "REAUTH_REQUIRED") {
    return {
      status: "REAUTH_REQUIRED",
      authorizationState: "REAUTH_REQUIRED",
      syncState: account.syncState === "LIVE" ? "PAUSED" : account.syncState,
      progressLabel: null
    };
  }

  return {
    status: account.status,
    authorizationState: account.authorizationState,
    syncState: account.syncState,
    progressLabel: null
  };
}
