"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { playNotificationBeep } from "@/features/inbox/notification-sound";
import {
  ackNotification,
  bindForegroundPushHandlers,
  ensurePushRegistration,
  isPushDisabledOnThisDevice,
  reconcileNotifications,
  runNotificationAction
} from "@/features/notifications/push-client";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Registers FCM after tenant login, reconciles offline gaps, and handles
 * foreground push + service-worker ack/action messages.
 */
export function PushBootstrap(): null {
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);

  useEffect(() => {
    if (!user || !accessToken) return;
    if (user.role !== "COADMIN" && user.role !== "STAFF") return;

    let cancelled = false;
    let unbind: (() => void) | undefined;

    void (async () => {
      if (isPushDisabledOnThisDevice()) return;

      const result = await ensurePushRegistration();
      if (cancelled) return;
      if (result.status === "registered") {
        await reconcileNotifications().catch(() => undefined);
        unbind = await bindForegroundPushHandlers({
          onMessage: ({ title, body, notificationId }) => {
            playNotificationBeep();
            toast(title, { description: body });
            if (notificationId) {
              void ackNotification(notificationId, "delivered").catch(() => undefined);
            }
          }
        });
      }
    })();

    const onSwMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        path?: string;
        notificationId?: string | null;
        event?: "delivered" | "opened" | "dismissed";
        action?: "open" | "mark_read" | "claim";
      } | null;

      if (!data?.type) return;

      if (data.type === "atlas.push.navigate" && typeof data.path === "string") {
        window.location.assign(data.path);
        return;
      }

      if (data.type === "atlas.push.ack" && data.notificationId && data.event) {
        void ackNotification(data.notificationId, data.event).catch(() => undefined);
        return;
      }

      if (data.type === "atlas.push.action" && data.notificationId && data.action) {
        void (async () => {
          try {
            const result = await runNotificationAction(data.notificationId!, data.action!);
            if (data.action === "open" && result.deepLinkPath) {
              window.location.assign(result.deepLinkPath);
            } else if (data.action === "open" && data.path) {
              window.location.assign(data.path);
            }
          } catch {
            if (data.action === "open" && data.path) window.location.assign(data.path);
          }
        })();
      }
    };
    navigator.serviceWorker?.addEventListener("message", onSwMessage);

    const onOnline = () => {
      void reconcileNotifications().catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void reconcileNotifications().catch(() => undefined);
      }
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      unbind?.();
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, accessToken]);

  return null;
}
