import type { ProjectState } from "@animaquill/core";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { findIn } from "./find.ts";

const t = ((key: string, options?: { name?: string; time?: string }) => {
  const kinds: Record<string, string> = {
    "chat.refs.clip": "片段",
    "chat.refs.caption": "字幕",
    "chat.refs.asset": "素材",
    "chat.refs.scene": "场景",
    "chat.refs.sound": "声音",
    "chat.refs.marker": "标记",
  };
  if (key === "chat.refs.markerAt") return `标记 ${options?.time}`;
  if (kinds[key]) return `${kinds[key]}「${options?.name}」`;
  if (key === "timeline.kind.color") return "纯色";
  return key;
}) as unknown as TFunction;

const clip = (id: string, start: string, extra: object) => ({
  id,
  track: "v1",
  start,
  duration: "1",
  ...extra,
});

const state = {
  manifest: { timelines: ["main", "other"] },
  timelines: {
    main: {
      name: "主时间轴",
      clips: {
        late: clip("late", "9", { name: "城市夜景", source: { kind: "color", color: "#000" } }),
        early: clip("early", "1", { name: "老城市", source: { kind: "color", color: "#000" } }),
        cap: clip("cap", "2", { source: { kind: "caption", text: "欢迎来到这座城市" } }),
        pic: clip("pic", "3", { source: { kind: "image", media: { asset: "a1" } } }),
        plain: clip("plain", "4", { source: { kind: "color", color: "#fff" } }),
      },
      tracks: {},
      markers: {
        m1: { id: "m1", time: "65", name: "高潮" },
        m2: { id: "m2", time: "5" },
      },
      sections: {},
      overrides: {},
    },
    other: {
      name: "另一条",
      clips: { far: clip("far", "0", { name: "城市远景", source: { kind: "color" } }) },
      tracks: {},
      markers: {},
      sections: {},
      overrides: {},
    },
  },
  assets: { a1: { name: "海边.jpg" }, a2: { name: "城市.mp4" } },
  scenes: { s1: { name: "片头" } },
  sounds: { so1: { name: "鼓点" } },
} as unknown as ProjectState;

/**
 * `@` in the input box looks through the whole project with each key that settles: thousands of
 * clips stay a few milliseconds. The limit leaves room for a busy machine, to catch a step back of
 * ten times, such as making the label of every clip.
 */
describe("what @ finds, in a big project", () => {
  it("looks through thousands of clips in a few milliseconds", () => {
    const many = Object.fromEntries(
      Array.from({ length: 5000 }, (_, at) => [
        `c${at}`,
        clip(`c${at}`, String(at), {
          name: at % 7 === 0 ? `镜头 ${at}` : undefined,
          source:
            at % 2 === 0
              ? { kind: "image", media: { asset: "a1" } }
              : { kind: "caption", text: `第 ${at} 句字幕` },
        }),
      ]),
    );
    const big = {
      ...state,
      timelines: { ...state.timelines, main: { ...state.timelines.main, clips: many } },
    } as unknown as ProjectState;
    findIn(big, "", { t, shown: "main", limit: 50 });
    const started = performance.now();
    for (const query of ["", "镜", "镜头 4", "字幕", "海"]) {
      findIn(big, query, { t, shown: "main", limit: 50 });
    }
    // Five looks; each is one key with the menu open.
    expect((performance.now() - started) / 5).toBeLessThan(25);
  });
});
