import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import { PwaBootstrap } from "@/components/pwa/pwa-bootstrap";
import { PushBootstrap } from "@/features/notifications/push-bootstrap";
import { AppProviders } from "@/lib/providers";
import "@/styles/globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Atlas Workspace",
  description: "Multi-tenant Telegram team workspace foundation",
  applicationName: "Atlas",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Atlas",
    statusBarStyle: "default"
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "192x192" }]
  }
};

export const viewport: Viewport = {
  themeColor: "#0F766E",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover"
};

const EARLY_PWA_CAPTURE = `
(function () {
  if (typeof window === "undefined") return;
  window.__atlasPwa = window.__atlasPwa || {
    deferred: null,
    installed: false,
    beforeinstallpromptFired: false,
    serviceWorkerRegistered: false,
    serviceWorkerRegistrationError: null,
    manifestFetchOk: null
  };
  if (window.__atlasPwaCaptureBound) return;
  window.__atlasPwaCaptureBound = true;
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    window.__atlasPwa.beforeinstallpromptFired = true;
    window.__atlasPwa.deferred = event;
    window.__atlasPwa.installed = false;
    window.dispatchEvent(new Event("atlas-pwa-change"));
  });
  window.addEventListener("appinstalled", function () {
    window.__atlasPwa.installed = true;
    window.__atlasPwa.deferred = null;
    window.dispatchEvent(new Event("atlas-pwa-change"));
  });
})();
`;

/**
 * Defines the global application shell and providers.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <Script id="atlas-pwa-early-capture" strategy="beforeInteractive">
          {EARLY_PWA_CAPTURE}
        </Script>
        <AppProviders>
          <PwaBootstrap />
          <PushBootstrap />
          {children}
          <Toaster richColors closeButton position="top-right" />
        </AppProviders>
      </body>
    </html>
  );
}
