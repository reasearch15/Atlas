"use client";

import { useEffect } from "react";
import {
  bootstrapPwaInstallCapture,
  probeAtlasManifest,
  registerAtlasServiceWorker
} from "@/components/pwa/pwa-install-controller";

/**
 * Bootstraps PWA install capture + service worker registration once on the client.
 */
export function PwaBootstrap(): null {
  useEffect(() => {
    bootstrapPwaInstallCapture();
    void registerAtlasServiceWorker();
    void probeAtlasManifest();
  }, []);
  return null;
}
