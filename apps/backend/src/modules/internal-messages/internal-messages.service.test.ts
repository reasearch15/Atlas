import { describe, expect, it, vi } from "vitest";
import { InternalMessagesService } from "./internal-messages.service";
import type { RequestUser } from "../auth/auth.types";

function user(partial: Partial<RequestUser> & Pick<RequestUser, "id" | "role" | "workspaceId">): RequestUser {
  return {
    email: "a@b.co",
    name: partial.name ?? "Actor",
    sessionId: "session-1",
    ...partial
  };
}

describe("InternalMessagesService security", () => {
  it("blocks cross-workspace Staff access", async () => {
    const app = {
      prisma: {
        user: {
          findFirst: vi.fn().mockResolvedValue(null)
        },
        internalMessageThread: {
          upsert: vi.fn()
        }
      }
    } as never;
    const service = new InternalMessagesService(app);
    await expect(
      service.listMessages(user({ id: "coadmin-1", role: "COADMIN", workspaceId: "ws-1", name: "Charlie" }), "staff-other-ws")
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("prevents Staff from opening another Staff member thread", async () => {
    const app = { prisma: {} } as never;
    const service = new InternalMessagesService(app);
    await expect(
      service.listMessages(user({ id: "staff-1", role: "STAFF", workspaceId: "ws-1", name: "Sarah" }), "staff-2")
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("ignores spoofed sender identity and uses session user", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "msg-1",
      workspaceId: "ws-1",
      threadId: "thread-1",
      senderUserId: "coadmin-1",
      receiverUserId: "staff-1",
      body: "Hello Sarah",
      createdAt: new Date(),
      readAt: null,
      editedAt: null,
      sender: { id: "coadmin-1", name: "Charlie", role: "COADMIN" }
    });
    const app = {
      prisma: {
        user: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ id: "staff-1", role: "STAFF" }) // assertThreadAccess
            .mockResolvedValueOnce({ id: "staff-1", role: "STAFF" }) // staff lookup
        },
        internalMessageThread: {
          upsert: vi.fn().mockResolvedValue({
            id: "thread-1",
            workspaceId: "ws-1",
            staffUserId: "staff-1",
            staffUnreadCount: 0,
            coadminUnreadCount: 0,
            staffUser: { id: "staff-1", name: "Sarah", username: "sarah" }
          }),
          update: vi.fn().mockResolvedValue({ staffUnreadCount: 1 })
        },
        internalMessage: { create },
        auditLog: { create: vi.fn().mockResolvedValue({}) }
      },
      redis: { publish: vi.fn().mockResolvedValue(1) }
    } as never;

    const service = new InternalMessagesService(app);
    const dto = await service.sendMessage(
      user({ id: "coadmin-1", role: "COADMIN", workspaceId: "ws-1", name: "Charlie" }),
      "staff-1",
      { body: "Hello Sarah", senderUserId: "spoofed", senderName: "Hacker", workspaceId: "other-ws" }
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          senderUserId: "coadmin-1",
          receiverUserId: "staff-1",
          body: "Hello Sarah"
        })
      })
    );
    expect(dto.senderUserId).toBe("coadmin-1");
    expect(dto.channel).toBe("INTERNAL_TEAM");
    expect(dto.label).toBe("Internal Team Message");
  });
});
