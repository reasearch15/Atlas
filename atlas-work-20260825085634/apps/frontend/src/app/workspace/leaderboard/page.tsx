"use client";

import { hasPermission } from "@atlas/shared";
import { LeaderboardBoardView } from "@/features/leaderboard/leaderboard-board-view";
import { LeaderboardCoadminControls } from "@/features/leaderboard/leaderboard-coadmin-controls";
import { useAuthStore } from "@/stores/auth-store";

export default function WorkspaceLeaderboardPage() {
  const user = useAuthStore((state) => state.user);

  return (
    <>
      <LeaderboardBoardView />
      {user && hasPermission(user.role, "leaderboard:settings") ? (
        <LeaderboardCoadminControls />
      ) : null}
    </>
  );
}
