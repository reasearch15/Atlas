/**
 * Import the approved engagement question bank.
 *
 * Validate only (no database write):
 *   pnpm --filter @atlas/backend engagement:import-questions -- --file path/to/atlas_poll_question_bank_1000.xlsx --validate-only
 *
 * Import into the local/target database:
 *   pnpm --filter @atlas/backend engagement:import-questions -- --file path/to/atlas_poll_question_bank_1000.xlsx
 *
 * JSON remains supported:
 *   { externalId, category, question, options: [a,b,c,d], active? }
 *
 * If --file is omitted, the bundled approved workbook is used:
 *   apps/backend/src/modules/engagement/data/atlas_poll_question_bank_1000.xlsx
 *
 * Runtime cycle/use state lives in Postgres, not in the spreadsheet.
 * Never run at app startup. Import writes require DATABASE_URL.
 */
import { isAbsolute, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { EngagementService } from "../engagement.service";
import {
  assessQuestionBank,
  formatQuestionBankReport,
  QuestionBankValidationError
} from "../question-bank";
import {
  defaultApprovedQuestionBankPath,
  expectedCountForFile,
  loadQuestionBankFile
} from "../question-bank-file";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const specified = readArg("--file");
  const filePath = specified
    ? isAbsolute(specified)
      ? specified
      : resolve(process.cwd(), specified)
    : defaultApprovedQuestionBankPath();
  const validateOnly = hasFlag("--validate-only");
  const expectRaw = readArg("--expect-count");
  const explicitExpect = expectRaw != null ? Number(expectRaw) : undefined;
  if (expectRaw != null && (!Number.isInteger(explicitExpect) || (explicitExpect ?? 0) <= 0)) {
    throw new Error(`Invalid --expect-count: ${expectRaw}`);
  }

  const parsed = await loadQuestionBankFile(filePath);
  const assessment = assessQuestionBank(parsed.rows);
  const report = formatQuestionBankReport(assessment, {
    sheetName: parsed.sheetName,
    skippedBlank: parsed.skippedBlank
  });
  console.log(report);

  if (assessment.issues.length > 0) {
    throw new QuestionBankValidationError(assessment.issues);
  }

  const expected = expectedCountForFile(filePath, explicitExpect);
  if (expected != null && assessment.valid !== expected) {
    throw new Error(
      `Approved question bank must contain exactly ${expected} valid questions, found ${assessment.valid}`
    );
  }

  if (validateOnly) {
    console.log(
      JSON.stringify(
        {
          filePath,
          format: parsed.format,
          validateOnly: true,
          discovered: assessment.discovered,
          valid: assessment.valid,
          invalid: assessment.invalid,
          duplicateIds: assessment.duplicateIds
        },
        null,
        2
      )
    );
    return;
  }

  const prisma = new PrismaClient();
  try {
    const result = await new EngagementService(prisma).importQuestionBank(parsed.rows);
    console.log(JSON.stringify({ filePath, format: parsed.format, ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
