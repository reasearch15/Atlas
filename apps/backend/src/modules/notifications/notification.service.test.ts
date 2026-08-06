import { describe, expect, it, vi } from "vitest";
import { NotificationPreferenceService } from "./device-token.service";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@atlas/shared";

describe("NotificationPreferenceService.shouldSend", () => {
  const service = new NotificationPreferenceService({} as never);

  it("blocks when muted or disabled", () => {
    expect(
      service.shouldSend({ ...DEFAULT_NOTIFICATION_PREFERENCES, muteAll: true }, "INCOMING_MESSAGE", false)
    ).toBe(false);
    expect(
      service.shouldSend({ ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: false }, "INCOMING_MESSAGE", false)
    ).toBe(false);
  });

  it("respects category toggles", () => {
    expect(
      service.shouldSend(
        { ...DEFAULT_NOTIFICATION_PREFERENCES, customerMessages: false },
        "INCOMING_MESSAGE",
        false
      )
    ).toBe(false);
    expect(
      service.shouldSend({ ...DEFAULT_NOTIFICATION_PREFERENCES, assignments: false }, "CONVERSATION_ASSIGNED", false)
    ).toBe(false);
    expect(
      service.shouldSend({ ...DEFAULT_NOTIFICATION_PREFERENCES, mentions: false }, "MENTION", false)
    ).toBe(false);
  });

  it("urgent-only mode suppresses non-urgent customer messages", () => {
    expect(
      service.shouldSend({ ...DEFAULT_NOTIFICATION_PREFERENCES, urgentOnly: true }, "INCOMING_MESSAGE", false)
    ).toBe(false);
    expect(
      service.shouldSend({ ...DEFAULT_NOTIFICATION_PREFERENCES, urgentOnly: true }, "INCOMING_MESSAGE", true)
    ).toBe(true);
    expect(
      service.shouldSend({ ...DEFAULT_NOTIFICATION_PREFERENCES, urgentOnly: true }, "URGENT_FLAG", false)
    ).toBe(true);
  });

  it("always allows test notifications when enabled", () => {
    expect(service.shouldSend(DEFAULT_NOTIFICATION_PREFERENCES, "TEST", false)).toBe(true);
  });
});

describe("NotificationService.resolveMessageRecipients", () => {
  it("returns assignee when conversation is assigned", async () => {
    const { NotificationService } = await import("./notification.service");
    const prisma = {
      telegramChat: {
        findFirst: vi.fn().mockResolvedValue({ assignedUserId: "user-a" })
      },
      user: { findMany: vi.fn() }
    };
    const app = {
      log: { child: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() }) },
      prisma,
      env: {},
      queues: { pushNotifications: { add: vi.fn() } }
    } as never;
    const service = new NotificationService(app);
    await expect(service.resolveMessageRecipients("ws", "chat")).resolves.toEqual(["user-a"]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("returns all active workspace agents when unassigned", async () => {
    const { NotificationService } = await import("./notification.service");
    const prisma = {
      telegramChat: {
        findFirst: vi.fn().mockResolvedValue({ assignedUserId: null })
      },
      user: {
        findMany: vi.fn().mockResolvedValue([{ id: "c1" }, { id: "s1" }])
      }
    };
    const app = {
      log: { child: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() }) },
      prisma,
      env: {},
      queues: { pushNotifications: { add: vi.fn() } }
    } as never;
    const service = new NotificationService(app);
    await expect(service.resolveMessageRecipients("ws", "chat")).resolves.toEqual(["c1", "s1"]);
  });
});
