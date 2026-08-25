import { describe, expect, it } from "vitest";
import type Redis from "ioredis";
import { AppError } from "../../utils/errors";
import {
  TENANT_LOGIN_FAIL_IP_MAX,
  TENANT_LOGIN_FAIL_USER_IP_MAX,
  assertTenantLoginNotRateLimited,
  clearTenantLoginFailures,
  legacyTenantLoginAccountKey,
  recordTenantLoginFailure,
  tenantLoginFailIpKey,
  tenantLoginFailUserIpKey
} from "./login-rate-limit";

function memoryRedis(): Redis & { readonly store: Map<string, { value: string; ttl: number }> } {
  const store = new Map<string, { value: string; ttl: number }>();
  const client = {
    store,
    incr: async (key: string) => {
      const current = store.get(key);
      const next = (current ? Number.parseInt(current.value, 10) : 0) + 1;
      store.set(key, { value: String(next), ttl: current?.ttl ?? -1 });
      return next;
    },
    expire: async (key: string, ttl: number) => {
      const current = store.get(key);
      if (!current) return 0;
      store.set(key, { ...current, ttl });
      return 1;
    },
    get: async (key: string) => store.get(key)?.value ?? null,
    ttl: async (key: string) => store.get(key)?.ttl ?? -2,
    del: async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
      }
      return removed;
    },
    set: async (key: string, value: string) => {
      store.set(key, { value, ttl: -1 });
      return "OK";
    }
  };
  return client as unknown as Redis & { readonly store: Map<string, { value: string; ttl: number }> };
}

describe("tenant login rate limit keys", () => {
  it("scopes failure keys by normalized username and IP", () => {
    expect(tenantLoginFailUserIpKey("staff", " Bella ", "203.0.113.10")).toBe(
      "staff-login:fail:user:bella:ip:203.0.113.10"
    );
    expect(tenantLoginFailIpKey("staff", "203.0.113.10")).toBe("staff-login:fail:ip:203.0.113.10");
    expect(legacyTenantLoginAccountKey("staff", "bella")).toBe("staff-login:account:bella");
  });

  it("counts only recorded failures and clears the user+IP key on success", async () => {
    const redis = memoryRedis();
    await recordTenantLoginFailure(redis, "staff", "bella", "1.1.1.1");
    await recordTenantLoginFailure(redis, "staff", "bella", "1.1.1.1");
    expect(await redis.get(tenantLoginFailUserIpKey("staff", "bella", "1.1.1.1"))).toBe("2");
    await clearTenantLoginFailures(redis, "staff", "bella", "1.1.1.1");
    expect(await redis.get(tenantLoginFailUserIpKey("staff", "bella", "1.1.1.1"))).toBeNull();
    // IP-wide defensive counter is intentionally retained.
    expect(await redis.get(tenantLoginFailIpKey("staff", "1.1.1.1"))).toBe("2");
  });

  it("throws RATE_LIMITED with retryAfterSeconds after too many user+IP failures", async () => {
    const redis = memoryRedis();
    for (let i = 0; i < TENANT_LOGIN_FAIL_USER_IP_MAX - 1; i += 1) {
      await recordTenantLoginFailure(redis, "staff", "bella", "9.9.9.9");
    }
    await expect(recordTenantLoginFailure(redis, "staff", "bella", "9.9.9.9")).rejects.toMatchObject({
      statusCode: 429,
      code: "RATE_LIMITED",
      details: { retryAfterSeconds: expect.any(Number) }
    } satisfies Partial<AppError>);
  });

  it("does not lock a second username behind the same IP via the user+IP key", async () => {
    const redis = memoryRedis();
    for (let i = 0; i < TENANT_LOGIN_FAIL_USER_IP_MAX - 1; i += 1) {
      await recordTenantLoginFailure(redis, "staff", "bella", "8.8.8.8");
    }
    await expect(recordTenantLoginFailure(redis, "staff", "bella", "8.8.8.8")).rejects.toMatchObject({
      code: "RATE_LIMITED"
    });
    await expect(assertTenantLoginNotRateLimited(redis, "staff", "bella", "8.8.8.8")).rejects.toMatchObject({
      code: "RATE_LIMITED"
    });
    await expect(assertTenantLoginNotRateLimited(redis, "staff", "alex", "8.8.8.8")).resolves.toBeUndefined();
  });

  it("still enforces a higher IP-wide defensive ceiling", async () => {
    const redis = memoryRedis();
    for (let i = 0; i < TENANT_LOGIN_FAIL_IP_MAX - 1; i += 1) {
      await recordTenantLoginFailure(redis, "staff", `user${i}`, "7.7.7.7");
    }
    await expect(recordTenantLoginFailure(redis, "staff", "final", "7.7.7.7")).rejects.toMatchObject({
      code: "RATE_LIMITED"
    });
  });
});
