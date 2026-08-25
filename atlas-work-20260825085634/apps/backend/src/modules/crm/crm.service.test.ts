import { describe, expect, it } from "vitest";
import type { RequestUser } from "../auth/auth.types";
import { CrmService } from "./crm.service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const chatId = "33333333-3333-4333-8333-333333333333";
const coadminId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
const staffId = "66666666-6666-4666-8666-666666666666";
const staff2Id = "77777777-7777-4777-8777-777777777777";
const otherWorkspaceStaffId = "88888888-8888-4888-8888-888888888888";

const coadmin: RequestUser = {
  id: coadminId,
  email: "coadmin@example.com",
  name: "Coadmin",
  role: "COADMIN",
  workspaceId,
  sessionId
};
const staff: RequestUser = { ...coadmin, id: staffId, name: "Staff One", role: "STAFF" };
const staff2: RequestUser = { ...coadmin, id: staff2Id, name: "Staff Two", role: "STAFF" };
const otherCoadmin: RequestUser = { ...coadmin, id: "99999999-9999-4999-8999-999999999999", workspaceId: otherWorkspaceId };

interface Row {
  id: string;
  [key: string]: unknown;
}

function createState() {
  return {
    chats: [] as Row[],
    users: [
      { id: coadminId, name: "Coadmin", role: "COADMIN", workspaceId, status: "ACTIVE" },
      { id: staffId, name: "Staff One", role: "STAFF", workspaceId, status: "ACTIVE" },
      { id: staff2Id, name: "Staff Two", role: "STAFF", workspaceId, status: "ACTIVE" },
      { id: otherWorkspaceStaffId, name: "Other Workspace Staff", role: "STAFF", workspaceId: otherWorkspaceId, status: "ACTIVE" }
    ] as Row[],
    tags: [] as Row[],
    chatTags: [] as Row[],
    notes: [] as Row[],
    activities: [] as Row[],
    statusHistory: [] as Row[],
    published: [] as Row[]
  };
}

function makeChat(overrides: Partial<Row> = {}): Row {
  return {
    id: chatId,
    workspaceId,
    telegramAccountId: "account-1",
    telegramChatId: "1001",
    chatType: "PRIVATE",
    crmContactId: null,
    crmStatus: "NEW",
    assignedUserId: null,
    assignedByUserId: null,
    assignedAt: null,
    claimedAt: null,
    lastAssignmentChangeAt: null,
    needsCrmAttention: true,
    crmAttentionAt: null,
    unreadCount: 0,
    ...overrides
  };
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const filter = value as { in?: unknown[]; gt?: number };
      if (filter.in) return filter.in.includes(row[key]);
      if (typeof filter.gt === "number") return typeof row[key] === "number" && (row[key] as number) > filter.gt;
      return true;
    }
    return row[key] === value;
  });
}

function withAuthor(note: Row, state: ReturnType<typeof createState>): Row {
  const author = state.users.find((user) => user.id === note.authorUserId);
  return { ...note, author: { name: author?.name ?? "Unknown" } };
}

