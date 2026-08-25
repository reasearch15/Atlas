import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import { LEADERBOARD_TIMEZONE } from "../leaderboard/leaderboard.constants";

export const ENGAGEMENT_TIMEZONE = LEADERBOARD_TIMEZONE;
export const POLL_DURATION_MS = 4 * 60 * 60 * 1000;
export const POLL_POST_HOURS = [6, 10, 14, 18, 22] as const;
export const DECLARATION_HOUR = 23;
export const QUIET_START_HOUR = 2;
export const QUIET_END_HOUR = 6;
export const PARTICIPATION_POINTS = 5;
export const WINNING_OPTION_POINTS = 10;
export const REFERRAL_START_POINTS = 50;
export const REFERRAL_STEP_POINTS = 10;
export const REFERRAL_FLOOR_POINTS = 20;
export const DAILY_PRIZES_CENTS = [500, 200, 100] as const;
export const TELEGRAM_QUESTION_MAX = 300;
export const TELEGRAM_BUTTON_MAX = 64;
export const ENGAGEMENT_CALLBACK_PREFIX = "eng:v:";
