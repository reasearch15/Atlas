import { z } from "zod";
import { roles } from "./roles";

export const uuidSchema = z.string().uuid();

export const emailSchema = z.string().trim().email().max(320).toLowerCase();

export const passwordSchema = z.string().min(12).max(256);

export const workspaceSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  workspaceSlug: z.string().trim().min(2).max(64).regex(/^[a-z0-9-]+$/).optional()
});

export const adminLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256)
});

export const adminVerifyDeviceSchema = z.object({
  challengeId: uuidSchema,
  code: z.string().trim().regex(/^\d{6}$/)
});

export const adminResendCodeSchema = z.object({
  challengeId: uuidSchema
});

export const coadminLoginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(256)
});

export const createCoadminSchema = z.object({
  username: usernameSchema,
  temporaryPassword: passwordSchema,
  confirmTemporaryPassword: passwordSchema
}).refine((value) => value.temporaryPassword === value.confirmTemporaryPassword, { message: "Passwords do not match.", path: ["confirmTemporaryPassword"] });

export const createStaffSchemaV2 = z.object({
  fullName: z.string().trim().min(2).max(120),
  username: usernameSchema,
  temporaryPassword: passwordSchema,
  confirmTemporaryPassword: passwordSchema,
  contactEmail: emailSchema.optional().or(z.literal("").transform(() => undefined)),
  status: z.enum(["ACTIVE", "SUSPENDED"]).default("ACTIVE")
}).refine((value) => value.temporaryPassword === value.confirmTemporaryPassword, { message: "Passwords do not match.", path: ["confirmTemporaryPassword"] });

export const tenantPasswordChangeSchema = z.object({
  password: passwordSchema,
  confirmPassword: passwordSchema
}).refine((value) => value.password === value.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: workspaceSlugSchema
});

export const createStaffSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(2).max(120),
  role: z.enum(["COADMIN", "STAFF"]),
  password: passwordSchema
});

export const auditQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const authUserSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  name: z.string(),
  role: z.enum(roles),
  workspaceId: uuidSchema.nullable()
});

export const sessionSchema = z.object({
  id: uuidSchema,
  deviceName: z.string(),
  ipAddress: z.string(),
  userAgent: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable()
});

export const telegramAccountStatusSchema = z.enum([
  "PENDING",
  "AUTHORIZING",
  "WAITING_FOR_QR",
  "WAITING_FOR_PHONE",
  "WAITING_FOR_CODE",
  "WAITING_FOR_PASSWORD",
  "SYNCING",
  "CONNECTED",
  "DEGRADED",
  "REAUTH_REQUIRED",
  "DISCONNECTED",
  "FAILED",
  "DELETING"
]);

export const developerAppProviderSchema = z.enum(["TELEGRAM"]);
export const telegramApiHashSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{32}$/i, "Telegram API hash must be a 32-character hexadecimal string.");

export const createDeveloperAppSchema = z.object({
  provider: developerAppProviderSchema,
  displayName: z.string().trim().min(2).max(120),
  apiId: z.coerce.number().int().positive(),
  apiHash: telegramApiHashSchema
});

export const updateDeveloperAppSchema = z.object({
  displayName: z.string().trim().min(2).max(120).optional(),
  apiId: z.coerce.number().int().positive().optional(),
  apiHash: z.union([telegramApiHashSchema, z.literal("").transform(() => undefined)]).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional()
});

export const createTelegramAccountSchema = z.object({
  developerAppId: uuidSchema,
  displayName: z.string().trim().min(2).max(120)
});

export const telegramPhoneSchema = z.object({
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, "Phone number must use international format, for example +15551234567.")
});

export const telegramCodeSchema = z.object({
  code: z.string().trim().min(2).max(32)
});

export const telegramPasswordSchema = z.object({
  password: z.string().min(1).max(256)
});

export const telegramSendMessageSchema = z.object({
  text: z.string().trim().min(1).max(4096),
  idempotencyKey: z.string().trim().min(16).max(160),
  replyToTelegramMessageId: z.string().trim().max(80).optional()
});

export const telegramDeleteMessageSchema = z.object({
  scope: z.enum(["EVERYONE", "ATLAS_ONLY"]),
  /** Client-generated key so repeated clicks do not enqueue duplicate DELETE_MESSAGE commands. */
  idempotencyKey: z.string().trim().min(16).max(160).optional()
});

export const telegramSendMediaSchema = z.object({
  contentType: z.enum(["PHOTO", "VIDEO", "VOICE", "AUDIO", "DOCUMENT", "ANIMATION", "STICKER", "LOCATION", "CONTACT"]),
  caption: z.string().trim().max(1024).optional(),
  idempotencyKey: z.string().trim().min(16).max(160),
  replyToTelegramMessageId: z.string().trim().max(80).optional(),
  storageKey: z.string().trim().min(8).max(512).optional(),
  mimeType: z.string().trim().max(120).optional(),
  fileName: z.string().trim().max(255).optional(),
  fileSizeBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  /** 0–31 peak samples for Telegram-style voice waveform UI (and GramJS when supported). */
  waveform: z.array(z.number().int().min(0).max(31)).max(100).optional(),
  /** When true, GramJS sends as a document even if the file is an image. */
  forceDocument: z.boolean().optional(),
  /** Prefer Telegram voice-note attributes (DocumentAttributeAudio.voice). */
  voiceNote: z.boolean().optional(),
  /** Prefer Telegram round video-note attributes. */
  videoNote: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  contactPhone: z.string().trim().max(32).optional(),
  contactFirstName: z.string().trim().max(120).optional(),
  contactLastName: z.string().trim().max(120).optional()
});

export const telegramMediaPresignSchema = z.object({
  contentType: z.enum(["PHOTO", "VIDEO", "VOICE", "AUDIO", "DOCUMENT", "ANIMATION", "STICKER"]),
  mimeType: z.string().trim().min(3).max(120),
  fileName: z.string().trim().min(1).max(255),
  fileSizeBytes: z.number().int().positive().max(100 * 1024 * 1024),
  idempotencyKey: z.string().trim().min(16).max(160)
});

export type LoginInput = z.infer<typeof loginSchema>;
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;
export type AdminVerifyDeviceInput = z.infer<typeof adminVerifyDeviceSchema>;
export type CoadminLoginInput = z.infer<typeof coadminLoginSchema>;
export type CreateCoadminInput = z.infer<typeof createCoadminSchema>;
export type CreateStaffV2Input = z.infer<typeof createStaffSchemaV2>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type AuthUser = z.infer<typeof authUserSchema>;
export type SessionDto = z.infer<typeof sessionSchema>;
export type CreateDeveloperAppInput = z.infer<typeof createDeveloperAppSchema>;
export type UpdateDeveloperAppInput = z.infer<typeof updateDeveloperAppSchema>;
export type CreateTelegramAccountInput = z.infer<typeof createTelegramAccountSchema>;
export type TelegramAccountStatus = z.infer<typeof telegramAccountStatusSchema>;
export type TelegramSendMessageInput = z.infer<typeof telegramSendMessageSchema>;
export type TelegramDeleteMessageInput = z.infer<typeof telegramDeleteMessageSchema>;
export type TelegramSendMediaInput = z.infer<typeof telegramSendMediaSchema>;
export type TelegramMediaPresignInput = z.infer<typeof telegramMediaPresignSchema>;
