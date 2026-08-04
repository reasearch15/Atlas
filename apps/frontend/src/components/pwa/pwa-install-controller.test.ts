import { afterEach, describe, expect, it, vi } from "vitest";

describe("pwa install controller", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("reports canPrompt only when a deferred beforeinstallprompt exists", async () => {
    const listeners = new Map<string, Set<EventListener>>();
    const deferred = {
      preventDefault() {},
      prompt: vi.fn(async () => undefined),
      userChoice: Promise.resolve({ outcome: "accepted" as const })
    };

    vi.stubGlobal("window", {
      __atlasPwa: {
        deferred,
        installed: false,
        beforeinstallpromptFired: true,
        serviceWorkerRegistered: true,
        serviceWorkerRegistrationError: null,
        manifestFetchOk: true
      },
      isSecureContext: true,
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      navigator: { userAgent: "Chrome", serviceWorker: { controller: {} } },
      addEventListener(type: string, listener: EventListener) {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent() {
        return true;
      }
    });
    vi.stubGlobal("document", {
      querySelector: () => ({ rel: "manifest" })
    });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/120.0.0.0",
      serviceWorker: { controller: {} }
    });

    const { canPromptPwaInstall, getPwaInstallDiagnostics, promptPwaInstall } = await import("./pwa-install-controller");
    expect(canPromptPwaInstall()).toBe(true);
    const diagnostics = getPwaInstallDiagnostics();
    expect(diagnostics.canPrompt).toBe(true);
    expect(diagnostics.beforeinstallpromptFired).toBe(true);
    expect(await promptPwaInstall()).toBe("accepted");
    expect(canPromptPwaInstall()).toBe(false);
  });
});
