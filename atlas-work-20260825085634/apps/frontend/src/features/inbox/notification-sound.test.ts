import { afterEach, describe, expect, it, vi } from "vitest";
import {
  playNotificationBeep,
  resetNotificationSoundStateForTests,
  setNotificationSoundSettings,
  shouldNotifyIncoming
} from "./notification-sound";

afterEach(() => {
  resetNotificationSoundStateForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shouldNotifyIncoming", () => {
  it("skips outgoing messages", () => {
    expect(
      shouldNotifyIncoming({
        direction: "OUTBOUND",
        chatId: "c1",
        chatTitle: "Ada",
        preview: "hi",
        isChatOpen: false,
        documentFocused: false,
        documentHidden: true
      })
    ).toBe(false);
  });

  it("skips muted chats", () => {
    expect(
      shouldNotifyIncoming({
        direction: "INBOUND",
        chatId: "c1",
        chatTitle: "Ada",
        preview: "hi",
        isChatOpen: false,
        chatMuted: true,
        documentFocused: false,
        documentHidden: true
      })
    ).toBe(false);
  });

  it("skips when focused and the chat is already open", () => {
    expect(
      shouldNotifyIncoming({
        direction: "INBOUND",
        chatId: "c1",
        chatTitle: "Ada",
        preview: "hi",
        isChatOpen: true,
        documentFocused: true,
        documentHidden: false
      })
    ).toBe(false);
  });

  it("notifies inbound when chat is not open", () => {
    expect(
      shouldNotifyIncoming({
        direction: "INBOUND",
        chatId: "c1",
        chatTitle: "Ada",
        preview: "hi",
        isChatOpen: false,
        documentFocused: true,
        documentHidden: false
      })
    ).toBe(true);
  });
});

describe("playNotificationBeep debounce", () => {
  function installFakeWindow(storage: Record<string, string> = {}): void {
    class FakeOscillator {
      type = "square";
      frequency = {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn()
      };
      connect = vi.fn();
      start = vi.fn();
      stop = vi.fn();
    }
    class FakeGain {
      gain = {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn()
      };
      connect = vi.fn();
    }
    class FakeAudioContext {
      currentTime = 0;
      state = "running";
      destination = {};
      resume = vi.fn(async () => undefined);
      createOscillator = vi.fn(() => new FakeOscillator());
      createGain = vi.fn(() => new FakeGain());
    }

    const fakeWindow = {
      AudioContext: FakeAudioContext,
      localStorage: {
        getItem: (key: string) => storage[key] ?? null,
        setItem: (key: string, value: string) => {
          storage[key] = value;
        }
      }
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("AudioContext", FakeAudioContext);
  }

  it("plays at most once per 1.5s window", () => {
    installFakeWindow();
    setNotificationSoundSettings({ enabled: true, volume: 0.9, muted: false });

    expect(playNotificationBeep(1_000)).toBe(true);
    expect(playNotificationBeep(1_400)).toBe(false);
    expect(playNotificationBeep(2_600)).toBe(true);
  });

  it("does not play when muted", () => {
    installFakeWindow();
    setNotificationSoundSettings({ muted: true });
    expect(playNotificationBeep(5_000)).toBe(false);
  });
});
