/**
 * In-panel conversation loading skeleton (never full-page).
 */
export function ConversationSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[hsl(210_25%_96%)]" aria-busy="true" aria-label="Loading conversation">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-white px-4">
        <span className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
        <div className="min-w-0 flex-1 space-y-2">
          <span className="block h-3 w-36 animate-pulse rounded bg-muted" />
          <span className="block h-2.5 w-24 animate-pulse rounded bg-muted/80" />
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-hidden px-3 py-4 sm:px-5">
        <BubblePlaceholder align="start" width="w-2/3" />
        <BubblePlaceholder align="end" width="w-1/2" />
        <BubblePlaceholder align="start" width="w-3/5" />
        <BubblePlaceholder align="end" width="w-2/5" />
        <BubblePlaceholder align="start" width="w-1/2" />
        <BubblePlaceholder align="end" width="w-3/5" />
      </div>

      <div className="sticky bottom-0 shrink-0 border-t bg-white px-3 py-2.5">
        <div className="h-11 animate-pulse rounded-2xl bg-muted/60" />
      </div>
    </div>
  );
}

function BubblePlaceholder({ align, width }: { readonly align: "start" | "end"; readonly width: string }) {
  return (
    <div className={`flex ${align === "end" ? "justify-end" : "justify-start"}`}>
      <div className={`${width} max-w-[min(100%,28rem)] animate-pulse rounded-2xl bg-white px-3 py-3 shadow-sm`}>
        <div className="h-3 w-full rounded bg-muted/70" />
        <div className="mt-2 h-3 w-2/3 rounded bg-muted/50" />
      </div>
    </div>
  );
}
