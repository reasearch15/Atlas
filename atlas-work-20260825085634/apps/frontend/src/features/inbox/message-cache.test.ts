import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CHAT_MESSAGES_STALE_MS, refreshChatMessagesForced, refreshChatMessagesIfStale, bindChatMessagesQueryClient } from "./message-cache";

describe("chat message refresh helpers", () => {
  const invalidateQueries = vi.fn();
  const getQueryState = vi.fn();

  beforeEach(() => {
    invalidateQueries.mockReset();
    getQueryState.mockReset();
    bindChatMessagesQueryClient({
      invalidateQueries,
      getQueryState,
      setQueryData: vi.fn(),
      cancelQueries: vi.fn(),
      removeQueries: vi.fn()
    } as never);
  });

  afterEach(() => {
    bindChatMessagesQueryClient(null as never);
  });

  it("skips soft refresh when cache is fresh", () => {
    getQueryState.mockReturnValue({ data: [{ id: "1" }], dataUpdatedAt: Date.now() });
    refreshChatMessagesIfStale("chat-1");
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("force refresh always invalidates even when cache is fresh", () => {
    getQueryState.mockReturnValue({ data: [{ id: "1" }], dataUpdatedAt: Date.now() });
    refreshChatMessagesForced("chat-1");
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["telegram", "chat-messages", "chat-1"],
      exact: true
    });
  });

  it("soft refresh invalidates when older than stale window", () => {
    getQueryState.mockReturnValue({
      data: [{ id: "1" }],
      dataUpdatedAt: Date.now() - CHAT_MESSAGES_STALE_MS - 1
    });
    refreshChatMessagesIfStale("chat-1");
    expect(invalidateQueries).toHaveBeenCalled();
  });
});
