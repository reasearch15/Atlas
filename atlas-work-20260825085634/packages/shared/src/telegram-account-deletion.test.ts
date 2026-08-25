import { describe, expect, it } from "vitest";
import { buildTelegramAccountDeleteConfirmation } from "@atlas/shared";

describe("buildTelegramAccountDeleteConfirmation", () => {
  it("normalizes @username to DELETE TOKEN", () => {
    expect(buildTelegramAccountDeleteConfirmation({ telegramUsername: "Piccaso47", displayName: "Other" })).toBe("DELETE PICCASO47");
    expect(buildTelegramAccountDeleteConfirmation({ telegramUsername: "@Piccaso47", displayName: "Other" })).toBe("DELETE PICCASO47");
  });

  it("falls back to display name when username is missing", () => {
    expect(buildTelegramAccountDeleteConfirmation({ telegramUsername: null, displayName: "Support Line" })).toBe("DELETE SUPPORTLINE");
  });
});
