"use client";

import type { ReactNode } from "react";
import { StaffShell } from "@/components/layout/staff-shell";
import { InboxProvider } from "@/features/inbox/inbox-provider";
import { InboxShell } from "@/features/inbox/inbox-shell";

/**
 * Persistent Staff inbox layout — shell, chat list, and provider stay mounted
 * across conversation routes.
 */
export default function StaffInboxLayout({ children }: { readonly children: ReactNode }) {
  return (
    <StaffShell>
      <InboxProvider>
        <InboxShell>{children}</InboxShell>
      </InboxProvider>
    </StaffShell>
  );
}
