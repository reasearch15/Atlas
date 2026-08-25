import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";
import { loadPlatformAdminSummary, resetPlatformAdminCredentials } from "./admin-recovery.service";

const prisma = new PrismaClient();

/**
 * Prompts for sensitive input without echoing typed characters.
 */
async function promptHidden(label: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  let value = "";
  output.write(label);
  stdin.setRawMode?.(true);

  return new Promise((resolve) => {
    function onData(buffer: Buffer): void {
      const char = buffer.toString("utf8");
      if (char === "\r" || char === "\n") {
        stdin.setRawMode?.(wasRaw);
        stdin.off("data", onData);
        output.write("\n");
        rl.close();
        resolve(value);
        return;
      }
      if (char === "\u0003") {
        stdin.setRawMode?.(wasRaw);
        process.exit(130);
      }
      if (char === "\b" || char === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    }
    stdin.on("data", onData);
  });
}

/**
 * Runs the local-only Platform Admin credential recovery command.
 */
async function main(): Promise<void> {
  loadEnv();
  if (process.argv.slice(2).length > 0) {
    throw new Error("admin:reset does not accept command-line arguments.");
  }

  const admin = await loadPlatformAdminSummary(prisma);
  output.write(`Existing Platform Admin: ${admin.email}\n`);

  const rl = readline.createInterface({ input, output });
  const emailAnswer = await rl.question("New admin email (leave blank to keep current): ");
  rl.close();
  const nextEmail = emailAnswer.trim() ? emailAnswer.trim().toLowerCase() : undefined;
  const password = await promptHidden("New password: ");
  const confirmPassword = await promptHidden("Confirm password: ");
  if (password !== confirmPassword) {
    throw new Error("Passwords do not match.");
  }

  const confirmationRl = readline.createInterface({ input, output });
  const confirmation = await confirmationRl.question(`Type RESET ${admin.email} to revoke all admin access and apply the new credentials: `);
  confirmationRl.close();
  if (confirmation !== `RESET ${admin.email}`) {
    throw new Error("Confirmation did not match. No changes were applied.");
  }

  const result = await resetPlatformAdminCredentials(prisma, nextEmail ? { email: nextEmail, password } : { password });
  output.write(`Platform Admin credentials reset for ${result.email}.\n`);
  output.write(
    `Revoked ${result.revokedSessionCount} sessions, ${result.revokedTrustedDeviceCount} trusted devices, and ${result.consumedChallengeCount} active challenges.\n`
  );
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    output.write(`${error instanceof Error ? error.message : "Admin reset failed."}\n`);
    process.exit(1);
  });
