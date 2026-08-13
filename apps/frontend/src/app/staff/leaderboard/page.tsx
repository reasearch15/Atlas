"use client";

import { StaffShell } from "@/components/layout/staff-shell";
import { LeaderboardBoardView } from "@/features/leaderboard/leaderboard-board-view";

export default function StaffLeaderboardPage() {
  return (
    <StaffShell>
      <LeaderboardBoardView />
    </StaffShell>
  );
}
