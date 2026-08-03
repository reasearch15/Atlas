export interface SanitizedTelegramError {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
  readonly errorMessage?: string;
  readonly stack?: string;
  readonly floodWaitSeconds?: number;
  readonly timestamp: string;
}

export interface TelegramFailureClassification {
  readonly nextAuthorizationState: "PHONE_REQUESTED" | "CODE_REQUESTED" | "PASSWORD_REQUESTED" | "AUTHORIZED" | "REAUTH_REQUIRED" | "CANCELLED";
  readonly nextSyncState: "IDLE" | "LIVE" | "PAUSED" | "FAILED";
  readonly nextStatus: "WAITING_FOR_PHONE" | "WAITING_FOR_CODE" | "WAITING_FOR_PASSWORD" | "CONNECTED" | "DEGRADED" | "FAILED" | "REAUTH_REQUIRED";
  readonly safeErrorCode: string;
  readonly safeUserMessage: string;
  readonly retryable: boolean;
}

const secretPatterns: readonly RegExp[] = [
  /\+[1-9]\d{7,14}/g,
  /\b\d{5,6}\b/g,
  /\b(?:api[_ -]?hash|auth[_ -]?key|session|stringSession|password|phoneCodeHash)\b\s*[:=]\s*["']?[^"',\s)]+/gi
];

const invalidSessionPattern = /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|USER_DEACTIVATED_BAN|AUTH_KEY_INVALID/i;
const floodWaitPattern = /FLOOD_WAIT_?(\d+)?|A wait of (\d+) seconds is required/i;

/**
 * Converts a Telegram/GramJS failure into a safe scalar object without walking object graphs.
 */
export function sanitizeTelegramError(error: unknown, includeStack = process.env.NODE_ENV === "development"): SanitizedTelegramError {
  const record = isRecord(error) ? error : {};
  const name = safeText(typeof record.name === "string" ? record.name : error instanceof Error ? error.name : "TelegramError", 120);
  const message = redactTelegramSecret(safeText(typeof record.message === "string" ? record.message : error instanceof Error ? error.message : "Telegram operation failed.", 1000));
  const code = scalarCode(record.code ?? record.errorCode);
  const errorMessage = typeof record.errorMessage === "string" ? redactTelegramSecret(safeText(record.errorMessage, 500)) : undefined;
  const stack = includeStack && typeof record.stack === "string" ? redactTelegramSecret(safeText(record.stack, 2000)) : undefined;
  const floodWaitSeconds = parseFloodWait(message, record.seconds);

  return {
    name,
    message,
    ...(code !== undefined ? { code } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(stack ? { stack } : {}),
    ...(floodWaitSeconds !== undefined ? { floodWaitSeconds } : {}),
    timestamp: new Date().toISOString()
  };
}

/**
 * Classifies a Telegram failure into safe account state and user-facing error fields.
 */
export function classifyTelegramFailure(
  error: unknown,
  currentAuthorizationState: string,
  hasStoredAuthorizedSession: boolean
): TelegramFailureClassification {
  const safe = sanitizeTelegramError(error, false);
  const combined = `${safe.name} ${safe.message} ${safe.code ?? ""} ${safe.errorMessage ?? ""}`;

  if (invalidSessionPattern.test(combined) && hasStoredAuthorizedSession) {
    return {
      nextAuthorizationState: "REAUTH_REQUIRED",
      nextSyncState: "PAUSED",
      nextStatus: "REAUTH_REQUIRED",
      safeErrorCode: "TELEGRAM_AUTH_KEY_INVALID",
      safeUserMessage: "Telegram authorization expired. Restart authorization to reconnect this account.",
      retryable: false
    };
  }

  if (/TELEGRAM_AUTH_CONTEXT_MISSING/i.test(combined)) {
    return terminalFailure("TELEGRAM_AUTH_CONTEXT_MISSING", "Telegram authorization context expired. Restart authorization to request a new code.");
  }

  if (/PHONE_CODE_EXPIRED/i.test(combined)) {
    return {
      nextAuthorizationState: "PHONE_REQUESTED",
      nextSyncState: "IDLE",
      nextStatus: "WAITING_FOR_PHONE",
      safeErrorCode: "PHONE_CODE_EXPIRED",
      safeUserMessage: "The Telegram verification code expired. Restart authorization and request a new code.",
      retryable: false
    };
  }

  if (/PHONE_CODE_INVALID|CODE_INVALID|PHONE_CODE_EMPTY/i.test(combined)) {
    return retryCurrent(currentAuthorizationState, "PHONE_CODE_INVALID", "The Telegram verification code was incorrect.");
  }

  if (/PASSWORD_HASH_INVALID|PASSWORD/i.test(combined)) {
    return retryCurrent(currentAuthorizationState, "WRONG_2FA", "The Telegram two-factor password was incorrect.");
  }

  if (floodWaitPattern.test(combined)) {
    return retryCurrent(currentAuthorizationState, "TELEGRAM_FLOOD_WAIT", "Telegram rate-limited this authorization attempt. Please wait before trying again.");
  }

  if (/Converting circular structure to JSON|circular/i.test(combined)) {
    return retryCurrent(currentAuthorizationState, "TELEGRAM_INTERNAL_SERIALIZATION_ERROR", "Telegram returned an internal response that could not be processed safely. Restart authorization and try again.");
  }

  if (/TELEGRAM_ACCOUNT_LEASE_BUSY/i.test(combined)) {
    return {
      nextAuthorizationState: "AUTHORIZED",
      nextSyncState: "LIVE",
      nextStatus: "CONNECTED",
      safeErrorCode: "TELEGRAM_ACCOUNT_LEASE_BUSY",
      safeUserMessage: "Telegram account is busy with live sync. Retry metadata refresh shortly.",
      retryable: false
    };
  }

  if (/TELEGRAM_AUTH_NETWORK_TIMEOUT/i.test(combined)) {
    return retryCurrent(
      currentAuthorizationState,
      "TELEGRAM_AUTH_NETWORK_TIMEOUT",
      "Telegram authorization timed out. You can retry without requesting a new code."
    );
  }

  if (/ECONN|ETIMEDOUT|ENOTFOUND|NETWORK|lease is held/i.test(combined)) {
    return retryCurrent(currentAuthorizationState, "TELEGRAM_NETWORK_ERROR", "Telegram is temporarily unreachable. Please try again.");
  }

  // Bare GramJS update-loop TIMEOUT should not reach here for temporary auth clients.
  // If it does during an auth RPC, treat as retryable auth network timeout.
  if (/\bTIMEOUT\b/i.test(combined)) {
    return retryCurrent(
      currentAuthorizationState,
      "TELEGRAM_AUTH_NETWORK_TIMEOUT",
      "Telegram authorization timed out. You can retry without requesting a new code."
    );
  }

  if (/API_ID|API_HASH|Developer app/i.test(combined)) {
    return terminalFailure("TELEGRAM_CONFIGURATION_ERROR", "Telegram Developer App configuration is invalid.");
  }

  return retryCurrent(currentAuthorizationState, "TELEGRAM_WORKER_ERROR", safe.message || "Telegram authorization failed. Please try again.");
}

/**
 * Redacts known Telegram secrets and authentication values from loggable text.
 */
export function redactTelegramSecret(value: string): string {
  return secretPatterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), value);
}

