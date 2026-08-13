/**
 * Explicit leaderboard participant backfill (Phase 5).
 *
 * Usage:
 *   pnpm --filter backend exec tsx src/modules/leaderboard/scripts/backfill-leaderboard-participants.ts --workspace <workspaceId> --dry-run
 *   pnpm --filter backend exec tsx src/modules/leaderboard/scripts/backfill-leaderboard-participants.ts --workspace <workspaceId> --owner <coadminUserId>
 *
 * Requires DATABASE_URL. Never run at app startup.
 */
import { PrismaClient } from "@prisma/client";
import { backfillLeaderboardParticipants } from "../backfill-participants";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const workspaceId = readArg("--workspace");
  if (!workspaceId) {
    console.error("Required: --workspace <workspaceId>");
    process.exitCode = 1;
    return;
  }
  const owner = readArg("--owner");
  const dryRun = hasFlag("--dry-run");
  const prisma = new PrismaClient();
  try {
    const result = await backfillLeaderboardParticipants(prisma, {
      workspaceId,
      dryRun,
      ...(owner !== undefined ? { ownerCoadminUserId: owner } : {})
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
