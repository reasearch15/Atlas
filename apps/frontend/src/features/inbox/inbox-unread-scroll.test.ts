import { describe, expect, it } from "vitest";
import { isRowIntersectingContainer, shouldAutoScrollToUnreadArrival } from "./inbox-unread-scroll";

describe("inbox unread arrival auto-scroll", () => {
  it("never scrolls when the list is hidden", () => {
    expect(
      shouldAutoScrollToUnreadArrival({
        listVisible: false,
        selectedChatId: null,
        arrivedChatId: "a",
        scrollTop: 0,
        rowFullyOrPartiallyVisible: true
      })
    ).toBe(false);
  });

  it("never scrolls when the staff is reading a different chat", () => {
    expect(
      shouldAutoScrollToUnreadArrival({
        listVisible: true,
        selectedChatId: "open",
        arrivedChatId: "arrived",
        scrollTop: 0,
        rowFullyOrPartiallyVisible: true
      })
    ).toBe(false);
  });

  it("scrolls when near the top of the list", () => {
    expect(
      shouldAutoScrollToUnreadArrival({
        listVisible: true,
        selectedChatId: null,
        arrivedChatId: "a",
        scrollTop: 20,
        rowFullyOrPartiallyVisible: false
      })
    ).toBe(true);
  });

  it("scrolls when the arrived row is already partially visible", () => {
    expect(
      shouldAutoScrollToUnreadArrival({
        listVisible: true,
        selectedChatId: null,
        arrivedChatId: "a",
        scrollTop: 400,
        rowFullyOrPartiallyVisible: true
      })
    ).toBe(true);
  });

  it("does not scroll when scrolled away and the row is off-screen", () => {
    expect(
      shouldAutoScrollToUnreadArrival({
        listVisible: true,
        selectedChatId: null,
        arrivedChatId: "a",
        scrollTop: 400,
        rowFullyOrPartiallyVisible: false
      })
    ).toBe(false);
  });

  it("detects row/container intersection", () => {
    expect(
      isRowIntersectingContainer({
        containerTop: 0,
        containerBottom: 100,
        rowTop: 80,
        rowBottom: 120
      })
    ).toBe(true);
    expect(
      isRowIntersectingContainer({
        containerTop: 0,
        containerBottom: 100,
        rowTop: 120,
        rowBottom: 140
      })
    ).toBe(false);
  });
});
