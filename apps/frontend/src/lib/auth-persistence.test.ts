import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRememberUsernamePreference,
  clearRememberedUsername,
  getRememberedUsername,
  normalizeUsername,
  REMEMBERED_USERNAME_STORAGE_KEY,
  rememberUsername
} from "./remembered-username";
import {
  confirmNewPasswordInputProps,
  currentPasswordInputProps,
  landingPathForRole,
  loginPasswordInputProps,
  loginUsernameInputProps,
  newPasswordInputProps
} from "./auth-form-fields";
import { refreshPathsForRole } from "./session-restore";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    get raw() {
      return values;
    }
  };
}

describe("remembered username", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores only a normalized username and never a password", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });

    rememberUsername("  North.Coadmin ");
    expect(getRememberedUsername()).toBe("north.coadmin");
    expect(storage.getItem(REMEMBERED_USERNAME_STORAGE_KEY)).toBe("north.coadmin");
    expect(JSON.stringify([...storage.raw.entries()])).not.toContain("password");
    expect(JSON.stringify([...storage.raw.entries()])).not.toContain("PermanentPass");
  });

  it("clears the remembered username when preference is disabled", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });

    applyRememberUsernamePreference("north.coadmin", true);
    expect(getRememberedUsername()).toBe("north.coadmin");
    applyRememberUsernamePreference("north.coadmin", false);
    expect(getRememberedUsername()).toBeNull();
    clearRememberedUsername();
    expect(storage.getItem(REMEMBERED_USERNAME_STORAGE_KEY)).toBeNull();
  });

  it("normalizes usernames consistently", () => {
    expect(normalizeUsername("  AbC_User ")).toBe("abc_user");
  });
});

describe("auth form autocomplete attributes", () => {
  it("uses password-manager friendly login field attributes", () => {
    expect(loginUsernameInputProps).toEqual({ name: "username", autoComplete: "username" });
    expect(loginPasswordInputProps).toEqual({
      name: "password",
      type: "password",
      autoComplete: "current-password"
    });
  });

  it("uses password-manager friendly change-password field attributes", () => {
    expect(currentPasswordInputProps.autoComplete).toBe("current-password");
    expect(newPasswordInputProps).toEqual({
      name: "new-password",
      type: "password",
      autoComplete: "new-password"
    });
    expect(confirmNewPasswordInputProps).toEqual({
      name: "confirm-password",
      type: "password",
      autoComplete: "new-password"
    });
  });
});

describe("role-based post-refresh redirect", () => {
  it("routes each role to the correct post-login workspace", () => {
    expect(landingPathForRole("COADMIN")).toBe("/workspace/inbox");
    expect(landingPathForRole("STAFF")).toBe("/staff/inbox");
    expect(landingPathForRole("PLATFORM_ADMIN")).toBe("/admin");
  });

  it("prefers the matching refresh endpoint for the last known role", () => {
    expect(refreshPathsForRole("STAFF")[0]).toBe("/api/staff-auth/refresh");
    expect(refreshPathsForRole("COADMIN")[0]).toBe("/api/coadmin-auth/refresh");
  });
});
