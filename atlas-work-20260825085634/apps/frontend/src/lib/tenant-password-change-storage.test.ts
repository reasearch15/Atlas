import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTenantPasswordChangeChallenge,
  hasPendingTenantPasswordChange,
  pauseTenantCookieRefresh,
  resumeTenantCookieRefresh,
  storeTenantPasswordChangeChallenge
} from "./tenant-password-change-storage";

describe("tenant password-change storage", () => {
  afterEach(() => {
    resumeTenantCookieRefresh();
    vi.unstubAllGlobals();
  });

  it("pauses cookie refresh while a challenge is stored", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        }
      }
    });

    pauseTenantCookieRefresh();
    expect(hasPendingTenantPasswordChange("STAFF")).toBe(true);

    storeTenantPasswordChangeChallenge("staff", {
      passwordChangeToken: "t".repeat(43),
      username: "bella"
    });
    expect(hasPendingTenantPasswordChange("STAFF")).toBe(true);
    expect(storage.get("atlas:staff:password-change")).toContain("passwordChangeToken");

    clearTenantPasswordChangeChallenge("staff");
    expect(hasPendingTenantPasswordChange("STAFF")).toBe(false);
  });
});
