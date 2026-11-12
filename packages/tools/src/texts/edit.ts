import type { TextTable } from "./table.ts";

/** The parts of the description of aq_edit around its list of operations, and its examples. */
export const EDIT_TEXTS = {
  "edit.operationsHeading":
    'Operations (every parameter, result and more examples: aq_guide topic "ops/<operation>"):',
  "edit.examplesHeading":
    "Examples of operations (illustrative; their ids come from a sample project, not from the open one):",
  "edit.examples": [
    [
      {
        op: "clip.add",
        timeline: "main",
        track: "track_video",
        id: "clip_title2",
        start: "31",
        duration: "4",
        source: { kind: "scene", scene: "title" },
      },
    ],
    [
      {
        op: "clip.move",
        timeline: "main",
        clips: [
          { clip: "clip_lottie", start: "7" },
          { clip: "clip_idea", start: "12" },
        ],
      },
    ],
    [
      {
        op: "clip.setTransition",
        timeline: "main",
        clip: "clip_logo",
        enter: { type: "fade", duration: "0.5" },
      },
    ],
    [
      {
        op: "property.edit",
        timeline: "main",
        edits: [
          {
            owner: { clip: "clip_title" },
            path: "transform.y",
            op: "set",
            value: {
              keys: [
                { time: "0", value: -200 },
                { time: "0.6", value: 0 },
              ],
            },
          },
        ],
      },
    ],
    [{ op: "clip.remove", timeline: "main", clips: ["clip_idea"] }],
    [
      {
        op: "scene.add",
        id: "lower_third",
        manifest: { name: "Lower third", entry: "index.html", runtime: 1 },
        files: { "index.html": "<!doctype html><p>Name</p>" },
      },
      {
        op: "clip.add",
        timeline: "main",
        track: "track_overlay",
        start: "0",
        duration: "4",
        source: { kind: "scene", scene: "lower_third" },
      },
    ],
  ],
} satisfies TextTable;
