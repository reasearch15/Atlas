"use client";

import { useEffect, useState } from "react";

export type AtlasBreakpoint = "mobile" | "tablet" | "desktop";

/**
 * Tailwind-aligned breakpoints:
 * mobile  < 768px
 * tablet  768–1023px
 * desktop ≥ 1024px
 */
export function useAtlasBreakpoint(): AtlasBreakpoint {
  const [breakpoint, setBreakpoint] = useState<AtlasBreakpoint>("desktop");

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 767.98px)");
    const tabletQuery = window.matchMedia("(min-width: 768px) and (max-width: 1023.98px)");

    function update(): void {
      if (mobileQuery.matches) setBreakpoint("mobile");
      else if (tabletQuery.matches) setBreakpoint("tablet");
      else setBreakpoint("desktop");
    }

    update();
    mobileQuery.addEventListener("change", update);
    tabletQuery.addEventListener("change", update);
    return () => {
      mobileQuery.removeEventListener("change", update);
      tabletQuery.removeEventListener("change", update);
    };
  }, []);

  return breakpoint;
}

export function useIsMobile(): boolean {
  return useAtlasBreakpoint() === "mobile";
}

export function useIsDesktop(): boolean {
  return useAtlasBreakpoint() === "desktop";
}