function createService(state: ReturnType<typeof createState>) {
  const prisma = {
    telegramChat: {
      findFirst: async ({ where }: { where: Row }) => state.chats.find((chat) => matches(chat, where)) ?? null,
      findUnique: async ({ where, include }: { where: { id: string }; include?: Row }) => {
        const chat = state.chats.find((row) => row.id === where.id);
        if (!chat) return null;
        const result: Row = { ...chat };
        if (include?.assignedUser) {
          const user = chat.assignedUserId ? state.users.find((row) => row.id === chat.assignedUserId) : null;
          result.assignedUser = user ? { name: user.name } : null;
        }
        if (include?.tags) {
          result.tags = state.chatTags
            .filter((chatTag) => chatTag.chatId === chat.id)
            .map((chatTag) => ({ tag: state.tags.find((tag) => tag.id === chatTag.tagId) }));
        }
        return result;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const chat = state.chats.find((row) => row.id === where.id);
        if (!chat) throw new Error("missing chat");
        Object.assign(chat, data);
        return chat;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const chat of state.chats) {
          if (!matches(chat, where)) continue;
          Object.assign(chat, data);
          count += 1;
        }
        return { count };
      },
      count: async ({ where }: { where: Row }) => state.chats.filter((chat) => matches(chat, where)).length
    },
    user: {
      findFirst: async ({ where }: { where: Row }) => state.users.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Row }) => state.users.filter((row) => matches(row, where))
    },
    workspaceTag: {
      create: async ({ data }: { data: Row }) => {
        const tag: Row = { archivedAt: null, ...data, id: `tag-${state.tags.length + 1}` };
        state.tags.push(tag);
        return tag;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const tag = state.tags.find((row) => row.id === where.id);
        if (!tag) throw new Error("missing tag");
        Object.assign(tag, data);
        return tag;
      },
      findFirst: async ({ where }: { where: Row }) => state.tags.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Row }) => state.tags.filter((row) => matches(row, where))
    },
    telegramChatTag: {
      upsert: async ({ where, create }: { where: Row; create: Row }) => {
        const key = where.chatId_tagId as { chatId: string; tagId: string };
        let row = state.chatTags.find((chatTag) => chatTag.chatId === key.chatId && chatTag.tagId === key.tagId);
        if (!row) {
          row = { ...create, id: `chattag-${state.chatTags.length + 1}` };
          state.chatTags.push(row);
        }
        return row;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = state.chatTags.length;
        state.chatTags = state.chatTags.filter((chatTag) => !matches(chatTag, where));
        return { count: before - state.chatTags.length };
      }
    },
    crmInternalNote: {
      create: async ({ data }: { data: Row }) => {
        const note: Row = { editedAt: null, createdAt: new Date(), ...data, id: `note-${state.notes.length + 1}` };
        state.notes.push(note);
        return withAuthor(note, state);
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const note = state.notes.find((row) => row.id === where.id);
        if (!note) throw new Error("missing note");
        Object.assign(note, data);
        return withAuthor(note, state);
      },
      findFirst: async ({ where }: { where: Row }) => state.notes.find((row) => matches(row, where)) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        state.notes.filter((row) => matches(row, where)).map((note) => withAuthor(note, state))
    },
    crmActivityEvent: {
      create: async ({ data }: { data: Row }) => {
        const activity: Row = { createdAt: new Date(), ...data, id: `activity-${state.activities.length + 1}` };
        state.activities.push(activity);
        return activity;
      }
    },
    crmStatusHistory: {
      create: async ({ data }: { data: Row }) => {
        const history: Row = { createdAt: new Date(), ...data, id: `history-${state.statusHistory.length + 1}` };
        state.statusHistory.push(history);
        return history;
      }
    }
  };

  const redis = {
    publish: async (_channel: string, payload: string) => {
      state.published.push(JSON.parse(payload) as Row);
      return 1;
    }
  };

  return new CrmService({ prisma, redis } as never);
}

