/**
 * Reconcile public leaderboard display names from linked Telegram identity.
 *
 * Dry-run (default):
 *   pnpm --filter @atlas/backend leaderboard:reconcile-public-names
 *   pnpm --filter @atlas/backend leaderboard:reconcile-public-names -- --workspace <workspaceId>
 *
 * Apply:
 *   CONFIRM_APPLY=YES pnpm --filter @atlas/backend leaderboard:reconcile-public-names
 *
 * Requires DATABASE_URL. Never runs at app startup. Updates only weak/placeholder
 * crm_contacts.display_name values. Does not change points, ranks, deposits,
 * standings, competition data, Telegram IDs, or participant IDs.
 */
import { PrismaClient } from "@prisma/client";
import { reconcileLeaderboardPublicNames } from "../reconcile-leaderboard-public-names";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const workspaceId = readArg("--workspace");
  const ownerCoadminUserId = readArg("--owner");
  const limitRaw = readArg("--limit");
  const dryRun = process.env.CONFIRM_APPLY !== "YES";
  const prisma = new PrismaClient();
  try {
    const result = await reconcileLeaderboardPublicNames(prisma, {
      dryRun,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(ownerCoadminUserId !== undefined ? { ownerCoadminUserId } : {}),
      ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
      logger: {
        info: (obj, msg) => {
          console.log(JSON.stringify({ msg, ...(obj as object) }));
        }
      }
    });
    console.log(JSON.stringify(result, null, 2));
    if (dryRun) {
      console.log("Dry-run only. Set CONFIRM_APPLY=YES to write recovered CRM display names.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
