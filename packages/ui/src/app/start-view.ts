import type { TFunction } from "i18next";

/** How the start page says when things were, see `start/cards.ts` for what else it says. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const startOfDay = (at: number): number => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * How long ago something was, as people say it of a project: "刚刚", "3 分钟前", "2 小时前" for
 * today, "昨天", "3 天前" within a week, and the day after that, with the year where it is another.
 */
export function agoText(at: number, now: number, t: TFunction): string {
  const passed = now - at;
  // A clock that is a little off must not say "in the future".
  if (passed < MINUTE) return t("start.ago.now");
  const days = Math.round((startOfDay(now) - startOfDay(at)) / (24 * HOUR));
  if (days <= 0) {
    return passed < HOUR
      ? t("start.ago.minutes", { count: Math.floor(passed / MINUTE) })
      : t("start.ago.hours", { count: Math.floor(passed / HOUR) });
  }
  if (days === 1) return t("start.ago.yesterday");
  if (days < 7) return t("start.ago.days", { count: days });
  const when = new Date(at);
  const day = t("start.ago.day", { month: when.getMonth() + 1, day: when.getDate() });
  return when.getFullYear() === new Date(now).getFullYear()
    ? day
    : t("start.ago.dayOfYear", { year: when.getFullYear(), day });
}

/** How long a timeline is, as on a card: "0:42", "6:15", "1:02:03". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
