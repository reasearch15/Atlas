/**
 * Typed API failure for status/code-aware UI (e.g. staff login rate limits).
 */
export class ApiClientError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryAfterSeconds: number | undefined;

  public constructor(code: string, message: string, status: number, retryAfterSeconds?: number) {
    super(code ? `${code}: ${message}` : message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  public get isRateLimited(): boolean {
    return this.status === 429 || this.code === "RATE_LIMITED";
  }

  public get isInvalidCredentials(): boolean {
    return this.status === 401 || this.code === "UNAUTHORIZED";
  }
}
