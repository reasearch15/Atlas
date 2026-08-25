/**
 * Explicit ACTIVE deposit-scoring reconciliation ($5=1 → $1=1).
 *
 * Usage (ops/deploy — not run automatically by the API):
 *   pnpm --filter backend exec tsx src/modules/leaderboard/scripts/reconcile-active-deposit-scoring.ts --owner <coadminUserId>
 *   pnpm --filter backend exec tsx src/modules/leaderboard/scripts/reconcile-active-deposit-scoring.ts --owner <coadminUserId> --competition <competitionId>
 *
 * Requires DATABASE_URL. Safe to re-run (idempotent per competition+contact).
 * Does NOT apply itself during normal request handling.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaLeaderboardService } from "../leaderboard.prisma-service";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const owner = readArg("--owner");
  if (!owner) {
    console.error("Required: --owner <ownerCoadminUserId>");
    process.exitCode = 1;
    return;
  }
  const competitionId = readArg("--competition");
  const prisma = new PrismaClient();
  try {
    const service = new PrismaLeaderboardService(prisma);
    const result = await service.reconcileActiveDepositScoring({
      ownerCoadminUserId: owner,
      ...(competitionId ? { competitionId } : {}),
      actorUserId: null
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
