/**
 * Pure helpers for Telegram phone-call update detection (no VoIP / no RPCs).
 */

export type IncomingPhoneCallRequested = {
  readonly callId: string;
  readonly callerTelegramUserId: string;
  readonly participantTelegramUserId: string;
  readonly video: boolean;
  readonly dateUnix: number;
};

/**
 * Extracts a safe PhoneCallRequested payload from a raw GramJS/MTProto update.
 * Returns null for any other update or incomplete call object.
 * Never reads or returns DH / accessHash / signaling material.
 */
export function parseIncomingPhoneCallRequested(update: unknown): IncomingPhoneCallRequested | null {
  const value = (update ?? {}) as Record<string, unknown>;
  const updateClass = String(value.className ?? value._ ?? "");
  if (updateClass !== "UpdatePhoneCall" && !updateClass.includes("UpdatePhoneCall")) {
    return null;
  }
  // Signaling updates share a className prefix — ignore them explicitly.
  if (updateClass.includes("SignalingData") || updateClass === "UpdatePhoneCallSignalingData") {
    return null;
  }

  const phoneCall = (value.phoneCall ?? value.phone_call ?? null) as Record<string, unknown> | null;
  if (!phoneCall || typeof phoneCall !== "object") {
    return null;
  }

  const callClass = String(phoneCall.className ?? phoneCall._ ?? "");
  if (callClass !== "PhoneCallRequested" && !callClass.endsWith("PhoneCallRequested")) {
    return null;
  }

  const callId = phoneCall.id != null ? String(phoneCall.id) : "";
  const adminId = phoneCall.adminId ?? phoneCall.admin_id;
  const participantId = phoneCall.participantId ?? phoneCall.participant_id;
  const callerTelegramUserId = adminId != null ? String(adminId) : "";
  const participantTelegramUserId = participantId != null ? String(participantId) : "";
  if (!callId || !callerTelegramUserId) {
    return null;
  }

  const dateRaw = phoneCall.date;
  const dateUnix =
    typeof dateRaw === "number" && Number.isFinite(dateRaw)
      ? dateRaw
      : Math.floor(Date.now() / 1000);

  return {
    callId,
    callerTelegramUserId,
    participantTelegramUserId,
    video: Boolean(phoneCall.video),
    dateUnix
  };
}

/**
 * Builds a display name from resolved caller identity fields.
 */
export function buildCallerDisplayName(input: {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly title?: string | null;
}): string | null {
  const fromParts = [input.firstName, input.lastName]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (fromParts) return fromParts;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  return title.length > 0 ? title : null;
}
