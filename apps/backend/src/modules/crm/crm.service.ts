import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type {
  CrmActivityDto,
  CrmActivityType,
  CrmAssigneeDto,
  CrmContactDto,
  CrmConversationPanelDto,
  CrmConversationStatus,
  CrmConversationUpdatedEvent,
  CrmInboxCountsDto,
  CrmNoteDto,
  CrmTagCreateInput,
  CrmTagDto,
  CrmTagUpdateInput
} from "@atlas/shared";
import { isAllowedManualStatusTransition, statusAfterClaim } from "@atlas/shared";
import type { Role } from "@atlas/shared";
import type { RequestUser } from "../auth/auth.types";
import { forbidden } from "../../utils/errors";
import { crmConflict, crmInvalidTransition, crmNotFound, crmTagArchived } from "./crm.errors";
import {
  applyActivityPayloadPrivacy,
  applyContactPrivacy
} from "../privacy/customer-privacy-mapper";
import { CUSTOMER_PRIVACY_NOTICE, customerPrivacyCapabilities } from "@atlas/shared";

export class CrmService {
  private readonly app: FastifyInstance;

  /**
   * Creates a CRM application service.
   */
  public constructor(app: FastifyInstance) {
    this.app = app;
  }

  /**
   * Loads a workspace-scoped chat, throwing 404 across workspace boundaries.
   */
  public async getChatForWorkspace(user: RequestUser, chatId: string) {
    const workspaceId = this.requireWorkspaceId(user);
    const chat = await this.app.prisma.telegramChat.findFirst({ where: { id: chatId, workspaceId } });
    if (!chat) {
      throw crmNotFound();
    }
    return chat;
  }

  /**
   * Claims an unassigned conversation for the acting Staff/Coadmin. Concurrency-safe:
   * the assignment update is conditioned on assignedUserId being NULL, so only one
   * concurrent caller can win the race; losers receive a conflict.
   */
  public async claim(user: RequestUser, chatId: string): Promise<void> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const chat = await this.getChatForWorkspace(user, chatId);
    const now = new Date();
    const previousStatus = chat.crmStatus as CrmConversationStatus;
    const nextStatus = statusAfterClaim(previousStatus);

    const result = await this.app.prisma.telegramChat.updateMany({
      where: { id: chatId, workspaceId, assignedUserId: null },
      data: {
        assignedUserId: user.id,
        assignedByUserId: user.id,
        assignedAt: now,
        claimedAt: now,
        lastAssignmentChangeAt: now,
        crmStatus: nextStatus
      }
    });

    if (result.count === 0) {
      throw crmConflict("This conversation has already been claimed by another teammate.");
    }

