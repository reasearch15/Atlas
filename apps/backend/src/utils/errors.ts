export interface AppErrorDetails {
  readonly retryAfterSeconds?: number;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: AppErrorDetails | undefined;

  /**
   * Creates a typed application error suitable for API serialization.
   */
  public constructor(statusCode: number, code: string, message: string, details?: AppErrorDetails) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * Produces a 401 error for unauthenticated requests.
 */
export function unauthorized(message = "Authentication is required"): AppError {
  return new AppError(401, "UNAUTHORIZED", message);
}

/**
 * Produces a 401 when a Bearer access token has expired (jose ERR_JWT_EXPIRED).
 * Clients should refresh once and retry; this must never surface as HTTP 500.
 */
export function accessTokenExpired(message = "Access token has expired"): AppError {
  return new AppError(401, "ACCESS_TOKEN_EXPIRED", message);
}

/**
 * Produces a 403 error for authenticated users without permission.
 */
export function forbidden(message = "You do not have permission to perform this action"): AppError {
  return new AppError(403, "FORBIDDEN", message);
}
