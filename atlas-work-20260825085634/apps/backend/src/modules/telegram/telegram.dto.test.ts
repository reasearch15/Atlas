import { describe, expect, it } from "vitest";
import type { TelegramAccountDto } from "@atlas/shared";

describe("Telegram API response safety", () => {
  it("does not define secret-bearing account DTO fields", async () => {
    const dtoKeys = Object.keys({
      id: "",
      workspaceId: "",
      developerAppId: "",
      displayName: "",
      maskedPhoneNumber: null,
      telegramUserId: null,
      telegramUsername: null,
      status: "",
      authorizationState: "",
      syncState: "",
      lastConnectedAt: null,
      lastUpdateAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: ""
    } satisfies TelegramAccountDto);

    expect(dtoKeys).not.toContain("sessionEncrypted");
    expect(dtoKeys).not.toContain("phoneNumberEncrypted");
    expect(dtoKeys).not.toContain("encryptedApiHash");
  });
});
