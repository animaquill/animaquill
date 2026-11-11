import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { agoText, durationText } from "./start-view.ts";

/** How the start page says when things were, and how long. */

const i18n = createInstance();
await i18n.init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  interpolation: { escapeValue: false },
});
const t = i18n.t;

/** 2026-11-10 14:08 where the tests run. */
const NOW = new Date(2026, 10, 10, 14, 8, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("how long ago", () => {
  const ago = (at: number) => agoText(at, NOW, t);

  it("says the last minute, minutes and hours of today", () => {
    expect(ago(NOW - 20_000)).toBe("刚刚");
    expect(ago(NOW - 3 * MINUTE)).toBe("3 分钟前");
    expect(ago(NOW - 59 * MINUTE)).toBe("59 分钟前");
    expect(ago(NOW - 2 * HOUR)).toBe("2 小时前");
    expect(ago(new Date(2026, 10, 10, 0, 5).getTime())).toBe("14 小时前");
  });

  it("says yesterday by the day, not by 24 hours", () => {
    // Late last evening is "yesterday", also when that is less than a day ago.
    expect(ago(new Date(2026, 10, 9, 23, 30).getTime())).toBe("昨天");
    expect(ago(new Date(2026, 10, 9, 0, 1).getTime())).toBe("昨天");
  });

  it("counts days within a week, and says the day after that", () => {
    expect(ago(new Date(2026, 10, 8, 20, 0).getTime())).toBe("2 天前");
    expect(ago(new Date(2026, 10, 4, 9, 0).getTime())).toBe("6 天前");
    expect(ago(new Date(2026, 10, 3, 9, 0).getTime())).toBe("11月3日");
    expect(ago(new Date(2025, 11, 31, 9, 0).getTime())).toBe("2025年12月31日");
  });

  it("never says that something is in the future, with a clock that is a little off", () => {
    expect(ago(NOW + 5 * MINUTE)).toBe("刚刚");
  });
});

describe("how long a timeline is", () => {
  it("says minutes and seconds, and hours where there are any", () => {
    expect(durationText(0)).toBe("0:00");
    expect(durationText(42_400)).toBe("0:42");
    expect(durationText(6 * 60_000 + 15_000)).toBe("6:15");
    expect(durationText(HOUR + 2 * MINUTE + 3_000)).toBe("1:02:03");
  });
});
