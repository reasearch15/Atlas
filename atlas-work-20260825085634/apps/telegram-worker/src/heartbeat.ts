import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { WorkerEnv } from "./env";

export interface WorkerHeartbeat {
  readonly workerId: string;
  readonly status: "running";
  readonly lastHeartbeatAt: string;
}

/**
 * Publishes a lightweight Redis heartbeat for operational status checks.
 */
export function startWorkerHeartbeat(redis: Redis, env: WorkerEnv): NodeJS.Timeout {
  const writeHeartbeat = async (): Promise<void> => {
    const heartbeat: WorkerHeartbeat = {
      workerId: env.TELEGRAM_WORKER_ID,
      status: "running",
      lastHeartbeatAt: new Date().toISOString()
    };
    await redis.set("atlas:telegram-worker:heartbeat", JSON.stringify(heartbeat), "EX", 45);
  };

  void writeHeartbeat();
  return setInterval(() => void writeHeartbeat(), 15_000);
}

/**
 * Maintains a PostgreSQL lease so only one worker controls a Telegram account.
 */
export class AccountLease {
  private readonly prisma: PrismaClient;
  private readonly env: WorkerEnv;

  /**
   * Creates a lease manager.
   */
  public constructor(prisma: PrismaClient, env: WorkerEnv) {
    this.prisma = prisma;
    this.env = env;
  }

  /**
   * Attempts to acquire a lease for an account.
   */
  public async acquire(accountId: string): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.env.TELEGRAM_LEASE_SECONDS * 1000);
    const result = await this.prisma.telegramAccount.updateMany({
      where: {
        id: accountId,
        OR: [{ workerLeaseExpiresAt: null }, { workerLeaseExpiresAt: { lt: now } }, { workerLeaseOwner: this.env.TELEGRAM_WORKER_ID }]
      },
      data: {
        workerLeaseOwner: this.env.TELEGRAM_WORKER_ID,
        workerLeaseExpiresAt: expiresAt
      }
    });
    return result.count === 1;
  }

  /**
   * Attempts to acquire a lease, failing fast after timeoutMs.
   */
  public async acquireWithTimeout(accountId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (await this.acquire(accountId)) {
        return true;
      }
      if (await this.isOwnedByThisWorker(accountId)) {
        await this.renew(accountId);
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
    }
    return false;
  }

  /**
   * Renews an existing lease.
   */
  public async renew(accountId: string): Promise<void> {
    await this.prisma.telegramAccount.updateMany({
      where: { id: accountId, workerLeaseOwner: this.env.TELEGRAM_WORKER_ID },
      data: { workerLeaseExpiresAt: new Date(Date.now() + this.env.TELEGRAM_LEASE_SECONDS * 1000) }
    });
  }

  /**
   * Releases a lease owned by this worker.
   */
  public async release(accountId: string): Promise<void> {
    await this.prisma.telegramAccount.updateMany({
      where: { id: accountId, workerLeaseOwner: this.env.TELEGRAM_WORKER_ID },
      data: { workerLeaseOwner: null, workerLeaseExpiresAt: null }
    });
  }

  /**
   * Returns whether this worker currently owns the account lease.
   */
  public async isOwnedByThisWorker(accountId: string): Promise<boolean> {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, workerLeaseOwner: this.env.TELEGRAM_WORKER_ID },
      select: { id: true }
    });
    return Boolean(account);
  }
}
