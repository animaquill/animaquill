import type { TextTable } from "./table.ts";

/** What each tool says it does, and what each of its own parameters is. */
export const TOOL_TEXTS = {
  "tools.aq_project_status.description":
    "Overview of the open AnimaQuill project: its name, frame rate, picture formats and languages; each timeline with its length and its numbers of tracks and clips; its scenes, sounds, assets and shared code files (up to {listed} of each; aq_search finds the rest); whether it can be changed; and how many problems it has. It does not list clips or keyframes: those are in aq_timeline_read and aq_object_read. Like every result, it starts with the project revision; the tools keep track of revisions themselves, so no call needs it back.",
  "tools.aq_timeline_read.description":
    "What is on one timeline: one compact line per clip, sorted by start, with its id, name, track, start..end in seconds, what it shows (asset=, scene=, sound=, color=, text=), the transitions at its edges, its effects, and how many properties it sets and how many of them are animated. The result also lists the sections the timeline is made of, its tracks from the back of the picture forward, joins (transitions between two clips that touch) and markers. from and to (seconds) and tracks narrow it; cursor pages through long timelines; without timeline it reads the first timeline of the project. It has no property values or keyframes: every field of a clip is in aq_object_read. The clips it lists count as read for the conflict check of aq_edit.",
  "tools.aq_timeline_read.params.timeline":
    "Timeline id, as aq_project_status lists it. Without it, the first timeline of the project.",
  "tools.aq_timeline_read.params.from":
    'Only clips that end after this moment. Seconds as a string, such as "12.5".',
  "tools.aq_timeline_read.params.to":
    'Only clips that start before this moment. Seconds as a string, such as "12.5".',
  "tools.aq_timeline_read.params.tracks": "Only clips on these tracks, by track id.",
  "tools.aq_timeline_read.params.limit":
    "How many clips at most, 1 to {max}; {default} by default.",
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
    '"detailed" gives every field as JSON, "concise" one line per object and its top-level fields; {default} by default.',
  "tools.aq_search.description":
    'Finds objects in the project by id, name, kind or text: clips that show a given asset or scene, tracks, markers, scenes, sounds, assets, files by path, and text inside the code of scenes and sounds (kind "text" answers with path:line and the line). Matching ignores case and finds the query anywhere in the id, name, path or source. Without query it lists everything of the given kinds. Results are compact lines with ids that the other tools take.',
  "tools.aq_search.params.query":
    "Text to find, any case, in ids, names, paths, sources, or the text of code files (kind text).",
  "tools.aq_search.params.kinds": "Only these kinds of objects; every kind but text by default.",
  "tools.aq_search.params.timeline": "Only objects of this timeline, by its id.",
  "tools.aq_search.params.limit": "How many results at most, 1 to {max}; {default} by default.",
  "tools.aq_search.params.cursor":
    "Where to go on, as the last line of an earlier result of this call says.",
  "tools.aq_file_read.description":
    'A code file of the project: the HTML, CSS and JavaScript of a scene (under scenes/<id>/), the code of a sound (under sounds/<id>/), or shared code (under code/). Lines come numbered as "   12→text"; the numbers are not part of the file. offset (the first line) and limit (how many lines) read a long file in parts. aq_file_write replaces an existing file only if all its lines were read here in this conversation. Project settings, timelines, scenes\' manifests and assets are not files here: they are in aq_object_read.',
  "tools.aq_file_read.params.path":
    'Path of a code file, such as "scenes/title/index.html", as aq_project_status or aq_search lists it.',
  "tools.aq_file_read.params.offset": "The first line to read, from 1; 1 by default.",
  "tools.aq_file_read.params.limit": "How many lines at most, 1 to {max}; {default} by default.",
  "tools.aq_selection_read.description":
    'What the user points at in the editor: the timeline, the playhead time, the version shown, the selected clips (ids and one line each, as they are now) and the selected transition. The editor keeps these as they were when each message of the user was sent. at "sent" gives them for one message, which is what "this" or "here" in it points at, even after the user selected something else; at "now" gives those of now. One call gives one, such as {"at": "sent"} for the message this task started with, {"at": "sent", "messages_back": 1} for the one before, or {"at": "now"}. Clips selected then and gone since are listed by id. It has only what the user chose to share, and no whole objects: those are in aq_object_read.',
  "tools.aq_selection_read.params.at":
    '"sent": as a message of the user was sent, see messages_back. "now": as the editor is now.',
  "tools.aq_selection_read.params.messages_back":
    'Only with at "sent": which message of the user, counted back from the latest: 0 (the default) is the latest, the one this task started with, 1 the one before it.',
  "tools.aq_guide.description":
    'The AnimaQuill manual: short pages on how the editor does things (topics "howto/…", such as "howto/keyframes", "howto/times" and "howto/transitions"), a reference page for every operation of aq_edit (topic "ops/<operation>", such as "ops/property.edit": parameters and the fields inside them, what it returns, its errors and examples), the types that operations share (topics "types/…", such as "types/ClipSource"), the project format (topics "format/…": times, ids, world coordinates, clips, transitions, effects, properties and keyframes), and how scene code talks to the editor (topics "scene-runtime/…"); the format and scene runtime pages are in Chinese. Without arguments it gives the table of contents; topic gives one page; query searches the titles and text by keywords.',
  "tools.aq_guide.params.topic":
    'One page, such as "ops/clip.move", "howto/keyframes", "types/ClipSource", "format/animaquill.json" or "scene-runtime/aq"; ":2" after it for its next part. Without topic and query, the table of contents.',
  "tools.aq_guide.params.query":
    "Words to look for in titles and pages; it gives up to 10 topics, each with a line of what it says.",
  "tools.aq_edit.description":
    'Changes the open project with a batch of operations — the same operations the editor\'s own commands use — on timelines, sections, tracks, clips, transitions, joins, effects, properties and keyframes, markers, scenes, sounds and assets. It does not change the text of code files; aq_file_edit and aq_file_write do. scene.add and sound.add take the first files of a new scene or sound.\n\nAll operations of one call succeed together or nothing is written, and the batch is one step the user can undo. Operations run in order, so a later one can refer to an object that an earlier one created with an id given in the batch, such as "clip_title2". Times are strings in seconds, such as "12.5" or "1001/30000"; positions and sizes are in world units, with the origin at the center of the picture. Ids of existing objects come from the reading tools; an id that does not exist fails with not-found. Clips with one link, such as the picture and sound of a video, go together in the editor; an operation changes only the clips it lists, and a linked clip that it does not list stays as it is.\n\nChanges are checked against what you have read: a change to an object that the user changed after you last read it fails with conflict, and a change to an existing object before anything was read in this conversation fails with not-read; in both cases nothing is written. dry_run: true checks the batch and reports everything it would change or remove, including what uses those objects, without writing. A failed call says which operation failed, why, the correct shape and an example.\n\nThe result lists the objects that changed, the ids of new objects, and the problems this batch introduced or resolved. summary is one short sentence that the user sees for this batch, saying what it does.',
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
    'Hands the user a decision and ends the turn: kind "question" shows 2 to 6 short options, and the user can also answer in their own words; kind "plan" shows a plan of the work as a card the user can change before accepting it. Changes later in the same answer are not run; the answer, or the plan as accepted, arrives as the user\'s next message.',
  "tools.aq_propose.params.kind":
    '"question": a choice for the user to make. "plan": the plan of the work, before any change.',
  "tools.aq_propose.params.question": "The question, in one sentence, in the language of the user.",
  "tools.aq_propose.params.options": "2 to 6 concrete answers.",
  "tools.aq_propose.params.options.label": "A short answer the user can pick.",
  "tools.aq_propose.params.options.detail": "What picking it means, in a few words.",
  "tools.aq_propose.params.allow_other":
    "false when the user must pick one of the options; by default they can also answer in their own words.",
  "tools.aq_propose.params.title": "The plan in a few words, in the language of the user.",
  "tools.aq_propose.params.steps": "The steps of the plan, in order, 1 to {max}.",
  "tools.aq_propose.params.steps.text": "What the step does, in one line.",
  "tools.aq_propose.params.steps.from": 'Where it starts, seconds as a string such as "4".',
  "tools.aq_propose.params.steps.to": "Where it ends, seconds as a string.",
  "tools.aq_propose.params.length": "How long the result is, seconds as a string.",
  "tools.aq_propose.params.style": "The look and feel, in a few words.",
  "tools.aq_render_frames.description":
    'Renders frames of a timeline as the export renders them. The pictures come first in the result, and after them what is on each frame: every clip that shows, back to front, with its id and name, what it shows, its box in world units, the share of the picture it covers, its opacity, how far it goes past the edges of the picture, whether its media is cut to its box, and which small clips overlap; and the text elements of HTML scenes with their text and box. A frame that cannot be rendered whole, as when the file of an asset is not on this computer or a scene does not run, gives an error with the reason, and no picture: a picture is only ever what the export would render.\n\ntimes gives a picture of each moment. range with count is an overview: count frames evenly spread over the range in one picture, each with its time printed on it. region is a part of the picture rendered at the full size of a picture: scenes are laid out again at that resolution, so their text stays sharp, while videos and images are scaled up. annotate draws on the picture a box with the id and name of each clip (true) or of the clips given, red where one goes past an edge. compare gives, for each time, the frame before, the frame now and a picture where the changed pixels are red, with the share of pixels that changed and the box around them: "task_start" is the project as this task started, and a revision is the project as an earlier result of this conversation started (its rev line). size small, medium or large is 512, 1024 or 1568 pixels on the longer side; a 1024×576 picture costs about 790 tokens; without size, the size the user set. Each frame is the one the export renders at that moment. A model that cannot see pictures gets the text only. Rendering waits while the user plays or exports, and while the editor page is in the background, as the browser draws nothing then; that wait is part of the call and no failure.',
  "tools.aq_render_frames.params.times":
    'Moments to render, 1 to {max}, seconds as strings such as "12.5"; each gives a picture. Not with range.',
  "tools.aq_render_frames.params.range":
    'An overview: {"from": "0", "to": "30"}, seconds as strings; count frames evenly spread from from, all in one picture. Not with times, region or compare.',
  "tools.aq_render_frames.params.count":
    "How many frames an overview has, 2 to {max}; 12 by default. Only with range.",
  "tools.aq_render_frames.params.timeline":
    "Timeline id, as aq_project_status lists it. Without it, the first timeline of the project.",
  "tools.aq_render_frames.params.version":
    "Picture format id, as aq_project_status lists it, for that version of the picture. Without it, the first format.",
  "tools.aq_render_frames.params.size":
    '"small" (512 pixels on the longer side), "medium" (1024) or "large" (1568). Without it, the size the user set, medium by default.',
  "tools.aq_render_frames.params.region":
    'A part of the picture to render at the full size of a picture, in world units: {"x": -960, "y": 0, "width": 960, "height": 540} is the bottom left quarter of a 1920×1080 picture; x and y are its top left corner, from the center of the picture.',
  "tools.aq_render_frames.params.annotate":
    "true draws a box with the id and name of every clip on the picture; a list of clip ids draws only those, 1 to 20.",
  "tools.aq_render_frames.params.compare":
    '"task_start", or a revision such as "k3x9:42" from the rev line of an earlier result of this conversation: each time is rendered as the project was then and as it is now, with what differs. At most 4 times.',
  "tools.aq_audio_analyze.description":
    "Mixes a part of a timeline as the export mixes it and measures it: stereo at 48 kHz, with volumes and sound transitions as set; muted tracks are not heard, and only soloed tracks where a track is soloed. Nothing is played to the user. loudness gives the integrated loudness in LUFS and the loudest 3 seconds (short-term max), as ITU-R BS.1770-4 and EBU R128 measure them, the true peak in dBTP (between samples too) and the sample peak in dBFS. For orientation: online video and streaming aim at about -14 LUFS integrated with the true peak at or below -1 dBTP; broadcast (EBU R128) at -23 LUFS. silence gives each stretch below -50 dBFS for 0.3 s or longer. clipping gives each place where samples stay at full scale for 3 samples or more, or go over it (the export cuts those), with how many samples. envelope gives where the sound is loudest, its attack (from 10% to 90% of its peak) and its decay (from the peak to 40 dB below it): check a short sound made by code with it. clip measures that clip alone over its time on the timeline, as if nothing else sounded. Times in the result are seconds on the timeline. A part where the file of an asset is not on this computer, or the code of a sound did not make it, gives an error with the reason and no numbers: a measure is only ever of what the export would give.",
  "tools.aq_audio_analyze.params.range":
    'The part to measure: {"from": "0", "to": "30"}, seconds as strings, at most 600 seconds long. Without it, the whole timeline, or the time of clip on it.',
  "tools.aq_audio_analyze.params.timeline":
    "Timeline id, as aq_project_status lists it. Without it, the first timeline of the project.",
  "tools.aq_audio_analyze.params.version":
    "Picture format id, as aq_project_status lists it; the sound of every format is the same today. Without it, the first format.",
  "tools.aq_audio_analyze.params.clip":
    "A clip id: measures only that clip, as if nothing else sounded, such as a sound made by code.",
  "tools.aq_audio_analyze.params.what":
    'Which measures: "loudness", "silence", "clipping", "envelope". By default loudness, silence and clipping; with clip, loudness, clipping and envelope.',
  "tools.aq_check_run.description":
    "Lists the problems of the project: files that do not fit the project format, references to things that are missing, values that do not fit what a scene describes, errors that scene and sound code threw when the editor ran it, and things this editor version does not do yet (they do not appear in the preview or the export). Runtime errors come only from code the editor has run: a scene runs while one of its clips is in the preview, and again after its code changes; the result lists changed code that has not run since. aq_edit results already include the problems that come from the project data alone. A fix line is an aq_edit operation that resolves that problem.",
  "tools.aq_check_run.params.checks":
    '"format": whether every document fits the project format; "problems": all problems the editor knows of. Both by default.',
  "tools.aq_check_run.params.severity": "Only problems of these kinds.",
  "tools.aq_check_run.params.subject": "Only problems of this object id or file path.",
  "tools.aq_check_run.params.limit": "How many problems at most, 1 to {max}; {default} by default.",
  "tools.aq_check_run.params.cursor":
    "Where to go on, as the last line of an earlier result of this call says.",
} satisfies TextTable;
