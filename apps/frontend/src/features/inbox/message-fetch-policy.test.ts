import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  bindChatMessagesQueryClient,
  cancelChatMessagesQuery,
  chatMessagesQueryKey,
  fetchChatMessages,
  refreshChatMessagesIfStale,
  CHAT_MESSAGES_STALE_MS
} from "./message-cache";

describe("active-chat message fetch policy", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    bindChatMessagesQueryClient(client);
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    client.clear();
  });

  it("dedupes in-flight fetches for the same chat", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        })
    );

    const p1 = client.fetchQuery({
      queryKey: chatMessagesQueryKey("chat-a"),
      queryFn: ({ signal }) => fetchChatMessages("chat-a", signal)
    });
    const p2 = client.fetchQuery({
      queryKey: chatMessagesQueryKey("chat-a"),
      queryFn: ({ signal }) => fetchChatMessages("chat-a", signal)
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the previous chat fetch when cancelling on switch", async () => {
    const controllers: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) controllers.push(init.signal);
      return new Promise<Response>(() => {
        /* hang until aborted */
      });
    });

    const pending = client.fetchQuery({
      queryKey: chatMessagesQueryKey("chat-old"),
      queryFn: ({ signal }) => fetchChatMessages("chat-old", signal)
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    cancelChatMessagesQuery("chat-old");
    await expect(pending).rejects.toThrow();
    expect(controllers[0]?.aborted).toBe(true);
  });

  it("reopening a cached chat does not refetch while fresh", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );

    await client.fetchQuery({
      queryKey: chatMessagesQueryKey("chat-b"),
      queryFn: ({ signal }) => fetchChatMessages("chat-b", signal),
      staleTime: CHAT_MESSAGES_STALE_MS
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.fetchQuery({
      queryKey: chatMessagesQueryKey("chat-b"),
      queryFn: ({ signal }) => fetchChatMessages("chat-b", signal),
      staleTime: CHAT_MESSAGES_STALE_MS
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(chatMessagesQueryKey("chat-b"))).toEqual([]);
  });

  it("refreshChatMessagesIfStale does not invalidate a fresh cache", () => {
    client.setQueryData(chatMessagesQueryKey("chat-c"), []);
    let invalidated = 0;
    const original = client.invalidateQueries.bind(client);
    client.invalidateQueries = (async (...args: Parameters<typeof original>) => {
      invalidated += 1;
      return original(...args);
    }) as typeof client.invalidateQueries;

    refreshChatMessagesIfStale("chat-c");
    expect(invalidated).toBe(0);
  });
});