describe("CrmService assignment", () => {
  it("assigns, reassigns, and releases a conversation as Coadmin", async () => {
    const state = createState();
    state.chats.push(makeChat());
    const service = createService(state);

    await service.assign(coadmin, chatId, staffId);
    expect(state.chats[0]).toMatchObject({ assignedUserId: staffId, assignedByUserId: coadminId });
    expect(state.activities.at(-1)).toMatchObject({ type: "ASSIGNED" });

    await service.assign(coadmin, chatId, staff2Id);
    expect(state.chats[0]).toMatchObject({ assignedUserId: staff2Id });
    expect(state.activities.at(-1)).toMatchObject({ type: "REASSIGNED" });

    await service.release(coadmin, chatId);
    expect(state.chats[0]).toMatchObject({ assignedUserId: null, claimedAt: null, assignedAt: null });
    expect(state.activities.at(-1)).toMatchObject({ type: "RELEASED" });
  });

  it("rejects Staff performing assignment and cross-workspace assignees", async () => {
    const state = createState();
    state.chats.push(makeChat());
    const service = createService(state);

    await expect(service.assign(staff, chatId, staffId)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.assign(coadmin, chatId, otherWorkspaceStaffId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets Staff release only their own conversation while Coadmin releases any", async () => {
    const state = createState();
    state.chats.push(makeChat({ assignedUserId: staffId, claimedAt: new Date() }));
    const service = createService(state);

    await expect(service.release(staff2, chatId)).rejects.toMatchObject({ statusCode: 403 });
    await service.release(staff, chatId);
    expect(state.chats[0]).toMatchObject({ assignedUserId: null });
  });
});

describe("CrmService claim", () => {
  it("lets Staff claim an unassigned NEW conversation and opens it", async () => {
    const state = createState();
    state.chats.push(makeChat({ crmStatus: "NEW" }));
    const service = createService(state);

    await service.claim(staff, chatId);

    expect(state.chats[0]).toMatchObject({ assignedUserId: staffId, crmStatus: "OPEN" });
    expect(state.activities.at(-1)).toMatchObject({ type: "CLAIMED" });
    expect(state.statusHistory.at(-1)).toMatchObject({ fromStatus: "NEW", toStatus: "OPEN", reason: "claim" });
  });

  it("keeps a non-NEW status unchanged when claimed (reopen/claim helper usage)", async () => {
    const state = createState();
    state.chats.push(makeChat({ crmStatus: "WAITING" }));
    const service = createService(state);

    await service.claim(staff, chatId);

    expect(state.chats[0]).toMatchObject({ crmStatus: "WAITING", assignedUserId: staffId });
    expect(state.statusHistory).toHaveLength(0);
  });

  it("allows only one winner when two teammates race to claim the same conversation", async () => {
    const state = createState();
    state.chats.push(makeChat());
    const service = createService(state);

    const [first, second] = await Promise.allSettled([service.claim(staff, chatId), service.claim(staff2, chatId)]);
    const outcomes = [first, second];

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ statusCode: 409, code: "CRM_CONFLICT" });
    const chat = state.chats[0]!;
    expect(chat.assignedUserId).not.toBeNull();
    expect([staffId, staff2Id]).toContain(chat.assignedUserId);
  });

  it("denies cross-workspace access when claiming a conversation", async () => {
    const state = createState();
    state.chats.push(makeChat());
    const service = createService(state);

    await expect(service.getChatForWorkspace(otherCoadmin, chatId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.claim(otherCoadmin, chatId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("CrmService status transitions", () => {
  it("applies allowed manual transitions and records status history", async () => {
    const state = createState();
    state.chats.push(makeChat({ crmStatus: "OPEN" }));
    const service = createService(state);

    await service.setStatus(staff, chatId, "WAITING");

    expect(state.chats[0]).toMatchObject({ crmStatus: "WAITING" });
    expect(state.statusHistory.at(-1)).toMatchObject({ fromStatus: "OPEN", toStatus: "WAITING", reason: "manual" });
    expect(state.activities.at(-1)).toMatchObject({ type: "STATUS_CHANGED" });
  });

  it("rejects a no-op status transition", async () => {
    const state = createState();
    state.chats.push(makeChat({ crmStatus: "OPEN" }));
    const service = createService(state);

    await expect(service.setStatus(staff, chatId, "OPEN")).rejects.toMatchObject({
      statusCode: 409,
      code: "CRM_INVALID_STATE_TRANSITION"
    });
  });
});

describe("CrmService tags", () => {
  it("denies attaching an archived tag but allows active tags", async () => {
    const state = createState();
    state.chats.push(makeChat());
    const service = createService(state);

    const archivable = await service.createTag(coadmin, { name: "VIP", color: "#ff0000" });
    await service.updateTag(coadmin, archivable.id, { archived: true });

    await expect(service.addTag(staff, chatId, archivable.id)).rejects.toMatchObject({
      statusCode: 409,
      code: "CRM_TAG_ARCHIVED"
    });

    const active = await service.createTag(coadmin, { name: "Priority", color: "#00ff00" });
    await service.addTag(staff, chatId, active.id);

    expect(state.chatTags).toHaveLength(1);
    expect(state.chatTags[0]).toMatchObject({ tagId: active.id });
  });

  it("rejects tag catalog management by Staff", async () => {
    const state = createState();
    const service = createService(state);
    await expect(service.createTag(staff, { name: "Nope", color: "#123456" })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("CrmService notes", () => {
  it("creates and edits notes without touching Telegram outbound queues", async () => {
    const state = createState();
    state.chats.push(makeChat());
    const service = createService(state);

    const note = await service.createNote(staff, chatId, "Called customer back.");
    expect(note).toMatchObject({ chatId, authorUserId: staffId, body: "Called customer back." });

    const updated = await service.updateNote(staff, chatId, note.id, "Called customer back twice.");
    expect(updated).toMatchObject({ body: "Called customer back twice.", editedAt: expect.any(String) });

    const notes = await service.listNotes(coadmin, chatId);
    expect(notes).toHaveLength(1);

    await expect(service.updateNote(staff2, chatId, note.id, "hijack")).rejects.toMatchObject({ statusCode: 403 });
  });
});
