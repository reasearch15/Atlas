import { LEADERBOARD_TIMEZONE } from "../leaderboard.constants";

/**
 * Formats competition `endsAt` for Telegram copy.
 * Always includes weekday + abbreviated month + day + time + timezone (CDT/CST).
 * Includes the year when the end year differs from `now` in the same zone.
 *
 * Example: `Tuesday, Aug 26 at 9:00 PM CDT`
 * Year boundary: `Tuesday, Jan 6, 2027 at 9:00 PM CST`
 */
export function formatCompetitionEndDisplay(
  endsAt: Date,
  timezone: string = LEADERBOARD_TIMEZONE,
  options?: { readonly now?: Date }
): string {
  const zone = timezone?.trim() || LEADERBOARD_TIMEZONE;
  const now = options?.now ?? new Date();

  try {
    const includeYear = yearInZone(endsAt, zone) !== yearInZone(now, zone);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "long",
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" as const } : {}),
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short"
    }).formatToParts(endsAt);

    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? "";

    const weekday = get("weekday");
    const month = get("month");
    const day = get("day");
    const year = get("year");
    const hour = get("hour");
    const minute = get("minute");
    const dayPeriod = get("dayPeriod");
    const timeZoneName = get("timeZoneName");

    if (!weekday || !month || !day || !hour || !minute || !dayPeriod || !timeZoneName) {
      throw new Error("Incomplete competition end display parts");
    }

    const dateCore =
      includeYear && year
        ? `${weekday}, ${month} ${day}, ${year}`
        : `${weekday}, ${month} ${day}`;

    return `${dateCore} at ${hour}:${minute} ${dayPeriod} ${timeZoneName}`;
  } catch {
    return "Tuesday 9 PM Texas time";
  }
}

function yearInZone(instant: Date, zone: string): number {
  const year = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric"
  }).format(instant);
  return Number(year);
}
