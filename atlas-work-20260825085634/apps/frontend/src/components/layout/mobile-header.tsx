"use client";

import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MobileHeaderProps {
  readonly title: string;
  readonly onMenuClick?: () => void;
  readonly action?: ReactNode;
  readonly subtitle?: string | null;
  readonly hideMenu?: boolean;
}

/**
 * Compact mobile app header with optional hamburger and trailing action.
 */
export function MobileHeader({ title, onMenuClick, action, subtitle, hideMenu }: MobileHeaderProps) {
  return (
    <header
      className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-white px-3 py-2 md:hidden"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      {!hideMenu ? (
        <Button type="button" variant="ghost" className="size-11 shrink-0 px-0" onClick={onMenuClick} aria-label="Open menu">
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-tight">{title}</p>
        {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
    </header>
  );
}
