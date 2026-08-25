import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QuestionBankValidationError, validateQuestionBank, type EngagementQuestionInput } from "./question-bank";

const bankPath = resolve(dirname(fileURLToPath(import.meta.url)), "data/question-bank.1000.json");

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

describe("question bank validation", () => {
  it("accepts the approved 1000-question JSON bank", () => {
    const rows = JSON.parse(readFileSync(bankPath, "utf8")) as EngagementQuestionInput[];
    const validated = validateQuestionBank(rows);
    expect(validated).toHaveLength(1000);
    expect(new Set(validated.map((row) => row.externalId)).size).toBe(1000);
  });

  it("rejects duplicate external IDs", () => {
    expect(() => validateQuestionBank([sample(), sample({ question: "Other prompt" })])).toThrow(
      QuestionBankValidationError
    );
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
