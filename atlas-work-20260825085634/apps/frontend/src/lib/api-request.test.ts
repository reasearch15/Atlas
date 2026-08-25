import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setSession = vi.fn();
const clearSession = vi.fn();
const toastError = vi.fn();

let authState: {
  accessToken: string | null;
  user: { id: string; email: string; name: string; role: "COADMIN" | "STAFF"; workspaceId: string } | null;
} = {
  accessToken: "expired-access-token",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "north.coadmin",
    name: "North Coadmin",
    role: "COADMIN",
    workspaceId: "22222222-2222-4222-8222-222222222222"
  }
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
    })
  }
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn()
  }
}));

vi.mock("@/lib/sensitive-cache", () => ({
  clearRoleSensitiveClientCaches: vi.fn()
}));

vi.mock("@/lib/auth-bootstrap", () => ({
  clearRoleAuthBootstrap: vi.fn(),
  markRoleAuthenticated: vi.fn()
}));

describe("apiRequest expired access token refresh", () => {
  beforeEach(() => {
    authState = {
      accessToken: "expired-access-token",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email: "north.coadmin",
        name: "North Coadmin",
        role: "COADMIN",
        workspaceId: "22222222-2222-4222-8222-222222222222"
      }
    };
    setSession.mockClear();
    clearSession.mockClear();
    toastError.mockClear();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: { assign: vi.fn() } });
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes once and retries the original POST with the same body", async () => {
    const createBody = JSON.stringify({ developerAppId: "app-1", displayName: "Piccaso" });
    const created = {
      id: "acc-1",
      displayName: "Piccaso",
      status: "PENDING"
    };

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        clone: () => ({
          json: async () => ({
            error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
          })
        }),
        json: async () => ({
          error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: "fresh-access-token",
          user: authState.user
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => created
      } as Response);

    const { apiRequest } = await import("./api");
    const { resetAuthRefreshLocksForTests } = await import("./auth-refresh");
    resetAuthRefreshLocksForTests();

    const result = await apiRequest("/api/telegram/accounts", { method: "POST", body: createBody });

    expect(result).toEqual(created);
    expect(fetch).toHaveBeenCalledTimes(3);

    const refreshCall = vi.mocked(fetch).mock.calls[1];
    expect(refreshCall?.[0]).toEqual(expect.stringContaining("/api/coadmin-auth/refresh"));
    expect(refreshCall?.[1]).toMatchObject({ method: "POST", credentials: "include" });

    const retryCall = vi.mocked(fetch).mock.calls[2];
    expect(retryCall?.[0]).toEqual(expect.stringContaining("/api/telegram/accounts"));
    expect(retryCall?.[1]).toMatchObject({ method: "POST", body: createBody });
    expect((retryCall?.[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer fresh-access-token"
    });
    expect(setSession).toHaveBeenCalledWith("fresh-access-token", authState.user);
  });

  it("retries the original request only once (no refresh recursion)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        clone: () => ({
          json: async () => ({
            error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
          })
        }),
        json: async () => ({
          error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: "fresh-access-token",
          user: authState.user
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        clone: () => ({
          json: async () => ({
            error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r2" }
          })
        }),
        json: async () => ({
          error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r2" }
        })
      } as Response);

    const { apiRequest } = await import("./api");
    const { resetAuthRefreshLocksForTests } = await import("./auth-refresh");
    resetAuthRefreshLocksForTests();

    await expect(apiRequest("/api/telegram/accounts", { method: "POST", body: "{}" })).rejects.toThrow(/ACCESS_TOKEN_EXPIRED/);
    expect(fetch).toHaveBeenCalledTimes(3);
    const paths = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(paths.filter((path) => path.includes("/api/coadmin-auth/refresh"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("/api/telegram/accounts"))).toHaveLength(2);
  });

  it("shares one refresh across concurrent expired requests", async () => {
    let refreshStarts = 0;
    let resolveRefresh!: (value: Response) => void;
    const refreshGate = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/coadmin-auth/refresh")) {
        refreshStarts += 1;
        return refreshGate;
      }
      if ((init as RequestInit | undefined)?.method === "POST" && url.includes("/api/telegram/accounts")) {
        if (authState.accessToken === "expired-access-token") {
          return {
            ok: false,
            status: 401,
            clone: () => ({
              json: async () => ({
                error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
              })
            }),
            json: async () => ({
              error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
            })
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "acc-1", status: "PENDING" })
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { apiRequest } = await import("./api");
    const { resetAuthRefreshLocksForTests } = await import("./auth-refresh");
    resetAuthRefreshLocksForTests();

    const bodyA = JSON.stringify({ developerAppId: "app-1", displayName: "A" });
    const bodyB = JSON.stringify({ developerAppId: "app-1", displayName: "B" });
    const pendingA = apiRequest("/api/telegram/accounts", { method: "POST", body: bodyA });
    const pendingB = apiRequest("/api/telegram/accounts", { method: "POST", body: bodyB });

    for (let i = 0; i < 20 && refreshStarts === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(refreshStarts).toBe(1);

    resolveRefresh({
      ok: true,
      json: async () => ({
        accessToken: "fresh-access-token",
        user: authState.user
      })
    } as Response);

    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
    expect(resultA).toEqual({ id: "acc-1", status: "PENDING" });
    expect(resultB).toEqual({ id: "acc-1", status: "PENDING" });
    expect(refreshStarts).toBe(1);
  });

  it("clears session and redirects to /login when refresh fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        clone: () => ({
          json: async () => ({
            error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
          })
        }),
        json: async () => ({
          error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: "UNAUTHORIZED", message: "Authentication is required", requestId: "r2" }
        })
      } as Response);

    const { apiRequest } = await import("./api");
    const { resetAuthRefreshLocksForTests } = await import("./auth-refresh");
    resetAuthRefreshLocksForTests();

    await expect(apiRequest("/api/telegram/accounts", { method: "POST", body: "{}" })).rejects.toThrow(
      /Your session expired\. Please sign in again/
    );
    expect(clearSession).toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("Your session expired. Please sign in again.");
    expect(window.location.assign).toHaveBeenCalledWith("/login");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not create duplicate account POSTs beyond a single retry", async () => {
    const createBody = JSON.stringify({ developerAppId: "app-1", displayName: "OnlyOnce" });
    let accountPosts = 0;

    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/coadmin-auth/refresh")) {
        return {
          ok: true,
          json: async () => ({
            accessToken: "fresh-access-token",
            user: authState.user
          })
        } as Response;
      }
      if (url.includes("/api/telegram/accounts") && (init as RequestInit | undefined)?.method === "POST") {
        accountPosts += 1;
        if (accountPosts === 1) {
          return {
            ok: false,
            status: 401,
            clone: () => ({
              json: async () => ({
                error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
              })
            }),
            json: async () => ({
              error: { code: "ACCESS_TOKEN_EXPIRED", message: "Access token has expired", requestId: "r1" }
            })
          } as Response;
        }
        expect((init as RequestInit).body).toBe(createBody);
        return {
          ok: true,
          json: async () => ({ id: "acc-1", displayName: "OnlyOnce" })
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { apiRequest } = await import("./api");
    const { resetAuthRefreshLocksForTests } = await import("./auth-refresh");
    resetAuthRefreshLocksForTests();

    await apiRequest("/api/telegram/accounts", { method: "POST", body: createBody });
    expect(accountPosts).toBe(2);
  });

  it("does not logout the browser when coadmin login returns 401", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      clone: () => ({
        json: async () => ({
          error: { code: "UNAUTHORIZED", message: "Invalid username or password.", requestId: "r1" }
        })
      }),
      json: async () => ({
        error: { code: "UNAUTHORIZED", message: "Invalid username or password.", requestId: "r1" }
      }),
      headers: { get: () => null }
    } as unknown as Response);

    const { apiRequest } = await import("./api");
    await expect(
      apiRequest("/api/coadmin-auth/login", {
        method: "POST",
        body: JSON.stringify({ username: "bella", password: "x" })
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(clearSession).not.toHaveBeenCalled();
    expect(window.location.assign).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
