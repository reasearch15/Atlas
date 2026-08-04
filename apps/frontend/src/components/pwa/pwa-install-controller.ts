"use client";

export interface BeforeInstallPromptEvent extends Event {
  readonly prompt: () => Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

export type PwaInstallBlocker =
  | "already_installed"
  | "no_beforeinstallprompt"
  | "prompt_consumed"
  | "insecure_context"
  | "no_service_worker_api"
  | "service_worker_registration_failed"
  | "manifest_unreachable"
  | "browser_no_install_ui";

export interface PwaInstallDiagnostics {
  readonly secureContext: boolean;
  readonly hasServiceWorkerApi: boolean;
  readonly serviceWorkerControlled: boolean;
  readonly serviceWorkerRegistered: boolean;
  readonly serviceWorkerRegistrationError: string | null;
  readonly manifestLinked: boolean;
  readonly manifestFetchOk: boolean | null;
  readonly displayModeStandalone: boolean;
  readonly iosStandalone: boolean;
  readonly deferredPromptPresent: boolean;
  readonly beforeinstallpromptFired: boolean;
  readonly installed: boolean;
  readonly canPrompt: boolean;
  readonly blockers: readonly PwaInstallBlocker[];
  readonly reason: string;
}

type AtlasPwaGlobal = {
  deferred: BeforeInstallPromptEvent | null;
  installed: boolean;
  beforeinstallpromptFired: boolean;
  serviceWorkerRegistered: boolean;
  serviceWorkerRegistrationError: string | null;
  manifestFetchOk: boolean | null;
};

declare global {
  interface Window {
    __atlasPwa?: AtlasPwaGlobal;
  }
}

const CHANGE_EVENT = "atlas-pwa-change";

function ensureGlobal(): AtlasPwaGlobal {
  if (typeof window === "undefined") {
    return {
      deferred: null,
      installed: false,
      beforeinstallpromptFired: false,
      serviceWorkerRegistered: false,
      serviceWorkerRegistrationError: null,
      manifestFetchOk: null
    };
  }
  if (!window.__atlasPwa) {
    window.__atlasPwa = {
      deferred: null,
      installed: false,
      beforeinstallpromptFired: false,
      serviceWorkerRegistered: false,
      serviceWorkerRegistrationError: null,
      manifestFetchOk: null
    };
  }
  return window.__atlasPwa;
}

function emitChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function detectInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia("(display-mode: standalone)");
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return media.matches || nav.standalone === true || ensureGlobal().installed;
}

/**
 * Captures beforeinstallprompt as early as possible and keeps a single deferred prompt.
 * Safe to call multiple times (idempotent).
 */
export function bootstrapPwaInstallCapture(): void {
  if (typeof window === "undefined") return;
  const state = ensureGlobal();
  if ((window as Window & { __atlasPwaCaptureBound?: boolean }).__atlasPwaCaptureBound) {
    state.installed = detectInstalled();
    return;
  }
  (window as Window & { __atlasPwaCaptureBound?: boolean }).__atlasPwaCaptureBound = true;
  state.installed = detectInstalled();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.beforeinstallpromptFired = true;
    state.deferred = event as BeforeInstallPromptEvent;
    state.installed = false;
    emitChange();
  });

  window.addEventListener("appinstalled", () => {
    state.installed = true;
    state.deferred = null;
    emitChange();
  });

  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", () => {
    state.installed = detectInstalled();
    if (state.installed) state.deferred = null;
    emitChange();
  });
}

/**
 * Registers the Atlas service worker required for Chromium installability.
 */
export async function registerAtlasServiceWorker(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const state = ensureGlobal();
  bootstrapPwaInstallCapture();

  if (!window.isSecureContext) {
    state.serviceWorkerRegistrationError = "insecure_context";
    emitChange();
    return false;
  }
  if (!("serviceWorker" in navigator)) {
    state.serviceWorkerRegistrationError = "no_service_worker_api";
    emitChange();
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    state.serviceWorkerRegistered = Boolean(registration);
    state.serviceWorkerRegistrationError = null;
    emitChange();
    return true;
  } catch (error) {
    state.serviceWorkerRegistered = false;
    state.serviceWorkerRegistrationError = error instanceof Error ? error.message : "registration_failed";
    emitChange();
    return false;
  }
}

/**
 * Probes whether /manifest.webmanifest is reachable (does not mutate install eligibility itself).
 */
export async function probeAtlasManifest(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const state = ensureGlobal();
  try {
    const response = await fetch("/manifest.webmanifest", { method: "GET", cache: "no-store" });
    state.manifestFetchOk = response.ok;
    emitChange();
    return response.ok;
  } catch {
    state.manifestFetchOk = false;
    emitChange();
    return false;
  }
}

