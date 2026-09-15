import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import { LEADERBOARD_TIMEZONE } from "../leaderboard/leaderboard.constants";

export const ENGAGEMENT_TIMEZONE = LEADERBOARD_TIMEZONE;
export const POLL_DURATION_MS = 4 * 60 * 60 * 1000;
export const POLL_POST_HOURS = [6, 18] as const;
export const DECLARATION_HOUR = 23;
export const QUIET_START_HOUR = 2;
export const QUIET_END_HOUR = 6;
export const PARTICIPATION_POINTS = 5;
export const WINNING_OPTION_POINTS = 10;
export const REFERRAL_START_POINTS = 50;
export const REFERRAL_STEP_POINTS = 10;
/** Legacy poll-ranking floor. Daily Freeplay draw weights use DRAW_REFERRAL_FLOOR_WEIGHT = 0. */
export const REFERRAL_FLOOR_POINTS = 20;
/** Disabled: old poll-based Top 3 $5/$2/$1. Kept only so historical tests can name the amounts. */
export const DAILY_PRIZES_CENTS = [500, 200, 100] as const;
/** Every eligible registered subscriber gets this draw weight, including zero-referral players. */
export const DRAW_BASE_WEIGHT = 10;
export const DRAW_REFERRAL_START_WEIGHT = 50;
export const DRAW_REFERRAL_STEP_WEIGHT = 10;
export const DRAW_REFERRAL_FLOOR_WEIGHT = 0;
/** Winner is ineligible for the next N daily draws after a win (rolling Chicago-date window). */
export const DRAW_WINNER_COOLDOWN_DRAWS = 7;
export const DAILY_DRAW_PRIZE_CENTS = 500;
export const TELEGRAM_QUESTION_MAX = 300;
export const TELEGRAM_BUTTON_MAX = 64;
export const ENGAGEMENT_CALLBACK_PREFIX = "eng:v:";
/** Channel keeps at most this many native engagement poll sets visible (header + poll). */
export const VISIBLE_NATIVE_POLL_LIMIT = 3;
/** Skip this many recently used header themes when rotating glitter lines. */
export const POLL_HEADER_RECENT_THEME_LIMIT = 3;
