"use client";

import { useEffect } from "react";

const LOCK_CLASS = "app-viewport-lock";

/** Dispatched after `--app-vv-*` CSS variables are synced from the Visual Viewport. */
export const APP_VISUAL_VIEWPORT_EVENT = "atlas:visual-viewport";

export interface AppVisualViewportDetail {
  readonly height: number;
  readonly offsetTop: number;
  readonly offsetLeft: number;
}

/**
 * Locks the document and sizes the messaging app shell to the *visual* viewport.
 *
 * Android Chrome / PWAs shrink `visualViewport` when the soft keyboard opens and
 * can leave a stale layout height (white gap under the composer) when it closes
 * if the shell is bound to `100vh` / layout viewport. This hook keeps
 * `--app-vv-height` / `--app-vv-offset-*` in sync so the shell always fills
 * exactly the visible screen.
 */
export function useAppViewportLock(): void {
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add(LOCK_CLASS);

    let raf = 0;
    let followUpTimers: number[] = [];

    const clearFollowUps = (): void => {
      for (const id of followUpTimers) window.clearTimeout(id);
      followUpTimers = [];
    };

    const apply = (): void => {
      const vv = window.visualViewport;
      const height = Math.max(1, Math.round(vv?.height ?? window.innerHeight));
      const offsetTop = Math.round(vv?.offsetTop ?? 0);
      const offsetLeft = Math.round(vv?.offsetLeft ?? 0);

      html.style.setProperty("--app-vv-height", `${height}px`);
      html.style.setProperty("--app-vv-offset-top", `${offsetTop}px`);
      html.style.setProperty("--app-vv-offset-left", `${offsetLeft}px`);

      // Android may scroll the layout viewport when the keyboard opens/closes.
      // Keep the document pinned so only the messages scroller moves.
      if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
      if (html.scrollTop !== 0) html.scrollTop = 0;
      if (document.body.scrollTop !== 0) document.body.scrollTop = 0;

      window.dispatchEvent(
        new CustomEvent<AppVisualViewportDetail>(APP_VISUAL_VIEWPORT_EVENT, {
          detail: { height, offsetTop, offsetLeft }
        })
      );
    };

    const sync = (): void => {
      cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(apply);
    };

    /**
     * Keyboard animations can emit intermediate VisualViewport sizes.
     * Re-read after the animation settles so the closed state restores fully.
     */
    const syncWithSettle = (): void => {
      sync();
      clearFollowUps();
      for (const delay of [50, 150, 300]) {
        followUpTimers.push(window.setTimeout(sync, delay));
      }
    };

    sync();

    const vv = window.visualViewport;
    vv?.addEventListener("resize", syncWithSettle);
    vv?.addEventListener("scroll", sync);
    window.addEventListener("resize", syncWithSettle);
    window.addEventListener("orientationchange", syncWithSettle);
    window.addEventListener("pageshow", syncWithSettle);
    // focus transitions coincide with keyboard open/close on Android.
    window.addEventListener("focusin", syncWithSettle);
    window.addEventListener("focusout", syncWithSettle);

    return () => {
      cancelAnimationFrame(raf);
      clearFollowUps();
      vv?.removeEventListener("resize", syncWithSettle);
      vv?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", syncWithSettle);
      window.removeEventListener("orientationchange", syncWithSettle);
      window.removeEventListener("pageshow", syncWithSettle);
      window.removeEventListener("focusin", syncWithSettle);
      window.removeEventListener("focusout", syncWithSettle);
      html.classList.remove(LOCK_CLASS);
      html.style.removeProperty("--app-vv-height");
      html.style.removeProperty("--app-vv-offset-top");
      html.style.removeProperty("--app-vv-offset-left");
    };
  }, []);
}
