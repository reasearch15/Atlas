"use client";

import { StaffShell } from "@/components/layout/staff-shell";
import { StaffTeamMessagesView } from "@/features/staff/staff-team-messages-view";

/**
 * Staff team messages route.
 */
export default function StaffTeamMessagesPage() {
  return (
    <StaffShell>
      <StaffTeamMessagesView />
    </StaffShell>
  );
}
