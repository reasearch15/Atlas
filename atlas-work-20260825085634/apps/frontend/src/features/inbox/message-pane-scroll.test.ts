import { describe, expect, it } from "vitest";
import { shouldAutoScrollMessagePane } from "./message-pane-scroll";

describe("message-pane scroll isolation", () => {
  it("does not auto-scroll for unrelated inbox reorder (not selected-chat message)", () => {
    expect(
      shouldAutoScrollMessagePane({
        isForSelectedChat: false,
        nearBottom: true,
        userSentMessage: false
      })
    ).toBe(false);
  });

  it("auto-scrolls selected-chat inbound only when near bottom", () => {
    expect(
      shouldAutoScrollMessagePane({
        isForSelectedChat: true,
        nearBottom: true,
        userSentMessage: false
      })
    ).toBe(true);
    expect(
      shouldAutoScrollMessagePane({
        isForSelectedChat: true,
        nearBottom: false,
        userSentMessage: false
      })
    ).toBe(false);
  });

  it("auto-scrolls when the user sent the message even if not near bottom", () => {
    expect(
      shouldAutoScrollMessagePane({
        isForSelectedChat: true,
        nearBottom: false,
        userSentMessage: true
      })
    ).toBe(true);
  });
});
