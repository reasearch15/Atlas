import { z } from "zod";
import {
  crmAssignSchema,
  crmChatTagSchema,
  crmNoteCreateSchema,
  crmNoteUpdateSchema,
  crmStatusSchema,
  crmTagCreateSchema,
  crmTagUpdateSchema,
  uuidSchema
} from "@atlas/shared";

export const crmChatParamsSchema = z.object({
  chatId: uuidSchema
});

export const crmTagParamsSchema = z.object({
  tagId: uuidSchema
});

export const crmChatTagParamsSchema = z.object({
  chatId: uuidSchema,
  tagId: uuidSchema
});

export const crmNoteParamsSchema = z.object({
  chatId: uuidSchema,
  noteId: uuidSchema
});

export const assignBodySchema = crmAssignSchema;
export const statusBodySchema = crmStatusSchema;
export const noteCreateBodySchema = crmNoteCreateSchema;
export const noteUpdateBodySchema = crmNoteUpdateSchema;
export const tagCreateBodySchema = crmTagCreateSchema;
export const tagUpdateBodySchema = crmTagUpdateSchema;
export const chatTagBodySchema = crmChatTagSchema;
