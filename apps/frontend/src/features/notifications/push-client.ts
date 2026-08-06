import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationAckEvent,
  type NotificationAction,
  type NotificationHistoryItemDto,
  type NotificationPreferencesDto,
  type NotificationReconcileResultDto,
  type NotificationWebConfigDto,
  type PushDeviceDto,
  type PushPlatform
} from "@atlas/shared";
import { apiRequest } from "@/lib/api";
import { normalizeFirebaseVapidKey } from "@/lib/firebase-csp";

const TOKEN_STORAGE_KEY = "atlas.fcm.token";

export type PushRegistrationState =
  | { readonly status: "unsupported" | "disabled" | "denied" | "ready" | "error"; readonly detail?: string }
  | { readonly status: "registered"; readonly token: string };

/**
 * Detects the best push platform label for this browser / device.
 */
export function detectPushPlatform(): PushPlatform {
  if (typeof navigator === "undefined") return "WEB";
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) return "ANDROID";
  if (/iPhone|iPad|iPod/i.test(ua)) return "IOS";
  return "WEB";
}

export async function fetchNotificationWebConfig(): Promise<NotificationWebConfigDto> {
  return apiRequest<NotificationWebConfigDto>("/api/notifications/web-config");
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferencesDto> {
  return apiRequest<NotificationPreferencesDto>("/api/notifications/preferences");
}

export async function updateNotificationPreferences(
  prefs: NotificationPreferencesDto
): Promise<NotificationPreferencesDto> {
  return apiRequest<NotificationPreferencesDto>("/api/notifications/preferences", {
    method: "PUT",
    body: JSON.stringify(prefs)
  });
}

export async function listPushDevices(): Promise<PushDeviceDto[]> {
  return apiRequest<PushDeviceDto[]>("/api/notifications/devices");
}

export async function registerPushDevice(input: {
  token: string;
  platform: PushPlatform;
  deviceName?: string;
  appVersion?: string;
}): Promise<PushDeviceDto> {
  return apiRequest<PushDeviceDto>("/api/notifications/devices", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function refreshPushDevice(input: {
  previousToken?: string;
  token: string;
  platform: PushPlatform;
  deviceName?: string;
  appVersion?: string;
}): Promise<PushDeviceDto> {
  return apiRequest<PushDeviceDto>("/api/notifications/devices/refresh", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function deletePushDevice(token: string): Promise<{ success: true }> {
  return apiRequest<{ success: true }>("/api/notifications/devices", {
    method: "DELETE",
    body: JSON.stringify({ token })
  });
}

export async function sendTestPush(deviceTokenId?: string): Promise<{ queued: number }> {
  return apiRequest<{ queued: number }>("/api/notifications/test", {
    method: "POST",
    body: JSON.stringify(deviceTokenId ? { deviceTokenId } : {})
  });
}

export async function reconcileNotifications(): Promise<NotificationReconcileResultDto> {
  return apiRequest<NotificationReconcileResultDto>("/api/notifications/reconcile", { method: "POST" });
}

export async function fetchNotificationHistory(
  status: "unread" | "read" | "dismissed" | "failed" | "all" = "all"
): Promise<NotificationHistoryItemDto[]> {
  return apiRequest<NotificationHistoryItemDto[]>(`/api/notifications/history?status=${status}&limit=50`);
}

export async function ackNotification(
  notificationId: string,
  event: NotificationAckEvent
): Promise<NotificationHistoryItemDto> {
  return apiRequest<NotificationHistoryItemDto>(`/api/notifications/${notificationId}/ack`, {
    method: "POST",
    body: JSON.stringify({ event })
  });
}

export async function runNotificationAction(
  notificationId: string,
  action: NotificationAction
): Promise<{ ok: true; deepLinkPath?: string }> {
  return apiRequest<{ ok: true; deepLinkPath?: string }>(`/api/notifications/${notificationId}/actions`, {
    method: "POST",
    body: JSON.stringify({ action })
  });
}

/**
 * Registers (or rotates) an FCM web token for the authenticated session.
 */
export async function ensurePushRegistration(): Promise<PushRegistrationState> {
  if (typeof window === "undefined") return { status: "unsupported" };
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return { status: "unsupported" };
  }

  let config: NotificationWebConfigDto;
  try {
    config = await fetchNotificationWebConfig();
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : "config_failed" };
  }

  if (!config.enabled || !config.apiKey || !config.projectId || !config.messagingSenderId || !config.appId || !config.vapidKey) {
    return { status: "disabled" };
  }

  const vapidKey = normalizeFirebaseVapidKey(config.vapidKey);
  if (!vapidKey) {
    return { status: "error", detail: "invalid_vapid_key" };
  }

  if (Notification.permission === "denied") return { status: "denied" };
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { status: "denied" };
  }

  try {
    const { initializeApp, getApps } = await import("firebase/app");
    const { getMessaging, getToken, isSupported } = await import("firebase/messaging");

    if (!(await isSupported())) return { status: "unsupported" };

    const app =
      getApps()[0] ??
      initializeApp({
        apiKey: config.apiKey,
        ...(config.authDomain ? { authDomain: config.authDomain } : {}),
        projectId: config.projectId,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId
      });

    const messaging = getMessaging(app);
    const registration = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration
    });

    if (!token) return { status: "error", detail: "empty_token" };

    const previous = localStorage.getItem(TOKEN_STORAGE_KEY);
    const platform = detectPushPlatform();
    const deviceName = navigator.userAgent.slice(0, 160);

    if (previous && previous !== token) {
      await refreshPushDevice({ previousToken: previous, token, platform, deviceName, appVersion: "web-1" });
    } else {
      await registerPushDevice({ token, platform, deviceName, appVersion: "web-1" });
    }
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    return { status: "registered", token };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "register_failed";
    // CSP blocks usually surface as Failed to fetch against firebaseinstallations / fcmregistrations.
    return { status: "error", detail };
  }
}

