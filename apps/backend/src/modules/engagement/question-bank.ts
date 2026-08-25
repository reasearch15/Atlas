import {
  TELEGRAM_BUTTON_MAX,
  TELEGRAM_QUESTION_MAX
} from "./engagement.constants";

export const APPROVED_QUESTION_BANK_COUNT = 1000;
export const APPROVED_QUESTION_BANK_SHEET = "Poll Questions";

export interface EngagementQuestionInput {
  readonly externalId: string;
  readonly category: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly active?: boolean;
}

export interface ValidatedEngagementQuestion {
  readonly externalId: string;
  readonly category: string;
  readonly question: string;
  readonly option1: string;
  readonly option2: string;
  readonly option3: string;
  readonly option4: string;
  readonly active: boolean;
}

export class QuestionBankValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Question bank validation failed (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${issues.join("\n")}`
    );
    this.name = "QuestionBankValidationError";
    this.issues = issues;
  }
}

export interface QuestionBankAssessment {
  readonly discovered: number;
  readonly valid: number;
  readonly invalid: number;
  readonly duplicateIds: readonly string[];
  readonly issues: readonly string[];
  readonly validated: readonly ValidatedEngagementQuestion[];
}

function cleanText(value: unknown, field: string, issues: string[], row: string): string {
  if (value == null || typeof value !== "string" || !value.trim()) {
    issues.push(`${row}: ${field} is required`);
    return "";
  }
  const trimmed = value.trim();
  if (/\r|\n|\t/.test(trimmed)) {
    issues.push(`${row}: ${field} must be a single line`);
  }
  return trimmed;
}

export function isBlankQuestionInput(row: EngagementQuestionInput): boolean {
  const options = Array.isArray(row.options) ? row.options : [];
  return (
    !String(row.externalId ?? "").trim() &&
    !String(row.category ?? "").trim() &&
    !String(row.question ?? "").trim() &&
    options.every((option) => !String(option ?? "").trim())
  );
}

export function assessQuestionBank(rows: readonly EngagementQuestionInput[]): QuestionBankAssessment {
  const issues: string[] = [];
  const seen = new Map<string, number>();
  const duplicateIds: string[] = [];
  const validated: ValidatedEngagementQuestion[] = [];
  let invalid = 0;

  rows.forEach((row, index) => {
    const label = `row ${index + 1} (id ${row.externalId ?? "?"})`;
    const before = issues.length;
    const externalId = cleanText(row.externalId, "externalId", issues, label);
    if (externalId) {
      const previous = seen.get(externalId);
      if (previous != null) {
        issues.push(`${label}: duplicate externalId ${externalId} (first seen at row ${previous})`);
        if (!duplicateIds.includes(externalId)) duplicateIds.push(externalId);
      } else {
        seen.set(externalId, index + 1);
      }
    }
    const category = cleanText(row.category, "category", issues, label);
    const question = cleanText(row.question, "question", issues, label);
    if (question.length > TELEGRAM_QUESTION_MAX) {
      issues.push(`${label}: question exceeds ${TELEGRAM_QUESTION_MAX} characters (${question.length})`);
    }
    const options = Array.isArray(row.options) ? row.options : [];
    if (options.length !== 4) {
      issues.push(`${label}: expected exactly 4 options, got ${options.length}`);
    }
    const cleanedOptions = [0, 1, 2, 3].map((i) =>
      cleanText(options[i], `option ${i + 1}`, issues, label)
    );
    const nonempty = cleanedOptions.filter(Boolean);
    if (new Set(nonempty.map((o) => o.toLowerCase())).size !== nonempty.length) {
      issues.push(`${label}: options must be unique`);
    }
    for (const [i, option] of cleanedOptions.entries()) {
      if (option.length > TELEGRAM_BUTTON_MAX) {
        issues.push(`${label}: option ${i + 1} exceeds ${TELEGRAM_BUTTON_MAX} characters (${option.length})`);
      }
    }
    if (issues.length > before) {
      invalid += 1;
      return;
    }
    validated.push({
      externalId,
      category,
      question,
      option1: cleanedOptions[0] ?? "",
      option2: cleanedOptions[1] ?? "",
      option3: cleanedOptions[2] ?? "",
      option4: cleanedOptions[3] ?? "",
      active: row.active !== false
    });
  });

  return {
    discovered: rows.length,
    valid: validated.length,
    invalid,
    duplicateIds,
    issues,
    validated
  };
}

export function validateQuestionBank(rows: readonly EngagementQuestionInput[]): ValidatedEngagementQuestion[] {
  const assessment = assessQuestionBank(rows);
  if (assessment.issues.length > 0) {
    throw new QuestionBankValidationError(assessment.issues);
  }
  return [...assessment.validated];
}

export function formatQuestionBankReport(
  assessment: QuestionBankAssessment,
  extras?: { readonly sheetName?: string | null; readonly skippedBlank?: number }
): string {
  const lines = [
    `Questions discovered: ${assessment.discovered}`,
    `Valid: ${assessment.valid}`,
    `Invalid: ${assessment.invalid}`,
    `Duplicate IDs: ${assessment.duplicateIds.length}`
  ];
  if (extras?.sheetName) lines.push(`Sheet: ${extras.sheetName}`);
  if (extras?.skippedBlank != null) lines.push(`Blank rows skipped: ${extras.skippedBlank}`);
  if (assessment.issues.length > 0) {
    lines.push("", "Issues:", ...assessment.issues);
  }
  return lines.join("\n");
}

export function shuffleIds<T>(items: readonly T[], random = Math.random): T[] {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = next[i]!;
    next[i] = next[j]!;
    next[j] = tmp;
  }
  return next;
}
