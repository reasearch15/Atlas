#!/usr/bin/env tsx
/**
 * Operational unlock for tenant (staff/coadmin) login rate-limit keys.
 *
 * Deletes only the precise failure keys for one normalized username (+ optional IP).
 * Does not flush unrelated Redis keys or weaken global limits.
 *
 * Usage:
 *   pnpm --filter @atlas/backend staff:unlock-login -- --username bella
 *   pnpm --filter @atlas/backend staff:unlock-login -- --username bella --ip 203.0.113.10
 *   pnpm --filter @atlas/backend staff:unlock-login -- --username bella --role staff --include-legacy
 */
import Redis from "ioredis";
import {
  legacyTenantLoginAccountKey,
  legacyTenantLoginIpKey,
  normalizeLoginIp,
  normalizeLoginUsername,
  tenantLoginFailIpKey,
  tenantLoginFailUserIpKey,
  type TenantLoginRole
} from "../modules/coadmin-auth/login-rate-limit";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const usernameRaw = argValue("--username");
  if (!usernameRaw) {
    throw new Error("Required: --username <staff-or-coadmin-username>");
  }
  const username = normalizeLoginUsername(usernameRaw);
  const role = (argValue("--role") ?? "staff") as TenantLoginRole;
  if (role !== "staff" && role !== "coadmin") {
    throw new Error("--role must be staff or coadmin");
  }
  const ipRaw = argValue("--ip");
  const includeLegacy = hasFlag("--include-legacy");
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  await redis.connect();

  const keys: string[] = [];
  if (ipRaw) {
    const ip = normalizeLoginIp(ipRaw);
    keys.push(tenantLoginFailUserIpKey(role, username, ip));
    if (includeLegacy) {
      keys.push(legacyTenantLoginAccountKey(role, username));
      keys.push(legacyTenantLoginIpKey(role, ip));
    }
  } else {
    // Scan only precise user-scoped failure keys for this username.
    const pattern = `${role}-login:fail:user:${username}:ip:*`;
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (includeLegacy) {
      keys.push(legacyTenantLoginAccountKey(role, username));
    }
  }

  const unique = [...new Set(keys)];
  if (unique.length === 0) {
    console.log(JSON.stringify({ deleted: 0, keys: [], username, role, note: "No matching lock keys found." }, null, 2));
    await redis.quit();
    return;
  }

  const deleted = await redis.del(...unique);
  console.log(JSON.stringify({ deleted, keys: unique, username, role }, null, 2));
  await redis.quit();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
