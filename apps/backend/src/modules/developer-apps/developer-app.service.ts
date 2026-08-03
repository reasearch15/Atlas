import type { Prisma } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import type { DeveloperAppDto } from "@atlas/shared";
import { encryptSecret } from "@atlas/shared/session-encryption";
import { AppError, forbidden } from "../../utils/errors";
import { AuditService } from "../audit/audit.service";
import type { RequestUser } from "../auth/auth.types";
import { createDeveloperAppBodySchema, updateDeveloperAppBodySchema } from "./developer-app.schemas";
import { DeveloperAppRepository } from "./developer-app.repository";

type DeveloperAppWithCount = {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: "TELEGRAM";
  readonly displayName: string;
  readonly apiId: number;
  readonly status: "ACTIVE" | "DISABLED";
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly _count: { readonly telegramAccounts: number };
  // Prisma include inference is widened until `prisma generate` picks up DELETING.
  readonly [key: string]: unknown;
};

export class DeveloperAppService {
  private readonly repository: DeveloperAppRepository;
  private readonly audit: AuditService;
  private readonly encryptionKey: string;

  /**
   * Creates a service for encrypted workspace-owned developer app credentials.
   */
  public constructor(private readonly request: FastifyRequest) {
    this.repository = new DeveloperAppRepository(request.server.prisma);
    this.audit = new AuditService(request.server.prisma);
    this.encryptionKey = request.server.env.TELEGRAM_SESSION_ENCRYPTION_KEY;
  }

  /**
   * Lists visible developer applications without exposing secrets.
   */
  public async list(user: RequestUser): Promise<DeveloperAppDto[]> {
    this.assertCoadmin(user);
    const apps = await this.repository.list(user);
    return apps.map((app) => this.toDto(app as unknown as DeveloperAppWithCount));
  }

  /**
   * Loads one developer application inside the Coadmin workspace.
   */
  public async get(user: RequestUser, id: string): Promise<DeveloperAppDto> {
    this.assertCoadmin(user);
    const app = await this.repository.getForUser(user, id);
    if (!app) {
      throw new AppError(404, "DEVELOPER_APP_NOT_FOUND", "Developer app was not found");
    }
    return this.toDto(app as unknown as DeveloperAppWithCount);
  }

  /**
   * Creates a Telegram developer app with encrypted API hash.
   */
  public async create(user: RequestUser, body: unknown, explicitWorkspaceId?: string): Promise<DeveloperAppDto> {
    this.assertCoadmin(user);
    const input = createDeveloperAppBodySchema.parse(body);
    const workspaceId = this.repository.workspaceIdFor(user, explicitWorkspaceId);
    await this.assertDisplayNameAvailable(workspaceId, input.displayName);
    const app = await this.repository.create({
      workspaceId,
      provider: input.provider,
      displayName: input.displayName,
      apiId: input.apiId,
      encryptedApiHash: encryptSecret(input.apiHash, this.encryptionKey) as unknown as Prisma.InputJsonObject,
      createdByUserId: user.id
    });

    await this.audit.record({
      workspaceId,
      actorId: user.id,
      action: "developer_app.create",
      metadata: { developerAppId: app.id, provider: app.provider }
    });
    return this.toDto(app as unknown as DeveloperAppWithCount);
  }

  /**
   * Updates non-deleted developer app metadata and optionally rotates credentials.
   */
  public async update(user: RequestUser, id: string, body: unknown): Promise<DeveloperAppDto> {
    this.assertCoadmin(user);
    const existing = await this.repository.getForUser(user, id);
    if (!existing) {
      throw new AppError(404, "DEVELOPER_APP_NOT_FOUND", "Developer app was not found");
    }
    const input = updateDeveloperAppBodySchema.parse(body);
    const data: Prisma.DeveloperAppUpdateInput = {};
    if (input.displayName) {
      await this.assertDisplayNameAvailable(existing.workspaceId, input.displayName, id);
      data.displayName = input.displayName;
    }
    if (input.apiId) data.apiId = input.apiId;
    if (input.status) data.status = input.status;
    const rotatesSecret = Boolean(input.apiHash);
    if (input.apiHash) {
      data.encryptedApiHash = encryptSecret(input.apiHash, this.encryptionKey) as unknown as Prisma.InputJsonObject;
    }

    const updated = await this.repository.update(id, data);
    await this.audit.record({
      workspaceId: existing.workspaceId,
      actorId: user.id,
      action: "developer_app.update",
      metadata: { developerAppId: id, provider: existing.provider }
    });
    if (rotatesSecret) {
      await this.audit.record({
        workspaceId: existing.workspaceId,
        actorId: user.id,
        action: "developer_app.credentials_rotated",
        metadata: { developerAppId: id, provider: existing.provider }
      });
    }
    return this.toDto(updated as unknown as DeveloperAppWithCount);
  }

