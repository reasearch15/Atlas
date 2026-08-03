import { describe, expect, it } from "vitest";
import type { TelegramAccountDto } from "./api";
import {
  getTelegramAccountActionKind,
  normalizeTelegramAccountDisplay,
  telegramAccountNeedsDisconnectBeforeDelete
} from "./telegram-account-actions";

function account(partial: Partial<TelegramAccountDto>): TelegramAccountDto {
  return {
    id: "a1",
    workspaceId: "w1",
    developerAppId: "d1",
    displayName: "Piccaso",
    telegramUsername: "Piccaso47",
    status: "CONNECTED",
    authorizationState: "AUTHORIZED",
    syncState: "LIVE",
    maskedPhoneNumber: null,
    telegramUserId: null,
    lastConnectedAt: null,
    lastUpdateAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: new Date().toISOString(),
    ...partial
  };
}

describe("getTelegramAccountActionKind", () => {
  it("treats CONNECTED / AUTHORIZED / LIVE as active (Disconnect + Permanent Delete)", () => {
    expect(getTelegramAccountActionKind(account({}))).toBe("active");
  });

  it("treats DISCONNECTED / CANCELLED / PAUSED as inactive (Reauthorize + Permanent Delete)", () => {
    expect(
      getTelegramAccountActionKind(
        account({ status: "DISCONNECTED", authorizationState: "CANCELLED", syncState: "PAUSED" })
      )
    ).toBe("inactive");
  });

  it("treats REAUTH_REQUIRED as inactive", () => {
    expect(getTelegramAccountActionKind(account({ status: "REAUTH_REQUIRED", authorizationState: "REAUTH_REQUIRED", syncState: "PAUSED" }))).toBe(
      "inactive"
    );
  });

  it("treats DELETING as deleting", () => {
    expect(getTelegramAccountActionKind(account({ status: "DELETING" }))).toBe("deleting");
  });

  it("keeps Disconnect available when auth is CANCELLED but status is still CONNECTED", () => {
    const contradictory = account({ status: "CONNECTED", authorizationState: "CANCELLED", syncState: "LIVE" });
    expect(getTelegramAccountActionKind(contradictory)).toBe("active");
    expect(telegramAccountNeedsDisconnectBeforeDelete(contradictory)).toBe(true);
  });
});

describe("normalizeTelegramAccountDisplay", () => {
  it("does not present LIVE sync next to CANCELLED auth on a CONNECTED badge path", () => {
    const display = normalizeTelegramAccountDisplay(
      account({ status: "CONNECTED", authorizationState: "CANCELLED", syncState: "LIVE" })
    );
    expect(display.syncState).not.toBe("LIVE");
    expect(display.authorizationState).toBe("CANCELLED");
  });

  it("normalizes DISCONNECTED rows to CANCELLED/PAUSED", () => {
    const display = normalizeTelegramAccountDisplay(
      account({ status: "DISCONNECTED", authorizationState: "CANCELLED", syncState: "PAUSED" })
    );
    expect(display).toMatchObject({ status: "DISCONNECTED", authorizationState: "CANCELLED", syncState: "PAUSED" });
  });
});
