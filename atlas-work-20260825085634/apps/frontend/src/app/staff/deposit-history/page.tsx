"use client";

import { StaffShell } from "@/components/layout/staff-shell";
import { DepositHistorySection } from "@/features/leaderboard/deposit-history-section";

export default function StaffDepositHistoryPage() {
  return (
    <StaffShell>
      <main className="space-y-4 p-4 pb-8 md:p-6 lg:p-8">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Deposit History</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Deposits you recorded, newest first. Load more to see older entries.
          </p>
        </div>
        <DepositHistorySection variant="staff" />
      </main>
    </StaffShell>
  );
}
