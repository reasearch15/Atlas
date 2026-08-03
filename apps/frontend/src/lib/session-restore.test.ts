import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setSession = vi.fn();
const clearSession = vi.fn();
let authState: { accessToken: string | null; user: { id: string; email: string; name: string; role: "COADMIN" | "STAFF"; workspaceId: string } | null } = {
  accessToken: null,
  user: null
};

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: authState.accessToken,
      user: authState.user,
      setSession: (accessToken: string, user: typeof authState.user) => {
        authState = { accessToken, user };
        setSession(accessToken, user);
      },
      clearSession: () => {
        authState = { accessToken: null, user: null };
        clearSession();
      }
    }),
    persist: {
      hasHydrated: () => true,
      onFinishHydration: (callback: () => void) => {
        callback();
        return () => undefined;
      }
    }
  }
}));

describe("restoreTenantSession", () => {
  beforeEach(async () => {
    authState = { accessToken: null, user: null };
    setSession.mockClear();
    clearSession.mockClear();
    vi.stubGlobal("fetch", vi.fn());
    const { clearRoleAuthBootstrap } = await import("./auth-bootstrap");
    clearRoleAuthBootstrap();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("restores coadmin session from a valid refresh cookie", async () => {
    const user = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "north.coadmin",
      name: "North Coadmin",
      role: "COADMIN" as const,
      workspaceId: "22222222-2222-4222-8222-222222222222"
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accessToken: "access-token", user })
    } as Response);

    const { restoreTenantSession } = await import("./session-restore");
    const restored = await restoreTenantSession();

    expect(restored).toEqual(user);
    expect(setSession).toHaveBeenCalledWith("access-token", user);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/coadmin-auth/refresh"),
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    const refreshInit = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect(refreshInit.headers).toBeUndefined();
    expect(refreshInit.body).toBeUndefined();
  });

  it("preserves a fresh in-memory login when role bootstrap is already ready", async () => {
    const user = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "north.staff",
      name: "North Staff",
      role: "STAFF" as const,
      workspaceId: "22222222-2222-4222-8222-222222222222"
    };
    authState = { accessToken: "login-access", user };
    const { markRoleAuthenticated } = await import("./auth-bootstrap");
    markRoleAuthenticated("STAFF");

    const { restoreTenantSession } = await import("./session-restore");
    const restored = await restoreTenantSession();

    expect(restored).toEqual(user);
    expect(fetch).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  it("returns to anonymous state when refresh sessions are expired", async () => {
    authState = {
      accessToken: "stale",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "north.coadmin",
        name: "North Coadmin",
        role: "COADMIN",
        workspaceId: "22222222-2222-4222-8222-222222222222"
      }
    };
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({}) } as Response);

    const { restoreTenantSession } = await import("./session-restore");
    const restored = await restoreTenantSession();

    expect(restored).toBeNull();
    expect(clearSession).toHaveBeenCalled();
  });

  it("returns to anonymous state when refresh sessions are revoked", async () => {
    authState = {
      accessToken: "stale",
      user: {
        id: "33333333-3333-4333-8333-333333333333",
        email: "north.staff",
        name: "North Staff",
        role: "STAFF",
        workspaceId: "22222222-2222-4222-8222-222222222222"
      }
    };
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);

    const { restoreTenantSession } = await import("./session-restore");
    const restored = await restoreTenantSession();

    expect(restored).toBeNull();
    expect(clearSession).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/staff-auth/refresh"), expect.any(Object));
  });

  it("returns to anonymous state when refresh fetch throws (network/CORS)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { restoreTenantSession } = await import("./session-restore");
    const restored = await restoreTenantSession();

    expect(restored).toBeNull();
    expect(clearSession).toHaveBeenCalled();
  });

  it("does not hang when persist hydration never finishes", async () => {
    const { useAuthStore } = await import("@/stores/auth-store");
    const originalPersist = useAuthStore.persist;
    useAuthStore.persist = {
      ...originalPersist,
      hasHydrated: () => false,
      onFinishHydration: () => () => undefined
    };
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({}) } as Response);

    try {
      const { restoreTenantSession } = await import("./session-restore");
      const started = Date.now();
      const restored = await restoreTenantSession();
      expect(Date.now() - started).toBeLessThan(3_500);
      expect(restored).toBeNull();
    } finally {
      useAuthStore.persist = originalPersist;
    }
  });

  it("uses staff refresh first for staff users and redirects via staff landing helper", async () => {
    authState = {
      accessToken: null,
      user: {
        id: "33333333-3333-4333-8333-333333333333",
        email: "north.staff",
        name: "North Staff",
        role: "STAFF",
        workspaceId: "22222222-2222-4222-8222-222222222222"
      }
    };
    const user = authState.user!;
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accessToken: "staff-access", user })
    } as Response);

    const { restoreTenantSession, resolveTenantLanding } = await import("./session-restore");
    const restored = await restoreTenantSession();

    expect(restored?.role).toBe("STAFF");
    expect(resolveTenantLanding(restored!)).toBe("/staff/inbox");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toEqual(expect.stringContaining("/api/staff-auth/refresh"));
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it("does not clear an authenticated Staff session when Coadmin refresh returns 401", async () => {
    const user = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "north.staff",
      name: "North Staff",
      role: "STAFF" as const,
      workspaceId: "22222222-2222-4222-8222-222222222222"
    };
    authState = { accessToken: "staff-access", user };
    const { markRoleAuthenticated } = await import("./auth-bootstrap");
    markRoleAuthenticated("STAFF");

    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);

    const { restoreTenantSession, attemptRefresh } = await import("./session-restore");
    expect(await attemptRefresh("/api/coadmin-auth/refresh")).toBeNull();
    const restored = await restoreTenantSession({ expectedRole: "STAFF" });

    expect(restored).toEqual(user);
    expect(clearSession).not.toHaveBeenCalled();
    expect(authState.accessToken).toBe("staff-access");
  });

  it("dedupes concurrent refresh calls for the same path", async () => {
    const user = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "north.staff",
      name: "North Staff",
      role: "STAFF" as const,
      workspaceId: "22222222-2222-4222-8222-222222222222"
    };
    let resolveFetch: ((value: Response) => void) | null = null;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const { attemptRefresh, resetTenantRefreshInflightForTests } = await import("./session-restore");
    resetTenantRefreshInflightForTests();
    const pendingA = attemptRefresh("/api/staff-auth/refresh");
    const pendingB = attemptRefresh("/api/staff-auth/refresh");
    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch!({
      ok: true,
      json: async () => ({ accessToken: "shared-access", user })
    } as Response);
    const [a, b] = await Promise.all([pendingA, pendingB]);
    expect(a?.accessToken).toBe("shared-access");
    expect(b?.accessToken).toBe("shared-access");
  });
});
