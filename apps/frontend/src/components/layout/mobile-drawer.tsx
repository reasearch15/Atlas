"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MobileDrawerProps {
  readonly open: boolean;
  readonly title?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

/**
 * Full-height slide-over navigation drawer for mobile shells.
 * Overlays content without resizing the page; locks background scroll.
 */
export function MobileDrawer({ open, title = "Menu", onClose, children, footer }: MobileDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close navigation menu"
        onClick={onClose}
      />
      <aside
        className="absolute inset-y-0 left-0 flex w-[min(20rem,88vw)] max-w-full flex-col bg-white shadow-xl"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex min-h-11 shrink-0 items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">{title}</p>
          <Button type="button" variant="ghost" className="size-11 shrink-0 px-0" onClick={onClose} aria-label="Close menu">
            <X className="size-5" aria-hidden="true" />
          </Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-3">{children}</nav>
        {footer ? <div className="shrink-0 border-t px-2 py-3">{footer}</div> : null}
      </aside>
    </div>
  );
}
