/**
 * Inbox notification sound via Web Audio oscillator with localStorage settings.
 */

const STORAGE_KEY = "atlas.inbox.notificationSound";
const DEBOUNCE_MS = 1500;

export interface NotificationSoundSettings {
  readonly enabled: boolean;
  readonly volume: number;
  readonly muted: boolean;
}

export interface NotifyIncomingOptions {
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly chatId: string;
  readonly chatTitle: string;
  readonly preview: string;
  readonly isChatOpen: boolean;
  readonly documentHidden?: boolean;
  readonly documentFocused?: boolean;
  readonly chatMuted?: boolean;
}

let audioContext: AudioContext | null = null;
let unlocked = false;
let lastPlayedAt = 0;

/**
 * Reads notification sound settings from localStorage.
 */
export function getNotificationSoundSettings(): NotificationSoundSettings {
  if (typeof window === "undefined") {
    return { enabled: true, volume: 0.85, muted: false };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: true, volume: 0.85, muted: false };
    const parsed = JSON.parse(raw) as Partial<NotificationSoundSettings>;
    return {
      enabled: parsed.enabled !== false,
      volume: clampVolume(typeof parsed.volume === "number" ? parsed.volume : 0.85),
      muted: Boolean(parsed.muted)
    };
  } catch {
    return { enabled: true, volume: 0.85, muted: false };
  }
}

/**
 * Persists notification sound settings.
 */
export function setNotificationSoundSettings(partial: Partial<NotificationSoundSettings>): NotificationSoundSettings {
  const next = { ...getNotificationSoundSettings(), ...partial, volume: clampVolume(partial.volume ?? getNotificationSoundSettings().volume) };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

/**
 * Unlocks AudioContext after a user gesture (required by browsers).
 */
export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  const ctx = ensureAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().then(() => {
      unlocked = true;
    });
  } else {
    unlocked = true;
  }
}

/**
 * Installs one-time listeners that unlock audio on first interaction.
 */
export function installAudioUnlockListeners(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const unlock = () => unlockAudio();
  const options = { once: true, passive: true } as const;
  window.addEventListener("pointerdown", unlock, options);
  window.addEventListener("keydown", unlock, options);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

/**
 * Returns whether an incoming message should trigger sound/desktop notify.
 */
export function shouldNotifyIncoming(opts: NotifyIncomingOptions): boolean {
  if (opts.direction === "OUTBOUND") return false;
  if (opts.chatMuted) return false;

  const focused =
    typeof opts.documentFocused === "boolean"
      ? opts.documentFocused
      : typeof document === "undefined"
        ? true
        : document.hasFocus();
  const hidden =
    typeof opts.documentHidden === "boolean"
      ? opts.documentHidden
      : typeof document === "undefined"
        ? false
        : document.hidden;

  // No mute flag on chats yet: suppress when the window is focused and this chat is open.
  if (opts.chatMuted == null && focused && opts.isChatOpen && !hidden) {
    return false;
  }

  return true;
}

/**
 * Plays a short sharp high-volume beep, debounced to once per 1.5s burst window.
 * Returns whether a beep was actually scheduled.
 */
export function playNotificationBeep(now = Date.now()): boolean {
  const settings = getNotificationSoundSettings();
  if (!settings.enabled || settings.muted) return false;
  if (lastPlayedAt > 0 && now - lastPlayedAt < DEBOUNCE_MS) return false;
  lastPlayedAt = now;

  const ctx = ensureAudioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    void ctx.resume();
  }

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(1180, ctx.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.07);

  const volume = clampVolume(settings.volume) * 0.95;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(ctx.currentTime);
  oscillator.stop(ctx.currentTime + 0.14);
  return true;
}

/**
 * Test helper: resets debounce window.
 */
export function resetNotificationSoundStateForTests(): void {
  lastPlayedAt = 0;
  unlocked = false;
  audioContext = null;
}

/**
 * Test helper: returns whether audio has been unlocked.
 */
export function isAudioUnlockedForTests(): boolean {
  return unlocked;
}

function ensureAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!audioContext) {
    audioContext = new AudioCtx();
  }
  return audioContext;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(1, Math.max(0, value));
}
