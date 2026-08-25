import {
  installAudioUnlockListeners,
  playNotificationBeep,
  shouldNotifyIncoming,
  type NotifyIncomingOptions
} from "./notification-sound";

let unlockInstalled = false;
let notificationPermissionRequested = false;

/**
 * Notifies the user about an inbound chat message (sound + optional desktop notification).
 */
export function notifyIncomingMessage(opts: NotifyIncomingOptions): void {
  ensureUnlockInstalled();

  if (!shouldNotifyIncoming(opts)) return;

  playNotificationBeep();

  const hidden =
    typeof opts.documentHidden === "boolean"
      ? opts.documentHidden
      : typeof document === "undefined"
        ? false
        : document.hidden;

  if (hidden) {
    void showDesktopNotification(opts);
  }
}

/**
 * Requests Notification permission once when appropriate.
 */
export async function ensureDesktopNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }
  if (notificationPermissionRequested) return Notification.permission;
  notificationPermissionRequested = true;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

async function showDesktopNotification(opts: NotifyIncomingOptions): Promise<void> {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await ensureDesktopNotificationPermission();
  }
  if (Notification.permission !== "granted") return;

  const title = opts.chatTitle || "New message";
  const body = opts.preview.slice(0, 180) || "New message";
  try {
    const notification = new Notification(title, {
      body,
      tag: `atlas-chat-${opts.chatId}`
    });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Ignore focus failures.
      }
      notification.close();
    };
  } catch {
    // Notification construction can fail in insecure contexts.
  }
}

function ensureUnlockInstalled(): void {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  installAudioUnlockListeners();
}
