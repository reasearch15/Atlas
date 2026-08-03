"use client";

import type { ReactNode } from "react";
import { InboxProvider } from "@/features/inbox/inbox-provider";
import { InboxShell } from "@/features/inbox/inbox-shell";

/**
 * Persistent inbox layout — chat list stays mounted across conversation routes.
 */
export default function WorkspaceInboxLayout({ children }: { readonly children: ReactNode }) {
  return (
    <InboxProvider>
      <InboxShell>{children}</InboxShell>
    </InboxProvider>
  );
}
