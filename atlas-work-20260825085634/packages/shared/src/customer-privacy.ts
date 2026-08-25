import type { Role } from "./roles";
import { hasPermission, type Permission } from "./roles";

/** Neutral copy shown when direct contact fields are withheld. */
export const CUSTOMER_PRIVACY_NOTICE = "Contact details hidden by workspace policy";

/** Permissions that gate direct customer contact data. */
export const customerPrivacyPermissions = [
  "customer:phone:view",
  "customer:telegram-username:view",
  "customer:external-ids:view",
  "customer:email:view",
  "customer:export",
  "customer:search-external"
] as const satisfies readonly Permission[];

export type CustomerPrivacyPermission = (typeof customerPrivacyPermissions)[number];

/**
 * Capability flags derived only from the authenticated role (never from the client).
 */
export interface CustomerPrivacyCapabilities {
  readonly canViewCustomerPhone: boolean;
  readonly canViewTelegramUsername: boolean;
  readonly canViewExternalContactIds: boolean;
  readonly canViewCustomerEmail: boolean;
  readonly canExportCustomerContactData: boolean;
  readonly canSearchByExternalIdentifier: boolean;
}

/**
 * Resolves customer-privacy capabilities for a role.
 */
export function customerPrivacyCapabilities(role: Role): CustomerPrivacyCapabilities {
  return {
    canViewCustomerPhone: hasPermission(role, "customer:phone:view"),
    canViewTelegramUsername: hasPermission(role, "customer:telegram-username:view"),
    canViewExternalContactIds: hasPermission(role, "customer:external-ids:view"),
    canViewCustomerEmail: hasPermission(role, "customer:email:view"),
    canExportCustomerContactData: hasPermission(role, "customer:export"),
    canSearchByExternalIdentifier: hasPermission(role, "customer:search-external")
  };
}

/** True when the role may see any direct customer contact identifier. */
export function canViewDirectCustomerContact(role: Role): boolean {
  const caps = customerPrivacyCapabilities(role);
  return (
    caps.canViewCustomerPhone ||
    caps.canViewTelegramUsername ||
    caps.canViewExternalContactIds ||
    caps.canViewCustomerEmail
  );
}

/**
 * Forbidden JSON key names that must never appear in Staff-visible payloads.
 * Used for negative assertions and recursive redaction.
 */
export const FORBIDDEN_CUSTOMER_IDENTIFIER_KEYS = [
  "phone",
  "phoneNumber",
  "phoneMasked",
  "maskedPhone",
  "maskedPhoneNumber",
  "peerPhone",
  "username",
  "telegramUsername",
  "telegramUserId",
  "senderTelegramUserId",
  "telegramChatId",
  "peerId",
  "accessHash",
  "access_hash",
  "email",
  "emailAddress",
  "whatsapp",
  "whatsApp",
  "waLink",
  "tMe",
  "tmeLink",
  "telegramLink",
  "profileLink",
  "socialHandle",
  "externalContact",
  "contactExport",
  "rawMetadata",
  "rawMetadataJson"
] as const;

const FORBIDDEN_KEY_SET = new Set<string>(FORBIDDEN_CUSTOMER_IDENTIFIER_KEYS);

/**
 * Maps Telegram chat types to neutral Staff-facing labels (no external channel identity).
 */
export function neutralCustomerTypeLabel(chatType: string | null | undefined, isBot?: boolean): string {
  if (isBot) return "Customer";
  switch ((chatType ?? "").toUpperCase()) {
    case "GROUP":
    case "SUPERGROUP":
      return "Group";
    case "CHANNEL":
      return "Channel";
    default:
      return "Customer";
  }
}

/**
 * Maps CRM contact kinds to neutral labels for Staff.
 */
export function neutralContactKindLabel(kind: string | null | undefined): string {
  const normalized = (kind ?? "").toUpperCase();
  if (normalized.includes("GROUP")) return "Group";
  if (normalized.includes("CHANNEL")) return "Channel";
  return "Customer";
}

/**
 * Returns whether a display string looks like a phone number or raw peer id.
 */
export function looksLikeExternalIdentifier(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^-?\d{5,}$/.test(trimmed)) return true;
  if (/^\+?[1-9]\d{6,14}$/.test(trimmed.replace(/[\s()-]/g, ""))) return true;
  if (/^@?[a-zA-Z][\w\d]{3,31}$/.test(trimmed) && !/\s/.test(trimmed)) {
    // Bare username-looking tokens are external handles when used as titles.
    return trimmed.startsWith("@");
  }
  return false;
}

