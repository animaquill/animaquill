import type { TextTable } from "./table.ts";

/** The parts of the description of aq_edit around its list of operations, and its examples. */
export const EDIT_TEXTS = {
  /**
   * How the description lists the operations: "names", by what they change, one line each, with
   * the summary of each one in its branch of the schema; or "signatures", one line each with what
   * it takes and its summary, as toolset 2026.1 did.
   */
  "edit.list": "names",
  "edit.operationsHeading":
    'Operations, by what they change. Each operation\'s parameters are in the schema; aq_guide topic "ops/<operation>" has its full page with examples.',
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
      {
        op: "property.edit",
        timeline: "main",
        edits: [
          {
            owner: { clip: "clip_title2" },
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
  ],
} satisfies TextTable;
