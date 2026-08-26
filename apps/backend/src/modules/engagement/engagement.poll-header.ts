/**
 * Compact decorative Telegram messages that wrap native engagement polls.
 * Telegram owns poll chrome (bars, counts, vote UI). These headers only add vibe.
 */

export interface PollHeaderTheme {
  readonly id: string;
  readonly text: string;
}

export const POLL_HEADER_THEMES: readonly PollHeaderTheme[] = [
  {
    id: "jackpot",
    text: "✨💎✨ SAYU GAMING HUB ✨💎✨\n🎰 JACKPOT PICK — VOTE BELOW 👇"
  },
  {
    id: "lucky",
    text: "🍀✨ LUCKY PICK ✨🍀\n🎲 Vote below 👇"
  },
  {
    id: "royal",
    text: "👑💎 ROYAL CHOICE 💎👑\n✨ Pick one below 👇"
  },
  {
    id: "fire",
    text: "🔥⚡ HOT PICK ⚡🔥\n💥 Vote below 👇"
  },
  {
    id: "party",
    text: "🪩✨ PARTY POLL ✨🪩\n🎉 Vote below 👇"
  },
  {
    id: "challenge",
    text: "🏆🔥 CHALLENGE TIME 🔥🏆\n🎯 Vote below 👇"
  },
  {
    id: "casino",
    text: "🎰✨ SAYU SPIN & PICK ✨🎰\n🎲 Vote below 👇"
  },
  {
    id: "battle",
    text: "⚔️⚡ BATTLE PICK ⚡⚔️\n💥 Choose below 👇"
  },
  {
    id: "neon",
    text: "💜✨💎✨💜\n🎰 SAYU PICK OF THE MOMENT 🎰\n💜✨ Vote below 👇 💜✨"
  },
  {
    id: "quick",
    text: "⚡✨ SAYU QUICK PICK ✨⚡\n🎲 Pick your favorite below 👇"
  },
  {
    id: "star",
    text: "🌟💎 SAYU GAMING HUB 💎🌟\n🌟 STAR PICK — VOTE BELOW 👇"
  },
  {
    id: "fortune",
    text: "🤑✨ FORTUNE PICK ✨🤑\n💸 Vote below 👇"
  }
];

const QUESTION_ECHO_PATTERN = /which would you (choose|pick)|vote below — results/i;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function formatPollHeaderMessage(theme: PollHeaderTheme): string {
  return theme.text;
}

/**
 * Pick a compact header theme. Recent ids are skipped so consecutive polls
 * do not reuse the same glitter line.
 */
export function selectPollHeaderTheme(
  seed: string,
  recentThemeIds: readonly string[] = []
): PollHeaderTheme {
  const recent = recentThemeIds.filter(Boolean);
  let pool = POLL_HEADER_THEMES.filter((theme) => !recent.includes(theme.id));
  if (pool.length === 0) {
    const last = recent[recent.length - 1];
    pool = POLL_HEADER_THEMES.filter((theme) => theme.id !== last);
  }
  if (pool.length === 0) {
    pool = [...POLL_HEADER_THEMES];
  }
  return pool[hashSeed(seed) % pool.length]!;
}

export function pollHeaderRepeatsQuestion(text: string, question: string): boolean {
  const header = text.trim().toLowerCase();
  const q = question.trim().toLowerCase();
  if (!header || !q) return false;
  return header.includes(q) || QUESTION_ECHO_PATTERN.test(header);
}
