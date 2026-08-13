"use client";

import { StaffShell } from "@/components/layout/staff-shell";
import { DepositHistorySection } from "@/features/leaderboard/deposit-history-section";
import { LeaderboardBoardView } from "@/features/leaderboard/leaderboard-board-view";

export default function StaffLeaderboardPage() {
  return (
    <StaffShell>
      <LeaderboardBoardView />
      <div className="px-4 pb-8 md:px-6 lg:px-8">
        <DepositHistorySection />
      </div>
    </StaffShell>
  );
}
