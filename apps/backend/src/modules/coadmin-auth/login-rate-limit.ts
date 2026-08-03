import type Redis from "ioredis";
import { AppError } from "../../utils/errors";

/** Sliding failure window for tenant (staff/coadmin) password login. */
export const TENANT_LOGIN_FAIL_WINDOW_SECONDS = 900;

/** Failed credential attempts per normalized username + client IP before lock. */
export const TENANT_LOGIN_FAIL_USER_IP_MAX = 8;

/**
 * Defensive ceiling for failed attempts from one IP across all usernames.
 * Kept higher than the per-user+IP cap so two users on one NAT are not
 * locked together by the primary key — only by sustained IP-wide abuse.
 */
export const TENANT_LOGIN_FAIL_IP_MAX = 40;

export type TenantLoginRole = "staff" | "coadmin";

/**
 * Primary lock key: failed staff/coadmin logins for one username from one IP.
 * Example: `staff-login:fail:user:bella:ip:203.0.113.10`
 */
export function tenantLoginFailUserIpKey(role: TenantLoginRole, username: string, ip: string): string {
  return `${role}-login:fail:user:${normalizeLoginUsername(username)}:ip:${normalizeLoginIp(ip)}`;
}

/**
 * Defensive IP-wide failure key.
 * Example: `staff-login:fail:ip:203.0.113.10`
 */
export function tenantLoginFailIpKey(role: TenantLoginRole, ip: string): string {
  return `${role}-login:fail:ip:${normalizeLoginIp(ip)}`;
}

/** Legacy pre-fix keys (attempt-counted, not failure-only) — unlock scripts may delete these. */
export function legacyTenantLoginAccountKey(role: TenantLoginRole, username: string): string {
  return `${role}-login:account:${normalizeLoginUsername(username)}`;
}

export function legacyTenantLoginIpKey(role: TenantLoginRole, ip: string): string {
  return `${role}-login:ip:${normalizeLoginIp(ip)}`;
}

export function normalizeLoginUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function normalizeLoginIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

/**
 * Throws 429 when an existing failure counter already exceeds its max (no increment).
 */
export async function assertTenantLoginNotRateLimited(
  redis: Redis,
  role: TenantLoginRole,
  username: string,
  ip: string
): Promise<void> {
  const userIpKey = tenantLoginFailUserIpKey(role, username, ip);
  const ipKey = tenantLoginFailIpKey(role, ip);
  const [userIpCount, ipCount] = await Promise.all([readCounter(redis, userIpKey), readCounter(redis, ipKey)]);
  if (userIpCount >= TENANT_LOGIN_FAIL_USER_IP_MAX) {
    throw await rateLimitedError(redis, userIpKey);
  }
  if (ipCount >= TENANT_LOGIN_FAIL_IP_MAX) {
    throw await rateLimitedError(redis, ipKey);
  }
}

/**
 * Increments failure counters only after a failed credential / inactive-account check.
 */
export async function recordTenantLoginFailure(
  redis: Redis,
  role: TenantLoginRole,
  username: string,
  ip: string
): Promise<void> {
  const userIpKey = tenantLoginFailUserIpKey(role, username, ip);
  const ipKey = tenantLoginFailIpKey(role, ip);
  await Promise.all([
    incrWithTtl(redis, userIpKey, TENANT_LOGIN_FAIL_WINDOW_SECONDS),
    incrWithTtl(redis, ipKey, TENANT_LOGIN_FAIL_WINDOW_SECONDS)
  ]);
  const [userIpCount, ipCount] = await Promise.all([readCounter(redis, userIpKey), readCounter(redis, ipKey)]);
  if (userIpCount >= TENANT_LOGIN_FAIL_USER_IP_MAX) {
    throw await rateLimitedError(redis, userIpKey);
  }
  if (ipCount >= TENANT_LOGIN_FAIL_IP_MAX) {
    throw await rateLimitedError(redis, ipKey);
  }
}

/**
 * Clears the precise username+IP failure counter after successful authentication.
 * Does not clear the IP-wide defensive counter (would weaken multi-username attacks).
 */
export async function clearTenantLoginFailures(
  redis: Redis,
  role: TenantLoginRole,
  username: string,
  ip: string
): Promise<void> {
  await redis.del(tenantLoginFailUserIpKey(role, username, ip));
}

async function incrWithTtl(redis: Redis, key: string, ttlSeconds: number): Promise<number> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

async function readCounter(redis: Redis, key: string): Promise<number> {
  const raw = await redis.get(key);
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function rateLimitedError(redis: Redis, key: string): Promise<AppError> {
  const ttl = await redis.ttl(key);
  const retryAfterSeconds = ttl > 0 ? ttl : TENANT_LOGIN_FAIL_WINDOW_SECONDS;
  return new AppError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.", {
    retryAfterSeconds
  });
}
