import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";
import { assertFixtureCleanupAllowed, cleanDevelopmentFixtures, loadFixtureCleanupPlan, type FixtureCleanupPlan } from "./fixtures-clean.service";

const prisma = new PrismaClient();

/**
 * Runs the local-only development fixture cleanup command.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  assertFixtureCleanupAllowed(env.NODE_ENV);
  if (process.argv.slice(2).length > 0) {
    throw new Error("fixtures:clean does not accept command-line arguments.");
  }

  const plan = await loadFixtureCleanupPlan(prisma);
  output.write("Development fixture cleanup plan:\n");
  printPlan(plan);

  const total = Object.values(plan).reduce((sum, records) => sum + records.length, 0);
  if (total === 0) {
    output.write("No development fixture records found.\n");
    return;
  }

  const confirmationText = "DELETE DEVELOPMENT FIXTURES";
  const rl = readline.createInterface({ input, output });
  const confirmation = await rl.question(`Type ${confirmationText} to permanently remove these local fixture records: `);
  rl.close();
  if (confirmation !== confirmationText) {
    throw new Error("Confirmation did not match. No fixture records were removed.");
  }

  const result = await cleanDevelopmentFixtures(prisma);
  output.write("Development fixture cleanup complete.\n");
  for (const [category, count] of Object.entries(result.deleted)) {
    output.write(`${category}: ${count}\n`);
  }
}

function printPlan(plan: FixtureCleanupPlan): void {
  for (const [category, records] of Object.entries(plan)) {
    output.write(`${category}: ${records.length}\n`);
    for (const record of records) {
      output.write(`  - ${record.label} [${record.id}]\n`);
    }
  }
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch((error) => {
    output.write(`${error instanceof Error ? error.message : "Fixture cleanup failed."}\n`);
    process.exit(1);
  });
