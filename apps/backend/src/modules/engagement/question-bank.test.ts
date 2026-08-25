import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  QuestionBankValidationError,
  assessQuestionBank,
  shuffleIds,
  validateQuestionBank,
  type EngagementQuestionInput
} from "./question-bank";
import { defaultApprovedQuestionBankPath, parseJsonQuestionBank, parseXlsxBuffer } from "./question-bank-file";

function sample(overrides: Partial<EngagementQuestionInput> = {}): EngagementQuestionInput {
  return {
    externalId: "1",
    category: "Food & Drinks",
    question: "Which would you pick right now?",
    options: ["Coffee", "Wings", "Pizza", "Smoothies"],
    active: true,
    ...overrides
  };
}

function xlsxFromRows(
  rows: ReadonlyArray<readonly unknown[]>,
  options?: { readonly sheetName?: string; readonly extraBlankRows?: number; readonly headers?: string[] }
): Buffer {
  const workbook = XLSX.utils.book_new();
  const header = options?.headers ?? ["ID", "Category", "Question", "Option A", "Option B", "Option C", "Option D"];
  const table: unknown[][] = [header, ...rows.map((row) => [...row])];
  for (let i = 0; i < (options?.extraBlankRows ?? 0); i += 1) table.push(["", "", "", "", "", "", ""]);
  const sheet = XLSX.utils.aoa_to_sheet(table);
  XLSX.utils.book_append_sheet(workbook, sheet, options?.sheetName ?? "Poll Questions");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("question bank validation", () => {
  it("accepts valid approved-bank shaped rows", () => {
    const rows = [
      sample({ externalId: "q-001" }),
      sample({ externalId: "q-002", question: "Which one wins?", options: ["A", "B", "C", "D"] })
    ];
    const validated = validateQuestionBank(rows);
    expect(validated).toHaveLength(2);
    expect(new Set(validated.map((row) => row.externalId)).size).toBe(2);
  });

  it("rejects duplicate external IDs", () => {
    expect(() => validateQuestionBank([sample(), sample({ question: "Other prompt" })])).toThrow(
      QuestionBankValidationError
    );
    const assessment = assessQuestionBank([sample(), sample({ question: "Other prompt" })]);
    expect(assessment.duplicateIds).toEqual(["1"]);
    expect(assessment.invalid).toBe(1);
  });

  it("rejects malformed rows", () => {
    expect(() =>
      validateQuestionBank([
        sample({ options: ["Only one"] }),
        sample({ externalId: "2", question: "" }),
        sample({ externalId: "3", options: ["A", "B", "C", "A"] })
      ])
    ).toThrow(/issue/);
  });

  it("rejects overlong button text instead of truncating", () => {
    expect(() =>
      validateQuestionBank([
        sample({
          options: ["ok", "ok2", "ok3", "x".repeat(65)]
        })
      ])
    ).toThrow(/64 characters/);
  });
});

describe("xlsx and json question-bank import", () => {
  it("parses a valid xlsx workbook and preserves category plus option order", () => {
    const buffer = xlsxFromRows([
      [7, "Travel", "Where would you go?", "Paris", "Tokyo", "Rome", "Cairo"]
    ]);
    const parsed = parseXlsxBuffer(buffer);
    expect(parsed.sheetName).toBe("Poll Questions");
    expect(parsed.rows).toEqual([
      {
        externalId: "7",
        category: "Travel",
        question: "Where would you go?",
        options: ["Paris", "Tokyo", "Rome", "Cairo"]
      }
    ]);
    const validated = validateQuestionBank(parsed.rows);
    expect(validated[0]).toMatchObject({
      option1: "Paris",
      option2: "Tokyo",
      option3: "Rome",
      option4: "Cairo",
      category: "Travel"
    });
  });

  it("ignores blank trailing Excel rows", () => {
    const buffer = xlsxFromRows([[1, "Cat", "Pick one?", "A", "B", "C", "D"]], { extraBlankRows: 8 });
    const parsed = parseXlsxBuffer(buffer);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.question).toBe("Pick one?");
  });

  it("rejects duplicate IDs in an xlsx workbook", () => {
    const buffer = xlsxFromRows([
      [1, "Cat", "Pick one?", "A", "B", "C", "D"],
      [1, "Cat", "Pick another?", "E", "F", "G", "H"]
    ]);
    const parsed = parseXlsxBuffer(buffer);
    expect(() => validateQuestionBank(parsed.rows)).toThrow(/duplicate externalId 1/);
  });

  it("rejects a missing question", () => {
    const buffer = xlsxFromRows([[1, "Cat", "", "A", "B", "C", "D"]]);
    const parsed = parseXlsxBuffer(buffer);
    expect(() => validateQuestionBank(parsed.rows)).toThrow(/question is required/);
  });

  it("rejects a missing option", () => {
    const buffer = xlsxFromRows([[1, "Cat", "Pick one?", "A", "B", "C", ""]]);
    const parsed = parseXlsxBuffer(buffer);
    expect(() => validateQuestionBank(parsed.rows)).toThrow(/option 4 is required/);
  });

  it("rejects an unsupported header structure", () => {
    const buffer = xlsxFromRows([[1, "x"]], { headers: ["Nope", "Wrong"] });
    expect(() => parseXlsxBuffer(buffer)).toThrow(/Unsupported question-bank structure/);
  });

  it("still accepts the documented JSON shape", () => {
    const parsed = parseJsonQuestionBank(
      JSON.stringify([
        {
          externalId: "9",
          category: "Food",
          question: "What sounds good?",
          options: ["Soup", "Salad", "Bread", "Fruit"]
        }
      ])
    );
    expect(parsed.rows[0]?.options).toEqual(["Soup", "Salad", "Bread", "Fruit"]);
  });

  it("validates the approved 1,000-question workbook exactly", () => {
    const buffer = readFileSync(defaultApprovedQuestionBankPath());
    const parsed = parseXlsxBuffer(buffer, defaultApprovedQuestionBankPath());
    const assessment = assessQuestionBank(parsed.rows);
    expect(parsed.sheetName).toBe("Poll Questions");
    expect(assessment.discovered).toBe(1000);
    expect(assessment.valid).toBe(1000);
    expect(assessment.invalid).toBe(0);
    expect(assessment.duplicateIds).toEqual([]);
    expect(assessment.validated[0]).toMatchObject({
      externalId: "1",
      category: "Food & Drinks",
      question: "Which would you pick right now?",
      option1: "Coffee",
      option2: "Wings",
      option3: "Pizza",
      option4: "Smoothies"
    });
    expect(assessment.validated[999]).toMatchObject({
      externalId: "1000",
      category: "Would You Rather",
      question: "Which option wins for you?",
      option1: "Meet your favorite celebrity",
      option2: "Have a personal trainer",
      option3: "Own an RV",
      option4: "Be an amazing dancer"
    });
    const shuffled = shuffleIds(
      assessment.validated.map((row) => row.externalId),
      () => 0.73
    );
    expect(shuffled.slice(0, 5)).not.toEqual(["1", "2", "3", "4", "5"]);
    expect([...shuffled].sort((a, b) => Number(a) - Number(b))).toEqual(
      assessment.validated.map((row) => row.externalId)
    );
  });
});
