"use client";

/**
 * Renders a neutral empty state for Platform Admin sections that are not implemented yet.
 */
export function AdminEmptyPage({ title, description }: { readonly title: string; readonly description: string }) {
  return (
    <main className="min-h-screen bg-background p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-8">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </section>
    </main>
  );
}
