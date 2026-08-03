import { afterEach, describe, expect, it, vi } from "vitest";

describe("staff auth credentials include", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses credentials include for staff refresh restore calls", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(init ?? {});
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          json: async () => ({})
        };
      })
    );

    vi.mock("@/stores/auth-store", () => ({
      useAuthStore: {
        getState: () => ({
          accessToken: null,
          user: null,
          setSession: vi.fn(),
          clearSession: vi.fn()
        }),
        persist: {
          hasHydrated: () => true,
          onFinishHydration: (cb: () => void) => {
            cb();
            return () => undefined;
          }
        }
      }
    }));

    const { attemptRefresh, resetTenantRefreshInflightForTests } = await import("@/lib/session-restore");
    resetTenantRefreshInflightForTests();
    await attemptRefresh("/api/staff-auth/refresh");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.credentials).toBe("include");
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toContain("/api/staff-auth/refresh");
  });
});
