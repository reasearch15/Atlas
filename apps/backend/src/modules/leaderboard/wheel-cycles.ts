import {
  WHEEL_CYCLE_HOURS,
  WHEEL_CYCLES_PER_COMPETITION
} from "./leaderboard.constants";

export interface WheelCompetitionBounds {
  readonly id: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface WheelCycleWindow {
  readonly sequence: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Lists exactly 7 half-open 48h cycles covering [startsAt, endsAt).
 * Uses competition UTC bounds (DST-safe — do not hardcode offsets).
 * Instant at cycleEnd belongs to the next cycle.
 */
export function listCycles(competition: WheelCompetitionBounds): WheelCycleWindow[] {
  const startMs = competition.startsAt.getTime();
  const endMs = competition.endsAt.getTime();
  if (!(endMs > startMs)) {
    throw new Error("Competition endsAt must be after startsAt");
  }

  const cycleMs = WHEEL_CYCLE_HOURS * 60 * 60 * 1000;
  const expectedEnd = startMs + WHEEL_CYCLES_PER_COMPETITION * cycleMs;
  if (expectedEnd !== endMs) {
    // Soft assert: biweekly Chicago windows are 14×24h wall; duration in UTC ms
    // may differ across DST. Still produce 7 equal-duration slices of the window.
  }

  const sliceMs = (endMs - startMs) / WHEEL_CYCLES_PER_COMPETITION;
  const cycles: WheelCycleWindow[] = [];
  for (let i = 0; i < WHEEL_CYCLES_PER_COMPETITION; i += 1) {
    const sequence = i + 1;
    const startsAt = new Date(startMs + Math.round(i * sliceMs));
    const endsAt =
      i === WHEEL_CYCLES_PER_COMPETITION - 1
        ? new Date(endMs)
        : new Date(startMs + Math.round((i + 1) * sliceMs));
    cycles.push({ sequence, startsAt, endsAt });
  }
  assertCycleSequence(cycles);
  return cycles;
}

/**
 * Returns the cycle containing `now` under half-open [startsAt, endsAt).
 * Instant at endsAt belongs to the next cycle (or null if past competition).
 */
export function cycleContaining(
  competition: WheelCompetitionBounds,
  now: Date
): WheelCycleWindow | null {
  const t = now.getTime();
  if (t < competition.startsAt.getTime() || t >= competition.endsAt.getTime()) {
    return null;
  }
  const cycles = listCycles(competition);
  for (const cycle of cycles) {
    if (t >= cycle.startsAt.getTime() && t < cycle.endsAt.getTime()) {
      return cycle;
    }
  }
  return null;
}

/**
 * Asserts sequences are exactly 1..7 contiguous half-open windows.
 */
export function assertCycleSequence(cycles: readonly WheelCycleWindow[]): void {
  if (cycles.length !== WHEEL_CYCLES_PER_COMPETITION) {
    throw new Error(`Expected ${WHEEL_CYCLES_PER_COMPETITION} wheel cycles, got ${cycles.length}`);
  }
  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i]!;
    if (cycle.sequence !== i + 1) {
      throw new Error(`Wheel cycle sequence mismatch at index ${i}: got ${cycle.sequence}`);
    }
    if (!(cycle.endsAt.getTime() > cycle.startsAt.getTime())) {
      throw new Error(`Wheel cycle ${cycle.sequence} has non-positive duration`);
    }
    if (i > 0) {
      const prev = cycles[i - 1]!;
      if (prev.endsAt.getTime() !== cycle.startsAt.getTime()) {
        throw new Error(`Wheel cycles ${prev.sequence} and ${cycle.sequence} are not contiguous`);
      }
    }
  }
}