export function getDeferredInstallPrompt(): BeforeInstallPromptEvent | null {
  return ensureGlobal().deferred;
}

export function isPwaInstalled(): boolean {
  return detectInstalled();
}

export function canPromptPwaInstall(): boolean {
  const state = ensureGlobal();
  return Boolean(state.deferred) && !detectInstalled();
}

/**
 * Triggers the native install prompt when a deferred event is available.
 */
export async function promptPwaInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const state = ensureGlobal();
  const deferred = state.deferred;
  if (!deferred) return "unavailable";
  state.deferred = null;
  emitChange();
  await deferred.prompt();
  const choice = await deferred.userChoice;
  if (choice.outcome === "accepted") {
    state.installed = true;
  }
  emitChange();
  return choice.outcome;
}

export function subscribePwaInstallChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/**
 * Builds a human-readable installability diagnosis for operators and UI debugging.
 */
export function getPwaInstallDiagnostics(): PwaInstallDiagnostics {
  if (typeof window === "undefined") {
    return {
      secureContext: false,
      hasServiceWorkerApi: false,
      serviceWorkerControlled: false,
      serviceWorkerRegistered: false,
      serviceWorkerRegistrationError: null,
      manifestLinked: false,
      manifestFetchOk: null,
      displayModeStandalone: false,
      iosStandalone: false,
      deferredPromptPresent: false,
      beforeinstallpromptFired: false,
      installed: false,
      canPrompt: false,
      blockers: ["no_beforeinstallprompt"],
      reason: "Diagnostics unavailable during SSR."
    };
  }

  const state = ensureGlobal();
  const media = window.matchMedia("(display-mode: standalone)");
  const nav = window.navigator as Navigator & { standalone?: boolean };
  const manifestLink = Boolean(document.querySelector('link[rel="manifest"]'));
  const installed = detectInstalled();
  const deferredPromptPresent = Boolean(state.deferred);
  const canPrompt = deferredPromptPresent && !installed;
  const blockers: PwaInstallBlocker[] = [];

  if (installed) blockers.push("already_installed");
  if (!window.isSecureContext) blockers.push("insecure_context");
  if (!("serviceWorker" in navigator)) blockers.push("no_service_worker_api");
  if (state.serviceWorkerRegistrationError) blockers.push("service_worker_registration_failed");
  if (state.manifestFetchOk === false) blockers.push("manifest_unreachable");
  if (!state.beforeinstallpromptFired && !deferredPromptPresent && !installed) {
    blockers.push("no_beforeinstallprompt");
    // Chromium-only install UI; Safari/Firefox never fire beforeinstallprompt.
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod|Firefox|Safari/i.test(ua) && !/Chrome|CriOS|Edg/i.test(ua)) {
      blockers.push("browser_no_install_ui");
    }
  }
  if (state.beforeinstallpromptFired && !deferredPromptPresent && !installed) {
    blockers.push("prompt_consumed");
  }

  let reason: string;
  if (canPrompt) {
    reason = "Installable: beforeinstallprompt is available and can be prompted.";
  } else if (installed) {
    reason = "Already installed (standalone display mode).";
  } else if (!window.isSecureContext) {
    reason = "Not installable: page is not a secure context (HTTPS/localhost required).";
  } else if (!("serviceWorker" in navigator)) {
    reason = "Not installable: browser has no Service Worker API.";
  } else if (state.serviceWorkerRegistrationError) {
    reason = `Service worker registration failed: ${state.serviceWorkerRegistrationError}`;
  } else if (state.manifestFetchOk === false) {
    reason = "Manifest unreachable at /manifest.webmanifest.";
  } else if (!state.beforeinstallpromptFired) {
    reason =
      "beforeinstallprompt has not fired yet. Chromium only fires this after manifest + service worker criteria are met, and may delay until engagement heuristics pass.";
  } else if (!deferredPromptPresent) {
    reason = "beforeinstallprompt already fired but the deferred prompt was consumed.";
  } else {
    reason = "Install prompt unavailable.";
  }

  return {
    secureContext: window.isSecureContext,
    hasServiceWorkerApi: "serviceWorker" in navigator,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    serviceWorkerRegistered: state.serviceWorkerRegistered,
    serviceWorkerRegistrationError: state.serviceWorkerRegistrationError,
    manifestLinked: manifestLink,
    manifestFetchOk: state.manifestFetchOk,
    displayModeStandalone: media.matches,
    iosStandalone: nav.standalone === true,
    deferredPromptPresent,
    beforeinstallpromptFired: state.beforeinstallpromptFired,
    installed,
    canPrompt,
    blockers,
    reason
  };
}
