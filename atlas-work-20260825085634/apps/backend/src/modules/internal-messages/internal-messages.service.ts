import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  InternalMessageCreatedEvent,
  InternalMessageDto,
  InternalMessageReadEvent,
  InternalMessageThreadDto,
  StaffInternalUnreadCountUpdatedEvent
} from "@atlas/shared";
import type { RequestUser } from "../auth/auth.types";
import { forbidden } from "../../utils/errors";
import { AppError } from "../../utils/errors";

const sendBodySchema = z.object({
  body: z.string().trim().min(1).max(8000)
});

/**
 * Workspace-scoped Coadmin↔Staff messaging. Never touches Telegram queues.
 */
export class InternalMessagesService {
  public constructor(private readonly app: FastifyInstance) {}

  /**
   * Lists internal threads visible to the actor.
   * Coadmin: all Staff threads. Staff: only their own thread.
   */
  public async listThreads(user: RequestUser): Promise<InternalMessageThreadDto[]> {
    const workspaceId = this.requireWorkspace(user);
    if (user.role === "STAFF") {
      const thread = await this.ensureThread(workspaceId, user.id);
      return [await this.toThreadDto(thread, user)];
    }
    this.assertCoadmin(user);
    const staff = await this.app.prisma.user.findMany({
      where: { workspaceId, role: "STAFF", status: { in: ["ACTIVE", "PENDING_PASSWORD_CHANGE", "SUSPENDED"] } },
      orderBy: { name: "asc" }
    });
    const threads = await Promise.all(staff.map((member) => this.ensureThread(workspaceId, member.id)));
    return Promise.all(threads.map((thread) => this.toThreadDto(thread, user)));
  }

