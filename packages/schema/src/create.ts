import { newId } from "./basics.ts";
import { ProjectFormat } from "./documents.ts";
import type { Project } from "./project.ts";
import type { Timeline } from "./timeline.ts";
import { CURRENT_FORMAT_VERSION } from "./version.ts";

export interface NewProject {
  readonly name: string;
  readonly language?: { readonly id: string; readonly name: string };
  readonly format?: {
    readonly id: string;
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly fps: string;
  };
}

/** The shapes a new project can be made in, with the size of each, see `newFormat`. */
export const FORMAT_SHAPES = {
  landscape: { name: "横屏", width: 1920, height: 1080 },
  portrait: { name: "竖屏", width: 1080, height: 1920 },
  square: { name: "方形", width: 1080, height: 1080 },
} as const;

export type FormatShape = keyof typeof FORMAT_SHAPES | "custom";

/** The frame rates a new project can be made at. */
export const NEW_FRAME_RATES = ["30", "60"] as const;

/**
 * The first format of a new project, see `NewProject.format`: one of `FORMAT_SHAPES`, or a size of
 * people's own ("custom"). Undefined where the format of a project does not take it, as for a
 * width that is no positive whole number: checked by the same rules as every project.
 */
export function newFormat(
  shape: FormatShape,
  fps: string,
  size?: { readonly width: number; readonly height: number },
): NonNullable<NewProject["format"]> | undefined {
  const known = shape === "custom" ? undefined : FORMAT_SHAPES[shape];
  const width = known?.width ?? size?.width;
  const height = known?.height ?? size?.height;
  const format = { id: shape, name: known?.name ?? "自定义", width, height, fps };
  const checked = ProjectFormat.safeParse(format);
  return checked.success
    ? { id: shape, name: format.name, width: checked.data.width, height: checked.data.height, fps }
    : undefined;
}

const NEW_TIMELINE_SECONDS = "10";

/** What a new timeline starts with: one track of each kind, one empty section. */
export const createTimeline = (name: string): Timeline => ({
  name,
  sections: [{ id: newId("section"), duration: NEW_TIMELINE_SECONDS }],
  tracks: [
    { id: newId("track"), kind: "video", clips: [] },
    { id: newId("track"), kind: "audio", clips: [] },
  ],
});

/** What a new project starts with: one timeline with nothing on it. */
export function createProject({ name, language, format }: NewProject): Project {
  const firstFormat = format ?? {
    id: "landscape",
    name: "横屏",
    width: 1920,
    height: 1080,
    fps: "30",
  };
  return {
    manifest: {
      formatVersion: CURRENT_FORMAT_VERSION,
      id: newId("project"),
      name,
      languages: [language ?? { id: "zh-CN", name: "中文" }],
      fps: firstFormat.fps,
      formats: [firstFormat],
      timelines: ["main"],
    },
    timelines: new Map([["main", { document: createTimeline("主线"), overrides: new Map() }]]),
    scenes: new Map(),
    sounds: new Map(),
    locales: new Map(),
  };
}
