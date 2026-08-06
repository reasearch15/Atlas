import type { Env } from "../../config/env";
import type { NotificationWebConfigDto } from "@atlas/shared";

/**
 * Whether Firebase Admin credentials are present and FCM is enabled.
 */
export function isFcmConfigured(env: Env): boolean {
  return Boolean(
    env.FCM_ENABLED &&
      env.FIREBASE_PROJECT_ID &&
      env.FIREBASE_CLIENT_EMAIL &&
      env.FIREBASE_PRIVATE_KEY
  );
}

/**
 * Whether the browser Messaging SDK has every field required for getToken().
 */
export function isFcmWebClientConfigured(env: Env): boolean {
  return Boolean(
    env.FIREBASE_WEB_API_KEY &&
      env.FIREBASE_MESSAGING_SENDER_ID &&
      env.FIREBASE_WEB_APP_ID &&
      env.FIREBASE_VAPID_KEY
  );
}

/**
 * Strips quotes/whitespace from the Web Push VAPID public key.
 */
export function normalizeFirebaseVapidKey(raw: string): string {
  let key = raw.trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  key = key.replace(/\s+/g, "");
  if (/%[0-9A-Fa-f]{2}/.test(key)) {
    try {
      key = decodeURIComponent(key);
    } catch {
      // Keep cleaned key.
    }
  }
  return key;
}

/**
 * Public web SDK config for authenticated clients (safe to expose).
 * `enabled` is true only when both Admin send credentials and web client fields exist.
 */
export function getNotificationWebConfig(env: Env): NotificationWebConfigDto {
  const vapidKey = env.FIREBASE_VAPID_KEY ? normalizeFirebaseVapidKey(env.FIREBASE_VAPID_KEY) : null;
  const enabled = isFcmConfigured(env) && isFcmWebClientConfigured(env) && Boolean(vapidKey);
  return {
    enabled,
    apiKey: env.FIREBASE_WEB_API_KEY ?? null,
    authDomain: env.FIREBASE_WEB_AUTH_DOMAIN ?? null,
    projectId: env.FIREBASE_PROJECT_ID ?? null,
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID ?? null,
    appId: env.FIREBASE_WEB_APP_ID ?? null,
    vapidKey
  };
}

/**
 * Normalizes PEM private keys that arrive with escaped newlines from env files.
 */
export function normalizeFirebasePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}
