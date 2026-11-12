import type { TextTable } from "./table.ts";

/** What each tool says it does, and what each of its own parameters is. */
export const TOOL_TEXTS = {
  "tools.aq_project_status.description":
    "Get an overview of the open AnimaQuill project: its name, frame rate, picture formats and languages, its timelines with their length and number of tracks and clips, its scenes, sounds, assets and shared code files, whether you may change it, and how many problems it has. Call it at the start of a task, and again when a result says the project was reopened. It does not list clips or keyframes: use aq_timeline_read for the clips of a timeline and aq_object_read for every field of an object. Lists stop at 30 entries; use aq_search to find the rest. Like every result, it starts with the project revision, which you never need to pass back yourself.",
  "tools.aq_timeline_read.description":
    "List what is on one timeline, one compact line per clip sorted by start: its id, name, track, start..end in seconds, what it shows (asset=, scene=, sound=, color=, text=), the transitions at its edges, its effects, and how many properties it sets and how many of them are animated. The result also lists the sections the timeline is made of, its tracks from the back of the picture forward, joins (transitions between two clips that touch) and markers. Narrow it with from and to (seconds) and tracks, and page through long timelines with cursor. Use it to find the clips you are about to change and their ids; to read every field, keyframe and effect parameter of a clip, use aq_object_read. Without timeline it reads the first timeline of the project.",
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
    'Read objects of the project by id, with every field as the project format writes it: clips with their source, transitions, effects, properties and keyframes; tracks, sections, joins, markers, scenes, sounds, assets, timelines, or "project" for the project settings. The JSON you get is the same shape that aq_edit operations take, so copy from it rather than guessing. Pass fields (dotted paths such as "properties.transform.x" or "effects") to read only those. For a clip that shows a scene it also lists the properties the scene describes, with their type, unit, range and default: use these paths with property.edit. Clip ids are unique only within a timeline; pass timeline when several timelines have the same id. Read up to 20 objects in one call; with response_format "concise" you get one line per object and a summary of its top-level fields instead of the full JSON.',
  "tools.aq_object_read.params.ids":
    'Ids of clips, tracks, sections, joins, markers, scenes, sounds, assets or timelines, or "project", 1 to 20.',
  "tools.aq_object_read.params.timeline": "Timeline id, for ids that several timelines have.",
  "tools.aq_object_read.params.fields":
    'Dotted paths to read only these fields, such as "start", "properties.transform.x" or "effects".',
  "tools.aq_object_read.params.response_format":
    '"detailed" (the default) gives every field as JSON; "concise" one line per object and its top-level fields.',
  "tools.aq_search.description":
    'Find objects in the project by id, name, kind or text, when you know what you are looking for but not where it is: clips that show a given asset or scene, a track by name, markers, scenes, sounds, assets, files by path, or text inside the code of scenes and sounds (kind "text", which answers with path:line and the line). Matching ignores case and finds the query anywhere in the id, name, path or source. Without query it lists everything of the given kinds. Results are compact lines with ids you can use in other tools.',
  "tools.aq_search.params.query":
    "Text to find, any case, in ids, names, paths, sources, or the text of code files (kind text).",
  "tools.aq_search.params.kinds": "Only these kinds of objects; every kind but text by default.",
  "tools.aq_search.params.timeline": "Only objects of this timeline, by its id.",
  "tools.aq_search.params.limit": "How many results at most, 1 to 200; 50 by default.",
  "tools.aq_search.params.cursor":
    "Where to go on, as the last line of an earlier result of this call says.",
  "tools.aq_file_read.description":
    'Read a code file of the project: the HTML, CSS and JavaScript of a scene (under scenes/<id>/), the code of a sound (under sounds/<id>/), or shared code (under code/). Lines come numbered as "   12→text"; the numbers are not part of the file, so leave them out when you copy text into aq_file_edit. Long files come in parts: pass offset (the first line) and limit (how many lines). Read all of a file before you replace it with aq_file_write, which requires it, and before you edit it, so that you copy its exact text. Project settings, timelines, scenes\' manifests and assets are not files you read here: use aq_object_read for them.',
  "tools.aq_file_read.params.path":
    'Path of a code file, such as "scenes/title/index.html", as aq_project_status or aq_search lists it.',
  "tools.aq_file_read.params.offset": "The first line to read, from 1; 1 by default.",
  "tools.aq_file_read.params.limit": "How many lines at most, 1 to 2000; 2000 by default.",
  "tools.aq_selection_read.description":
    'See what the user is pointing at in the editor right now: the timeline they are on, the playhead time, the current version, the selected clips (ids and one line each) and the selected transition. Call it when the user says "this", "here", "these clips" or "now". It only gives what the user chose to share with you; read the full objects with aq_object_read.',
  "tools.aq_guide.description":
    'Read the AnimaQuill manual. It has a reference page for every operation of aq_edit (topic "ops/<operation>", such as "ops/property.edit": parameters, what it returns, its errors, examples), the project format (topics "format/…": times, ids, world coordinates, clips, transitions, effects, properties and keyframes) and how scene code talks to the editor (topics "scene-runtime/…"). Call it without arguments for the table of contents, with topic for one page, or with query to search by keywords. Look things up here instead of guessing: read the page of an operation before its first use when its parameters are not obvious, and the scene runtime pages when scene code has to work with the editor (its properties, time, assets or fonts).',
  "tools.aq_guide.params.topic":
    'One page, such as "ops/clip.move", "format/animaquill.json" or "scene-runtime/aq"; ":2" after it for its next part. Without topic and query, the table of contents.',
  "tools.aq_guide.params.query":
    "Words to look for in titles and pages; it gives up to 10 topics, each with a line of what it says.",
  "tools.aq_edit.description":
    'Change the open project with a batch of operations — the same operations the editor\'s own commands use. All operations of one call succeed together or nothing is written, and the batch is one step the user can undo. Operations run in order, so a later one can refer to an object an earlier one created: give new objects ids of your own, such as "clip_title2", and use them in the same batch.\n\nUse it for everything about timelines, sections, tracks, clips, transitions, joins, effects, properties and keyframes, markers, scenes, sounds and assets. Do not use it for the text of code files: change code with aq_file_edit or aq_file_write. To create a scene or a sound, use scene.add or sound.add with its files in the same operation.\n\nTimes are strings in seconds, such as "12.5" or "1001/30000". Positions and sizes are in world units, with the origin at the center of the picture. Ids come from the reading tools; never invent ids of existing objects.\n\nBefore a batch that deletes several objects, send it with dry_run: true first to see everything it would remove, including what uses those objects. If the user changed something you are about to change after you last read it, the call fails with conflict and writes nothing: read it again, then decide. A failed call says which operation failed, why, the correct shape and an example.\n\nThe result lists the objects that changed, the ids of new objects, and the problems this batch introduced or resolved — fix the problems you introduced. Write summary as one short sentence that tells the user what the batch does, without your reasoning.',
  "tools.aq_edit.params.operations":
    'The operations, run in order as one batch: each one {"op": "<operation>", …its parameters}. 1 to 100.',
  "tools.aq_edit.params.summary":
    "One short sentence for the user on what the batch does, without your reasoning.",
  "tools.aq_edit.params.dry_run":
    "true checks everything and writes nothing, and lists what the batch would change.",
  "tools.aq_edit.params.base_revision":
    "Hardly ever needed: a revision from an earlier result, to also refuse changes of anything changed since then. It never lets through a change the tools would refuse.",
  "tools.aq_edit.params.request_id":
    "Any string of yours: a call sent again with the same one is not run again and gets the same result.",
  "tools.aq_file_edit.description":
    "Change part of a code file by replacing exact text: for each edit, old_text must appear exactly once in the file as it is now (copy it from aq_file_read without the line numbers, with enough surrounding lines to be unique), and it is replaced with new_text. Set replace_all to replace every occurrence instead. All edits of one call are applied in order and succeed together, or nothing is written. This is the way to change scene, sound and shared code; it does not need the file's revision, so the user may edit other parts of the same file meanwhile. If old_text is not found, the user may have just changed that part: read the file again. The result shows the changed lines and a syntax check. To create a file or rewrite most of one, use aq_file_write.",
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
    "Create a code file, or replace all of one: a new file of a scene, sound or shared code, or a rewrite of most of a file. Paths go under scenes/<scene id>/, sounds/<sound id>/ or code/; the scene or sound must exist (create it with scene.add or sound.add in aq_edit, which takes its first files too). To replace an existing file you must have read all its lines with aq_file_read in this conversation, and the call fails with file-changed if somebody changed it since: read it again, then write. For small changes use aq_file_edit, which keeps the user's edits elsewhere in the file. The result includes a syntax check.",
  "tools.aq_file_write.params.path":
    'Path of the file, under scenes/<scene id>/, sounds/<sound id>/ or code/, such as "code/ease.js".',
  "tools.aq_file_write.params.text": "All of its text.",
  "tools.aq_file_write.params.base_revision":
    "Hardly ever needed: a revision from an earlier result, to also refuse the write if the file changed since then. The file still has to be read first.",
  "tools.aq_file_write.params.request_id":
    "Any string of yours: a call sent again with the same one is not run again and gets the same result.",
  "tools.aq_propose.description":
    "Hand a decision to the user and stop this turn to wait for it. Use kind \"question\" when you cannot go on without the user's choice — which of two clips they meant, which of a few styles they want, whether to replace or keep something — and give 2 to 6 short, concrete options; the user can also answer in their own words. Do not ask about what you can find out by reading the project, and ask one question at a time. After calling it, end your turn without further tools: the answer arrives as the user's next message.",
  "tools.aq_propose.params.kind": '"question": a choice for the user to make.',
  "tools.aq_propose.params.question": "The question, in one sentence, in the language of the user.",
  "tools.aq_propose.params.options": "2 to 6 concrete answers.",
  "tools.aq_propose.params.options.label": "A short answer the user can pick.",
  "tools.aq_propose.params.options.detail": "What picking it means, in a few words.",
  "tools.aq_propose.params.allow_other":
    "false when the user must pick one of the options; by default they can also answer in their own words.",
  "tools.aq_check_run.description":
    "Check the project and list its problems: files that do not fit the project format, references to things that are missing, values that do not fit what a scene describes, errors that scene and sound code threw when the editor ran it, and things this editor version does not do yet (they will not appear in the preview or the export). Run it after changing code, and before you tell the user you are done; fix the problems you caused and mention the others. Problems with a fix line are fixed by sending that operation to aq_edit. Runtime errors only come from code the editor has run, which happens shortly after a change; aq_edit results already include the problems that come from the project data alone.",
  "tools.aq_check_run.params.checks":
    '"format": whether every document fits the project format; "problems": all problems the editor knows of. Both by default.',
  "tools.aq_check_run.params.severity": "Only problems of these kinds.",
  "tools.aq_check_run.params.subject": "Only problems of this object id or file path.",
  "tools.aq_check_run.params.limit": "How many problems at most, 1 to 500; 100 by default.",
  "tools.aq_check_run.params.cursor":
    "Where to go on, as the last line of an earlier result of this call says.",
} satisfies TextTable;
