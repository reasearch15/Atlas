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
 * Public web SDK config for authenticated clients (safe to expose).
 */
export function getNotificationWebConfig(env: Env): NotificationWebConfigDto {
  const enabled = isFcmConfigured(env) && Boolean(env.FIREBASE_WEB_API_KEY && env.FIREBASE_VAPID_KEY);
  return {
    enabled,
    apiKey: env.FIREBASE_WEB_API_KEY ?? null,
    authDomain: env.FIREBASE_WEB_AUTH_DOMAIN ?? null,
    projectId: env.FIREBASE_PROJECT_ID ?? null,
    messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID ?? null,
    appId: env.FIREBASE_WEB_APP_ID ?? null,
    vapidKey: env.FIREBASE_VAPID_KEY ?? null
  };
}

/**
 * Normalizes PEM private keys that arrive with escaped newlines from env files.
 */
export function normalizeFirebasePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}
