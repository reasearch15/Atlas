import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  APPROVED_QUESTION_BANK_COUNT,
  APPROVED_QUESTION_BANK_SHEET,
  isBlankQuestionInput,
  type EngagementQuestionInput
} from "./question-bank";

export interface QuestionBankFileParse {
  readonly filePath: string;
  readonly format: "xlsx" | "json";
  readonly sheetName: string | null;
  readonly skippedBlank: number;
  readonly rows: EngagementQuestionInput[];
}

type HeaderField = "externalId" | "category" | "question" | "active" | "option0" | "option1" | "option2" | "option3";

const HEADER_ALIASES: Record<string, HeaderField> = {
  id: "externalId",
  "question id": "externalId",
  questionid: "externalId",
  externalid: "externalId",
  "external id": "externalId",
  category: "category",
  question: "question",
  prompt: "question",
  active: "active",
  "option a": "option0",
  "option b": "option1",
  "option c": "option2",
  "option d": "option3",
  "option 1": "option0",
  "option 2": "option1",
  "option 3": "option2",
  "option 4": "option3",
  option1: "option0",
  option2: "option1",
  option3: "option2",
  option4: "option3"
};

export function defaultApprovedQuestionBankPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "data/atlas_poll_question_bank_1000.xlsx");
}

export function isApprovedQuestionBankPath(filePath: string): boolean {
  return /atlas_poll_question_bank_1000\.xlsx$/i.test(filePath.replace(/\\/g, "/"));
}

export function expectedCountForFile(filePath: string, explicit?: number): number | undefined {
  if (explicit != null) return explicit;
  if (isApprovedQuestionBankPath(filePath)) return APPROVED_QUESTION_BANK_COUNT;
  return undefined;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function cellText(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value.trim();
  if (value instanceof Date) {
    throw new Error("Question bank cells must be text, not dates");
  }
  return String(value).trim();
}

function parseActive(value: string): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  if (["false", "0", "no", "n", "inactive"].includes(normalized)) return false;
  return true;
}

function mapHeaders(values: unknown[]): Map<HeaderField, number> {
  const mapped = new Map<HeaderField, number>();
  values.forEach((value, index) => {
    const alias = HEADER_ALIASES[normalizeHeader(value)];
    if (alias && !mapped.has(alias)) mapped.set(alias, index);
  });
  const missing: string[] = [];
  if (!mapped.has("externalId")) missing.push("ID");
  if (!mapped.has("category")) missing.push("Category");
  if (!mapped.has("question")) missing.push("Question");
  for (const [label, field] of [
    ["Option A", "option0"],
    ["Option B", "option1"],
    ["Option C", "option2"],
    ["Option D", "option3"]
  ] as const) {
    if (!mapped.has(field)) missing.push(label);
  }
  if (missing.length > 0) {
    const found = values.map((value) => cellText(value)).filter(Boolean).join(", ");
    throw new Error(
      `Unsupported question-bank structure: missing ${missing.join(", ")}. Found headers: ${found || "(none)"}`
    );
  }
  return mapped;
}

function rowFromCells(cells: unknown[], headers: Map<HeaderField, number>): EngagementQuestionInput {
  const at = (field: HeaderField): string => {
    const index = headers.get(field);
    return index == null ? "" : cellText(cells[index]);
  };
  return {
    externalId: at("externalId"),
    category: at("category"),
    question: at("question"),
    options: [at("option0"), at("option1"), at("option2"), at("option3")],
    ...(headers.has("active") ? { active: parseActive(at("active")) } : {})
  };
}

function chooseSheetName(workbook: XLSX.WorkBook): string {
  const named = workbook.SheetNames.find(
    (name) => name.trim().toLowerCase() === APPROVED_QUESTION_BANK_SHEET.toLowerCase()
  );
  if (named) return named;
  const usable = workbook.SheetNames.find((name) => name.trim().toLowerCase() !== "readme");
  if (!usable) throw new Error("Workbook has no question sheet");
  return usable;
}

export function parseXlsxBuffer(buffer: Buffer, filePath = "workbook.xlsx"): QuestionBankFileParse {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, raw: true });
  const sheetName = chooseSheetName(workbook);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet ${sheetName} is missing`);
  const table = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true
  });
  const rows: EngagementQuestionInput[] = [];
  let skippedBlank = 0;
  let headers: Map<HeaderField, number> | null = null;

  for (const raw of table) {
    const cells = Array.isArray(raw) ? raw : [];
    if (!headers) {
      if (cells.every((cell) => !cellText(cell))) continue;
      headers = mapHeaders(cells);
      continue;
    }
    const parsed = rowFromCells(cells, headers);
    if (isBlankQuestionInput(parsed)) {
      skippedBlank += 1;
      continue;
    }
    rows.push(parsed);
  }

  if (!headers) {
    throw new Error(`Sheet ${sheetName} has no header row`);
  }

  return {
    filePath,
    format: "xlsx",
    sheetName,
    skippedBlank,
    rows
  };
}

export function parseJsonQuestionBank(text: string, filePath = "questions.json"): QuestionBankFileParse {
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Question bank JSON must be an array: ${filePath}`);
  }
  const rows: EngagementQuestionInput[] = [];
  let skippedBlank = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error(`Question bank JSON rows must be objects: ${filePath}`);
    }
    const record = item as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options.map((option) => String(option ?? ""))
      : [];
    const row: EngagementQuestionInput = {
      externalId: String(record.externalId ?? ""),
      category: String(record.category ?? ""),
      question: String(record.question ?? ""),
      options,
      ...(record.active === false ? { active: false } : {})
    };
    if (isBlankQuestionInput(row)) {
      skippedBlank += 1;
      continue;
    }
    rows.push(row);
  }
  return {
    filePath,
    format: "json",
    sheetName: null,
    skippedBlank,
    rows
  };
}

export async function loadQuestionBankFile(filePath: string): Promise<QuestionBankFileParse> {
  const ext = extname(filePath).toLowerCase();
  const buffer = readFileSync(filePath);
  if (ext === ".xlsx" || ext === ".xlsm") {
    return parseXlsxBuffer(buffer, filePath);
  }
  if (ext === ".json") {
    return parseJsonQuestionBank(buffer.toString("utf8"), filePath);
  }
  throw new Error(`Unsupported question-bank file type: ${ext || "(none)"}. Use .xlsx or .json`);
}
