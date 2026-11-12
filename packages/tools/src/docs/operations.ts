import type { AiOperationName } from "@animaquill/core";

/**
 * What AI reads about each operation of aq_edit, in English: a line for the list of operations, and
 * examples, the first the simplest. The ids of examples come from the sample project
 * (packages/schema/fixtures/v1), and each one runs on it: the tests hold them to that. Longer
 * descriptions, words for each parameter and hints for errors follow with the manual.
 */
export interface OperationExample {
  readonly title: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface OperationDoc {
  /** One line, for the list of operations in the description of aq_edit. */
  readonly summary: string;
  readonly examples: readonly OperationExample[];
}

const COLOR = { kind: "color", color: "#3366ff" };

export const OPERATION_DOCS: { readonly [N in AiOperationName]: OperationDoc } = {
  "project.rename": {
    summary: "rename the project",
    examples: [{ title: "Rename the project", params: { name: "What atoms are" } }],
  },
  "project.setFrameRate": {
    summary: "set the frame rate the timeline counts frames by",
    examples: [{ title: "Count 25 frames a second", params: { fps: "25" } }],
  },
  "asset.update": {
    summary: "rename an asset or change its tags",
    examples: [
      {
        title: "Rename an asset",
        params: { asset: "interview", changes: { name: "Interview, take 2" } },
      },
    ],
  },
  "asset.remove": {
    summary: "remove an asset, and with withUses the clips that use it",
    examples: [
      { title: "Remove an asset and its clips", params: { asset: "raw-footage", withUses: true } },
    ],
  },
  "scene.add": {
    summary: "create a scene (HTML, CSS and JavaScript that draw a picture) with its files",
    examples: [
      {
        title: "Create a scene",
        params: {
          id: "lower_third",
          manifest: { name: "Lower third", entry: "index.html", runtime: 1 },
          files: { "index.html": "<!doctype html><h1>Name</h1>" },
        },
      },
    ],
  },
  "scene.update": {
    summary: "change the manifest of a scene: name, entry, params, presets",
    examples: [
      { title: "Rename a scene", params: { scene: "title", changes: { name: "Opening title" } } },
    ],
  },
  "scene.remove": {
    summary: "remove a scene and its files, and with withUses the clips that use it",
    examples: [
      { title: "Remove a scene and its clips", params: { scene: "title", withUses: true } },
    ],
  },
  "sound.add": {
    summary: "create a sound made by code, with its files",
    examples: [
      {
        title: "Create a sound",
        params: {
          id: "whoosh",
          manifest: { name: "Whoosh", entry: "sound.js", runtime: 1 },
          files: { "sound.js": "export default () => {};" },
        },
      },
    ],
  },
  "sound.update": {
    summary: "change the manifest of a sound: name, entry, params, outputs",
    examples: [
      { title: "Rename a sound", params: { sound: "impacts", changes: { name: "Hits" } } },
    ],
  },
  "sound.remove": {
    summary: "remove a sound and its files, and with withUses the clips that use it",
    examples: [
      { title: "Remove a sound and its clips", params: { sound: "impacts", withUses: true } },
    ],
  },
  "source.replace": {
    summary: "make every clip that uses an asset, scene or sound use another one of the same kind",
    examples: [
      {
        title: "Use another asset",
        params: { kind: "asset", from: "narration-zh", to: "narration-en" },
      },
    ],
  },
  "file.remove": {
    summary: "remove a code file that is no entry",
    examples: [{ title: "Remove a file", params: { path: "code/animate.js" } }],
  },
  "file.rename": {
    summary: "rename or move a code file",
    examples: [
      { title: "Rename a file", params: { from: "code/animate.js", to: "code/motion.js" } },
    ],
  },
  "timeline.rename": {
    summary: "rename a timeline",
    examples: [{ title: "Rename a timeline", params: { timeline: "main", name: "Main cut" } }],
  },
  "section.add": {
    summary: "add a section to a timeline, which makes it longer",
    examples: [
      {
        title: "Add a section at the end",
        params: { timeline: "main", duration: "4", name: "Credits" },
      },
    ],
  },
  "section.update": {
    summary: "change the duration or name of a section",
    examples: [
      {
        title: "Make a section longer",
        params: { timeline: "main", section: "section_intro", duration: "6" },
      },
    ],
  },
  "section.remove": {
    summary: "remove a section; a timeline keeps at least one",
    examples: [{ title: "Remove a section", params: { timeline: "main", section: "section_end" } }],
  },
  "track.add": {
    summary: "add a video, audio or caption track",
    examples: [
      {
        title: "Add a video track on top",
        params: { timeline: "main", kind: "video", name: "Titles" },
      },
    ],
  },
  "track.update": {
    summary: "change the name, hidden, muted, solo, locked, group or role of a track",
    examples: [
      {
        title: "Mute a track",
        params: { timeline: "main", track: "track_music", changes: { muted: true } },
      },
    ],
  },
  "track.move": {
    summary: "move a track before another one, or last",
    examples: [
      { title: "Move a track to the top", params: { timeline: "main", track: "track_overlay" } },
    ],
  },
  "track.remove": {
    summary: "remove a track with all its clips",
    examples: [{ title: "Remove a track", params: { timeline: "main", track: "track_overlay" } }],
  },
  "clip.add": {
    summary: "put a clip on a track: an asset, a scene, a sound, a color or a caption",
    examples: [
      {
        title: "Put a color clip on a track",
        params: {
          timeline: "main",
          track: "track_overlay",
          start: "0",
          duration: "3",
          source: COLOR,
        },
      },
    ],
  },
  "clip.remove": {
    summary: "remove clips",
    examples: [{ title: "Remove a clip", params: { timeline: "main", clips: ["clip_idea"] } }],
  },
  "clip.update": {
    summary: "change the name, source, offset, loop, hidden, draft, link or section fit of a clip",
    examples: [
      {
        title: "Rename a clip",
        params: { timeline: "main", clip: "clip_title", changes: { name: "Opening" } },
      },
    ],
  },
  "clip.setTransition": {
    summary:
      "put a transition at the start (enter) or end (exit) of a clip, or take it away with null",
    examples: [
      {
        title: "Fade a clip out",
        params: {
          timeline: "main",
          clip: "clip_interview",
          exit: { type: "fade", duration: "0.5" },
        },
      },
    ],
  },
  "clip.move": {
    summary: "move clips to other starts or tracks, in one step",
    examples: [
      {
        title: "Move a clip later",
        params: { timeline: "main", clips: [{ clip: "clip_idea", start: "11" }] },
      },
    ],
  },
  "clip.trim": {
    summary: "move the start or end of a clip; what it shows stays in place",
    examples: [
      {
        title: "End a clip earlier",
        params: { timeline: "main", clip: "clip_interview", end: "15" },
      },
    ],
  },
  "clip.split": {
    summary: "cut a clip in two at a moment of the timeline",
    examples: [
      { title: "Cut a clip", params: { timeline: "main", clip: "clip_interview", at: "10" } },
    ],
  },
  "join.add": {
    summary: "put a transition on the cut between two clips that touch",
    examples: [
      {
        title: "Cross-fade between two clips",
        params: { timeline: "main", from: "clip_interview", to: "clip_logo", type: "fade" },
      },
    ],
  },
  "join.update": {
    summary: "change the type, duration, align, curve or values of a join",
    examples: [
      {
        title: "Make a join longer",
        params: { timeline: "main", join: "join_1", changes: { duration: "1.5" } },
      },
    ],
  },
  "join.remove": {
    summary: "remove joins",
    examples: [{ title: "Remove a join", params: { timeline: "main", joins: ["join_1"] } }],
  },
  "effect.add": {
    summary: "put an effect on a clip, with the values of its parameters",
    examples: [
      {
        title: "Blur a clip",
        params: { timeline: "main", clip: "clip_title", type: "blur", values: { radius: 8 } },
      },
    ],
  },
  "effect.remove": {
    summary: "take effects off a clip",
    examples: [
      {
        title: "Take an effect off",
        params: { timeline: "main", clip: "clip_interview", effects: ["fx_blur"] },
      },
    ],
  },
  "effect.move": {
    summary: "move an effect in the list of its clip, which changes what it works on",
    examples: [
      {
        title: "Make an effect work first",
        params: { timeline: "main", clip: "clip_interview", effect: "fx_grade", index: 0 },
      },
    ],
  },
  "effect.update": {
    summary: "turn an effect on or off, or change when it works",
    examples: [
      {
        title: "Turn an effect off",
        params: { timeline: "main", clip: "clip_interview", effect: "fx_blur", enabled: false },
      },
    ],
  },
  "property.edit": {
    summary: "set properties of clips and their keyframes, in one step",
    examples: [
      {
        title: "Fade a property in with two keyframes",
        params: {
          timeline: "main",
          edits: [
            {
              owner: { clip: "clip_title" },
              path: "opacity",
              op: "set",
              value: {
                keys: [
                  { time: "0", value: 0 },
                  { time: "1", value: 1 },
                ],
              },
            },
          ],
        },
      },
    ],
  },
  "property.rename": {
    summary:
      "give properties of a clip another path, with their keyframes, after code renamed what they are about",
    examples: [
      {
        title: "Rename a property",
        params: {
          timeline: "main",
          renames: [{ owner: { clip: "clip_title" }, from: "param.size", to: "param.fontSize" }],
        },
      },
    ],
  },
  "marker.add": {
    summary: "add a marker to a timeline",
    examples: [{ title: "Mark a moment", params: { timeline: "main", time: "12", name: "Drop" } }],
  },
  "marker.update": {
    summary: "change the time, name, note, color or duration of a marker",
    examples: [
      {
        title: "Move a marker",
        params: { timeline: "main", marker: "marker_turn", changes: { time: "6" } },
      },
    ],
  },
  "marker.remove": {
    summary: "remove a marker",
    examples: [{ title: "Remove a marker", params: { timeline: "main", marker: "marker_hook" } }],
  },
};
