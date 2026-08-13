import { PROMOTION_WINDOW_MS } from "./leaderboard.constants";

export interface RandomSource {
  nextIntInclusive(min: number, max: number): number;
}

/**
 * Cryptographically seeded random source for production promotion awards.
 */
export function createCryptoRandomSource(): RandomSource {
  return {
    nextIntInclusive(min: number, max: number): number {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new Error("Invalid random bounds");
      }
      const range = max - min + 1;
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return min + (buf[0]! % range);
    }
  };
}

export function createFixedRandomSource(values: readonly number[]): RandomSource {
  let index = 0;
  return {
    nextIntInclusive(min: number, max: number): number {
      const value = values[Math.min(index, values.length - 1)]!;
      index += 1;
      if (value < min || value > max) {
        throw new Error(`Fixed random value ${value} outside [${min}, ${max}]`);
      }
      return value;
    }
  };
}

/**
 * Finds the open promotion window start from prior awards, or null if a new window should begin.
 * Window = 24h from the first promotion after a ≥24h gap.
 */
export function findOpenPromotionWindowStart(existingCreatedAt: readonly Date[], now: Date): Date | null {
  if (existingCreatedAt.length === 0) return null;
  const sorted = [...existingCreatedAt].sort((a, b) => a.getTime() - b.getTime());
  let windowStart = sorted[0]!;
  for (let i = 1; i < sorted.length; i += 1) {
    const t = sorted[i]!;
    if (t.getTime() - windowStart.getTime() >= PROMOTION_WINDOW_MS) {
      windowStart = t;
    }
  }
  if (now.getTime() - windowStart.getTime() < PROMOTION_WINDOW_MS) {
    return windowStart;
  }
  return null;
}

/**
 * Resolves promotion points: random 1–3 for a new window, else exactly +1.
 */
export function resolvePromotionPoints(
  existingCreatedAt: readonly Date[],
  now: Date,
  random: RandomSource
): number {
  const open = findOpenPromotionWindowStart(existingCreatedAt, now);
  if (open) return 1;
  return random.nextIntInclusive(1, 3);
}
