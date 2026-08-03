import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts");

const mjsScripts = [
  "backfill-telegram-identity.mjs",
  "inbox-diagnostics.mjs",
  "cleanup-telegram-service-chats.mjs"
];

describe("backend operational .mjs scripts", () => {
  it("pass node --check (plain ESM JavaScript, no TypeScript syntax)", () => {
    for (const name of mjsScripts) {
      const scriptPath = path.join(scriptsDir, name);
      expect(() => {
        execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" });
      }).not.toThrow();
    }
  });
});
