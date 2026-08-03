import { z } from "zod";
import {
  createTelegramAccountSchema,
  telegramCodeSchema,
  telegramMediaPresignSchema,
  telegramPasswordSchema,
  telegramPhoneSchema,
  telegramSendMediaSchema,
  telegramSendMessageSchema,
  uuidSchema
} from "@atlas/shared";

export const telegramAccountParamsSchema = z.object({
  accountId: uuidSchema
});

export const telegramChatParamsSchema = z.object({
  accountId: uuidSchema,
  chatId: uuidSchema
});

export const telegramChatIdParamsSchema = z.object({
  chatId: uuidSchema
});

export const createAccountBodySchema = createTelegramAccountSchema;
export const phoneBodySchema = telegramPhoneSchema;
export const codeBodySchema = telegramCodeSchema;
export const passwordBodySchema = telegramPasswordSchema;
export const sendMessageBodySchema = telegramSendMessageSchema;
export const sendMediaBodySchema = telegramSendMediaSchema;
export const mediaPresignBodySchema = telegramMediaPresignSchema;