/**
 * Unregisters the local FCM token from Atlas (call on logout).
 */
export async function unregisterLocalPushDevice(): Promise<void> {
  if (typeof window === "undefined") return;
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return;
  try {
    await deletePushDevice(token);
  } catch {
    // Best-effort — server also revokes by session on logout.
  } finally {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

/**
 * Subscribes to foreground FCM messages: toast + sound + vibration + OS notification.
 * Does NOT suppress the system notification when the app is open.
 */
export async function bindForegroundPushHandlers(handlers: {
  onMessage: (payload: {
    title: string;
    body: string;
    deepLinkPath: string | null;
    chatId: string | null;
    messageId: string | null;
    notificationId: string | null;
  }) => void;
}): Promise<() => void> {
  if (typeof window === "undefined") return () => undefined;

  try {
    const config = await fetchNotificationWebConfig();
    if (!config.enabled || !config.apiKey || !config.projectId || !config.messagingSenderId || !config.appId) {
      return () => undefined;
    }

    const { initializeApp, getApps } = await import("firebase/app");
    const { getMessaging, onMessage, isSupported } = await import("firebase/messaging");
    if (!(await isSupported())) return () => undefined;

    const app =
      getApps()[0] ??
      initializeApp({
        apiKey: config.apiKey,
        ...(config.authDomain ? { authDomain: config.authDomain } : {}),
        projectId: config.projectId,
        messagingSenderId: config.messagingSenderId,
        appId: config.appId
      });

    const messaging = getMessaging(app);
    const unsubscribe = onMessage(messaging, async (payload) => {
      const title = payload.notification?.title || payload.data?.title || "Atlas";
      const body = payload.notification?.body || payload.data?.body || "New notification";
      const deepLinkPath = payload.data?.deepLinkPath ?? null;
      const chatId = payload.data?.chatId || null;
      const messageId = payload.data?.messageId || null;
      const notificationId = payload.data?.notificationId || null;
      const tag = notificationId
        ? `atlas-n-${notificationId}`
        : `atlas-fg-${messageId || chatId || Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      handlers.onMessage({ title, body, deepLinkPath, chatId, messageId, notificationId });

      try {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(title, {
          body,
          tag,
          requireInteraction: true,
          data: { deepLinkPath, chatId, messageId, notificationId },
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png"
        });
      } catch {
        // showNotification can fail without permission / SW.
      }

      if (payload.data?.vibration !== "0" && navigator.vibrate) {
        navigator.vibrate([80, 40, 80]);
      }
    });

    return () => unsubscribe();
  } catch {
    return () => undefined;
  }
}

export { DEFAULT_NOTIFICATION_PREFERENCES, TOKEN_STORAGE_KEY };
