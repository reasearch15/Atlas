"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  readonly prompt: () => Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

/**
 * Compact header control that triggers the browser PWA install prompt when available.
 * Hidden when the app is already installed or the browser has no install prompt.
 */
export function PwaInstallButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia("(display-mode: standalone)");
    const nav = window.navigator as Navigator & { standalone?: boolean };
    const alreadyInstalled = media.matches || nav.standalone === true;
    setInstalled(alreadyInstalled);

    function onChange(): void {
      setInstalled(media.matches || nav.standalone === true);
    }

    function onBeforeInstall(event: Event): void {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    }

    function onAppInstalled(): void {
      setInstalled(true);
      setDeferred(null);
    }

    media.addEventListener("change", onChange);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      media.removeEventListener("change", onChange);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  if (installed || !deferred) return null;

  async function install(): Promise<void> {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") {
      setInstalled(true);
    }
    setDeferred(null);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      className="h-8 shrink-0 gap-1 px-2 text-xs font-medium text-muted-foreground"
      onClick={() => void install()}
      aria-label="Install PWA"
    >
      <Download className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Install</span>
    </Button>
  );
}
