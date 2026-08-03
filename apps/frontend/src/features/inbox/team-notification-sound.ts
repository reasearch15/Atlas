/**
 * Softer notification sound for internal Coadmin↔Staff messages.
 * Separate mute from customer Telegram alerts.
 */

const STORAGE_KEY = "atlas.inbox.teamNotificationSound";
const DEBOUNCE_MS = 1200;

export interface TeamNotificationSoundSettings {
  readonly enabled: boolean;
  readonly volume: number;
  readonly muted: boolean;
}

let audioContext: AudioContext | null = null;
let lastPlayedAt = 0;

/**
 * Reads team-message sound settings.
 */
export function getTeamNotificationSoundSettings(): TeamNotificationSoundSettings {
  if (typeof window === "undefined") {
    return { enabled: true, volume: 0.45, muted: false };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: true, volume: 0.45, muted: false };
    const parsed = JSON.parse(raw) as Partial<TeamNotificationSoundSettings>;
    return {
      enabled: parsed.enabled !== false,
      volume: typeof parsed.volume === "number" ? Math.min(1, Math.max(0, parsed.volume)) : 0.45,
      muted: Boolean(parsed.muted)
    };
  } catch {
    return { enabled: true, volume: 0.45, muted: false };
  }
}

/**
 * Persists team-message sound settings (independent of customer alerts).
 */
export function setTeamNotificationSoundSettings(
  partial: Partial<TeamNotificationSoundSettings>
): TeamNotificationSoundSettings {
  const current = getTeamNotificationSoundSettings();
  const next = {
    ...current,
    ...partial,
    volume: typeof partial.volume === "number" ? Math.min(1, Math.max(0, partial.volume)) : current.volume
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

/**
 * Plays a soft sine tone for internal team messages.
 */
export function playTeamMessageBeep(now = Date.now()): boolean {
  const settings = getTeamNotificationSoundSettings();
  if (!settings.enabled || settings.muted) return false;
  if (lastPlayedAt > 0 && now - lastPlayedAt < DEBOUNCE_MS) return false;
  lastPlayedAt = now;

  if (typeof window === "undefined") return false;
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return false;
  audioContext ??= new AudioCtx();
  const ctx = audioContext;
  if (ctx.state === "suspended") void ctx.resume();

  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(660, ctx.currentTime);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, settings.volume * 0.35), ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.3);
  return true;
}