    await this.writeActivity(workspaceId, chatId, user.id, "CLAIMED", { assignedUserId: user.id });
    if (nextStatus !== previousStatus) {
      await this.writeStatusHistory(workspaceId, chatId, previousStatus, nextStatus, user.id, "claim");
    }
    await this.publishCrmConversationUpdated(workspaceId, chatId, "claim");
  }

  /**
   * Sets, changes, or clears the assignee for a conversation. Coadmin only.
   */
  public async assign(user: RequestUser, chatId: string, assigneeUserId: string | null): Promise<void> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const chat = await this.getChatForWorkspace(user, chatId);

    if (assigneeUserId) {
      await this.assertAssigneeInWorkspace(workspaceId, assigneeUserId);
    }

    const previousAssignee = chat.assignedUserId;
    const activityType: CrmActivityType = assigneeUserId === null ? "RELEASED" : previousAssignee ? "REASSIGNED" : "ASSIGNED";
    const now = new Date();
    const keepsSameAssignee = assigneeUserId !== null && assigneeUserId === previousAssignee;

    await this.app.prisma.telegramChat.update({
      where: { id: chatId },
      data: {
        assignedUserId: assigneeUserId,
        assignedByUserId: user.id,
        assignedAt: assigneeUserId ? now : null,
        claimedAt: keepsSameAssignee ? chat.claimedAt : null,
        lastAssignmentChangeAt: now
      }
    });

    await this.writeActivity(workspaceId, chatId, user.id, activityType, {
      fromUserId: previousAssignee,
      toUserId: assigneeUserId
    });
    await this.publishCrmConversationUpdated(workspaceId, chatId, activityType.toLowerCase());
  }

  /**
   * Releases a conversation's assignment. Staff may only release their own conversation;
   * Coadmin may release any conversation in the workspace.
   */
  public async release(user: RequestUser, chatId: string): Promise<void> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const chat = await this.getChatForWorkspace(user, chatId);

    if (user.role === "STAFF" && chat.assignedUserId !== user.id) {
      throw forbidden();
    }

    const previousAssignee = chat.assignedUserId;
    await this.app.prisma.telegramChat.update({
      where: { id: chatId },
      data: {
        assignedUserId: null,
        assignedByUserId: user.id,
        assignedAt: null,
        claimedAt: null,
        lastAssignmentChangeAt: new Date()
      }
    });

    await this.writeActivity(workspaceId, chatId, user.id, "RELEASED", { fromUserId: previousAssignee });
    await this.publishCrmConversationUpdated(workspaceId, chatId, "released");
  }

  /**
   * Applies a manual CRM status transition, recording status history and activity.
   */
  public async setStatus(user: RequestUser, chatId: string, status: CrmConversationStatus): Promise<void> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const chat = await this.getChatForWorkspace(user, chatId);
    const fromStatus = chat.crmStatus as CrmConversationStatus;

    if (!isAllowedManualStatusTransition(fromStatus, status)) {
      throw crmInvalidTransition(`Cannot change status from ${fromStatus} to ${status}`);
    }

    await this.app.prisma.telegramChat.update({ where: { id: chatId }, data: { crmStatus: status } });
    await this.writeStatusHistory(workspaceId, chatId, fromStatus, status, user.id, "manual");
    await this.writeActivity(workspaceId, chatId, user.id, "STATUS_CHANGED", { from: fromStatus, to: status });
    await this.publishCrmConversationUpdated(workspaceId, chatId, "status_changed");
  }

  /**
   * Lists the workspace tag catalog (including archived tags, for historical display).
   */
  public async listTags(user: RequestUser): Promise<CrmTagDto[]> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const tags = await this.app.prisma.workspaceTag.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });
    return tags.map((tag) => this.toTagDto(tag));
  }

  /**
   * Creates a new workspace tag. Coadmin only.
   */
  public async createTag(user: RequestUser, input: CrmTagCreateInput): Promise<CrmTagDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    try {
      const tag = await this.app.prisma.workspaceTag.create({
        data: { workspaceId, name: input.name, color: input.color, createdByUserId: user.id }
      });
      return this.toTagDto(tag);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw crmConflict("A tag with this name already exists.");
      }
      throw error;
    }
  }

  /**
   * Renames, recolors, and/or archives a workspace tag. Coadmin only.
   * Archiving does not detach the tag from conversations that already carry it.
   */
  public async updateTag(user: RequestUser, tagId: string, input: CrmTagUpdateInput): Promise<CrmTagDto> {
    this.assertCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    const existing = await this.app.prisma.workspaceTag.findFirst({ where: { id: tagId, workspaceId } });
    if (!existing) {
      throw crmNotFound("Tag was not found");
    }

    try {
      const tag = await this.app.prisma.workspaceTag.update({
        where: { id: tagId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {})
        }
      });
      return this.toTagDto(tag);
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw crmConflict("A tag with this name already exists.");
      }
      throw error;
    }
  }

  /**
   * Attaches a workspace tag to a conversation. Archived tags cannot be newly attached.
   */
  public async addTag(user: RequestUser, chatId: string, tagId: string): Promise<void> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    await this.getChatForWorkspace(user, chatId);

    const tag = await this.app.prisma.workspaceTag.findFirst({ where: { id: tagId, workspaceId } });
    if (!tag) {
      throw crmNotFound("Tag was not found");
    }
    if (tag.archivedAt) {
      throw crmTagArchived();
    }

    await this.app.prisma.telegramChatTag.upsert({
      where: { chatId_tagId: { chatId, tagId } },
      update: {},
      create: { workspaceId, chatId, tagId, addedByUserId: user.id }
    });

    await this.writeActivity(workspaceId, chatId, user.id, "TAG_ADDED", { tagId });
    await this.publishCrmConversationUpdated(workspaceId, chatId, "tag_added");
  }

  /**
   * Removes a tag from a conversation.
   */
  public async removeTag(user: RequestUser, chatId: string, tagId: string): Promise<void> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    await this.getChatForWorkspace(user, chatId);

    await this.app.prisma.telegramChatTag.deleteMany({ where: { chatId, tagId, workspaceId } });

    await this.writeActivity(workspaceId, chatId, user.id, "TAG_REMOVED", { tagId });
    await this.publishCrmConversationUpdated(workspaceId, chatId, "tag_removed");
  }

  /**
   * Creates an internal note on a conversation. Notes never enqueue Telegram outbound
   * commands or otherwise touch the Telegram worker queues.
   */
  public async createNote(user: RequestUser, chatId: string, body: string): Promise<CrmNoteDto> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    await this.getChatForWorkspace(user, chatId);

    const note = await this.app.prisma.crmInternalNote.create({
      data: { workspaceId, chatId, authorUserId: user.id, body },
      include: { author: { select: { name: true } } }
    });

    await this.writeActivity(workspaceId, chatId, user.id, "NOTE_CREATED", { noteId: note.id });
    return this.toNoteDto(note, note.author.name);
  }

  /**
   * Edits an existing internal note. Only the original author or a Coadmin may edit.
   */
  public async updateNote(user: RequestUser, chatId: string, noteId: string, body: string): Promise<CrmNoteDto> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    await this.getChatForWorkspace(user, chatId);

    const existing = await this.app.prisma.crmInternalNote.findFirst({ where: { id: noteId, chatId, workspaceId } });
    if (!existing) {
      throw crmNotFound("Note was not found");
    }
    if (existing.authorUserId !== user.id && user.role !== "COADMIN") {
      throw forbidden();
    }

    const updated = await this.app.prisma.crmInternalNote.update({
      where: { id: noteId },
      data: { body, editedAt: new Date() },
      include: { author: { select: { name: true } } }
    });

    await this.writeActivity(workspaceId, chatId, user.id, "NOTE_EDITED", { noteId });
    return this.toNoteDto(updated, updated.author.name);
  }

  /**
   * Lists internal notes for a conversation, newest first.
   */
  public async listNotes(user: RequestUser, chatId: string): Promise<CrmNoteDto[]> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);
    await this.getChatForWorkspace(user, chatId);

    const notes = await this.app.prisma.crmInternalNote.findMany({
      where: { workspaceId, chatId },
      orderBy: { createdAt: "desc" },
      include: { author: { select: { name: true } } }
    });
    return notes.map((note) => this.toNoteDto(note, note.author.name));
  }

  /**
   * Assembles the full CRM side panel for a conversation: contact, assignee, tags,
   * notes, and recent activity. Future stubs (e.g. linked deals) are intentionally omitted.
   */
  public async getPanel(user: RequestUser, chatId: string): Promise<CrmConversationPanelDto> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);

    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: chatId, workspaceId },
      include: {
        crmContact: true,
        assignedUser: { select: { id: true, name: true, role: true } },
        telegramAccount: { select: { displayName: true } },
        tags: { include: { tag: true } },
        notes: { orderBy: { createdAt: "desc" }, include: { author: { select: { name: true } } } },
        activities: { orderBy: { createdAt: "desc" }, take: 50, include: { actor: { select: { name: true } } } }
      }
    });
    if (!chat) {
      throw crmNotFound();
    }

    let contact: CrmContactDto | null = null;
    if (chat.crmContact) {
      const conversationCount = await this.app.prisma.telegramChat.count({ where: { crmContactId: chat.crmContact.id } });
      contact = this.toContactDto(chat.crmContact, conversationCount, user);
    }

    const caps = customerPrivacyCapabilities(user.role as Role);
    const accountLabel = caps.canViewTelegramUsername || caps.canViewCustomerPhone
      ? chat.telegramAccount.displayName
      : "Workspace account";

    return {
      chatId: chat.id,
      contact,
      telegramAccountLabel: accountLabel,
      chatType: chat.chatType,
      crmStatus: chat.crmStatus,
      assignee: chat.assignedUser
        ? { id: chat.assignedUser.id, name: chat.assignedUser.name, role: chat.assignedUser.role as "COADMIN" | "STAFF" }
        : null,
      tags: chat.tags.map((chatTag) => this.toTagDto(chatTag.tag)),
      notes: chat.notes.map((note) => this.toNoteDto(note, note.author.name)),
      activities: chat.activities.map((activity) => this.toActivityDto(activity, activity.actor?.name ?? null, user)),
      unreadCount: chat.unreadCount,
      needsCrmAttention: chat.needsCrmAttention,
      lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
      firstSeenAt: chat.crmContact?.firstSeenAt.toISOString() ?? null,
      ...(!caps.canViewCustomerPhone && !caps.canViewTelegramUsername && !caps.canViewExternalContactIds
        ? { privacyNotice: CUSTOMER_PRIVACY_NOTICE }
        : {})
    };
  }

  /**
   * Returns inbox filter counts scoped to the actor's workspace.
   */
  public async getInboxCounts(user: RequestUser): Promise<CrmInboxCountsDto> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);

    const [all, unassigned, mine, newCount, open, waiting, unread, resolved] = await Promise.all([
      this.app.prisma.telegramChat.count({ where: { workspaceId } }),
      this.app.prisma.telegramChat.count({ where: { workspaceId, assignedUserId: null } }),
      this.app.prisma.telegramChat.count({ where: { workspaceId, assignedUserId: user.id } }),
      this.app.prisma.telegramChat.count({ where: { workspaceId, crmStatus: "NEW" } }),
      this.app.prisma.telegramChat.count({ where: { workspaceId, crmStatus: "OPEN" } }),
      this.app.prisma.telegramChat.count({ where: { workspaceId, crmStatus: "WAITING" } }),
      this.app.prisma.telegramChat.count({ where: { workspaceId, unreadCount: { gt: 0 } } }),
      this.app.prisma.telegramChat.count({ where: { workspaceId, crmStatus: "RESOLVED" } })
    ]);

    return { all, unassigned, mine, new: newCount, open, waiting, unread, resolved };
  }

  /**
   * Lists workspace Staff and Coadmins eligible to be assigned conversations.
   */
  public async listAssignees(user: RequestUser): Promise<CrmAssigneeDto[]> {
    this.assertStaffOrCoadmin(user);
    const workspaceId = this.requireWorkspaceId(user);

    const users = await this.app.prisma.user.findMany({
      where: { workspaceId, role: { in: ["COADMIN", "STAFF"] }, status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, role: true }
    });
    return users.map((row) => ({ id: row.id, name: row.name, role: row.role as "COADMIN" | "STAFF" }));
  }

  /**
   * Resolves the workspace where the actor is allowed to operate. Never trusts client input.
   */
  private requireWorkspaceId(user: RequestUser): string {
    if (!user.workspaceId) {
      throw forbidden();
    }
    return user.workspaceId;
  }

  private assertCoadmin(user: RequestUser): void {
    if (user.role !== "COADMIN" || !user.workspaceId) {
      throw forbidden();
    }
  }

  private assertStaffOrCoadmin(user: RequestUser): void {
    if (!user.workspaceId || (user.role !== "COADMIN" && user.role !== "STAFF")) {
      throw forbidden();
    }
  }

  private async assertAssigneeInWorkspace(workspaceId: string, assigneeUserId: string): Promise<void> {
    const assignee = await this.app.prisma.user.findFirst({
      where: { id: assigneeUserId, workspaceId, role: { in: ["COADMIN", "STAFF"] } }
    });
    if (!assignee) {
      throw crmNotFound("Assignee was not found in this workspace.");
    }
  }

  private async writeActivity(
    workspaceId: string,
    chatId: string,
    actorUserId: string | null,
    type: CrmActivityType,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.app.prisma.crmActivityEvent.create({
      data: { workspaceId, chatId, actorUserId, type, payloadJson: payload as unknown as Prisma.InputJsonObject }
    });
  }

  private async writeStatusHistory(
    workspaceId: string,
    chatId: string,
    fromStatus: CrmConversationStatus,
    toStatus: CrmConversationStatus,
    actorUserId: string | null,
    reason: string
  ): Promise<void> {
    await this.app.prisma.crmStatusHistory.create({
      data: { workspaceId, chatId, fromStatus, toStatus, actorUserId, reason }
    });
  }

  /**
   * Publishes a realtime CRM update matching the existing telegram publish pattern
   * (app.redis.publish on the shared "atlas.workspace-events" channel).
   */
  private async publishCrmConversationUpdated(workspaceId: string, chatId: string, reason: string): Promise<void> {
    const chat = await this.app.prisma.telegramChat.findUnique({
      where: { id: chatId },
      include: { assignedUser: { select: { name: true } }, tags: { include: { tag: true } } }
    });
    if (!chat) {
      return;
    }
    const event: CrmConversationUpdatedEvent = {
      type: "crm.conversation.updated",
      eventId: crypto.randomUUID(),
      workspaceId,
      chatId,
      crmStatus: chat.crmStatus,
      assignedUserId: chat.assignedUserId,
      assignedUserName: chat.assignedUser?.name ?? null,
      assignedAt: chat.assignedAt?.toISOString() ?? null,
      claimedAt: chat.claimedAt?.toISOString() ?? null,
      needsCrmAttention: chat.needsCrmAttention,
      tags: chat.tags.map((chatTag) => this.toTagDto(chatTag.tag)),
      reason
    };
    await this.app.redis.publish("atlas.workspace-events", JSON.stringify(event));
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
  }

  private toTagDto(tag: { id: string; name: string; color: string; archivedAt: Date | null }): CrmTagDto {
    return { id: tag.id, name: tag.name, color: tag.color, archivedAt: tag.archivedAt?.toISOString() ?? null };
  }

  private toNoteDto(
    note: { id: string; chatId: string; body: string; authorUserId: string; createdAt: Date; editedAt: Date | null },
    authorName: string
  ): CrmNoteDto {
    return {
      id: note.id,
      chatId: note.chatId,
      body: note.body,
      authorUserId: note.authorUserId,
      authorName,
      createdAt: note.createdAt.toISOString(),
      editedAt: note.editedAt?.toISOString() ?? null
    };
  }

  private toActivityDto(
    activity: { id: string; chatId: string; type: string; actorUserId: string | null; payloadJson: unknown; createdAt: Date },
    actorName: string | null,
    user: RequestUser
  ): CrmActivityDto {
    const payload =
      activity.payloadJson && typeof activity.payloadJson === "object" && !Array.isArray(activity.payloadJson)
        ? (activity.payloadJson as Record<string, unknown>)
        : {};
    return {
      id: activity.id,
      chatId: activity.chatId,
      type: activity.type,
      actorUserId: activity.actorUserId,
      actorName,
      payload: applyActivityPayloadPrivacy(payload, user.role as Role),
      createdAt: activity.createdAt.toISOString()
    };
  }

  private toContactDto(
    contact: {
      id: string;
      kind: string;
      displayName: string;
      username: string | null;
      phoneMasked: string | null;
      firstSeenAt: Date;
      lastSeenAt: Date;
    },
    conversationCount: number,
    user: RequestUser
  ): CrmContactDto {
    return applyContactPrivacy(
      {
        id: contact.id,
        kind: contact.kind,
        displayName: contact.displayName,
        username: contact.username,
        phoneMasked: contact.phoneMasked,
        firstSeenAt: contact.firstSeenAt.toISOString(),
        lastSeenAt: contact.lastSeenAt.toISOString(),
        conversationCount
      },
      user.role as Role
    );
  }
}
