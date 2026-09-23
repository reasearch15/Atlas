import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { LeaderboardTelegramOutboxService } from "../telegram/leaderboard-telegram.outbox";
import { WinnerAnnouncementRecoveryService } from "../telegram/winner-announcement-recovery";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const explicitDryRun = args.includes("--dry-run");
if (execute && explicitDryRun)
  throw new Error("Choose either --dry-run or --execute");
const lookbackDays = numberArg(args, "--lookback-days") ?? 30;
const competitionId = stringArg(args, "--competition-id");
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl)
  throw new Error("DATABASE_URL and REDIS_URL are required");

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue("leaderboard-telegram", { connection: redis });
const outbox = new LeaderboardTelegramOutboxService(
  prisma,
  LeaderboardTelegramOutboxService.createWakeFromQueue(queue),
);

try {
  const report = await new WinnerAnnouncementRecoveryService(
    prisma,
    outbox,
  ).inspect({
    lookbackDays,
    ...(competitionId ? { competitionId } : {}),
    execute,
  });
  console.table(report);
  console.log(
    JSON.stringify({
      mode: execute ? "EXECUTE" : "DRY_RUN",
      lookbackDays,
      competitionId: competitionId ?? null,
      count: report.length,
    }),
  );
} finally {
  await queue.close();
  await redis.quit();
  await prisma.$disconnect();
}

function stringArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function numberArg(values: string[], name: string): number | undefined {
  const value = stringArg(values, name);
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}
