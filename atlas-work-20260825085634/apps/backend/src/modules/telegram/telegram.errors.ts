import { AppError } from "../../utils/errors";

/**
 * Creates a Telegram-specific not found error.
 */
export function telegramNotFound(message = "Telegram resource was not found"): AppError {
  return new AppError(404, "TELEGRAM_NOT_FOUND", message);
}

/**
 * Creates a Telegram authorization transition error.
 */
export function invalidTelegramTransition(message: string): AppError {
  return new AppError(409, "TELEGRAM_INVALID_STATE_TRANSITION", message);
}

/**
 * Creates a Telegram configuration error.
 */
export function telegramConfigurationError(message: string): AppError {
  return new AppError(503, "TELEGRAM_CONFIGURATION_ERROR", message);
}

/**
 * Creates a conflict when the Telegram worker does not currently own the account lease.
 * Reserved for worker/command paths — not used by HTTP send enqueue.
 */
export function telegramAccountLeaseBusy(message = "Telegram account lease is busy."): AppError {
  return new AppError(409, "TELEGRAM_ACCOUNT_LEASE_BUSY", message);
}

/**
 * Creates an error when the Telegram account is not authorized for messaging.
 */
export function telegramAccountNotAuthorized(message = "Telegram account is not authorized."): AppError {
  return new AppError(409, "TELEGRAM_ACCOUNT_NOT_AUTHORIZED", message);
}

/**
 * Creates an error when the Telegram account cannot send because it is disconnected.
 */
export function telegramAccountDisconnected(message = "Telegram account is disconnected."): AppError {
  return new AppError(409, "TELEGRAM_ACCOUNT_DISCONNECTED", message);
}

/**
 * Creates an error when a racing send targets an account that is being or was permanently deleted.
 */
export function telegramAccountDeleted(message = "Telegram account was permanently deleted."): AppError {
  return new AppError(410, "TELEGRAM_ACCOUNT_DELETED", message);
}

/**
 * Creates an error when permanent delete is requested for an actively connected account.
 */
export function telegramAccountMustDisconnectFirst(
  message = "Disconnect this Telegram account before permanently deleting it."
): AppError {
  return new AppError(409, "TELEGRAM_ACCOUNT_MUST_DISCONNECT_FIRST", message);
}

/**
 * Creates a conflict when a Telegram auth command is already in flight for the account.
 */
export function telegramAuthCommandInProgress(
  message = "A Telegram authorization step is already in progress for this account."
): AppError {
  return new AppError(409, "TELEGRAM_AUTH_COMMAND_IN_PROGRESS", message);
}

/**
 * Creates an error when durable outbound queueing failed (worker/queue unavailable).
 */
export function telegramWorkerUnavailable(message = "Telegram worker queue is unavailable."): AppError {
  return new AppError(503, "WORKER_UNAVAILABLE", message);
}