/**
 * Recursively removes forbidden identifier keys from a JSON-compatible value.
 * Does not replace values with placeholders — keys are omitted entirely.
 */
export function stripForbiddenCustomerIdentifierKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenCustomerIdentifierKeys(item)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_SET.has(key)) continue;
      output[key] = stripForbiddenCustomerIdentifierKeys(nested);
    }
    return output as T;
  }
  return value;
}

/**
 * Redacts media metadata so Staff never receive embedded phone / username / peer fields.
 */
export function redactMediaMetadataForPrivacy(
  metadata: Record<string, unknown> | null,
  caps: CustomerPrivacyCapabilities
): Record<string, unknown> | null {
  if (!metadata) return null;
  if (
    caps.canViewCustomerPhone &&
    caps.canViewTelegramUsername &&
    caps.canViewExternalContactIds &&
    caps.canViewCustomerEmail
  ) {
    return metadata;
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (!caps.canViewCustomerPhone && (lower.includes("phone") || lower === "vcard")) continue;
    if (!caps.canViewTelegramUsername && (lower.includes("username") || lower === "user")) continue;
    if (
      !caps.canViewExternalContactIds &&
      (lower.includes("userid") ||
        lower.includes("user_id") ||
        lower.includes("peer") ||
        lower.includes("accesshash") ||
        lower.includes("access_hash") ||
        lower === "id")
    ) {
      continue;
    }
    if (!caps.canViewCustomerEmail && lower.includes("email")) continue;
    if (key === "webPreview" && value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = redactWebPreview(value as Record<string, unknown>, caps);
      continue;
    }
    next[key] = typeof value === "object" && value !== null ? stripForbiddenCustomerIdentifierKeys(value) : value;
  }
  return Object.keys(next).length > 0 ? next : null;
}

/**
 * Redacts or drops web previews that are external contact/profile links.
 */
export function redactWebPreview(
  preview: { readonly url?: unknown; readonly title?: unknown; readonly description?: unknown } | null,
  caps: CustomerPrivacyCapabilities
): { readonly url: string; readonly title: string | null; readonly description: string | null } | null {
  if (!preview || typeof preview.url !== "string" || !preview.url) return null;
  const url = preview.url;
  const isExternalContactLink =
    /(?:^|\/\/)(?:t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|mailto:)/i.test(url) ||
    /^tel:/i.test(url);
  if (isExternalContactLink && !caps.canViewExternalContactIds && !caps.canViewTelegramUsername && !caps.canViewCustomerPhone) {
    return null;
  }
  return {
    url,
    title: typeof preview.title === "string" ? preview.title : null,
    description: typeof preview.description === "string" ? preview.description : null
  };
}

/**
 * Asserts that a Staff-visible payload contains none of the forbidden identifier keys.
 * Returns the list of violations (empty when safe).
 */
export function findForbiddenCustomerIdentifierKeys(payload: unknown, path = ""): string[] {
  const hits: string[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => {
      hits.push(...findForbiddenCustomerIdentifierKeys(item, `${path}[${index}]`));
    });
    return hits;
  }
  if (payload && typeof payload === "object") {
    for (const [key, nested] of Object.entries(payload as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY_SET.has(key)) {
        hits.push(nextPath);
      }
      hits.push(...findForbiddenCustomerIdentifierKeys(nested, nextPath));
    }
  }
  return hits;
}

/**
 * Columns allowed in Staff customer exports (direct identifiers excluded entirely).
 */
export const STAFF_CUSTOMER_EXPORT_COLUMNS = [
  "atlasContactId",
  "atlasConversationId",
  "displayName",
  "neutralTypeLabel",
  "crmStatus",
  "assignedUserName",
  "tags",
  "lastMessageAt"
] as const;

/**
 * Columns available to privileged exports when export permission is granted.
 */
export const PRIVILEGED_CUSTOMER_EXPORT_COLUMNS = [
  ...STAFF_CUSTOMER_EXPORT_COLUMNS,
  "phone",
  "username",
  "telegramUserId",
  "telegramChatId",
  "email"
] as const;

/**
 * Resolves the export column set for a role. Staff never receive identifier columns.
 */
export function customerExportColumnsForRole(role: Role): readonly string[] {
  const caps = customerPrivacyCapabilities(role);
  if (!caps.canExportCustomerContactData) {
    return STAFF_CUSTOMER_EXPORT_COLUMNS;
  }
  return PRIVILEGED_CUSTOMER_EXPORT_COLUMNS;
}
