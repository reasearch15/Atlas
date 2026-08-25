/**
 * Import the approved engagement question bank.
 *
 * Default (checked-in conversion of the approved 1,000-row XLSX):
 *   pnpm --filter @atlas/backend engagement:import-questions
 *
 * Custom JSON:
 *   pnpm --filter @atlas/backend engagement:import-questions -- --file path/to/questions.json
 *
 * Expected JSON: array of
 *   { externalId, category, question, options: [a,b,c,d], active? }
 *
 * Expected XLSX columns (convert to the JSON shape above before import):
 *   ID, Category, Question, Option A, Option B, Option C, Option D
 *   optional Active (true/false; default true)
 *
 * Runtime cycle/use state lives in Postgres, not in the spreadsheet.
 * Never run at app startup. Requires DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { EngagementService } from "../engagement.service";
import type { EngagementQuestionInput } from "../question-bank";

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function defaultBankPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../data/question-bank.1000.json");
}

async function main(): Promise<void> {
  const specified = readArg("--file");
  const filePath = specified
    ? isAbsolute(specified)
      ? specified
      : resolve(process.cwd(), specified)
    : defaultBankPath();
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Question bank file must be a JSON array: ${filePath}`);
  }
  const rows = parsed as EngagementQuestionInput[];
  const prisma = new PrismaClient();
  try {
    const result = await new EngagementService(prisma).importQuestionBank(rows);
    console.log(JSON.stringify({ filePath, ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
