import { DateTime } from "luxon";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import {
  DECLARATION_HOUR,
  ENGAGEMENT_TIMEZONE,
  POLL_DURATION_MS,
  POLL_POST_HOURS,
  QUIET_END_HOUR,
  QUIET_START_HOUR
} from "./engagement.constants";

export interface EngagementSlot {
  readonly slotKey: string;
  readonly chicagoWallDate: string;
  readonly hour: number;
  readonly opensAt: Date;
  readonly closesAt: Date;
  readonly chicagoDate: string;
}

export function isEngagementPostHour(hour: number): boolean {
  return (POLL_POST_HOURS as readonly number[]).includes(hour);
}

export function isEngagementQuietHour(hour: number): boolean {
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

export function engagementSlotKey(chicagoWallDate: string, hour: number): string {
  return `${chicagoWallDate}T${String(hour).padStart(2, "0")}:00`;
}

export function pollOpensAt(chicagoWallDate: string, hour: number): Date {
  return chicagoWallTimeToUtc(`${chicagoWallDate}T${String(hour).padStart(2, "0")}:00:00`);
}

/** Close is always 4 elapsed hours after open (DST-safe). */
export function pollClosesAt(opensAt: Date): Date {
  return new Date(opensAt.getTime() + POLL_DURATION_MS);
}

export function chicagoDateString(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: "utc" }).setZone(ENGAGEMENT_TIMEZONE).toFormat("yyyy-MM-dd");
}

function declarationInstantOn(chicagoWallDate: string): Date {
  return chicagoWallTimeToUtc(`${chicagoWallDate}T${String(DECLARATION_HOUR).padStart(2, "0")}:00:00`);
}

/**
 * Daily scoring date for a poll is the Chicago date of the 11 PM declaration
 * whose half-open window (previous 23:00, this 23:00] contains `closesAt`.
 */
export function scoringChicagoDateForInstant(instant: Date): string {
  const zoned = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(ENGAGEMENT_TIMEZONE);
  const todayDeclare = zoned.set({
    hour: DECLARATION_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0
  });
  if (zoned.toMillis() <= todayDeclare.toMillis()) {
    return zoned.toFormat("yyyy-MM-dd");
  }
  return zoned.plus({ days: 1 }).toFormat("yyyy-MM-dd");
}

/**
 * First Chicago date that may receive a daily engagement result.
 * Derived from durable poll rows (scheduled or posted), not process uptime.
 * yyyy-MM-dd strings compare lexicographically.
 */
export function firstEligibleDeclarationChicagoDate(pollChicagoDates: readonly string[]): string | null {
  let first: string | null = null;
  for (const date of pollChicagoDates) {
    if (first == null || date < first) first = date;
  }
  return first;
}

/** True when `chicagoDate` is on/after the first poll scoring date. No polls → never eligible. */
export function isEligibleEngagementDeclarationDate(
  chicagoDate: string,
  pollChicagoDates: readonly string[]
): boolean {
  const first = firstEligibleDeclarationChicagoDate(pollChicagoDates);
  return first != null && chicagoDate >= first;
}

/** Most recently reached 11 PM Chicago date (inclusive). */
export function latestDeclarationChicagoDate(now: Date): string {
  const zoned = DateTime.fromJSDate(now, { zone: "utc" }).setZone(ENGAGEMENT_TIMEZONE);
  const todayDeclare = zoned.set({
    hour: DECLARATION_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0
  });
  if (zoned.toMillis() >= todayDeclare.toMillis()) {
    return zoned.toFormat("yyyy-MM-dd");
  }
  return zoned.minus({ days: 1 }).toFormat("yyyy-MM-dd");
}

export function chicagoDateDiffDays(from: string, to: string): number {
  const start = DateTime.fromISO(from, { zone: ENGAGEMENT_TIMEZONE }).startOf("day");
  const end = DateTime.fromISO(to, { zone: ENGAGEMENT_TIMEZONE }).startOf("day");
  return Math.round(end.diff(start, "days").days);
}

export function addChicagoDays(chicagoDate: string, days: number): string {
  return DateTime.fromISO(chicagoDate, { zone: ENGAGEMENT_TIMEZONE }).plus({ days }).toFormat("yyyy-MM-dd");
}

export function declarationInstantForChicagoDate(chicagoDate: string): Date {
  return declarationInstantOn(chicagoDate);
}

export function firstDeclarationAfter(instant: Date): Date {
  const zoned = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(ENGAGEMENT_TIMEZONE);
  const todayDeclare = zoned.set({
    hour: DECLARATION_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0
  });
  if (zoned.toMillis() < todayDeclare.toMillis()) {
    return todayDeclare.toUTC().toJSDate();
  }
  return todayDeclare.plus({ days: 1 }).toUTC().toJSDate();
}

export function buildSlot(chicagoWallDate: string, hour: number): EngagementSlot {
  if (!isEngagementPostHour(hour)) {
    throw new Error(`Hour ${hour} is not an engagement post slot`);
  }
  const opensAt = pollOpensAt(chicagoWallDate, hour);
  const closesAt = pollClosesAt(opensAt);
  return {
    slotKey: engagementSlotKey(chicagoWallDate, hour),
    chicagoWallDate,
    hour,
    opensAt,
    closesAt,
    chicagoDate: scoringChicagoDateForInstant(closesAt)
  };
}

export function listSlotsInRange(from: Date, to: Date): EngagementSlot[] {
  const start = DateTime.fromJSDate(from, { zone: "utc" }).setZone(ENGAGEMENT_TIMEZONE).startOf("day").minus({ days: 1 });
  const end = DateTime.fromJSDate(to, { zone: "utc" }).setZone(ENGAGEMENT_TIMEZONE).startOf("day").plus({ days: 2 });
  const slots: EngagementSlot[] = [];
  for (let day = start; day <= end; day = day.plus({ days: 1 })) {
    const date = day.toFormat("yyyy-MM-dd");
    for (const hour of POLL_POST_HOURS) {
      const slot = buildSlot(date, hour);
      if (slot.closesAt.getTime() < from.getTime() - POLL_DURATION_MS) continue;
      if (slot.opensAt.getTime() > to.getTime()) continue;
      slots.push(slot);
    }
  }
  return slots;
}
