import { centsToUsdAmount } from "./pye-cash.schema";
import type { ProviderAttempt, PyeCashProvider } from "./pye-cash.types";

export interface HttpPyeCashClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
  /** Live network is refused unless this is explicitly true. Tests leave it false. */
  readonly allowLiveFetch?: boolean;
}

/**
 * One-shot Pye-Cash create client. It never retries.
 * The response body is not logged.
 */
export class HttpPyeCashClient implements PyeCashProvider {
  public constructor(private readonly options: HttpPyeCashClientOptions) {}

  public async createInvoice(input: { readonly amountCents: number; readonly merchant: string }): Promise<ProviderAttempt> {
    if (!this.options.allowLiveFetch) {
      throw new Error("Pye-Cash live fetch is disabled");
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/api/payments`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          amount: centsToUsdAmount(input.amountCents),
          currency: "USD",
          metadata: { merchant: input.merchant }
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });
      const raw = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        return response.ok
          ? { kind: "uncertain", category: "MALFORMED_RESPONSE" }
          : this.classifyStatus(response.status);
      }
      if (response.ok) return { kind: "created", body };
      return this.classifyStatus(response.status);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return { kind: "uncertain", category: "TIMEOUT" };
      }
      return { kind: "uncertain", category: "NETWORK" };
    }
  }

  private classifyStatus(status: number): ProviderAttempt {
    if (status === 408 || status === 429 || status >= 500) {
      return { kind: "uncertain", category: `HTTP_${status}` };
    }
    if (status >= 400 && status < 500) {
      return { kind: "rejected", category: `HTTP_${status}` };
    }
    return { kind: "uncertain", category: `HTTP_${status}` };
  }
}

/** Used while the feature flag is off so a route bug cannot reach the network. */
export class DisabledPyeCashProvider implements PyeCashProvider {
  public async createInvoice(): Promise<ProviderAttempt> {
    throw new Error("Pye-Cash provider is disabled");
  }
}
