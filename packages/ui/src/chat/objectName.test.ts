import type { ProjectState } from "@animaquill/core";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { changeName } from "./objectName.ts";

const t = ((key: string, options?: { number?: number }) =>
  key === "chat.kinds.clip"
    ? "片段"
    : key === "timeline.track.video"
      ? `视频 ${options?.number}`
      : key) as unknown as TFunction;

const state = {
  timelines: {
    main: {
      name: "主时间轴",
      clips: {
        named: { id: "named", name: "标题", source: { kind: "color" } },
        scene: { id: "scene", source: { kind: "scene", scene: "s1" } },
        image: { id: "image", source: { kind: "image", media: { asset: "a1" } } },
        clip_fkm1z6hc78: { id: "clip_fkm1z6hc78", source: { kind: "color" } },
      },
      tracks: { v1: { id: "v1", kind: "video", order: 0 } },
      markers: { m1: { id: "m1", name: "AI" } },
      sections: {},
    },
  },
  scenes: { s1: { name: "开场" } },
  assets: { a1: { name: "海边.jpg" } },
  sounds: {},
} as unknown as ProjectState;

describe("what a change of a turn calls an object", () => {
  it("is its name, else what a clip shows, else 片段 and its number; never the inner id", () => {
    const named = (id: string) => changeName(t, { kind: "clip", id, timeline: "main" }, state);
    expect(named("named")).toBe("标题");
    expect(named("scene")).toBe("开场");
    expect(named("image")).toBe("海边.jpg");
    expect(named("clip_fkm1z6hc78")).toBe("片段 4");
    expect(changeName(t, { kind: "clip", id: "scene" }, state)).toBe("开场");
    expect(changeName(t, { kind: "marker", id: "m1", timeline: "main" }, state)).toBe("AI");
    // What the tool said wins; gone without a name is no name.
    expect(changeName(t, { kind: "clip", id: "gone", name: "旧的" }, state)).toBe("旧的");
    expect(changeName(t, { kind: "clip", id: "gone" }, state)).toBeUndefined();
  });
});
