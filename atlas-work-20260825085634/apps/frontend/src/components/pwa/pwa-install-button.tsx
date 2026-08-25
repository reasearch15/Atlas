"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  canPromptPwaInstall,
  getPwaInstallDiagnostics,
  isPwaInstalled,
  promptPwaInstall,
  subscribePwaInstallChanges
} from "@/components/pwa/pwa-install-controller";

interface PwaInstallButtonProps {
  /** drawer = full-width nav footer control; compact = icon/text header control */
  readonly variant?: "drawer" | "compact";
}

/**
 * Shows a real Install App control only when Chromium exposes beforeinstallprompt.
 * Hidden when already installed or when installation is not possible.
 */
export function PwaInstallButton({ variant = "drawer" }: PwaInstallButtonProps) {
  const [canPrompt, setCanPrompt] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function sync(): void {
      setInstalled(isPwaInstalled());
      setCanPrompt(canPromptPwaInstall());
      if (process.env.NODE_ENV === "development") {
        // Operator breadcrumb — never logs tokens/secrets.
        console.info("[atlas-pwa]", getPwaInstallDiagnostics());
      }
    }
    sync();
    return subscribePwaInstallChanges(sync);
  }, []);

  if (installed || !canPrompt) return null;

  async function onInstall(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await promptPwaInstall();
      if (outcome === "accepted") {
        setInstalled(true);
        setCanPrompt(false);
      } else {
        setCanPrompt(canPromptPwaInstall());
      }
    } finally {
      setBusy(false);
    }
  }

  if (variant === "compact") {
    return (
      <Button
        type="button"
        variant="ghost"
        className="h-8 shrink-0 gap-1 px-2 text-xs font-medium text-muted-foreground"
        onClick={() => void onInstall()}
        disabled={busy}
        aria-label="Install App"
      >
        <Download className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Install</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      className="min-h-11 w-full justify-start"
      onClick={() => void onInstall()}
      disabled={busy}
      aria-label="Install App"
    >
      <Download className="size-4" aria-hidden="true" />
      Install App
    </Button>
  );
}
