import { TOOLSET_VERSION } from "../../toolset.ts";
import { DEFAULT_TEXTS, hashOfTexts, type TextsUsed } from "../index.ts";
import type { TextTable } from "../table.ts";

/**
 * The words of toolset 2026.1, before the default ones said only what tools are and do: they also
 * said when to call each tool and what to do first. Only for tests and evaluations with real models,
 * which compare the two (see the design of model packs: this is a pack that changes the default
 * words), and for the switch of the browser that lets people try both: the editor loads it only
 * when that is on. It changes descriptions and the system prompt; what tools give back stays.
 */
export const DIRECTIVE_OVERRIDES = {
  "ops.clip.add.params.enter": "Transition at its start; null takes it away.",
  "ops.clip.add.params.exit": "Transition at its end; null takes it away.",
  "system.work":
    'How to work\nRead what you are about to change before you change it: the tools remember what you have read and use it to keep you from overwriting what the user changed since. Change timelines and everything on them with aq_edit, in as few batches as the task allows, because each batch succeeds or fails as a whole and is one step the user can undo. Change code with aq_file_edit or aq_file_write. Errors that scene and sound code throw only show in aq_check_run, so run it after you change code and before you tell the user you are done, and fix the problems you caused. When the user says "this", "here" or "now", they mean what aq_selection_read shows. When you cannot go on without the user\'s decision, ask with aq_propose.',
  "system.rules":
    "Rules\n- Change what the user asked for. If you notice something else worth changing, mention it at the end instead of changing it.\n- The user can undo everything you change. Before a batch that deletes several objects, send it with dry_run first and check what it would remove.\n- A failed call says what was wrong and how to fix it. Change the call before you send it again; the same call fails the same way.",

  "tools.aq_project_status.description":
    "Get an overview of the open AnimaQuill project: its name, frame rate, picture formats and languages, its timelines with their length and number of tracks and clips, its scenes, sounds, assets and shared code files, whether you may change it, and how many problems it has. Call it at the start of a task, and again when a result says the project was reopened. It does not list clips or keyframes: use aq_timeline_read for the clips of a timeline and aq_object_read for every field of an object. Lists stop at 30 entries; use aq_search to find the rest. Like every result, it starts with the project revision, which you never need to pass back yourself.",
  "tools.aq_timeline_read.description":
    "List what is on one timeline, one compact line per clip sorted by start: its id, name, track, start..end in seconds, what it shows (asset=, scene=, sound=, color=, text=), the transitions at its edges, its effects, and how many properties it sets and how many of them are animated. The result also lists the sections the timeline is made of, its tracks from the back of the picture forward, joins (transitions between two clips that touch) and markers. Narrow it with from and to (seconds) and tracks, and page through long timelines with cursor. Use it to find the clips you are about to change and their ids; to read every field, keyframe and effect parameter of a clip, use aq_object_read. Without timeline it reads the first timeline of the project.",
  "tools.aq_object_read.description":
    'Read objects of the project by id, with every field as the project format writes it: clips with their source, transitions, effects, properties and keyframes; tracks, sections, joins, markers, scenes, sounds, assets, timelines, or "project" for the project settings. The JSON you get is the same shape that aq_edit operations take, so copy from it rather than guessing. Pass fields (dotted paths such as "properties.transform.x" or "effects") to read only those. For a clip that shows a scene it also lists the properties the scene describes, with their type, unit, range and default: use these paths with property.edit. Clip ids are unique only within a timeline; pass timeline when several timelines have the same id. Read up to 20 objects in one call; with response_format "concise" you get one line per object and a summary of its top-level fields instead of the full JSON.',
  "tools.aq_search.description":
    'Find objects in the project by id, name, kind or text, when you know what you are looking for but not where it is: clips that show a given asset or scene, a track by name, markers, scenes, sounds, assets, files by path, or text inside the code of scenes and sounds (kind "text", which answers with path:line and the line). Matching ignores case and finds the query anywhere in the id, name, path or source. Without query it lists everything of the given kinds. Results are compact lines with ids you can use in other tools.',
  "tools.aq_file_read.description":
    'Read a code file of the project: the HTML, CSS and JavaScript of a scene (under scenes/<id>/), the code of a sound (under sounds/<id>/), or shared code (under code/). Lines come numbered as "   12→text"; the numbers are not part of the file, so leave them out when you copy text into aq_file_edit. Long files come in parts: pass offset (the first line) and limit (how many lines). Read all of a file before you replace it with aq_file_write, which requires it, and before you edit it, so that you copy its exact text. Project settings, timelines, scenes\' manifests and assets are not files you read here: use aq_object_read for them.',
  "tools.aq_selection_read.description":
    'See what the user is pointing at in the editor right now: the timeline they are on, the playhead time, the current version, the selected clips (ids and one line each) and the selected transition. Call it when the user says "this", "here", "these clips" or "now". It only gives what the user chose to share with you; read the full objects with aq_object_read.',
  "tools.aq_guide.description":
    'Read the AnimaQuill manual. It has a reference page for every operation of aq_edit (topic "ops/<operation>", such as "ops/property.edit": parameters, what it returns, its errors, examples), the project format (topics "format/…": times, ids, world coordinates, clips, transitions, effects, properties and keyframes) and how scene code talks to the editor (topics "scene-runtime/…"). Call it without arguments for the table of contents, with topic for one page, or with query to search by keywords. Look things up here instead of guessing: read the page of an operation before its first use when its parameters are not obvious, and the scene runtime pages when scene code has to work with the editor (its properties, time, assets or fonts).',
  "tools.aq_edit.description":
    'Change the open project with a batch of operations — the same operations the editor\'s own commands use. All operations of one call succeed together or nothing is written, and the batch is one step the user can undo. Operations run in order, so a later one can refer to an object an earlier one created: give new objects ids of your own, such as "clip_title2", and use them in the same batch.\n\nUse it for everything about timelines, sections, tracks, clips, transitions, joins, effects, properties and keyframes, markers, scenes, sounds and assets. Do not use it for the text of code files: change code with aq_file_edit or aq_file_write. To create a scene or a sound, use scene.add or sound.add with its files in the same operation.\n\nTimes are strings in seconds, such as "12.5" or "1001/30000". Positions and sizes are in world units, with the origin at the center of the picture. Ids come from the reading tools; never invent ids of existing objects.\n\nBefore a batch that deletes several objects, send it with dry_run: true first to see everything it would remove, including what uses those objects. If the user changed something you are about to change after you last read it, the call fails with conflict and writes nothing: read it again, then decide. A failed call says which operation failed, why, the correct shape and an example.\n\nThe result lists the objects that changed, the ids of new objects, and the problems this batch introduced or resolved — fix the problems you introduced. Write summary as one short sentence that tells the user what the batch does, without your reasoning.',
  "tools.aq_file_edit.description":
    "Change part of a code file by replacing exact text: for each edit, old_text must appear exactly once in the file as it is now (copy it from aq_file_read without the line numbers, with enough surrounding lines to be unique), and it is replaced with new_text. Set replace_all to replace every occurrence instead. All edits of one call are applied in order and succeed together, or nothing is written. This is the way to change scene, sound and shared code; it does not need the file's revision, so the user may edit other parts of the same file meanwhile. If old_text is not found, the user may have just changed that part: read the file again. The result shows the changed lines and a syntax check. To create a file or rewrite most of one, use aq_file_write.",
  "tools.aq_file_write.description":
    "Create a code file, or replace all of one: a new file of a scene, sound or shared code, or a rewrite of most of a file. Paths go under scenes/<scene id>/, sounds/<sound id>/ or code/; the scene or sound must exist (create it with scene.add or sound.add in aq_edit, which takes its first files too). To replace an existing file you must have read all its lines with aq_file_read in this conversation, and the call fails with file-changed if somebody changed it since: read it again, then write. For small changes use aq_file_edit, which keeps the user's edits elsewhere in the file. The result includes a syntax check.",
  "tools.aq_propose.description":
    "Hand a decision to the user and stop this turn to wait for it. Use kind \"question\" when you cannot go on without the user's choice — which of two clips they meant, which of a few styles they want, whether to replace or keep something — and give 2 to 6 short, concrete options; the user can also answer in their own words. Do not ask about what you can find out by reading the project, and ask one question at a time. After calling it, end your turn without further tools: the answer arrives as the user's next message.",
  "tools.aq_check_run.description":
    "Check the project and list its problems: files that do not fit the project format, references to things that are missing, values that do not fit what a scene describes, errors that scene and sound code threw when the editor ran it, and things this editor version does not do yet (they will not appear in the preview or the export). Run it after changing code, and before you tell the user you are done; fix the problems you caused and mention the others. Problems with a fix line are fixed by sending that operation to aq_edit. Runtime errors only come from code the editor has run, which happens shortly after a change; aq_edit results already include the problems that come from the project data alone.",
  "tools.aq_edit.params.base_revision":
    "Hardly ever needed: a revision from an earlier result, to also refuse changes of anything changed since then. It never lets through a change the tools would refuse.",
  "edit.examplesHeading":
    "Examples of operations (illustrative; their ids come from a sample project, so use the ids you read):",
  "tools.aq_guide.params.topic":
    'One page, such as "ops/clip.move", "format/animaquill.json" or "scene-runtime/aq"; ":2" after it for its next part. Without topic and query, the table of contents.',
  "types.Key":
    'A keyframe: {"time":"<seconds from the start of the clip>","value":…}, with how it goes on to the next one.',
  // How toolset 2026.1 listed the operations in the description of aq_edit: signatures with these
  // summaries, and these examples; the branches of the schema had no description.
  "ops.project.rename.summary": "rename the project",
  "ops.project.setFrameRate.summary": "set the frame rate the timeline counts frames by",
  "ops.asset.update.summary": "rename an asset or change its tags",
  "ops.asset.remove.summary": "remove an asset, and with withUses the clips that use it",
  "ops.scene.add.summary":
    "create a scene (HTML, CSS and JavaScript that draw a picture) with its files",
  "ops.scene.update.summary": "change the manifest of a scene: name, entry, params, presets",
  "ops.scene.remove.summary":
    "remove a scene and its files, and with withUses the clips that use it",
  "ops.sound.add.summary": "create a sound made by code, with its files",
  "ops.sound.update.summary": "change the manifest of a sound: name, entry, params, outputs",
  "ops.sound.remove.summary":
    "remove a sound and its files, and with withUses the clips that use it",
  "ops.source.replace.summary":
    "make every clip that uses an asset, scene or sound use another one of the same kind",
  "ops.file.remove.summary": "remove a code file that is no entry",
  "ops.file.rename.summary": "rename or move a code file",
  "ops.timeline.rename.summary": "rename a timeline",
  "ops.section.add.summary": "add a section to a timeline, which makes it longer",
  "ops.section.update.summary": "change the duration or name of a section",
  "ops.section.remove.summary": "remove a section; a timeline keeps at least one",
  "ops.track.add.summary": "add a video, audio or caption track",
  "ops.track.update.summary":
    "change the name, hidden, muted, solo, locked, group or role of a track",
  "ops.track.move.summary": "move a track before another one, or last",
  "ops.track.remove.summary": "remove a track with all its clips",
  "ops.clip.add.summary": "put a clip on a track: an asset, a scene, a sound, a color or a caption",
  "ops.clip.remove.summary": "remove clips",
  "ops.clip.update.summary":
    "change the name, source, offset, loop, hidden, draft, link or section fit of a clip",
  "ops.clip.setTransition.summary":
    "put a transition at the start (enter) or end (exit) of a clip, or take it away with null",
  "ops.join.add.summary": "put a transition on the cut between two clips that touch",
  "ops.effect.add.summary": "put an effect on a clip, with the values of its parameters",
  "ops.effect.remove.summary": "take effects off a clip",
  "ops.effect.move.summary":
    "move an effect in the list of its clip, which changes what it works on",
  "ops.effect.update.summary": "turn an effect on or off, or change when it works",
  "ops.join.update.summary": "change the type, duration, align, curve or values of a join",
  "ops.join.remove.summary": "remove joins",
  "ops.clip.move.summary": "move clips to other starts or tracks, in one step",
  "ops.clip.trim.summary": "move the start or end of a clip; what it shows stays in place",
  "ops.clip.split.summary": "cut a clip in two at a moment of the timeline",
  "ops.property.edit.summary": "set properties of clips and their keyframes, in one step",
  "ops.property.rename.summary":
    "give properties of a clip another path, with their keyframes, after code renamed what they are about",
  "ops.marker.add.summary": "add a marker to a timeline",
  "ops.marker.update.summary": "change the time, name, note, color or duration of a marker",
  "ops.marker.remove.summary": "remove a marker",
  "edit.list": "signatures",
  "edit.operationsHeading":
    'Operations (every parameter, result and more examples: aq_guide topic "ops/<operation>"):',
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

/** The default words with these instead: the toolset as 2026.1 had it. */
export const DIRECTIVE_TEXTS: TextTable = { ...DEFAULT_TEXTS, ...DIRECTIVE_OVERRIDES };

/** What a conversation records when it used these words. */
export const DIRECTIVE_TEXTS_USED: TextsUsed = {
  id: "animaquill/eval-directive",
  version: TOOLSET_VERSION,
  hash: hashOfTexts(DIRECTIVE_TEXTS),
};