  /**
   * Returns messages for a Staff member's internal thread.
   */
  public async listMessages(user: RequestUser, staffUserId: string): Promise<InternalMessageDto[]> {
    const workspaceId = this.requireWorkspace(user);
    await this.assertThreadAccess(user, staffUserId);
    const thread = await this.ensureThread(workspaceId, staffUserId);
    const rows = await this.app.prisma.internalMessage.findMany({
      where: { threadId: thread.id, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: { sender: { select: { id: true, name: true, role: true } } }
    });
    return rows.map((row) => this.toMessageDto(row, staffUserId));
  }

  /**
   * Sends an internal team message. Sender identity always comes from the session.
   */
  public async sendMessage(user: RequestUser, staffUserId: string, rawBody: unknown): Promise<InternalMessageDto> {
    const workspaceId = this.requireWorkspace(user);
    const { body } = sendBodySchema.parse(rawBody);
    await this.assertThreadAccess(user, staffUserId);

    const staff = await this.app.prisma.user.findFirst({
      where: { id: staffUserId, workspaceId, role: "STAFF" }
    });
    if (!staff) {
      throw new AppError(404, "NOT_FOUND", "Staff member not found in this workspace.");
    }

    // Staff may only message Coadmins; Coadmin messages the Staff member.
    let receiverUserId: string;
    if (user.role === "STAFF") {
      if (user.id !== staffUserId) {
        throw forbidden("Staff may only access their own team thread.");
      }
      const coadmin = await this.app.prisma.user.findFirst({
        where: { workspaceId, role: "COADMIN", status: "ACTIVE" },
        orderBy: { createdAt: "asc" }
      });
      if (!coadmin) {
        throw new AppError(404, "NOT_FOUND", "No Coadmin is available in this workspace.");
      }
      receiverUserId = coadmin.id;
    } else {
      this.assertCoadmin(user);
      receiverUserId = staffUserId;
    }

    // Ignore any client-supplied sender fields — identity is session-only.
    const thread = await this.ensureThread(workspaceId, staffUserId);
    const message = await this.app.prisma.internalMessage.create({
      data: {
        workspaceId,
        threadId: thread.id,
        senderUserId: user.id,
        receiverUserId,
        body
      },
      include: { sender: { select: { id: true, name: true, role: true } } }
    });

    const preview = body.slice(0, 500);
    const isStaffSender = user.role === "STAFF";
    const updatedThread = await this.app.prisma.internalMessageThread.update({
      where: { id: thread.id },
      data: {
        lastMessageAt: message.createdAt,
        lastMessagePreview: preview,
        ...(isStaffSender
          ? { coadminUnreadCount: { increment: 1 } }
          : { staffUnreadCount: { increment: 1 } })
      }
    });

    const dto = this.toMessageDto(message, staffUserId);
    await this.publishCreated(dto, updatedThread.staffUnreadCount);
    await this.writeActivity(workspaceId, user, staffUserId, body);
    return dto;
  }

  /**
   * Marks an internal message as read by the authenticated receiver.
   */
  public async markRead(user: RequestUser, messageId: string): Promise<InternalMessageDto> {
    const workspaceId = this.requireWorkspace(user);
    const message = await this.app.prisma.internalMessage.findFirst({
      where: { id: messageId, workspaceId, deletedAt: null },
      include: {
        sender: { select: { id: true, name: true, role: true } },
        thread: true
      }
    });
    if (!message) {
      throw new AppError(404, "NOT_FOUND", "Internal message not found.");
    }
    await this.assertThreadAccess(user, message.thread.staffUserId);

    if (message.receiverUserId !== user.id) {
      throw forbidden("Only the message recipient can mark it as read.");
    }

    const readAt = message.readAt ?? new Date();
    const updated = message.readAt
      ? message
      : await this.app.prisma.internalMessage.update({
          where: { id: message.id },
          data: { readAt },
          include: { sender: { select: { id: true, name: true, role: true } }, thread: true }
        });

    if (!message.readAt) {
      const unreadField = user.role === "STAFF" ? "staffUnreadCount" : "coadminUnreadCount";
      const thread = await this.app.prisma.internalMessageThread.update({
        where: { id: message.threadId },
        data: {
          [unreadField]: {
            set: Math.max(
              0,
              (user.role === "STAFF" ? message.thread.staffUnreadCount : message.thread.coadminUnreadCount) - 1
            )
          }
        }
      });
      await this.publishRead(user, message.thread.staffUserId, message.threadId, message.id, readAt, thread.staffUnreadCount);
    }

    return this.toMessageDto(
      {
        ...updated,
        sender: updated.sender
      },
      message.thread.staffUserId
    );
  }

  private async ensureThread(workspaceId: string, staffUserId: string) {
    return this.app.prisma.internalMessageThread.upsert({
      where: { workspaceId_staffUserId: { workspaceId, staffUserId } },
      update: {},
      create: { workspaceId, staffUserId },
      include: {
        staffUser: { select: { id: true, name: true, username: true } }
      }
    });
  }

  private async toThreadDto(
    thread: {
      id: string;
      workspaceId: string;
      staffUserId: string;
      lastMessageAt: Date | null;
      lastMessagePreview: string | null;
      staffUnreadCount: number;
      coadminUnreadCount: number;
      staffUser?: { id: string; name: string; username: string | null };
    },
    viewer: RequestUser
  ): Promise<InternalMessageThreadDto> {
    const staff =
      thread.staffUser ??
      (await this.app.prisma.user.findUniqueOrThrow({
        where: { id: thread.staffUserId },
        select: { id: true, name: true, username: true }
      }));
    const lastSession = await this.app.prisma.session.findFirst({
      where: { userId: thread.staffUserId, revokedAt: null },
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true }
    });
    return {
      id: thread.id,
      workspaceId: thread.workspaceId,
      staffUserId: thread.staffUserId,
      staffName: staff.name,
      staffUsername: staff.username ?? "",
      lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: thread.lastMessagePreview,
      unreadCount: viewer.role === "STAFF" ? thread.staffUnreadCount : thread.coadminUnreadCount,
      staffLastActiveAt: lastSession?.lastSeenAt.toISOString() ?? null
    };
  }

