"use client";

import { DepositHistorySection } from "@/features/leaderboard/deposit-history-section";

export default function WorkspaceDepositHistoryPage() {
  return (
    <main className="space-y-4 p-4 pb-8 md:p-6 lg:p-8">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Deposit History</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All deposits on your leaderboard, including Staff entries. Newest first.
        </p>
      </div>
      <DepositHistorySection variant="coadmin" />
    </main>
  );
}
