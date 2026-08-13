import { describe, expect, it } from "vitest";
import {
  decodeDepositHistoryCursor,
  DEPOSIT_HISTORY_PAGE_SIZE,
  depositHistoryOlderThanCursor,
  encodeDepositHistoryCursor,
  sliceDepositHistoryPage
} from "./deposit-history";

describe("deposit-history cursor helpers", () => {
  it("round-trips cursor encode/decode", () => {
    const createdAt = new Date("2026-08-13T15:41:00.000Z");
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const encoded = encodeDepositHistoryCursor({ createdAt, id });
    const decoded = decodeDepositHistoryCursor(encoded);
    expect(decoded.id).toBe(id);
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeDepositHistoryCursor("not-valid")).toThrow("INVALID_DEPOSIT_HISTORY_CURSOR");
    expect(() => decodeDepositHistoryCursor(Buffer.from("no-sep", "utf8").toString("base64url"))).toThrow(
      "INVALID_DEPOSIT_HISTORY_CURSOR"
    );
  });

  it("builds keyset older-than clause", () => {
    const cursor = {
      createdAt: new Date("2026-08-13T12:00:00.000Z"),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    };
    expect(depositHistoryOlderThanCursor(cursor)).toEqual({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } }
      ]
    });
  });
});

describe("sliceDepositHistoryPage", () => {
  function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      createdAt: new Date(Date.UTC(2026, 7, 13, 20, 0, n - i))
    }));
  }

  it("10 deposits → one page, no more", () => {
    const page = sliceDepositHistoryPage(rows(10), DEPOSIT_HISTORY_PAGE_SIZE);
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("exactly 30 → one page, no second page", () => {
    const page = sliceDepositHistoryPage(rows(30), DEPOSIT_HISTORY_PAGE_SIZE);
    expect(page.items).toHaveLength(30);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("31 → first 30 with hasMore + cursor for final 1", () => {
    const fetched = rows(31); // simulates limit+1
    const first = sliceDepositHistoryPage(fetched, DEPOSIT_HISTORY_PAGE_SIZE);
    expect(first.items).toHaveLength(30);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const cursor = decodeDepositHistoryCursor(first.nextCursor!);
    expect(cursor.id).toBe(first.items[29]!.id);

    const remaining = [fetched[30]!];
    const second = sliceDepositHistoryPage(remaining, DEPOSIT_HISTORY_PAGE_SIZE);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it("75 → 30 + 30 + 15 without duplicates/gaps", () => {
    const all = rows(75);
    const p1 = sliceDepositHistoryPage(all.slice(0, 31), DEPOSIT_HISTORY_PAGE_SIZE);
    const p2 = sliceDepositHistoryPage(all.slice(30, 61), DEPOSIT_HISTORY_PAGE_SIZE);
    const p3 = sliceDepositHistoryPage(all.slice(60), DEPOSIT_HISTORY_PAGE_SIZE);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((r) => r.id);
    expect(ids).toHaveLength(75);
    expect(new Set(ids).size).toBe(75);
    expect(ids).toEqual(all.map((r) => r.id));
    expect(p1.hasMore).toBe(true);
    expect(p2.hasMore).toBe(true);
    expect(p3.hasMore).toBe(false);
  });

  it("orders newest first in fixture rows", () => {
    const page = sliceDepositHistoryPage(rows(5), DEPOSIT_HISTORY_PAGE_SIZE);
    for (let i = 1; i < page.items.length; i++) {
      expect(page.items[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        page.items[i]!.createdAt.getTime()
      );
    }
  });
});