  /**
   * Enables a disabled developer application.
   */
  public async enable(user: RequestUser, id: string): Promise<DeveloperAppDto> {
    return this.setStatus(user, id, "ACTIVE", "developer_app.enabled");
  }

  /**
   * Disables a developer application without deleting it.
   */
  public async disable(user: RequestUser, id: string): Promise<DeveloperAppDto> {
    return this.setStatus(user, id, "DISABLED", "developer_app.disabled");
  }

  /**
   * Soft deletes a developer app that has no connected Telegram accounts.
   */
  public async remove(user: RequestUser, id: string): Promise<DeveloperAppDto> {
    this.assertCoadmin(user);
    const existing = (await this.repository.getForUser(user, id)) as unknown as DeveloperAppWithCount | null;
    if (!existing) {
      throw new AppError(404, "DEVELOPER_APP_NOT_FOUND", "Developer app was not found");
    }
    if (existing._count.telegramAccounts > 0) {
      await this.audit.record({
        workspaceId: existing.workspaceId,
        actorId: user.id,
        action: "developer_app.delete_blocked",
        metadata: { developerAppId: id, provider: existing.provider, connectedTelegramAccountCount: existing._count.telegramAccounts }
      });
      throw new AppError(409, "DEVELOPER_APP_HAS_TELEGRAM_ACCOUNTS", "Disconnect Telegram accounts before deleting this developer app.");
    }
    const deleted = await this.repository.update(id, { deletedAt: new Date(), status: "DISABLED" });
    await this.audit.record({
      workspaceId: existing.workspaceId,
      actorId: user.id,
      action: "developer_app.delete",
      metadata: { developerAppId: id, provider: existing.provider }
    });
    return this.toDto(deleted as unknown as DeveloperAppWithCount);
  }

  private async setStatus(user: RequestUser, id: string, status: "ACTIVE" | "DISABLED", action: string): Promise<DeveloperAppDto> {
    this.assertCoadmin(user);
    const existing = await this.repository.getForUser(user, id);
    if (!existing) {
      throw new AppError(404, "DEVELOPER_APP_NOT_FOUND", "Developer app was not found");
    }
    const updated = await this.repository.update(id, { status });
    await this.audit.record({
      workspaceId: existing.workspaceId,
      actorId: user.id,
      action,
      metadata: { developerAppId: id, provider: existing.provider }
    });
    return this.toDto(updated as unknown as DeveloperAppWithCount);
  }

  private assertCoadmin(user: RequestUser): void {
    if (user.role !== "COADMIN" || !user.workspaceId) {
      throw forbidden();
    }
  }

  private async assertDisplayNameAvailable(workspaceId: string, displayName: string, excludeId?: string): Promise<void> {
    const duplicate = await this.repository.findActiveByDisplayName(workspaceId, displayName, excludeId);
    if (duplicate) {
      throw new AppError(409, "DEVELOPER_APP_DISPLAY_NAME_EXISTS", "Display name is already used in this workspace.");
    }
  }

  private toDto(app: DeveloperAppWithCount): DeveloperAppDto {
    return {
      id: app.id,
      workspaceId: app.workspaceId,
      provider: app.provider,
      displayName: app.displayName,
      apiId: app.apiId,
      status: app.status,
      connectedTelegramAccountCount: app._count.telegramAccounts,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString()
    };
  }
}
