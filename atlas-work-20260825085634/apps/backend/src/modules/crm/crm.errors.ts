import { AppError } from "../../utils/errors";

/**
 * Creates a CRM-specific not found error (also used for cross-workspace access denial).
 */
export function crmNotFound(message = "CRM resource was not found"): AppError {
  return new AppError(404, "CRM_NOT_FOUND", message);
}

/**
 * Creates a CRM conflict error, e.g. for concurrent claim races or duplicate tag names.
 */
export function crmConflict(message: string): AppError {
  return new AppError(409, "CRM_CONFLICT", message);
}

/**
 * Creates a CRM state transition error for disallowed manual status changes.
 */
export function crmInvalidTransition(message: string): AppError {
  return new AppError(409, "CRM_INVALID_STATE_TRANSITION", message);
}

/**
 * Creates an error when attempting to newly attach an archived workspace tag.
 */
export function crmTagArchived(message = "This tag is archived and cannot be applied."): AppError {
  return new AppError(409, "CRM_TAG_ARCHIVED", message);
}
