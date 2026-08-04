"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";

export interface MobileBottomNavItem {
  readonly href: Route | string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly match?: "exact" | "prefix";
  readonly badge?: number;
  readonly onClick?: () => void;
}

interface MobileBottomNavProps {
  readonly items: readonly MobileBottomNavItem[];
}

/**
 * Fixed bottom navigation for primary mobile operational routes.
 */
export function MobileBottomNav({ items }: MobileBottomNavProps) {
  const pathname = usePathname();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-white/95 backdrop-blur-sm md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <ul className="grid h-12 grid-flow-col auto-cols-fr">
        {items.map((item) => {
          const Icon = item.icon;
          const active =
            item.match === "exact"
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const content = (
            <>
              <span className="relative">
                <Icon className={active ? "size-[22px]" : "size-5"} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
                {typeof item.badge === "number" && item.badge > 0 ? (
                  <span className="absolute -right-2 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-semibold text-destructive-foreground">
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                ) : null}
              </span>
              <span className={`text-[10px] leading-none ${active ? "font-semibold" : "font-medium"}`}>{item.label}</span>
            </>
          );
          const className = `flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 transition-colors ${
            active ? "text-primary" : "text-muted-foreground"
          }`;
          return (
            <li key={`${item.label}-${item.href}`}>
              {item.onClick ? (
                <button type="button" className={`w-full ${className}`} onClick={item.onClick} aria-current={active ? "page" : undefined}>
                  {content}
                </button>
              ) : (
                <Link href={item.href as Route} className={className} aria-current={active ? "page" : undefined}>
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
