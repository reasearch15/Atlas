import type { Role } from "@atlas/shared";
import {
  CUSTOMER_PRIVACY_NOTICE,
  customerExportColumnsForRole,
  customerPrivacyCapabilities
} from "@atlas/shared";
import { assertCanExportCustomerContactData, exportColumnsForUser } from "./customer-privacy-guards";
import type { RequestUser } from "../auth/auth.types";

export interface CustomerExportSourceRow {
  readonly atlasContactId: string;
  readonly atlasConversationId: string;
  readonly displayName: string;
  readonly neutralTypeLabel: string;
  readonly crmStatus: string;
  readonly assignedUserName: string | null;
  readonly tags: string;
  readonly lastMessageAt: string | null;
  readonly phone?: string | null;
  readonly username?: string | null;
  readonly telegramUserId?: string | null;
  readonly telegramChatId?: string | null;
  readonly email?: string | null;
}

/**
 * Builds CSV-ready export rows using only columns permitted for the actor.
 * Staff schemas exclude identifier columns entirely (not blank values).
 */
export function buildCustomerExportRows(
  user: Pick<RequestUser, "role">,
  rows: readonly CustomerExportSourceRow[]
): { readonly columns: readonly string[]; readonly rows: readonly Record<string, string>[] } {
  const caps = customerPrivacyCapabilities(user.role as Role);
  // Staff may export operational fields only. Privileged roles need the export permission.
  if (caps.canExportCustomerContactData) {
    assertCanExportCustomerContactData(user);
  }
  const columns = exportColumnsForUser(user);
  const projected = rows.map((row) => {
    const out: Record<string, string> = {};
    for (const column of columns) {
      const value = (row as unknown as Record<string, string | null | undefined>)[column];
      out[column] = value == null ? "" : String(value);
    }
    return out;
  });
  return { columns, rows: projected };
}

/**
 * Serializes export rows to CSV. Never includes columns outside the role schema.
 */
export function serializeCustomerExportCsv(
  user: Pick<RequestUser, "role">,
  rows: readonly CustomerExportSourceRow[]
): string {
  const { columns, rows: projected } = buildCustomerExportRows(user, rows);
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const lines = [columns.join(",")];
  for (const row of projected) {
    lines.push(columns.map((column) => escape(row[column] ?? "")).join(","));
  }
  return lines.join("\n");
}

/**
 * Returns whether Staff export schemas include any direct-contact column (always false).
 */
export function staffExportContainsDirectContactColumns(role: Role = "STAFF"): boolean {
  const columns = new Set(customerExportColumnsForRole(role));
  return ["phone", "username", "telegramUserId", "telegramChatId", "email"].some((key) => columns.has(key));
}

export { CUSTOMER_PRIVACY_NOTICE };
