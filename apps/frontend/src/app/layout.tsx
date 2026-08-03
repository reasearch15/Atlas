import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import { AppProviders } from "@/lib/providers";
import "@/styles/globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Atlas Workspace",
  description: "Multi-tenant Telegram team workspace foundation"
};

/**
 * Defines the global application shell and providers.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AppProviders>
          {children}
          <Toaster richColors closeButton position="top-right" />
        </AppProviders>
      </body>
    </html>
  );
}
