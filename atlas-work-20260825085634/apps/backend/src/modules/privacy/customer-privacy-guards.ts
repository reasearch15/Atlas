import type { Role } from "@atlas/shared";
import {
  customerExportColumnsForRole,
  customerPrivacyCapabilities,
  type CustomerPrivacyCapabilities
} from "@atlas/shared";
import { forbidden } from "../../utils/errors";
import type { RequestUser } from "../auth/auth.types";

/**
 * Resolves privacy capabilities from the authenticated user only (never from the request body).
 */
export function privacyCapsForUser(user: Pick<RequestUser, "role">): CustomerPrivacyCapabilities {
  return customerPrivacyCapabilities(user.role as Role);
}

/**
 * Asserts the actor may export direct customer contact columns.
 */
export function assertCanExportCustomerContactData(user: Pick<RequestUser, "role">): void {
  if (!privacyCapsForUser(user).canExportCustomerContactData) {
    throw forbidden("Exporting customer contact identifiers is not permitted for this role.");
  }
}

/**
 * Returns the export schema columns allowed for the actor. Staff never get identifier columns.
 */
export function exportColumnsForUser(user: Pick<RequestUser, "role">): readonly string[] {
  return customerExportColumnsForRole(user.role as Role);
}

/**
 * Asserts the actor may search by external customer identifiers.
 */
export function assertCanSearchByExternalIdentifier(user: Pick<RequestUser, "role">): void {
  if (!privacyCapsForUser(user).canSearchByExternalIdentifier) {
    throw forbidden("Searching by external customer identifiers is not permitted for this role.");
  }
}
