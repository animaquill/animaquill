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

const find = (query: string, shown: string | undefined = "main", limit = 5) =>
  findIn(state, query, { t, shown, limit });

describe("what @ finds", () => {
  it("is by name, any case, anywhere in it: clips, assets, scenes, sounds, markers, in that order", () => {
    expect(find("").map((group) => group.kind)).toEqual([
      "clip",
      "asset",
      "scene",
      "sound",
      "marker",
    ]);
    const city = find("城市");
    expect(city.map((group) => group.kind)).toEqual(["clip", "asset"]);
    // Names that start with it first; then the timeline shown, by time, then the others.
    expect(city[0]?.refs.map((ref) => ref.label)).toEqual([
      "片段「城市夜景」",
      "片段「城市远景」",
      "片段「老城市」",
      "字幕「欢迎来到这座城市」",
    ]);
    expect(city[0]?.refs[0]?.href).toBe("aq://object/late?timeline=main");
    expect(city[0]?.refs[1]?.href).toBe("aq://object/far?timeline=other");
    expect(city[1]?.refs).toEqual([{ label: "素材「城市.mp4」", href: "aq://object/a2" }]);
    expect(find("JPG").map((group) => group.kind)).toEqual(["clip", "asset"]);
  });

  it("finds a clip by what it shows or its kind, a marker by its name or its time", () => {
    expect(find("海边").map((group) => [group.kind, group.refs.map((ref) => ref.label)])).toEqual([
      ["clip", ["片段「海边.jpg」"]],
      ["asset", ["素材「海边.jpg」"]],
    ]);
    expect(find("纯色")[0]?.refs.map((ref) => ref.href)).toEqual([
      "aq://object/plain?timeline=main",
    ]);
    expect(find("").find((group) => group.kind === "marker")?.refs).toEqual([
      { label: "标记 0:05", href: "aq://object/m2?timeline=main" },
      { label: "标记「高潮」", href: "aq://object/m1?timeline=main" },
    ]);
  });

  it("gives the first few of each kind, and how many there are in all", () => {
    const clips = find("", "main", 2)[0];
    expect(clips?.refs).toHaveLength(2);
    expect(clips?.total).toBe(6);
    expect(find("没有这个")).toEqual([]);
  });
});
