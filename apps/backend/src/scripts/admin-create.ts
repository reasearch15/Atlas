import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";
import { AuditService } from "../modules/audit/audit.service";

const prisma = new PrismaClient();

/**
 * Prompts for sensitive input without echoing characters to the terminal.
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
 * Creates the first Platform Admin through a secure one-time bootstrap process.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const rl = readline.createInterface({ input, output });
  const defaultEmail = env.BOOTSTRAP_ADMIN_EMAIL;
  const emailAnswer = await rl.question(`Admin email${defaultEmail ? ` (${defaultEmail})` : ""}: `);
  const email = (emailAnswer || defaultEmail || "").trim().toLowerCase();
  rl.close();

  const password =
    env.NODE_ENV !== "production" && env.BOOTSTRAP_ADMIN_PASSWORD ? env.BOOTSTRAP_ADMIN_PASSWORD : await promptHidden("Admin password: ");
  const confirm =
    env.NODE_ENV !== "production" && env.BOOTSTRAP_ADMIN_PASSWORD ? env.BOOTSTRAP_ADMIN_PASSWORD : await promptHidden("Confirm password: ");

  if (!email || !email.includes("@")) {
    throw new Error("A valid admin email is required.");
  }
  if (password.length < 12) {
    throw new Error("Admin password must be at least 12 characters.");
  }
  if (password !== confirm) {
    throw new Error("Passwords do not match.");
  }

  const existing = await prisma.platformAdmin.count();
  if (existing > 0) {
    throw new Error("A Platform Admin already exists. Bootstrap is one-time only.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const adminUser = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        name: "Platform Admin",
        role: "PLATFORM_ADMIN",
        status: "ACTIVE",
        passwordHash
      }
    });
    await tx.platformAdmin.create({
      data: {
        userId: user.id,
        email,
        passwordHash,
        status: "ACTIVE"
      }
    });
    return user;
  });

  await new AuditService(prisma).record({
    workspaceId: null,
    actorId: adminUser.id,
    action: "admin_auth.bootstrap.created",
    metadata: { method: "cli" }
  });

  output.write(`Platform Admin created for ${email}.\n`);
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    output.write(`${error instanceof Error ? error.message : "Admin bootstrap failed."}\n`);
    process.exit(1);
  });
