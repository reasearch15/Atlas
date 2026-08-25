/**
 * One-time ops: remove a settled legacy callback poll from the channel and post
 * the next scheduled slot early as an anonymous native Telegram poll.
 *
 *   pnpm --filter @atlas/backend engagement:replace-legacy-poll -- --owner <uuid>
 */
import { PrismaClient } from "@prisma/client";
import { decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import { HttpLeaderboardTelegramClient } from "../../leaderboard/telegram/leaderboard-telegram.client";
import { EngagementService } from "../engagement.service";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const ownerCoadminUserId = readArg("--owner");
  if (!ownerCoadminUserId) {
    throw new Error("--owner <coadmin-user-id> is required");
  }
  const encryptionKey = process.env.TELEGRAM_SESSION_ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("TELEGRAM_SESSION_ENCRYPTION_KEY is required");
  }

  const prisma = new PrismaClient();
  const client = new HttpLeaderboardTelegramClient();
  try {
    const integration = await prisma.leaderboardBotIntegration.findUnique({
      where: { ownerCoadminUserId }
    });
    if (!integration?.encryptedBotToken) {
      throw new Error("Leaderboard bot integration not found for owner");
    }
    const token = decryptSecret(integration.encryptedBotToken as unknown as EncryptedSecret, encryptionKey);
    const service = new EngagementService(prisma);
    const result = await service.replaceLegacyVisiblePoll({
      ownerCoadminUserId,
      client,
      token
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
