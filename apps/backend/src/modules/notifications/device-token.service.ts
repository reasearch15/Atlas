import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferencesDto,
  type NotificationPreferencesInput,
  type NotificationType,
  type PushDeviceDto,
  type PushPlatform,
  type RegisterPushDeviceInput,
  type RefreshPushDeviceInput
} from "@atlas/shared";
import type { RequestUser } from "../auth/auth.types";
import { AppError, forbidden } from "../../utils/errors";

/**
 * Manages FCM device token lifecycle: register, rotate, revoke, list.
 */
export class DeviceTokenService {
  private readonly app: FastifyInstance;

  public constructor(app: FastifyInstance) {
    this.app = app;
  }

  public async register(user: RequestUser, input: RegisterPushDeviceInput): Promise<PushDeviceDto> {
    const workspaceId = this.requireWorkspace(user);
    const now = new Date();
    const row = await this.app.prisma.pushDeviceToken.upsert({
      where: { token: input.token },
      create: {
        id: crypto.randomUUID(),
        userId: user.id,
        workspaceId,
        sessionId: user.sessionId,
        platform: input.platform,
        token: input.token,
        deviceName: input.deviceName ?? null,
        appVersion: input.appVersion ?? null,
        lastSeenAt: now,
        revokedAt: null
      },
      update: {
        userId: user.id,
        workspaceId,
        sessionId: user.sessionId,
        platform: input.platform,
        ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
        ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
        lastSeenAt: now,
        revokedAt: null
      }
    });
    return this.toDto(row);
  }

  public async refresh(user: RequestUser, input: RefreshPushDeviceInput): Promise<PushDeviceDto> {
    const workspaceId = this.requireWorkspace(user);
    const now = new Date();

    if (input.previousToken && input.previousToken !== input.token) {
      await this.app.prisma.pushDeviceToken.updateMany({
        where: { token: input.previousToken, userId: user.id },
        data: { revokedAt: now }
      });
    }

    return this.register(user, {
      token: input.token,
      platform: input.platform,
      deviceName: input.deviceName,
      appVersion: input.appVersion
    });
  }

  public async unregister(user: RequestUser, token: string): Promise<{ success: true }> {
    await this.app.prisma.pushDeviceToken.updateMany({
      where: { token, userId: user.id },
      data: { revokedAt: new Date() }
    });
    return { success: true };
  }

