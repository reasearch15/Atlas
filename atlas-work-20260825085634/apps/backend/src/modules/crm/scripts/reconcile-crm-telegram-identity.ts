/**
 * Controlled CRM identity reconciliation from persisted telegram_chats.
 *
 * Dry-run (default):
 *   pnpm --filter @atlas/backend crm:reconcile-identity
 *   pnpm --filter @atlas/backend crm:reconcile-identity -- --workspace <workspaceId>
 *
 * Apply:
 *   CONFIRM_APPLY=YES pnpm --filter @atlas/backend crm:reconcile-identity
 *
 * Requires DATABASE_URL. Never runs at app startup. Does not change
 * crm_contact_id links, leaderboard ownership, or referral ownership.
 */
import { PrismaClient } from "@prisma/client";
import { reconcileCrmTelegramIdentities } from "../reconcile-crm-telegram-identity";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const workspaceId = readArg("--workspace");
  const limitRaw = readArg("--limit");
  const dryRun = process.env.CONFIRM_APPLY !== "YES";
  const prisma = new PrismaClient();
  try {
    const result = await reconcileCrmTelegramIdentities(prisma, {
      dryRun,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {})
    });
    console.log(JSON.stringify(result, null, 2));
    if (dryRun) {
      console.log("Dry-run only. Set CONFIRM_APPLY=YES to write placeholder CRM identities.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
