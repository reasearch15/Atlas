import { stdout as output } from "node:process";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";
import { loadPlatformAdminSummary } from "./admin-recovery.service";

const prisma = new PrismaClient();

/**
 * Displays non-secret Platform Admin recovery information.
 */
async function main(): Promise<void> {
  loadEnv();
  if (process.argv.slice(2).length > 0) {
    throw new Error("admin:show does not accept command-line arguments.");
  }

  const admin = await loadPlatformAdminSummary(prisma);
  output.write(`Admin email: ${admin.email}\n`);
  output.write(`Status: ${admin.status}\n`);
  output.write(`Created: ${admin.createdAt.toISOString()}\n`);
  output.write(`Last login: ${admin.lastLoginAt ? admin.lastLoginAt.toISOString() : "never"}\n`);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    output.write(`${error instanceof Error ? error.message : "Admin show failed."}\n`);
    process.exit(1);
  });
