import { DateTime } from "luxon";
import {
  COMPETITION_DURATION_DAYS,
  LEADERBOARD_EPOCH_ISO_CHICAGO,
  LEADERBOARD_TIMEZONE
} from "./leaderboard.constants";

export interface CompetitionWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly sequence: number;
}

/**
 * Converts a wall-clock Chicago instant to a UTC Date.
 */
export function chicagoWallTimeToUtc(isoLocal: string, zone = LEADERBOARD_TIMEZONE): Date {
  const dt = DateTime.fromISO(isoLocal, { zone });
  if (!dt.isValid) {
    throw new Error(`Invalid Chicago wall time: ${isoLocal} (${dt.invalidReason})`);
  }
  return dt.toUTC().toJSDate();
}

/**
 * Returns the biweekly competition window containing `now` (half-open [startsAt, endsAt)).
 * Sequence 0 starts at the documented Chicago epoch Tuesday 21:00.
 */
export function competitionWindowContaining(
  now: Date,
  zone = LEADERBOARD_TIMEZONE
): CompetitionWindow {
  const epoch = DateTime.fromISO(LEADERBOARD_EPOCH_ISO_CHICAGO, { zone });
  if (!epoch.isValid) {
    throw new Error(`Invalid leaderboard epoch: ${epoch.invalidReason}`);
  }
  const nowZoned = DateTime.fromJSDate(now, { zone: "utc" }).setZone(zone);
  const millis = nowZoned.toMillis() - epoch.toMillis();
  const windowMs = COMPETITION_DURATION_DAYS * 24 * 60 * 60 * 1000;
  let sequence = Math.floor(millis / windowMs);
  if (sequence < 0) sequence = 0;

  let starts = epoch.plus({ days: sequence * COMPETITION_DURATION_DAYS });
  let ends = starts.plus({ days: COMPETITION_DURATION_DAYS });

  // Guard against floating edge cases: ensure half-open membership.
  while (nowZoned < starts) {
    sequence -= 1;
    starts = epoch.plus({ days: sequence * COMPETITION_DURATION_DAYS });
    ends = starts.plus({ days: COMPETITION_DURATION_DAYS });
  }
  while (nowZoned >= ends) {
    sequence += 1;
    starts = epoch.plus({ days: sequence * COMPETITION_DURATION_DAYS });
    ends = starts.plus({ days: COMPETITION_DURATION_DAYS });
  }

  return {
    sequence,
    startsAt: starts.toUTC().toJSDate(),
    endsAt: ends.toUTC().toJSDate()
  };
}

/**
 * True when startsAt <= eventTime < endsAt.
 */
export function isInCompetitionWindow(eventTime: Date, startsAt: Date, endsAt: Date): boolean {
  const t = eventTime.getTime();
  return t >= startsAt.getTime() && t < endsAt.getTime();
}
