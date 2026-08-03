import { z } from "zod";

export const crmConversationStatuses = ["NEW", "OPEN", "WAITING", "RESOLVED", "CLOSED"] as const;
export type CrmConversationStatus = (typeof crmConversationStatuses)[number];

export const crmActivityTypes = [
  "CLAIMED",
  "ASSIGNED",
  "REASSIGNED",
  "RELEASED",
  "STATUS_CHANGED",
  "TAG_ADDED",
  "TAG_REMOVED",
  "NOTE_CREATED",
  "NOTE_EDITED",
  "REOPENED",
  "TELEGRAM_MESSAGE_SENT",
  "INTERNAL_MESSAGE_SENT"
] as const;
export type CrmActivityType = (typeof crmActivityTypes)[number];

export const crmInboxFilters = [
  "all",
  "unassigned",
  "mine",
  "new",
  "open",
  "waiting",
  "unread",
  "resolved"
] as const;
export type CrmInboxFilter = (typeof crmInboxFilters)[number];

/**
 * Resolves the CRM status after an inbound customer message.
 * RESOLVED → OPEN, CLOSED → NEW (attention resets to unworked).
 */
export function reopenStatusOnInbound(current: CrmConversationStatus): CrmConversationStatus | null {
  if (current === "RESOLVED") return "OPEN";
  if (current === "CLOSED") return "NEW";
  return null;
}

/**
 * Returns whether a status transition is allowed for interactive CRM updates.
 */
export function isAllowedManualStatusTransition(
  from: CrmConversationStatus,
  to: CrmConversationStatus
): boolean {
  if (from === to) return false;
  return crmConversationStatuses.includes(to);
}

/**
 * Claiming an unassigned NEW conversation opens it.
 */
export function statusAfterClaim(current: CrmConversationStatus): CrmConversationStatus {
  return current === "NEW" ? "OPEN" : current;
}

export const crmAssignSchema = z.object({
  assigneeUserId: z.string().uuid().nullable()
});

export const crmStatusSchema = z.object({
  status: z.enum(crmConversationStatuses)
});

export const crmNoteCreateSchema = z.object({
  body: z.string().trim().min(1).max(8000)
});

export const crmNoteUpdateSchema = z.object({
  body: z.string().trim().min(1).max(8000)
});

export const crmTagCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/)
});

export const crmTagUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  archived: z.boolean().optional()
});

export const crmChatTagSchema = z.object({
  tagId: z.string().uuid()
});

export type CrmAssignInput = z.infer<typeof crmAssignSchema>;
export type CrmStatusInput = z.infer<typeof crmStatusSchema>;
export type CrmNoteCreateInput = z.infer<typeof crmNoteCreateSchema>;
export type CrmNoteUpdateInput = z.infer<typeof crmNoteUpdateSchema>;
export type CrmTagCreateInput = z.infer<typeof crmTagCreateSchema>;
export type CrmTagUpdateInput = z.infer<typeof crmTagUpdateSchema>;
