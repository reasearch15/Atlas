/**
 * Firebase Cloud Messaging (web) hosts required by the Firebase JS SDK.
 *
 * Verified against @firebase/installations and @firebase/messaging (v0.13.x):
 * - Installations FID: https://firebaseinstallations.googleapis.com/v1
 * - FCM web token registration: https://fcmregistrations.googleapis.com/v1
 * - Optional SW delivery telemetry: https://play.google.com/log?...
 *
 * Do not broaden to *.googleapis.com — keep the allowlist minimal.
 */
export const FIREBASE_MESSAGING_CONNECT_SRC = [
  "https://firebaseinstallations.googleapis.com",
  "https://fcmregistrations.googleapis.com",
  "https://play.google.com"
] as const;

/**
 * Builds the connect-src CSP directive value for Atlas + FCM web push.
 */
export function buildAtlasConnectSrc(options: {
  readonly apiOrigin: string;
  readonly wsOrigin: string;
}): string {
  return [
    "'self'",
    options.apiOrigin,
    options.wsOrigin,
    ...FIREBASE_MESSAGING_CONNECT_SRC
  ].join(" ");
}

/**
 * Normalizes a Firebase Web Push / VAPID public key from env or API config.
 * Strips quotes/whitespace that commonly break getToken().
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
      // Keep the cleaned key if decoding fails.
    }
  }
  return key;
}
