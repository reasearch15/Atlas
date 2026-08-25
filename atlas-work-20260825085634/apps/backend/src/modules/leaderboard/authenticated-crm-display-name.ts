/**
 * Authenticated Staff/Coadmin CRM display labels (not public Telegram board naming).
 * Prefer real CRM/Telegram identity; never invent public "Player" placeholders.
 */

export type AuthenticatedCrmDisplayNameInput = {
  readonly displayName?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
  /** When false, skip username fallback (privacy). Default true for Coadmin CRM. */
  readonly allowUsername?: boolean;
};

export type AuthenticatedCrmChatIdentity = {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
};

function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

/** True for empty values and Unknown / Unknown User / Unknown Bot placeholders. */
export function isUnknownPlaceholderDisplayName(value: string | null | undefined): boolean {
  const trimmed = clean(value);
  if (!trimmed) return true;
  return /^unknown(\s|$)/i.test(trimmed);
}

/**
 * Picks Telegram chat identity for display: prefer a chat with first/last name,
 * otherwise the most recent chat (caller should order chats desc by updatedAt).
 */
export function pickAuthenticatedCrmChatIdentity(
  chats: readonly AuthenticatedCrmChatIdentity[]
): AuthenticatedCrmChatIdentity {
  const withName = chats.find((chat) => clean(chat.firstName) || clean(chat.lastName));
  const chat = withName ?? chats[0];
  return {
    firstName: chat?.firstName ?? null,
    lastName: chat?.lastName ?? null,
    username: chat?.username ?? null
  };
}

/**
 * Resolves the best authenticated CRM display label for referral/admin surfaces.
 *
 * Priority:
 * 1. CRM displayName when usable (not Unknown*)
 * 2. Telegram firstName + lastName (or either alone)
 * 3. Telegram username when allowed
 * 4. "Unknown"
 */
export function resolveAuthenticatedCrmDisplayName(input: AuthenticatedCrmDisplayNameInput): string {
  const displayName = clean(input.displayName);
  if (displayName && !isUnknownPlaceholderDisplayName(displayName)) {
    return displayName;
  }

  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (firstName && lastName) return `${firstName} ${lastName}`;
  if (firstName) return firstName;
  if (lastName) return lastName;

  if (input.allowUsername !== false) {
    const username = clean(input.username)?.replace(/^@+/, "") ?? null;
    if (username) return username;
  }

  return "Unknown";
}

/**
 * Resolves a display label from a CRM contact row plus related PRIVATE chat identity.
 */
export function resolveAuthenticatedCrmDisplayNameFromContact(
  contact: {
    readonly displayName: string;
    readonly username: string | null;
    readonly chats: readonly AuthenticatedCrmChatIdentity[];
  },
  options?: { readonly allowUsername?: boolean }
): string {
  const chat = pickAuthenticatedCrmChatIdentity(contact.chats);
  return resolveAuthenticatedCrmDisplayName({
    displayName: contact.displayName,
    firstName: chat.firstName,
    lastName: chat.lastName,
    username: contact.username ?? chat.username,
    ...(options?.allowUsername !== undefined ? { allowUsername: options.allowUsername } : {})
  });
}
