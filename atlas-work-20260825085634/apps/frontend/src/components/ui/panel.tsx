import { cn } from "@atlas/ui";

/**
 * Renders a compact operational panel for grouped dashboard information.
 */
export function Panel({ className, children }: Readonly<{ className?: string; children: React.ReactNode }>) {
  return <section className={cn("rounded-lg border bg-card p-5 text-card-foreground shadow-sm", className)}>{children}</section>;
}
