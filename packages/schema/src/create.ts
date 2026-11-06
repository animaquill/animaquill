import { newId } from "./basics.ts";
import type { Project } from "./project.ts";
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

const NEW_TIMELINE_SECONDS = "10";

/** What a new project starts with: one timeline, one track of each kind, one empty section. */
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
    timelines: new Map([
      [
        "main",
        {
          document: {
            name: "主线",
            sections: [{ id: newId("section"), duration: NEW_TIMELINE_SECONDS }],
            tracks: [
              { id: newId("track"), kind: "video", clips: [] },
              { id: newId("track"), kind: "audio", clips: [] },
            ],
          },
          overrides: new Map(),
        },
      ],
    ]),
    scenes: new Map(),
    sounds: new Map(),
    locales: new Map(),
  };
}
