import type { TextTable } from "./table.ts";

/** What each tool says it does, and what each of its own parameters is. */
export const TOOL_TEXTS = {
  "tools.aq_project_status.description":
    "Overview of the open AnimaQuill project: its name, frame rate, picture formats and languages; each timeline with its length and its numbers of tracks and clips; its scenes, sounds, assets and shared code files (up to 30 of each; aq_search finds the rest); whether it can be changed; and how many problems it has. It does not list clips or keyframes: those are in aq_timeline_read and aq_object_read. Like every result, it starts with the project revision; the tools keep track of revisions themselves, so no call needs it back.",
  "tools.aq_timeline_read.description":
    "What is on one timeline: one compact line per clip, sorted by start, with its id, name, track, start..end in seconds, what it shows (asset=, scene=, sound=, color=, text=), the transitions at its edges, its effects, and how many properties it sets and how many of them are animated. The result also lists the sections the timeline is made of, its tracks from the back of the picture forward, joins (transitions between two clips that touch) and markers. from and to (seconds) and tracks narrow it; cursor pages through long timelines; without timeline it reads the first timeline of the project. It has no property values or keyframes: every field of a clip is in aq_object_read. The clips it lists count as read for the conflict check of aq_edit.",
  "tools.aq_timeline_read.params.timeline":
    "Timeline id, as aq_project_status lists it. Without it, the first timeline of the project.",
  "tools.aq_timeline_read.params.from":
    'Only clips that end after this moment. Seconds as a string, such as "12.5".',
  "tools.aq_timeline_read.params.to":
    'Only clips that start before this moment. Seconds as a string, such as "12.5".',
  "tools.aq_timeline_read.params.tracks": "Only clips on these tracks, by track id.",
  "tools.aq_timeline_read.params.limit": "How many clips at most, 1 to 500; 200 by default.",
  "tools.aq_timeline_read.params.cursor":
    "Where to go on, as the last line of an earlier result of this call says.",
  "tools.aq_object_read.description":
    'Objects of the project by id, with every field as the project format writes it: clips with their source, transitions, effects, properties and keyframes; tracks, sections, joins, markers, scenes, sounds, assets, timelines, or "project" for the project settings. The JSON has the same shape that aq_edit operations take. fields (dotted paths such as "properties.transform.x" or "effects") limits the result to those fields. For a clip that shows a scene, it also lists the properties the scene describes, with their type, unit, range and default; these are the paths property.edit takes. Clip ids are unique only within a timeline; timeline picks one when several timelines have the same id. Up to 20 objects per call; response_format "concise" gives one line per object and a summary of its top-level fields instead of the full JSON.',
  "tools.aq_object_read.params.ids":
    'Ids of clips, tracks, sections, joins, markers, scenes, sounds, assets or timelines, or "project", 1 to 20.',
  "tools.aq_object_read.params.timeline": "Timeline id, for ids that several timelines have.",
  "tools.aq_object_read.params.fields":
    'Dotted paths to read only these fields, such as "start", "properties.transform.x" or "effects".',
  "tools.aq_object_read.params.response_format":
    '"detailed" (the default) gives every field as JSON; "concise" one line per object and its top-level fields.',
  "tools.aq_search.description":
    'Finds objects in the project by id, name, kind or text: clips that show a given asset or scene, tracks, markers, scenes, sounds, assets, files by path, and text inside the code of scenes and sounds (kind "text" answers with path:line and the line). Matching ignores case and finds the query anywhere in the id, name, path or source. Without query it lists everything of the given kinds. Results are compact lines with ids that the other tools take.',
  "tools.aq_search.params.query":
    "Text to find, any case, in ids, names, paths, sources, or the text of code files (kind text).",
  "tools.aq_search.params.kinds": "Only these kinds of objects; every kind but text by default.",
  "tools.aq_search.params.timeline": "Only objects of this timeline, by its id.",
  "tools.aq_search.params.limit": "How many results at most, 1 to 200; 50 by default.",
  "tools.aq_search.params.cursor":
    "Where to go on, as the last line of an earlier result of this call says.",
  "tools.aq_file_read.description":
    'A code file of the project: the HTML, CSS and JavaScript of a scene (under scenes/<id>/), the code of a sound (under sounds/<id>/), or shared code (under code/). Lines come numbered as "   12→text"; the numbers are not part of the file. offset (the first line) and limit (how many lines) read a long file in parts. aq_file_write replaces an existing file only if all its lines were read here in this conversation. Project settings, timelines, scenes\' manifests and assets are not files here: they are in aq_object_read.',
  "tools.aq_file_read.params.path":
    'Path of a code file, such as "scenes/title/index.html", as aq_project_status or aq_search lists it.',
  "tools.aq_file_read.params.offset": "The first line to read, from 1; 1 by default.",
  "tools.aq_file_read.params.limit": "How many lines at most, 1 to 2000; 2000 by default.",
  "tools.aq_selection_read.description":
    "What the user is pointing at in the editor right now: the timeline they are on, the playhead time, the current version, the selected clips (ids and one line each) and the selected transition. It has only what the user chose to share; the full objects are in aq_object_read.",
  "tools.aq_guide.description":
    'The AnimaQuill manual: short pages on how the editor does things (topics "howto/…", such as "howto/keyframes", "howto/times" and "howto/transitions"), a reference page for every operation of aq_edit (topic "ops/<operation>", such as "ops/property.edit": parameters and the fields inside them, what it returns, its errors and examples), the types that operations share (topics "types/…", such as "types/ClipSource"), the project format (topics "format/…": times, ids, world coordinates, clips, transitions, effects, properties and keyframes), and how scene code talks to the editor (topics "scene-runtime/…"); the format and scene runtime pages are in Chinese. Without arguments it gives the table of contents; topic gives one page; query searches the titles and text by keywords.',
  "tools.aq_guide.params.topic":
    'One page, such as "ops/clip.move", "howto/keyframes", "types/ClipSource", "format/animaquill.json" or "scene-runtime/aq"; ":2" after it for its next part. Without topic and query, the table of contents.',
  "tools.aq_guide.params.query":
    "Words to look for in titles and pages; it gives up to 10 topics, each with a line of what it says.",
  "tools.aq_edit.description":
    'Changes the open project with a batch of operations — the same operations the editor\'s own commands use — on timelines, sections, tracks, clips, transitions, joins, effects, properties and keyframes, markers, scenes, sounds and assets. It does not change the text of code files; aq_file_edit and aq_file_write do. scene.add and sound.add take the first files of a new scene or sound.\n\nAll operations of one call succeed together or nothing is written, and the batch is one step the user can undo. Operations run in order, so a later one can refer to an object that an earlier one created with an id given in the batch, such as "clip_title2". Times are strings in seconds, such as "12.5" or "1001/30000"; positions and sizes are in world units, with the origin at the center of the picture. Ids of existing objects come from the reading tools; an id that does not exist fails with not-found.\n\nChanges are checked against what you have read: a change to an object that the user changed after you last read it fails with conflict, and a change to an existing object before anything was read in this conversation fails with not-read; in both cases nothing is written. dry_run: true checks the batch and reports everything it would change or remove, including what uses those objects, without writing. A failed call says which operation failed, why, the correct shape and an example.\n\nThe result lists the objects that changed, the ids of new objects, and the problems this batch introduced or resolved. summary is one short sentence that the user sees for this batch, saying what it does.',
  "tools.aq_edit.params.operations":
    'The operations, run in order as one batch: each one {"op": "<operation>", …its parameters}. 1 to 100.',
  "tools.aq_edit.params.summary":
    "One short sentence for the user on what the batch does, without your reasoning.",
  "tools.aq_edit.params.dry_run":
    "true checks everything and writes nothing, and lists what the batch would change.",
  "tools.aq_edit.params.base_revision":
    "Hardly ever needed: a revision from an earlier result; changes of anything changed since then are refused too. It only adds to the checks of the tools.",
  "tools.aq_edit.params.request_id":
    "Any string of yours: a call sent again with the same one is not run again and gets the same result.",
  "tools.aq_file_edit.description":
    "Changes part of a code file by replacing exact text: each edit's old_text must appear exactly once in the file as it is now (without the line numbers that aq_file_read shows), and is replaced with new_text; replace_all replaces every occurrence instead. All edits of one call apply in order and succeed together, or nothing is written. It does not use the file's revision, so the user's edits elsewhere in the same file do not stop it; old_text that is not found is not in the file as it is now, as when that part changed after it was read. The file must exist: aq_file_write creates files. The result shows the changed lines and a syntax check.",
  "tools.aq_file_edit.params.path": 'Path of the code file, such as "scenes/title/index.html".',
  "tools.aq_file_edit.params.edits": "Replacements, applied in order, 1 to 20.",
  "tools.aq_file_edit.params.edits.old_text":
    "Text of the file as it is now, exactly, without the line numbers of aq_file_read; enough of it to be found once.",
  "tools.aq_file_edit.params.edits.new_text": "What replaces it.",
  "tools.aq_file_edit.params.edits.replace_all":
    "true replaces every place old_text is found, at least one.",
  "tools.aq_file_edit.params.request_id":
    "Any string of yours: a call sent again with the same one is not run again and gets the same result.",
  "tools.aq_file_write.description":
    "Creates a code file or replaces all of one. Paths go under scenes/<scene id>/, sounds/<sound id>/ or code/, and the scene or sound must exist (scene.add and sound.add in aq_edit create them with their first files). An existing file is replaced only if all its lines were read with aq_file_read in this conversation, and the call fails with file-changed if somebody changed it since. Replacing a whole file also replaces any edits the user made elsewhere in it; aq_file_edit changes only the parts it names. The result includes a syntax check.",
  "tools.aq_file_write.params.path":
    'Path of the file, under scenes/<scene id>/, sounds/<sound id>/ or code/, such as "code/ease.js".',
  "tools.aq_file_write.params.text": "All of its text.",
  "tools.aq_file_write.params.base_revision":
    "Hardly ever needed: a revision from an earlier result, to also refuse the write if the file changed since then. The file still has to be read first.",
  "tools.aq_file_write.params.request_id":
    "Any string of yours: a call sent again with the same one is not run again and gets the same result.",
  "tools.aq_propose.description":
    'Hands a decision to the user: kind "question" shows the question with 2 to 6 short options, and the user can also answer in their own words. The turn ends with this call: changes later in the same answer are not run, and the answer arrives as the user\'s next message.',
  "tools.aq_propose.params.kind": '"question": a choice for the user to make.',
  "tools.aq_propose.params.question": "The question, in one sentence, in the language of the user.",
  "tools.aq_propose.params.options": "2 to 6 concrete answers.",
  "tools.aq_propose.params.options.label": "A short answer the user can pick.",
  "tools.aq_propose.params.options.detail": "What picking it means, in a few words.",
  "tools.aq_propose.params.allow_other":
    "false when the user must pick one of the options; by default they can also answer in their own words.",
  "tools.aq_check_run.description":
    "Lists the problems of the project: files that do not fit the project format, references to things that are missing, values that do not fit what a scene describes, errors that scene and sound code threw when the editor ran it, and things this editor version does not do yet (they do not appear in the preview or the export). Runtime errors come only from code the editor has run: a scene runs while one of its clips is in the preview, and again after its code changes; the result lists changed code that has not run since. aq_edit results already include the problems that come from the project data alone. A fix line is an aq_edit operation that resolves that problem.",
  "tools.aq_check_run.params.checks":
    '"format": whether every document fits the project format; "problems": all problems the editor knows of. Both by default.',
  "tools.aq_check_run.params.severity": "Only problems of these kinds.",
  "tools.aq_check_run.params.subject": "Only problems of this object id or file path.",
  "tools.aq_check_run.params.limit": "How many problems at most, 1 to 500; 100 by default.",
  "tools.aq_check_run.params.cursor":
    "Where to go on, as the last line of an earlier result of this call says.",
} satisfies TextTable;