  private toMessageDto(
    row: {
      id: string;
      workspaceId: string;
      threadId: string;
      senderUserId: string;
      receiverUserId: string;
      body: string;
      createdAt: Date;
      readAt: Date | null;
      editedAt: Date | null;
      sender: { id: string; name: string; role: string };
    },
    staffUserId: string
  ): InternalMessageDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      threadId: row.threadId,
      staffUserId,
      senderUserId: row.senderUserId,
      senderName: row.sender.name,
      senderRole: row.sender.role === "STAFF" ? "STAFF" : "COADMIN",
      receiverUserId: row.receiverUserId,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
      editedAt: row.editedAt?.toISOString() ?? null,
      channel: "INTERNAL_TEAM",
      label: "Internal Team Message"
    };
  }

  private async publishCreated(message: InternalMessageDto, staffUnreadCount: number): Promise<void> {
    const created: InternalMessageCreatedEvent = {
      type: "internal_message.created",
      eventId: crypto.randomUUID(),
      workspaceId: message.workspaceId,
      threadId: message.threadId,
      staffUserId: message.staffUserId,
      message
    };
    const unread: StaffInternalUnreadCountUpdatedEvent = {
      type: "staff_internal_unread_count.updated",
      eventId: crypto.randomUUID(),
      workspaceId: message.workspaceId,
      staffUserId: message.staffUserId,
      unreadCount: staffUnreadCount
    };
    await this.app.redis.publish("atlas.workspace-events", JSON.stringify(created));
    await this.app.redis.publish("atlas.workspace-events", JSON.stringify(unread));
  }

  private async publishRead(
    user: RequestUser,
    staffUserId: string,
    threadId: string,
    messageId: string,
    readAt: Date,
    staffUnreadCount: number
  ): Promise<void> {
    const workspaceId = this.requireWorkspace(user);
    const readEvent: InternalMessageReadEvent = {
      type: "internal_message.read",
      eventId: crypto.randomUUID(),
      workspaceId,
      threadId,
      staffUserId,
      messageId,
      readAt: readAt.toISOString(),
      readerUserId: user.id
    };
    const unread: StaffInternalUnreadCountUpdatedEvent = {
      type: "staff_internal_unread_count.updated",
      eventId: crypto.randomUUID(),
      workspaceId,
      staffUserId,
      unreadCount: staffUnreadCount
    };
    await this.app.redis.publish("atlas.workspace-events", JSON.stringify(readEvent));
    await this.app.redis.publish("atlas.workspace-events", JSON.stringify(unread));
  }

  private async writeActivity(
    workspaceId: string,
    user: RequestUser,
    staffUserId: string,
    body: string
  ): Promise<void> {
    // Activity is workspace-level; attach to a sentinel chat only if needed later.
    // Use audit log for internal messaging trail without polluting customer CRM timelines.
    await this.app.prisma.auditLog.create({
      data: {
        workspaceId,
        actorId: user.id,
        action: "internal.message.sent",
        metadata: {
          staffUserId,
          preview: body.slice(0, 120),
          senderRole: user.role
        }
      }
    });
  }

  private async assertThreadAccess(user: RequestUser, staffUserId: string): Promise<void> {
    const workspaceId = this.requireWorkspace(user);
    if (user.role === "STAFF") {
      if (user.id !== staffUserId) {
        throw forbidden("Staff may only access their own team thread.");
      }
      return;
    }
    this.assertCoadmin(user);
    const staff = await this.app.prisma.user.findFirst({
      where: { id: staffUserId, workspaceId, role: "STAFF" },
      select: { id: true }
    });
    if (!staff) {
      throw new AppError(404, "NOT_FOUND", "Staff member not found in this workspace.");
    }
  }

  private assertCoadmin(user: RequestUser): void {
    if (user.role !== "COADMIN") {
      throw forbidden("Only Coadmin can manage Staff team threads.");
    }
  }

  private requireWorkspace(user: RequestUser): string {
    if (!user.workspaceId) {
      throw forbidden("Workspace context required.");
    }
    return user.workspaceId;
  }
}
