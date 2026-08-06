import type { Env } from "../../config/env";
import { isFcmConfigured, normalizeFirebasePrivateKey } from "./fcm.config";

export type FirebaseMessagingLike = {
  send: (message: Record<string, unknown>) => Promise<string>;
};

export type FirebaseMessagingResult =
  | { readonly status: "ready"; readonly messaging: FirebaseMessagingLike }
  | { readonly status: "not_configured" }
  | { readonly status: "init_failed"; readonly error: unknown };

let messagingInstance: FirebaseMessagingLike | null = null;
let initPromise: Promise<FirebaseMessagingResult> | null = null;

/**
 * Lazily initializes firebase-admin once using the ESM v14 API (`getApps`, `cert`, `getMessaging`).
 * Shared by the notification dispatcher so worker restarts never spawn duplicate apps.
 */
export async function getFirebaseMessaging(env: Env): Promise<FirebaseMessagingResult> {
  if (!isFcmConfigured(env)) {
    return { status: "not_configured" };
  }

  if (messagingInstance) {
    return { status: "ready", messaging: messagingInstance };
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async (): Promise<FirebaseMessagingResult> => {
    try {
      const { initializeApp, getApps, cert } = await import("firebase-admin");
      const { getMessaging } = await import("firebase-admin/messaging");

      if (getApps().length === 0) {
        initializeApp({
          credential: cert({
            projectId: env.FIREBASE_PROJECT_ID!,
            clientEmail: env.FIREBASE_CLIENT_EMAIL!,
            privateKey: normalizeFirebasePrivateKey(env.FIREBASE_PRIVATE_KEY!)
          })
        });
      }

      messagingInstance = getMessaging() as unknown as FirebaseMessagingLike;
      return { status: "ready", messaging: messagingInstance };
    } catch (error) {
      initPromise = null;
      return { status: "init_failed", error };
    }
  })();

  return initPromise;
}

/** Test-only reset so vitest cases do not share singleton state. */
export function resetFirebaseMessagingForTests(): void {
  messagingInstance = null;
  initPromise = null;
}
