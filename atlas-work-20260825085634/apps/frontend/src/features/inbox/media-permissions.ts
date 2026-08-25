export type MediaPermissionKind = "microphone" | "camera";

export type MediaPermissionState = "unknown" | "granted" | "denied" | "unsupported" | "unavailable";

const DENIED_SESSION_PREFIX = "atlas.inbox.permission-denied:";

/**
 * Returns whether this browser exposes getUserMedia.
 */
export function isMediaDevicesSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Reads a session-scoped denial flag so we do not re-prompt after the user denies.
 */
export function wasPermissionDeniedThisSession(kind: MediaPermissionKind): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(`${DENIED_SESSION_PREFIX}${kind}`) === "1";
  } catch {
    return false;
  }
}

/**
 * Marks a permission as denied for this tab session.
 */
export function markPermissionDeniedThisSession(kind: MediaPermissionKind): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${DENIED_SESSION_PREFIX}${kind}`, "1");
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Clears the session denial flag (e.g. after the user opens OS settings and retries once).
 */
export function clearPermissionDeniedThisSession(kind: MediaPermissionKind): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(`${DENIED_SESSION_PREFIX}${kind}`);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Maps a getUserMedia failure into a stable permission state + user message.
 */
export function classifyMediaError(kind: MediaPermissionKind, error: unknown): {
  readonly state: MediaPermissionState;
  readonly message: string;
} {
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    markPermissionDeniedThisSession(kind);
    return {
      state: "denied",
      message:
        kind === "microphone"
          ? "Microphone access was denied. Enable it in browser settings to record voice messages."
          : "Camera access was denied. Enable it in browser settings to capture photos or video."
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      state: "unavailable",
      message: kind === "microphone" ? "No microphone was found on this device." : "No camera was found on this device."
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      state: "unavailable",
      message: kind === "microphone" ? "Microphone is busy or unavailable." : "Camera is busy or unavailable."
    };
  }
  if (name === "NotSupportedError" || !isMediaDevicesSupported()) {
    return {
      state: "unsupported",
      message: kind === "microphone" ? "Microphone is not supported in this browser." : "Camera is not supported in this browser."
    };
  }
  return {
    state: "unavailable",
    message: kind === "microphone" ? "Unable to access the microphone." : "Unable to access the camera."
  };
}

/**
 * Requests a media stream only after an explicit user action.
 */
export async function requestUserMedia(
  kind: MediaPermissionKind,
  constraints: MediaStreamConstraints
): Promise<MediaStream> {
  if (!isMediaDevicesSupported()) {
    throw Object.assign(new Error("unsupported"), { name: "NotSupportedError" });
  }
  if (wasPermissionDeniedThisSession(kind)) {
    throw Object.assign(new Error("Permission denied this session"), { name: "NotAllowedError" });
  }
  return navigator.mediaDevices.getUserMedia(constraints);
}