  public async unregisterSession(userId: string, sessionId: string): Promise<void> {
    await this.app.prisma.pushDeviceToken.updateMany({
      where: { userId, sessionId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }

  public async revokeInvalidToken(token: string): Promise<void> {
    await this.app.prisma.pushDeviceToken.updateMany({
      where: { token, revokedAt: null },
      data: { revokedAt: new Date(), lastFailedDeliveryAt: new Date() }
    });
  }

  public async listForUser(user: RequestUser): Promise<PushDeviceDto[]> {
    const workspaceId = this.requireWorkspace(user);
    const rows = await this.app.prisma.pushDeviceToken.findMany({
      where: { userId: user.id, workspaceId, revokedAt: null },
      orderBy: { lastSeenAt: "desc" }
    });
    return rows.map((row) => this.toDto(row));
  }

  public async listForWorkspaceAdmin(
    actor: RequestUser,
    workspaceId: string
  ): Promise<Array<PushDeviceDto & { readonly userId: string; readonly userName: string }>> {
    if (actor.role !== "PLATFORM_ADMIN" && actor.workspaceId !== workspaceId) {
      throw forbidden();
    }
    const rows = await this.app.prisma.pushDeviceToken.findMany({
      where: { workspaceId, revokedAt: null },
      include: { user: { select: { id: true, name: true } } },
      orderBy: { lastSeenAt: "desc" },
      take: 500
    });
    return rows.map((row) => ({
      ...this.toDto(row),
      userId: row.user.id,
      userName: row.user.name
    }));
  }

  public async activeTokensForUsers(
    workspaceId: string,
    userIds: readonly string[]
  ): Promise<
    Array<{
      readonly id: string;
      readonly userId: string;
      readonly workspaceId: string;
      readonly platform: PushPlatform;
      readonly token: string;
    }>
  > {
    if (userIds.length === 0) return [];
    return this.app.prisma.pushDeviceToken.findMany({
      where: {
        workspaceId,
        userId: { in: [...userIds] },
        revokedAt: null
      },
      select: {
        id: true,
        userId: true,
        workspaceId: true,
        platform: true,
        token: true
      }
    });
  }

  public async markDelivery(deviceTokenId: string, ok: boolean): Promise<void> {
    const now = new Date();
    await this.app.prisma.pushDeviceToken.updateMany({
      where: { id: deviceTokenId },
      data: ok
        ? { lastSuccessfulDeliveryAt: now, lastSeenAt: now }
        : { lastFailedDeliveryAt: now }
    });
  }

  private requireWorkspace(user: RequestUser): string {
    if (!user.workspaceId) {
      throw new AppError(400, "BAD_REQUEST", "Push devices require a workspace-scoped session");
    }
    return user.workspaceId;
  }

  private toDto(row: {
    id: string;
    platform: PushPlatform;
    deviceName: string | null;
    appVersion: string | null;
    lastSeenAt: Date;
    createdAt: Date;
    updatedAt: Date;
    lastSuccessfulDeliveryAt: Date | null;
    lastFailedDeliveryAt: Date | null;
  }): PushDeviceDto {
    return {
      id: row.id,
      platform: row.platform,
      deviceName: row.deviceName,
      appVersion: row.appVersion,
      lastSeenAt: row.lastSeenAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastSuccessfulDeliveryAt: row.lastSuccessfulDeliveryAt?.toISOString() ?? null,
      lastFailedDeliveryAt: row.lastFailedDeliveryAt?.toISOString() ?? null
    };
  }
}

/**
 * Loads and updates per-user notification preference settings.
 */
export class NotificationPreferenceService {
  private readonly app: FastifyInstance;

  public constructor(app: FastifyInstance) {
    this.app = app;
  }

  public async get(user: RequestUser): Promise<NotificationPreferencesDto> {
    const workspaceId = this.requireWorkspace(user);
    const row = await this.app.prisma.notificationPreference.findUnique({ where: { userId: user.id } });
    if (!row) {
      return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    }
    return this.toDto(row, workspaceId);
  }

  public async update(user: RequestUser, input: NotificationPreferencesInput): Promise<NotificationPreferencesDto> {
    const workspaceId = this.requireWorkspace(user);
    const dndValue =
      input.doNotDisturb === undefined || input.doNotDisturb === null
        ? Prisma.DbNull
        : (input.doNotDisturb as Prisma.InputJsonValue);
    const row = await this.app.prisma.notificationPreference.upsert({
      where: { userId: user.id },
      create: {
        id: crypto.randomUUID(),
        userId: user.id,
        workspaceId,
        enabled: input.enabled,
        customerMessages: input.customerMessages,
        assignments: input.assignments,
        mentions: input.mentions,
        urgentOnly: input.urgentOnly,
        sound: input.sound,
        vibration: input.vibration,
        previewText: input.previewText,
        showCustomerNames: input.showCustomerNames,
        muteAll: input.muteAll,
        doNotDisturb: dndValue
      },
      update: {
        workspaceId,
        enabled: input.enabled,
        customerMessages: input.customerMessages,
        assignments: input.assignments,
        mentions: input.mentions,
        urgentOnly: input.urgentOnly,
        sound: input.sound,
        vibration: input.vibration,
        previewText: input.previewText,
        showCustomerNames: input.showCustomerNames,
        muteAll: input.muteAll,
        doNotDisturb: dndValue
      }
    });
    return this.toDto(row, workspaceId);
  }

  public async getMapForUsers(
    userIds: readonly string[]
  ): Promise<Map<string, NotificationPreferencesDto>> {
    const map = new Map<string, NotificationPreferencesDto>();
    if (userIds.length === 0) return map;
    const rows = await this.app.prisma.notificationPreference.findMany({
      where: { userId: { in: [...userIds] } }
    });
    for (const id of userIds) {
      map.set(id, { ...DEFAULT_NOTIFICATION_PREFERENCES });
    }
    for (const row of rows) {
      map.set(row.userId, this.toDto(row, row.workspaceId));
    }
    return map;
  }

  /**
   * Returns whether a notification type should be sent given preference flags.
   */
  public shouldSend(prefs: NotificationPreferencesDto, type: NotificationType, urgent: boolean): boolean {
    if (!prefs.enabled || prefs.muteAll) return false;
    if (prefs.urgentOnly && !urgent && type !== "URGENT_FLAG" && type !== "FAILED_MESSAGE") {
      return false;
    }
    switch (type) {
      case "INCOMING_MESSAGE":
      case "NEW_CONVERSATION":
      case "URGENT_FLAG":
      case "FAILED_MESSAGE":
        return prefs.customerMessages;
      case "CONVERSATION_ASSIGNED":
      case "CONVERSATION_REASSIGNED":
      case "CONVERSATION_REOPENED":
        return prefs.assignments;
      case "MENTION":
        return prefs.mentions;
      case "SLA_WARNING":
        return prefs.customerMessages || prefs.assignments;
      case "TEST":
        return true;
      default:
        return true;
    }
  }

  private requireWorkspace(user: RequestUser): string {
    if (!user.workspaceId) {
      throw new AppError(400, "BAD_REQUEST", "Notification preferences require a workspace-scoped session");
    }
    return user.workspaceId;
  }

  private toDto(
    row: {
      enabled: boolean;
      customerMessages: boolean;
      assignments: boolean;
      mentions: boolean;
      urgentOnly: boolean;
      sound: boolean;
      vibration: boolean;
      previewText: boolean;
      showCustomerNames: boolean;
      muteAll: boolean;
      doNotDisturb: unknown;
    },
    _workspaceId: string
  ): NotificationPreferencesDto {
    return {
      enabled: row.enabled,
      customerMessages: row.customerMessages,
      assignments: row.assignments,
      mentions: row.mentions,
      urgentOnly: row.urgentOnly,
      sound: row.sound,
      vibration: row.vibration,
      previewText: row.previewText,
      showCustomerNames: row.showCustomerNames,
      muteAll: row.muteAll,
      doNotDisturb: (row.doNotDisturb as NotificationPreferencesDto["doNotDisturb"]) ?? null
    };
  }
}