function retryCurrent(currentAuthorizationState: string, code: string, message: string): TelegramFailureClassification {
  if (currentAuthorizationState === "PASSWORD_REQUESTED") {
    return {
      nextAuthorizationState: "PASSWORD_REQUESTED",
      nextSyncState: "IDLE",
      nextStatus: "WAITING_FOR_PASSWORD",
      safeErrorCode: code,
      safeUserMessage: message,
      retryable: true
    };
  }
  if (currentAuthorizationState === "CODE_REQUESTED") {
    return {
      nextAuthorizationState: "CODE_REQUESTED",
      nextSyncState: "IDLE",
      nextStatus: "WAITING_FOR_CODE",
      safeErrorCode: code,
      safeUserMessage: message,
      retryable: true
    };
  }
  return {
    nextAuthorizationState: "PHONE_REQUESTED",
    nextSyncState: "IDLE",
    nextStatus: "WAITING_FOR_PHONE",
    safeErrorCode: code,
    safeUserMessage: message,
    retryable: true
  };
}

function terminalFailure(code: string, message: string): TelegramFailureClassification {
  return {
    nextAuthorizationState: "PHONE_REQUESTED",
    nextSyncState: "FAILED",
    nextStatus: "FAILED",
    safeErrorCode: code,
    safeUserMessage: message,
    retryable: false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function scalarCode(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

function safeText(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

function parseFloodWait(message: string, seconds: unknown): number | undefined {
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return seconds;
  const match = message.match(floodWaitPattern);
  const parsed = Number(match?.[1] ?? match?.[2]);
  return Number.isFinite(parsed) ? parsed : undefined;
}
