import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";
import { assertOrphanPlatformAdminCleanupAllowed, cleanOrphanPlatformAdminUsers, inspectOrphanPlatformAdminUsers } from "./admin-orphan-cleanup.service";

const prisma = new PrismaClient();

/**
 * Runs the local-only orphan Platform Admin cleanup command.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  assertOrphanPlatformAdminCleanupAllowed(env.NODE_ENV);

  const plan = await inspectOrphanPlatformAdminUsers(prisma);
  output.write(`Canonical Platform Admin count: ${plan.platformAdminCount}\n`);
  output.write(`Canonical Platform Admin email: ${plan.platformAdminEmail ?? "none"}\n`);

  if (plan.orphanUsers.length === 0) {
    output.write("No orphan Platform Admin users found.\n");
    return;
  }

  output.write("Orphan Platform Admin users to remove:\n");
  for (const user of plan.orphanUsers) {
    output.write(
      `- ${user.email ?? user.id} (${user.id}) status=${user.status} sessions=${user.sessionCount} activeSessions=${user.activeSessionCount} trustedDevices=${user.trustedDeviceCount} auditLogs=${user.auditLogCount} createdAt=${user.createdAt.toISOString()}\n`
    );
  }

  const rl = readline.createInterface({ input, output });
  const answer = await rl.question('Type "cleanup orphan platform admins" to continue: ');
  rl.close();
  if (answer !== "cleanup orphan platform admins") {
    throw new Error("Confirmation did not match. Cleanup aborted.");
  }

  await cleanOrphanPlatformAdminUsers(prisma);
  output.write(`Removed ${plan.orphanUsers.length} orphan Platform Admin user(s).\n`);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    output.write(`${error instanceof Error ? error.message : "Orphan cleanup failed."}\n`);
    process.exit(1);
  });
