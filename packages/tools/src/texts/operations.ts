import type { TextTable } from "./table.ts";

/**
 * What AI reads about each operation of aq_edit: a line for the list of operations, examples (the
 * first the simplest; their ids come from the sample project, packages/schema/fixtures/v1, and each
 * one runs on it, the tests hold them to that), and words for a parameter where it means something
 * else in this operation than `PARAM_TEXTS` says.
 */
export const OPERATION_TEXTS = {
  "ops.project.rename.summary": "rename the project",
  "ops.project.rename.examples": [
    { title: "Rename the project", params: { name: "What atoms are" } },
  ],
  "ops.project.setFrameRate.summary": "set the frame rate the timeline counts frames by",
  "ops.project.setFrameRate.examples": [
    { title: "Count 25 frames a second", params: { fps: "25" } },
  ],
  "ops.asset.update.summary": "rename an asset or change its tags",
  "ops.asset.update.examples": [
    {
      title: "Rename an asset",
      params: { asset: "interview", changes: { name: "Interview, take 2" } },
    },
  ],
  "ops.asset.remove.summary": "remove an asset, and with withUses the clips that use it",
  "ops.asset.remove.examples": [
    { title: "Remove an asset and its clips", params: { asset: "raw-footage", withUses: true } },
  ],
  "ops.scene.add.summary":
    "create a scene (HTML, CSS and JavaScript that draw a picture) with its files",
  "ops.scene.add.examples": [
    {
      title: "Create a scene",
      params: {
        id: "lower_third",
        manifest: { name: "Lower third", entry: "index.html", runtime: 1 },
        files: { "index.html": "<!doctype html><h1>Name</h1>" },
      },
    },
  ],
  "ops.scene.update.summary": "change the manifest of a scene: name, entry, params, presets",
  "ops.scene.update.examples": [
    { title: "Rename a scene", params: { scene: "title", changes: { name: "Opening title" } } },
  ],
  "ops.scene.update.params.changes": "The fields of the SceneManifest to change; the rest stay.",
  "ops.scene.remove.summary":
    "remove a scene and its files, and with withUses the clips that use it",
  "ops.scene.remove.examples": [
    { title: "Remove a scene and its clips", params: { scene: "title", withUses: true } },
  ],
  "ops.sound.add.summary": "create a sound made by code, with its files",
  "ops.sound.add.examples": [
    {
      title: "Create a sound",
      params: {
        id: "whoosh",
        manifest: { name: "Whoosh", entry: "sound.js", runtime: 1 },
        files: { "sound.js": "export default () => {};" },
      },
    },
  ],
  "ops.sound.update.summary": "change the manifest of a sound: name, entry, params, outputs",
  "ops.sound.update.examples": [
    { title: "Rename a sound", params: { sound: "impacts", changes: { name: "Hits" } } },
  ],
  "ops.sound.update.params.changes": "The fields of the SoundManifest to change; the rest stay.",
  "ops.sound.remove.summary":
    "remove a sound and its files, and with withUses the clips that use it",
  "ops.sound.remove.examples": [
    { title: "Remove a sound and its clips", params: { sound: "impacts", withUses: true } },
  ],
  "ops.source.replace.summary":
    "make every clip that uses an asset, scene or sound use another one of the same kind",
  "ops.source.replace.examples": [
    {
      title: "Use another asset",
      params: { kind: "asset", from: "narration-zh", to: "narration-en" },
    },
  ],
  "ops.source.replace.params.kind": '"asset", "scene" or "sound".',
  "ops.source.replace.params.from": "Id of what clips use now.",
  "ops.source.replace.params.to": "Id to use instead, same kind.",
  "ops.file.remove.summary": "remove a code file that is no entry",
  "ops.file.remove.examples": [{ title: "Remove a file", params: { path: "code/animate.js" } }],
  "ops.file.rename.summary": "rename or move a code file",
  "ops.file.rename.examples": [
    { title: "Rename a file", params: { from: "code/animate.js", to: "code/motion.js" } },
  ],
  "ops.file.rename.params.from": "Path now.",
  "ops.file.rename.params.to": "New path.",
  "ops.timeline.rename.summary": "rename a timeline",
  "ops.timeline.rename.examples": [
    { title: "Rename a timeline", params: { timeline: "main", name: "Main cut" } },
  ],
  "ops.section.add.summary": "add a section to a timeline, which makes it longer",
  "ops.section.add.examples": [
    {
      title: "Add a section at the end",
      params: { timeline: "main", duration: "4", name: "Credits" },
    },
  ],
  "ops.section.update.summary": "change the duration or name of a section",
  "ops.section.update.examples": [
    {
      title: "Make a section longer",
      params: { timeline: "main", section: "section_intro", duration: "6" },
    },
  ],
  "ops.section.remove.summary": "remove a section; a timeline keeps at least one",
  "ops.section.remove.examples": [
    { title: "Remove a section", params: { timeline: "main", section: "section_end" } },
  ],
  "ops.track.add.summary": "add a video, audio or caption track",
  "ops.track.add.examples": [
    {
      title: "Add a video track on top",
      params: { timeline: "main", kind: "video", name: "Titles" },
    },
  ],
  "ops.track.add.params.kind": '"video", "audio" or "caption".',
  "ops.track.update.summary":
    "change the name, hidden, muted, solo, locked, group or role of a track",
  "ops.track.update.examples": [
    {
      title: "Mute a track",
      params: { timeline: "main", track: "track_music", changes: { muted: true } },
    },
  ],
  "ops.track.move.summary": "move a track before another one, or last",
  "ops.track.move.examples": [
    { title: "Move a track to the top", params: { timeline: "main", track: "track_overlay" } },
  ],
  "ops.track.remove.summary": "remove a track with all its clips",
  "ops.track.remove.examples": [
    { title: "Remove a track", params: { timeline: "main", track: "track_overlay" } },
  ],
  "ops.clip.add.summary": "put a clip on a track: an asset, a scene, a sound, a color or a caption",
  "ops.clip.add.examples": [
    {
      title: "Put a color clip on a track",
      params: {
        timeline: "main",
        track: "track_overlay",
        start: "0",
        duration: "3",
        source: { kind: "color", color: "#3366ff" },
      },
    },
  ],
  "ops.clip.add.params.enter": "Transition at its start.",
  "ops.clip.add.params.exit": "Transition at its end.",
  "ops.clip.remove.summary": "remove clips",
  "ops.clip.remove.examples": [
    { title: "Remove a clip", params: { timeline: "main", clips: ["clip_idea"] } },
  ],
  "ops.clip.update.summary":
    "change the name, source, offset, loop, hidden, draft, link or section fit of a clip",
  "ops.clip.update.examples": [
    {
      title: "Rename a clip",
      params: { timeline: "main", clip: "clip_title", changes: { name: "Opening" } },
    },
  ],
  "ops.clip.setTransition.summary":
    "put a transition at the start (enter) or end (exit) of a clip, or take it away with null",
  "ops.clip.setTransition.examples": [
    {
      title: "Fade a clip out",
      params: { timeline: "main", clip: "clip_interview", exit: { type: "fade", duration: "0.5" } },
    },
  ],
  "ops.join.add.summary": "put a transition on the cut between two clips that touch",
  "ops.join.add.examples": [
    {
      title: "Cross-fade between two clips",
      params: { timeline: "main", from: "clip_interview", to: "clip_logo", type: "fade" },
    },
  ],
  "ops.join.add.params.from": "Clip id before the cut.",
  "ops.join.add.params.to": "Clip id after the cut, starting where the first ends.",
  "ops.join.add.params.duration": "Length, seconds; leave out for as much as fits.",
  "ops.effect.add.summary": "put an effect on a clip, with the values of its parameters",
  "ops.effect.add.examples": [
    {
      title: "Blur a clip",
      params: { timeline: "main", clip: "clip_title", type: "blur", values: { radius: 8 } },
    },
  ],
  "ops.effect.add.params.start": "Seconds from the clip's start.",
  "ops.effect.add.params.end": "Seconds from the clip's start.",
  "ops.effect.remove.summary": "take effects off a clip",
  "ops.effect.remove.examples": [
    {
      title: "Take an effect off",
      params: { timeline: "main", clip: "clip_interview", effects: ["fx_blur"] },
    },
  ],
  "ops.effect.remove.params.effects": "Effect ids of the clip.",
  "ops.effect.move.summary":
    "move an effect in the list of its clip, which changes what it works on",
  "ops.effect.move.examples": [
    {
      title: "Make an effect work first",
      params: { timeline: "main", clip: "clip_interview", effect: "fx_grade", index: 0 },
    },
  ],
  "ops.effect.update.summary": "turn an effect on or off, or change when it works",
  "ops.effect.update.examples": [
    {
      title: "Turn an effect off",
      params: { timeline: "main", clip: "clip_interview", effect: "fx_blur", enabled: false },
    },
  ],
  "ops.effect.update.params.start": "Seconds from the clip's start; null for its start.",
  "ops.effect.update.params.end": "Seconds from the clip's start; null for its end.",
  "ops.join.update.summary": "change the type, duration, align, curve or values of a join",
  "ops.join.update.examples": [
    {
      title: "Make a join longer",
      params: { timeline: "main", join: "join_1", changes: { duration: "1.5" } },
    },
  ],
  "ops.join.remove.summary": "remove joins",
  "ops.join.remove.examples": [
    { title: "Remove a join", params: { timeline: "main", joins: ["join_1"] } },
  ],
  "ops.clip.move.summary": "move clips to other starts or tracks, in one step",
  "ops.clip.move.examples": [
    {
      title: "Move a clip later",
      params: { timeline: "main", clips: [{ clip: "clip_idea", start: "11" }] },
    },
  ],
  "ops.clip.move.params.clips": 'Each {"clip":id,"start"?,"track"?}.',
  "ops.clip.trim.summary": "move the start or end of a clip; what it shows stays in place",
  "ops.clip.trim.examples": [
    {
      title: "End a clip earlier",
      params: { timeline: "main", clip: "clip_interview", end: "15" },
    },
  ],
  "ops.clip.trim.params.start": "New start; what it shows stays put.",
  "ops.clip.trim.params.end": "New end.",
  "ops.clip.split.summary": "cut a clip in two at a moment of the timeline",
  "ops.clip.split.examples": [
    { title: "Cut a clip", params: { timeline: "main", clip: "clip_interview", at: "10" } },
  ],
  "ops.property.edit.summary": "set properties of clips and their keyframes, in one step",
  "ops.property.edit.examples": [
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
  "ops.property.rename.summary":
    "give properties of a clip another path, with their keyframes, after code renamed what they are about",
  "ops.property.rename.examples": [
    {
      title: "Rename a property",
      params: {
        timeline: "main",
        renames: [{ owner: { clip: "clip_title" }, from: "param.size", to: "param.fontSize" }],
      },
    },
  ],
  "ops.marker.add.summary": "add a marker to a timeline",
  "ops.marker.add.examples": [
    { title: "Mark a moment", params: { timeline: "main", time: "12", name: "Drop" } },
  ],
  "ops.marker.add.params.duration": "Length, seconds, for a stretch.",
  "ops.marker.update.summary": "change the time, name, note, color or duration of a marker",
  "ops.marker.update.examples": [
    {
      title: "Move a marker",
      params: { timeline: "main", marker: "marker_turn", changes: { time: "6" } },
    },
  ],
  "ops.marker.remove.summary": "remove a marker",
  "ops.marker.remove.examples": [
    { title: "Remove a marker", params: { timeline: "main", marker: "marker_hook" } },
  ],
} satisfies TextTable;
