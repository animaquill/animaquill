import type { TextTable } from "../table.ts";

/**
 * Other ways to say what the default words say, where nothing measured yet tells which works better:
 * each one changes a few keys of the default table, and an evaluation with real models compares it
 * with the default (6.17). Only for tests and evaluations; no conversation uses them.
 */
export const ALTERNATIVES: Readonly<
  Record<string, { readonly about: string; readonly texts: TextTable }>
> = {
  "examples-of-the-plan": {
    about:
      "The two examples of aq_edit that the plan named (a clip of a scene; clips moved), where the default puts keyframes on the new clip in the same batch: keyframe times written as numbers were the mistake the review of hand-written tasks found most.",
    texts: {
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
      ],
    },
  },
  "signatures-in-the-list": {
    about:
      "aq_edit lists its operations with their signatures and summaries, as toolset 2026.2 did, in place of their names by group with the summaries in the schema. Its description is then longer than the 4,000 characters Claude Code loads, so only the browser can use it.",
    texts: { "edit.list": "signatures" },
  },
};
