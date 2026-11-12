import type { TextTable } from "./table.ts";

/**
 * What AI reads about each operation of aq_edit. In the list of tools: `summary`, the description
 * of the operation's branch of the schema, and words for a parameter where it means something else
 * in this operation than `PARAM_TEXTS` says (`params.<name>`). In the manual only, on the page
 * "ops/<operation>" that aq_guide gives: `description`, `fields.<path>` for a parameter or a field
 * inside one (a dotted path, without the places of lists), `errors.<code>` for why the operation
 * gives an error of its own, and `examples` (the first the simplest; their ids come from the sample
 * project, packages/schema/fixtures/v1, and each one runs on it, the tests hold them to that). They
 * say what is so: what an operation does, takes, gives back and refuses, and why.
 */
export const OPERATION_TEXTS = {
  "ops.project.rename.summary": "renames the project",
  "ops.project.rename.description":
    "Sets the name of the project, as animaquill.json has it and the editor shows it. The id of the project stays as it is.",
  "ops.project.rename.examples": [
    { title: "A new name for the project", params: { name: "What atoms are" } },
  ],

  "ops.project.setFrameRate.summary": "sets the frame rate the timeline counts frames by",
  "ops.project.setFrameRate.description":
    'Sets fps of animaquill.json, the editing frame rate: the ruler counts frames by it and drags land on its frames. Times in the project stay as they are, because they are exact seconds, not frame numbers. Each picture format has an export frame rate of its own, which this leaves as it is. A frame rate is a string, such as "30", "25" or "30000/1001".',
  "ops.project.setFrameRate.examples": [
    { title: "25 frames a second", params: { fps: "25" } },
    { title: "The NTSC rate of 29.97", params: { fps: "30000/1001" } },
  ],

  "ops.asset.update.summary": "renames an asset or changes its tags",
  "ops.asset.update.description":
    "Changes the name or the tags of an asset of assets.json. Clips that use the asset stay on it. Where its file is and what the file is (path, hash, size, media info) only the user changes. aq_project_status and aq_search list assets with their ids.",
  "ops.asset.update.fields.changes.name": "New name, not empty.",
  "ops.asset.update.fields.changes.tags":
    "Words to find it by, each 1 to 40 characters, at most 30, each one once; they take the place of the tags it had, and an empty list takes them all away.",
  "ops.asset.update.errors.not-found": "There is no asset with this id.",
  "ops.asset.update.errors.invalid-value":
    "The asset with these changes does not fit the project format.",
  "ops.asset.update.examples": [
    {
      title: "A new name for an asset",
      params: { asset: "interview", changes: { name: "Interview, take 2" } },
    },
    {
      title: "Tags of an asset",
      params: { asset: "logo", changes: { tags: ["brand", "intro"] } },
    },
  ],

  "ops.asset.remove.summary": "removes an asset, and with withUses the clips that use it",
  "ops.asset.remove.description":
    "Takes an asset out of assets.json; its file stays in the project folder. While clips use it, or versions make clips use it, it fails with asset-in-use, unless withUses is true: then those clips go in the same step, with the joins at their edges, and so does what versions change to use it. While code refers to it with aq.asset, it fails with asset-in-use whatever withUses says. dry_run lists everything it would remove.",
  "ops.asset.remove.errors.not-found": "There is no asset with this id.",
  "ops.asset.remove.errors.asset-in-use":
    "Clips or versions use the asset and withUses is not true, or the code of a scene refers to it (the error names the file).",
  "ops.asset.remove.examples": [
    { title: "An asset that no clip uses", params: { asset: "font-sans" } },
    {
      title: "An asset and the clips that use it",
      params: { asset: "raw-footage", withUses: true },
    },
  ],

  "ops.scene.add.summary":
    "creates a scene (HTML, CSS and JavaScript that draw a picture) with its files",
  "ops.scene.add.description":
    'Creates the folder scenes/<id>/ with the manifest of the scene (scene.json) and its first files, as one step. manifest.entry is the file that starts it, an .html, .js or .mjs file, and has to be one of files. manifest.runtime is the version of the scene runtime the code is written for: 1 in this editor. files maps paths inside the folder to their text: scenes hold text only, and pictures and fonts are assets, which the code gets with aq.asset. A file is at most 8 MiB. Each param of the manifest is a property param.<param id> of the clips that show the scene. Clips show it with source {"kind":"scene","scene":"<id>"}; clip.add can come in the same batch. Later changes of its code are for aq_file_edit and aq_file_write.',
  "ops.scene.add.fields.files":
    'Path in the folder of the scene → text of the file, such as {"index.html":"<!doctype html>…","main.js":"…"}. Paths are relative, with / between folders; scene.json is the manifest, no file.',
  "ops.scene.add.errors.id-taken": "There is a scene with this id already.",
  "ops.scene.add.errors.invalid-value":
    "A path of files is no path of a code file in the folder of the scene, such as scene.json.",
  "ops.scene.add.errors.not-found":
    "A file would go in the folder of a scene or sound that is not there.",
  "ops.scene.add.errors.file-too-large": "A file is larger than 8 MiB.",
  "ops.scene.add.errors.path-taken":
    'Two of files need the same place: a file where another one needs a folder, as "a" and "a/b.js".',
  "ops.scene.add.errors.runtime-too-new":
    "manifest.runtime is newer than this editor's runtime, 1.",
  "ops.scene.add.errors.missing-entry": "manifest.entry is not one of files.",
  "ops.scene.add.examples": [
    {
      title: "A scene of one file",
      params: {
        id: "lower_third",
        manifest: { name: "Lower third", entry: "index.html", runtime: 1 },
        files: { "index.html": "<!doctype html><h1>Name</h1>" },
      },
    },
    {
      title: "A scene with a parameter that its code reads every frame",
      params: {
        id: "caption_card",
        manifest: {
          name: "Caption card",
          entry: "index.html",
          runtime: 1,
          params: [{ id: "text", name: "Text", type: "text", default: "Hello" }],
        },
        files: {
          "index.html":
            '<!doctype html><p id="line"></p><script type="module" src="main.js"></script>',
          "main.js":
            'const line = document.getElementById("line");\naq.frame((seconds) => {\n  line.textContent = aq.param("text", seconds);\n});\n',
        },
      },
    },
  ],

  "ops.scene.update.summary": "changes the manifest of a scene: name, entry, params, presets",
  "ops.scene.update.description":
    "Changes fields of the manifest of a scene (its scene.json): name, description, entry, runtime, params, tags and presets. The fields in changes take the place of what they were, whole: params with a new param is the full list of params. clear takes the fields it names away. The entry has to be one of the files of the scene. The code of the scene is for aq_file_edit and aq_file_write; aq_object_read gives the manifest as it is.",
  "ops.scene.update.params.changes": "The fields of the SceneManifest to change; the rest stay.",
  "ops.scene.update.errors.not-found": "There is no scene with this id.",
  "ops.scene.update.errors.invalid-value":
    "The manifest with these changes does not fit the project format.",
  "ops.scene.update.errors.runtime-too-new": "runtime is newer than this editor's runtime, 1.",
  "ops.scene.update.errors.missing-entry": "The entry is not one of the files of the scene.",
  "ops.scene.update.examples": [
    {
      title: "A new name for a scene",
      params: { scene: "title", changes: { name: "Opening title" } },
    },
    {
      title: "A new description, and no presets",
      params: {
        scene: "title",
        changes: { description: "A numbered chapter title" },
        clear: ["presets"],
      },
    },
  ],

  "ops.scene.remove.summary":
    "removes a scene and its files, and with withUses the clips that use it",
  "ops.scene.remove.description":
    "Takes a scene out of the project with all the files of its folder. While clips use it, or versions make clips use it, it fails with scene-in-use, unless withUses is true: then those clips go in the same step, with the joins at their edges, and so does what versions change to use it. dry_run lists everything it would remove.",
  "ops.scene.remove.errors.not-found": "There is no scene with this id.",
  "ops.scene.remove.errors.scene-in-use":
    "Clips or versions use the scene and withUses is not true.",
  "ops.scene.remove.examples": [
    { title: "A scene and its clips", params: { scene: "title", withUses: true } },
  ],

  "ops.sound.add.summary": "creates a sound made by code, with its files",
  "ops.sound.add.description":
    'Creates the folder sounds/<id>/ with the manifest of the sound (sound.json) and its first files, as one step. Sound code computes audio once, in a worker without a page, so manifest.entry is a .js or .mjs file, and has to be one of files. manifest.runtime is 1 in this editor. outputs names several sounds that one program makes; a clip picks one with source.output. A file is at most 8 MiB. Clips play it with source {"kind":"sound","sound":"<id>"} on an audio track.',
  "ops.sound.add.fields.files":
    'Path in the folder of the sound → text of the file, such as {"sound.js":"…"}. Paths are relative, with / between folders.',
  "ops.sound.add.errors.id-taken": "There is a sound with this id already.",
  "ops.sound.add.errors.invalid-value":
    "The entry is not a .js or .mjs file, or a path of files is no path of a code file in the folder of the sound.",
  "ops.sound.add.errors.not-found":
    "A file would go in the folder of a scene or sound that is not there.",
  "ops.sound.add.errors.file-too-large": "A file is larger than 8 MiB.",
  "ops.sound.add.errors.path-taken":
    'Two of files need the same place: a file where another one needs a folder, as "a" and "a/b.js".',
  "ops.sound.add.errors.runtime-too-new":
    "manifest.runtime is newer than this editor's runtime, 1.",
  "ops.sound.add.errors.missing-entry": "manifest.entry is not one of files.",
  "ops.sound.add.examples": [
    {
      title: "A sound of one file, a second of silence",
      params: {
        id: "whoosh",
        manifest: { name: "Whoosh", entry: "sound.js", runtime: 1 },
        files: { "sound.js": "aq.sound(({ frames }) => new Float32Array(frames));\n" },
      },
    },
  ],

  "ops.sound.update.summary": "changes the manifest of a sound: name, entry, params, outputs",
  "ops.sound.update.description":
    "Changes fields of the manifest of a sound (its sound.json): name, description, entry, runtime, params, tags and outputs. The fields in changes take the place of what they were, whole. clear takes the fields it names away. The entry has to be a .js or .mjs file of the sound. aq_object_read gives the manifest as it is.",
  "ops.sound.update.params.changes": "The fields of the SoundManifest to change; the rest stay.",
  "ops.sound.update.errors.not-found": "There is no sound with this id.",
  "ops.sound.update.errors.invalid-value":
    "The manifest with these changes does not fit the project format, or its entry is no .js or .mjs file.",
  "ops.sound.update.errors.runtime-too-new": "runtime is newer than this editor's runtime, 1.",
  "ops.sound.update.errors.missing-entry": "The entry is not one of the files of the sound.",
  "ops.sound.update.examples": [
    { title: "A new name for a sound", params: { sound: "impacts", changes: { name: "Hits" } } },
  ],

  "ops.sound.remove.summary":
    "removes a sound and its files, and with withUses the clips that use it",
  "ops.sound.remove.description":
    "Takes a sound out of the project with all the files of its folder. While clips use it, or versions make clips use it, it fails with sound-in-use, unless withUses is true: then those clips go in the same step, with the joins at their edges, and so does what versions change to use it.",
  "ops.sound.remove.errors.not-found": "There is no sound with this id.",
  "ops.sound.remove.errors.sound-in-use":
    "Clips or versions use the sound and withUses is not true.",
  "ops.sound.remove.examples": [
    { title: "A sound and its clips", params: { sound: "impacts", withUses: true } },
  ],

  "ops.source.replace.summary":
    "makes every clip that uses an asset, scene or sound use another one of the same kind",
  "ops.source.replace.description":
    "Every clip of every timeline that uses from, and every version that makes a clip use it, uses to instead; everything else about the clips stays as it is. from need not be in the project any more, as when a file took it away; to has to be. An asset takes the place of an asset that clips can show: a video or image clip needs one of its own kind, and an audio clip an audio or video asset.",
  "ops.source.replace.params.kind": '"asset", "scene" or "sound".',
  "ops.source.replace.params.from": "Id of what clips use now.",
  "ops.source.replace.params.to": "Id to use instead, same kind.",
  "ops.source.replace.errors.invalid-value":
    "from and to are the same, or a clip cannot show the asset to (the error names the clip).",
  "ops.source.replace.errors.not-found": "There is no asset, scene or sound to of this kind.",
  "ops.source.replace.errors.not-in-use": "No clip and no version uses from.",
  "ops.source.replace.examples": [
    {
      title: "The English narration in place of the Chinese one",
      params: { kind: "asset", from: "narration-zh", to: "narration-en" },
    },
  ],

  "ops.file.remove.summary": "removes a code file that is no entry",
  "ops.file.remove.description":
    "Takes a code file out of a scene, a sound or code/. The file that starts a scene or a sound (its entry) stays: scene.remove and sound.remove take a whole scene or sound away. Code that imports the file is not changed.",
  "ops.file.remove.errors.not-found": "There is no file at this path.",
  "ops.file.remove.errors.entry-in-use": "The file is the entry of its scene or sound.",
  "ops.file.remove.examples": [{ title: "A shared file", params: { path: "code/animate.js" } }],

  "ops.file.rename.summary": "renames or moves a code file",
  "ops.file.rename.description":
    "Gives a code file another path, within a scene, a sound or code/, or from one of them to another. The entry of a scene or sound can only get another name in its own folder, and the manifest follows it. Code that imports the file by its old path is not changed: aq_search with kind text finds those imports.",
  "ops.file.rename.params.from": "Path now.",
  "ops.file.rename.params.to": "New path.",
  "ops.file.rename.errors.not-found":
    "There is no file at from, or to is in the folder of a scene or sound that is not there.",
  "ops.file.rename.errors.path-taken":
    "There is a file at to already, or to needs a place that a file or folder has.",
  "ops.file.rename.errors.entry-in-use": "from is an entry, and to is outside its folder.",
  "ops.file.rename.errors.file-too-large": "The file is larger than 8 MiB.",
  "ops.file.rename.errors.invalid-value":
    "to is no path of a code file, or the entry of a sound would not be a .js or .mjs file.",
  "ops.file.rename.errors.runtime-too-new":
    "The manifest of the scene or sound that follows the entry names a runtime newer than 1.",
  "ops.file.rename.errors.missing-entry": "The manifest that follows the entry does not find it.",
  "ops.file.rename.examples": [
    {
      title: "A shared file with a new name",
      params: { from: "code/animate.js", to: "code/motion.js" },
    },
  ],

  "ops.timeline.rename.summary": "renames a timeline",
  "ops.timeline.rename.description":
    "Sets the name of a timeline, which people see. Its id, and the folder timelines/<id>/, stay.",
  "ops.timeline.rename.errors.not-found": "There is no timeline with this id.",
  "ops.timeline.rename.examples": [
    { title: "A new name for a timeline", params: { timeline: "main", name: "Main cut" } },
  ],

  "ops.section.add.summary": "adds a section to a timeline, which makes it longer",
  "ops.section.add.description":
    "A timeline is made of sections laid end to end, and its length is the sum of their durations. section.add puts a new one before the section named by before, or last. Clips keep their start times: they are on the timeline, not in sections. Sections, tracks and clips of one timeline share their ids.",
  "ops.section.add.errors.not-found": "There is no timeline with this id, or no section before.",
  "ops.section.add.errors.id-taken":
    "A section, track or clip of the timeline has this id already.",
  "ops.section.add.examples": [
    {
      title: "A section at the end",
      params: { timeline: "main", duration: "4", name: "Credits" },
    },
    {
      title: "A section before another one",
      params: { timeline: "main", id: "section_recap", duration: "3", before: "section_end" },
    },
  ],

  "ops.section.update.summary": "changes the duration or name of a section",
  "ops.section.update.description":
    "Changes the duration or the name of a section. The timeline gets longer or shorter by as much; clips keep their start times, so a shorter section can leave clips past the end of the timeline.",
  "ops.section.update.errors.not-found": "There is no timeline or section with this id.",
  "ops.section.update.examples": [
    {
      title: "A longer section",
      params: { timeline: "main", section: "section_intro", duration: "6" },
    },
  ],

  "ops.section.remove.summary": "removes a section; a timeline keeps at least one",
  "ops.section.remove.description":
    "Takes a section away; the timeline is shorter by its duration. Clips keep their start times. The last section of a timeline stays.",
  "ops.section.remove.errors.not-found": "There is no timeline or section with this id.",
  "ops.section.remove.errors.last-section": "It is the only section of the timeline.",
  "ops.section.remove.examples": [
    { title: "A section", params: { timeline: "main", section: "section_end" } },
  ],

  "ops.track.add.summary": "adds a video, audio or caption track",
  "ops.track.add.description":
    "Adds a track to a timeline: video tracks hold video, image, scene, timeline and color clips; audio tracks hold audio, sound, music and timeline clips; caption tracks hold captions. Tracks are listed from the back of the picture to the front, and a new one goes before the track named by before, or in front of all. Sections, tracks and clips of one timeline share their ids.",
  "ops.track.add.params.kind": '"video", "audio" or "caption".',
  "ops.track.add.errors.not-found": "There is no timeline with this id, or no track before.",
  "ops.track.add.errors.id-taken": "A section, track or clip of the timeline has this id already.",
  "ops.track.add.examples": [
    {
      title: "A video track in front of the others",
      params: { timeline: "main", kind: "video", name: "Titles" },
    },
    {
      title: "An audio track for sound effects, listed before the music track",
      params: {
        timeline: "main",
        id: "track_sfx",
        kind: "audio",
        name: "Effects",
        before: "track_music",
      },
    },
  ],

  "ops.track.update.summary":
    "changes the name, hidden, muted, solo, locked, group or role of a track",
  "ops.track.update.description":
    "Changes settings of a track. hidden is for video and caption tracks; muted, solo and role are for audio tracks: a setting that a kind of track does not have fails with invalid-value. locked only keeps people from changing its clips in the editor: AI changes them all the same.",
  "ops.track.update.fields.changes.locked":
    "true keeps people from dragging, trimming or deleting its clips in the editor; aq_edit changes them all the same.",
  "ops.track.update.fields.changes.group": "Name of a group of tracks, as people see it.",
  "ops.track.update.fields.changes.hidden":
    "true leaves the track out of the picture; video and caption tracks.",
  "ops.track.update.fields.changes.muted": "true silences the track; audio tracks.",
  "ops.track.update.fields.changes.solo":
    "true plays only the tracks that are solo, while any is; audio tracks.",
  "ops.track.update.fields.changes.role":
    '"voice" follows the language, "music" plays across sections, or "effects"; audio tracks.',
  "ops.track.update.errors.not-found": "There is no timeline or track with this id.",
  "ops.track.update.errors.invalid-value": "The kind of track does not have one of these settings.",
  "ops.track.update.examples": [
    {
      title: "A muted track",
      params: { timeline: "main", track: "track_music", changes: { muted: true } },
    },
  ],

  "ops.track.move.summary": "moves a track before another one, or last",
  "ops.track.move.description":
    "Changes the order of the tracks, which is the order of the picture from back to front: the track goes before the track named by before, or in front of all. Its clips go with it.",
  "ops.track.move.errors.not-found":
    "There is no timeline or track with this id, or no track before.",
  "ops.track.move.examples": [
    { title: "A track in front of all", params: { timeline: "main", track: "track_video" } },
    {
      title: "A track behind another one",
      params: { timeline: "main", track: "track_overlay", before: "track_video" },
    },
  ],

  "ops.track.remove.summary": "removes a track with all its clips",
  "ops.track.remove.description":
    "Takes a track away with all its clips and their joins, as one step. dry_run lists everything it would remove.",
  "ops.track.remove.errors.not-found": "There is no timeline or track with this id.",
  "ops.track.remove.examples": [
    { title: "A track and its clips", params: { timeline: "main", track: "track_overlay" } },
  ],

  "ops.clip.add.summary":
    "puts a clip on a track: an asset, a scene, a sound, a color or a caption",
  "ops.clip.add.description":
    'Puts a new clip on a track, from start (on the timeline) for duration. source says what it shows or plays, and the kind of the track has to hold it (topic "types/ClipSource"). A scene or sound that is not in the project fails with not-found; an asset id is not checked, and a clip of an asset that is not in assets.json is added as it is. A clip past the end of the timeline makes its last section longer. Clips already in the way make it fail with overlap, unless overlap is "overwrite": then the parts in the way are cut away. properties sets values and keyframes from the start (paths: topic "howto/keyframes"); enter and exit are transitions at its edges; effects are the effects on its picture, whose parameters go in properties as effect.<effect id>.<parameter>. Sections, tracks and clips of one timeline share their ids; with id, later operations of the batch can name the clip.',
  "ops.clip.add.params.enter": "Transition at its start.",
  "ops.clip.add.params.exit": "Transition at its end.",
  "ops.clip.add.fields.properties":
    'Property path → a value or keyframes, such as {"opacity":0.8,"param.title":"Hello"}; keyframe times are on the clip\'s clock (topic "howto/times").',
  "ops.clip.add.fields.effects.id": "Id of the effect, unique on this clip.",
  "ops.clip.add.fields.effects.type": 'Kind of effect, such as "blur" or "crop".',
  "ops.clip.add.fields.effects.start":
    "When it starts to work, seconds from the start of the clip; without it, the start of the clip.",
  "ops.clip.add.fields.effects.end":
    "When it stops working, seconds from the start of the clip; without it, the end of the clip.",
  "ops.clip.add.errors.not-found":
    "There is no timeline or track with this id, or the scene or sound of source is not there.",
  "ops.clip.add.errors.wrong-track": "The kind of the track cannot hold this kind of clip.",
  "ops.clip.add.errors.id-taken": "A section, track or clip of the timeline has this id already.",
  "ops.clip.add.errors.not-animatable":
    "A property in properties that cannot have keyframes has them, such as fit.",
  "ops.clip.add.errors.overlap":
    'Clips on the track are in the way and overlap is not "overwrite" (the error names them).',
  "ops.clip.add.errors.not-moved":
    "Only for what people do in the editor; aq_edit does not give it.",
  "ops.clip.add.examples": [
    {
      title: "A color clip",
      params: {
        timeline: "main",
        track: "track_overlay",
        start: "0",
        duration: "3",
        source: { kind: "color", color: "#3366ff" },
      },
    },
    {
      title: "A clip of a scene with an id, a parameter and a fade in",
      params: {
        timeline: "main",
        track: "track_video",
        id: "clip_title2",
        start: "31",
        duration: "4",
        source: { kind: "scene", scene: "title" },
        properties: { "param.title": "Chapter 2" },
        enter: { type: "fade", duration: "0.5" },
      },
    },
  ],

  "ops.clip.remove.summary": "removes clips",
  "ops.clip.remove.description":
    "Takes clips away, as one step, with the joins at their edges. Nothing else moves: what was after them keeps its place.",
  "ops.clip.remove.errors.not-found":
    "There is no timeline with this id, or one of the clips is not on it.",
  "ops.clip.remove.examples": [
    { title: "A clip", params: { timeline: "main", clips: ["clip_idea"] } },
  ],

  "ops.clip.update.summary":
    "changes the name, source, offset, loop, hidden, draft, link or section fit of a clip",
  "ops.clip.update.description":
    "Changes fields of a clip itself. What it shows (source) can change, as long as its track holds the new kind. Where the clip is and how long are for clip.move and clip.trim; its transitions for clip.setTransition; its properties and keyframes for property.edit; its effects for the effect operations. clear takes the fields it names away.",
  "ops.clip.update.fields.changes.source":
    "What it shows or plays now; its track has to hold the kind.",
  "ops.clip.update.fields.changes.offset":
    "Reading of the clip's clock at its first frame, seconds; keyframes are on that clock, so they stay with the picture.",
  "ops.clip.update.fields.changes.loop": "true plays the media again from its start when it ends.",
  "ops.clip.update.fields.changes.hidden": "true leaves the clip out of the picture and the sound.",
  "ops.clip.update.fields.changes.draft": "true marks it a sketch to look at an idea.",
  "ops.clip.update.fields.changes.link":
    "Clips with the same link move together when people drag them, like the picture and sound of a video; clip.move moves only the clips it lists.",
  "ops.clip.update.fields.changes.sectionFit":
    'What it does when its section gets longer in a version: "stretch" scales it, "hold" holds its end, "span" runs on across sections.',
  "ops.clip.update.errors.not-found": "There is no timeline or clip with this id.",
  "ops.clip.update.errors.invalid-value":
    "The clip with these changes does not fit the project format.",
  "ops.clip.update.errors.wrong-track":
    "The track of the clip cannot hold the kind of the new source.",
  "ops.clip.update.errors.overlap": "The clip would overlap other clips on its track.",
  "ops.clip.update.examples": [
    {
      title: "A new name for a clip",
      params: { timeline: "main", clip: "clip_title", changes: { name: "Opening" } },
    },
    {
      title: "Another asset for a clip, and no draft mark",
      params: {
        timeline: "main",
        clip: "clip_idea",
        changes: { source: { kind: "image", media: { asset: "logo" } } },
        clear: ["draft"],
      },
    },
  ],

  "ops.clip.setTransition.summary":
    "puts a transition at the start (enter) or end (exit) of a clip, or takes it away with null",
  "ops.clip.setTransition.description":
    'Sets the transition at the beginning of a clip (enter: from nothing to the clip) or at its end (exit: from the clip to nothing), such as a fade in or out; null takes one away, and an edge left out stays as it is. Built-in transitions for pictures are fade, dip, wipe and push; for sound fade and fade-linear (topic "howto/transitions"). enter and exit together fit in the clip. A transition between two clips that touch is a join: join.add.',
  "ops.clip.setTransition.errors.not-found": "There is no timeline or clip with this id.",
  "ops.clip.setTransition.errors.transition-missing":
    "There is no such transition, it comes from a plugin that is not installed, or it does not work on this kind of clip (wipe on sound).",
  "ops.clip.setTransition.errors.transition-unsupported":
    "This editor cannot do this transition at this edge yet, such as transitions of captions.",
  "ops.clip.setTransition.errors.invalid-value":
    "values has a property the transition does not have, or a value out of its range.",
  "ops.clip.setTransition.errors.transition-too-long":
    "The enter and exit transitions together, or a transition and the join at the other edge, would be longer than the clip.",
  "ops.clip.setTransition.examples": [
    {
      title: "A fade out",
      params: { timeline: "main", clip: "clip_interview", exit: { type: "fade", duration: "0.5" } },
    },
    {
      title: "A wipe in to the left, and no fade out",
      params: {
        timeline: "main",
        clip: "clip_card",
        enter: { type: "wipe", duration: "0.6", values: { direction: "left" } },
        exit: null,
      },
    },
  ],

  "ops.join.add.summary": "puts a transition on the cut between two clips that touch",
  "ops.join.add.description":
    'Puts a join, a transition from one clip to the next, on the cut between two clips on one video or audio track, where from ends exactly where to starts. A cut has one join at most. The transition is named by type (built in: fade, dip, wipe, push for pictures; fade, fade-linear for sound), as in topic "types/Transition". Without duration it takes the default length of the transition (0.5 s for pictures, 0.2 s for sound), or as much as fits. align says where it is around the cut: "center" half before and half after, "before" it ends at the cut, "after" it starts at it; without align the editor picks by how much the two clips have past the cut. The join moves with the clips while they stay together; moving one of them apart removes it.',
  "ops.join.add.params.from": "Clip id before the cut.",
  "ops.join.add.params.to": "Clip id after the cut, starting where the first ends.",
  "ops.join.add.params.duration": "Length, seconds; leave out for as much as fits.",
  "ops.join.add.fields.type":
    "Built in: fade, dip, wipe or push for pictures, fade or fade-linear for sound; a name with a dot is a transition of a plugin.",
  "ops.join.add.errors.not-found":
    "There is no timeline with this id, or one of the clips is not on it.",
  "ops.join.add.errors.invalid-value":
    "from and to are the same clip, or values does not fit the transition.",
  "ops.join.add.errors.not-adjacent":
    "The clips are on different tracks, or there is a gap between them.",
  "ops.join.add.errors.join-taken":
    "The cut has a join already (the error names it): join.update changes it.",
  "ops.join.add.errors.id-taken": "There is a join with this id already.",
  "ops.join.add.errors.transition-too-long":
    "There is no room for a join at this cut, or duration is longer than what fits (the error gives the longest).",
  "ops.join.add.errors.wrong-track": "The clips are on a caption track, which has no joins.",
  "ops.join.add.errors.transition-missing":
    "There is no such transition, or it does not work on the media of this track.",
  "ops.join.add.errors.transition-unsupported":
    "This editor cannot do this transition as a join yet.",
  "ops.join.add.examples": [
    {
      title: "A cross-fade between two clips",
      params: { timeline: "main", from: "clip_interview", to: "clip_logo", type: "fade" },
    },
    {
      title: "A push to the left that ends at the cut",
      params: {
        timeline: "main",
        from: "clip_interview",
        to: "clip_logo",
        type: "push",
        duration: "0.4",
        align: "before",
        values: { direction: "left" },
      },
    },
  ],

  "ops.effect.add.summary": "puts an effect on a clip, with the values of its parameters",
  "ops.effect.add.description":
    'Puts an effect on the picture of a clip on a video track. Effects work in the order of the list of the clip, each on what the one before made; index puts it at a place of the list, and without index it goes last. Built-in effects: brightness, contrast, saturation, temperature, blur, crop (topic "howto/effects"). The parameters of the effect are properties of the clip, effect.<effect id>.<parameter>: values sets them here, plain or with keyframes, and property.edit changes them later. A parameter left out has a default that leaves the picture as it is. start and end, in seconds from the start of the clip, limit when it works.',
  "ops.effect.add.params.start": "Seconds from the clip's start.",
  "ops.effect.add.params.end": "Seconds from the clip's start.",
  "ops.effect.add.fields.type":
    "Built in: brightness, contrast, saturation, temperature, blur or crop; a name with a dot is an effect of a plugin.",
  "ops.effect.add.fields.values":
    'Parameter → a value or keyframes, such as {"radius":8} for blur; the effect\'s own parameter names, without effect.<id>.',
  "ops.effect.add.errors.not-found":
    "There is no timeline or clip with this id, no effect of this type, or no parameter of this name in values (the error names it).",
  "ops.effect.add.errors.wrong-track":
    "The clip is not on a video track: only those have effects so far.",
  "ops.effect.add.errors.invalid-value":
    "A value does not fit its parameter, or start and end are not within the clip with start before end.",
  "ops.effect.add.errors.id-taken": "The clip has an effect with this id already.",
  "ops.effect.add.errors.not-animatable":
    "A parameter that cannot have keyframes has them, such as the edge of blur.",
  "ops.effect.add.examples": [
    {
      title: "A blur",
      params: { timeline: "main", clip: "clip_title", type: "blur", values: { radius: 8 } },
    },
    {
      title: "A blur that grows over the first second, first in the list",
      params: {
        timeline: "main",
        clip: "clip_logo",
        id: "fx_soft",
        type: "blur",
        index: 0,
        values: {
          radius: {
            keys: [
              { time: "0", value: 0 },
              { time: "1", value: 12 },
            ],
          },
        },
      },
    },
  ],

  "ops.effect.remove.summary": "takes effects off a clip",
  "ops.effect.remove.description":
    "Takes effects off a clip with their parameters (the properties effect.<effect id>.*), also in versions.",
  "ops.effect.remove.params.effects": "Effect ids of the clip.",
  "ops.effect.remove.errors.not-found":
    "There is no timeline or clip with this id, or the clip has no effect with one of these ids.",
  "ops.effect.remove.examples": [
    {
      title: "An effect",
      params: { timeline: "main", clip: "clip_interview", effects: ["fx_blur"] },
    },
  ],

  "ops.effect.move.summary":
    "moves an effect in the list of its clip, which changes what it works on",
  "ops.effect.move.description":
    "Moves an effect to another place in the list of its clip. Effects work in the order of the list, each on what the one before made, so the order changes the picture. index counts from 0 in the list without the effect.",
  "ops.effect.move.errors.not-found":
    "There is no timeline or clip with this id, or the clip has no such effect.",
  "ops.effect.move.examples": [
    {
      title: "An effect first in the list",
      params: { timeline: "main", clip: "clip_interview", effect: "fx_grade", index: 0 },
    },
  ],

  "ops.effect.update.summary": "turns an effect on or off, or changes when it works",
  "ops.effect.update.description":
    "Turns an effect on or off, or changes when it works. Off, it does nothing and keeps its place and parameters. start and end are seconds from the start of the clip, within it; null takes one away, which is the start or the end of the clip. What is left out stays as it is. Its parameters are properties: property.edit changes them.",
  "ops.effect.update.params.start": "Seconds from the clip's start; null for its start.",
  "ops.effect.update.params.end": "Seconds from the clip's start; null for its end.",
  "ops.effect.update.errors.not-found":
    "There is no timeline or clip with this id, or the clip has no such effect.",
  "ops.effect.update.errors.invalid-value":
    "start and end are not within the clip, with start before end.",
  "ops.effect.update.examples": [
    {
      title: "An effect turned off",
      params: { timeline: "main", clip: "clip_interview", effect: "fx_blur", enabled: false },
    },
    {
      title: "An effect from 2 seconds into its clip to its end",
      params: {
        timeline: "main",
        clip: "clip_interview",
        effect: "fx_blur",
        start: "2",
        end: null,
      },
    },
  ],

  "ops.join.update.summary": "changes the type, duration, align, curve or values of a join",
  "ops.join.update.description":
    "Changes a join. A new type (or transition, or library with resource) names another transition and takes the place of what it was, with values, unless values comes along. values is all of them at once: what it leaves out is the default. null takes curve, align or values away. A longer join has to fit the clips at the cut.",
  "ops.join.update.fields.changes.type": 'Another built-in transition, such as "dip" or "wipe".',
  "ops.join.update.fields.changes.duration": "Length, seconds.",
  "ops.join.update.fields.changes.curve":
    "Speed curve [x1, y1, x2, y2] as in CSS cubic-bezier(); null for an even speed.",
  "ops.join.update.fields.changes.values":
    'Values of the transition\'s own properties, such as {"direction":"left"}; null for the defaults.',
  "ops.join.update.fields.changes.align": '"center", "before" or "after" the cut; null for center.',
  "ops.join.update.errors.not-found": "There is no timeline or join with this id.",
  "ops.join.update.errors.invalid-value":
    "The join with these changes does not fit the project format, values do not fit the transition, or only part of the join is left (join.remove takes it away).",
  "ops.join.update.errors.transition-missing":
    "There is no such transition, or it does not work on the media of this track.",
  "ops.join.update.errors.transition-unsupported":
    "This editor cannot do this transition as a join yet.",
  "ops.join.update.errors.wrong-track": "The track of the join is a caption track.",
  "ops.join.update.errors.transition-too-long":
    "The join would be longer than what fits at the cut (the error gives the longest).",
  "ops.join.update.examples": [
    {
      title: "A longer join",
      params: { timeline: "main", join: "join_1", changes: { duration: "1.5" } },
    },
    {
      title: "A dip to white in place of a fade",
      params: {
        timeline: "main",
        join: "join_1",
        changes: { type: "dip", values: { color: "#ffffff" } },
      },
    },
  ],

  "ops.join.remove.summary": "removes joins",
  "ops.join.remove.description":
    "Takes joins away; the clips meet at a plain cut. It works for any join, also one that only part of is left.",
  "ops.join.remove.errors.not-found": "There is no timeline or join with this id.",
  "ops.join.remove.examples": [
    { title: "A join", params: { timeline: "main", joins: ["join_1"] } },
  ],

  "ops.clip.move.summary": "moves clips to other starts or tracks, in one step",
  "ops.clip.move.description":
    'Moves clips to new start times on the timeline, to other tracks of the same timeline, or both, as one step: a place one clip leaves is free for another of the same batch. What a clip shows moves with it, and so do its keyframes, effects and transitions. Each clip appears once. Clips in the way make it fail with overlap, unless overlap is "overwrite": then the parts in the way are cut away. A clip past the end of the timeline makes its last section longer. Joins go along while their two clips stay together; a join whose clips come apart is removed, and the result lists it under changed.',
  "ops.clip.move.params.clips": 'Each {"clip":id,"start"?,"track"?}.',
  "ops.clip.move.fields.clips.start":
    'New start on the timeline, seconds as a string: "12.5"; without it, the start stays.',
  "ops.clip.move.fields.clips.track":
    "Track id to move to, which holds the clip's kind; without it, the track stays.",
  "ops.clip.move.errors.not-found": "There is no timeline, clip or track with this id.",
  "ops.clip.move.errors.invalid-value": "The same clip is in clips twice.",
  "ops.clip.move.errors.wrong-track": "The new track cannot hold the kind of the clip.",
  "ops.clip.move.errors.overlap":
    'Moved clips would land on each other, or clips that stay are in the way and overlap is not "overwrite".',
  "ops.clip.move.examples": [
    {
      title: "A clip 1 second later",
      params: { timeline: "main", clips: [{ clip: "clip_idea", start: "11" }] },
    },
    {
      title: "Two clips at once, one to another track",
      params: {
        timeline: "main",
        clips: [
          { clip: "clip_lottie", start: "7" },
          { clip: "clip_idea", start: "12", track: "track_video" },
        ],
        overlap: "overwrite",
      },
    },
  ],

  "ops.clip.trim.summary": "moves the start or end of a clip; what it shows stays in place",
  "ops.clip.trim.description":
    "Moves the edges of a clip, as dragging them does: start and end are new times of its edges on the timeline, and what the clip shows stays where it is on the timeline (its offset follows the start). Keyframes stay with the picture; transitions at the edges get shorter when they no longer fit. A clip cannot start before its media starts, or end after its media ends unless it loops. A longer clip that runs into other clips fails with overlap. A join at an edge that moves is removed, and the result lists it under changed. clip.move moves a whole clip.",
  "ops.clip.trim.params.start": "New start; what it shows stays put.",
  "ops.clip.trim.params.end": "New end.",
  "ops.clip.trim.errors.not-found": "There is no timeline or clip with this id.",
  "ops.clip.trim.errors.invalid-value": "The end would not be after the start.",
  "ops.clip.trim.errors.source-end":
    "The clip would go on after its media ends; only a clip with loop: true goes on past it.",
  "ops.clip.trim.errors.source-start":
    "The clip would start before its media starts; colors, images and captions have no such limit.",
  "ops.clip.trim.errors.overlap":
    "The clip would run into other clips on its track (the error names them).",
  "ops.clip.trim.examples": [
    {
      title: "A clip that ends earlier",
      params: { timeline: "main", clip: "clip_interview", end: "15" },
    },
    {
      title: "A clip that starts later",
      params: { timeline: "main", clip: "clip_interview", start: "6" },
    },
  ],

  "ops.clip.split.summary": "cuts a clip in two at a moment of the timeline",
  "ops.clip.split.description":
    "Cuts a clip in two at at, a moment of the timeline inside it. The first part keeps the id; the part after the cut is a new clip, with the id piece if given. Both parts keep all keyframes; the first keeps the enter transition and the second the exit one. Clips linked to it (same link) are cut at the same moment too, except those in keep, and the parts after the cut get a new link of their own.",
  "ops.clip.split.fields.keep": "Linked clip ids that stay whole and keep their link.",
  "ops.clip.split.errors.not-found": "There is no timeline or clip with this id.",
  "ops.clip.split.errors.invalid-value": "at is not inside the clip.",
  "ops.clip.split.errors.id-taken":
    "A section, track or clip of the timeline has the id of piece already.",
  "ops.clip.split.examples": [
    {
      title: "A cut at 10 seconds",
      params: { timeline: "main", clip: "clip_interview", at: "10" },
    },
    {
      title: "A cut with an id for the part after it",
      params: { timeline: "main", clip: "clip_interview", at: "10", piece: "clip_interview_b" },
    },
  ],

  "ops.property.edit.summary": "sets properties of clips and their keyframes, in one step",
  "ops.property.edit.description":
    'Changes properties of clips: values that can change over time with keyframes, such as opacity, transform.x, param.<scene param> or effect.<effect id>.<parameter> (topic "howto/keyframes"). edits run in order as one step, each on what the ones before made, and can be about several clips of the timeline. Each edit names the clip (owner), the property (path) and what to do (op): "set" the whole property to a value or keyframes, "clear" it, "write" a value at a time (a keyframe there when it has keyframes, else the value), "setKey" a keyframe, "removeKey", "moveKey", "putKeys" (whole keyframes in place of what is at those times) or "setInterp" (how keyframes go on to the next), as topic "types/PropertyEdit" has it. Keyframe times are on the clip\'s clock (topic "howto/times"). aq_object_read gives the properties a clip has and those its scene describes.',
  "ops.property.edit.errors.not-found":
    "There is no timeline or clip with this id, or an edit is about a keyframe at a time where there is none (the error gives the time).",
  "ops.property.edit.errors.invalid-value":
    "A value does not fit the property (the error says why), the path is no property, or two keyframes would be at one time.",
  "ops.property.edit.errors.not-animatable":
    "A property that cannot have keyframes gets them, such as fit.",
  "ops.property.edit.examples": [
    {
      title: "A property that fades in with two keyframes",
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
    {
      title: "A parameter of a scene, and a keyframe added with an ease out",
      params: {
        timeline: "main",
        edits: [
          { owner: { clip: "clip_title" }, path: "param.size", op: "set", value: 72 },
          { owner: { clip: "clip_title" }, path: "opacity", op: "setKey", time: "2", value: 0.5 },
          {
            owner: { clip: "clip_title" },
            path: "opacity",
            op: "setInterp",
            times: ["2"],
            ease: { interp: "bezier", out: [0.42, 0] },
          },
        ],
      },
    },
  ],

  "ops.property.rename.summary":
    "gives properties of a clip another path, with their keyframes, after code renamed what they are about",
  "ops.property.rename.description":
    'Moves the values and keyframes of properties of a clip to another path, in every version, as one step: for scene code that renamed an object or a property, such as object.arm.* to object.arm_l.*. A path that ends in ".*" moves everything under it. scale and offset convert numbers: what is stored becomes value × scale + offset. Two properties can swap paths in one step.',
  "ops.property.rename.errors.not-found":
    "There is no timeline or clip with this id, or the clip has no property at from.",
  "ops.property.rename.errors.invalid-value":
    "to is no property path, a property would get its own path, the same property is renamed twice, or two would get one path.",
  "ops.property.rename.errors.path-taken":
    "The clip has a property at to already, and it does not move away.",
  "ops.property.rename.errors.not-animatable":
    "The new path is a property that cannot have keyframes, and the old one had them.",
  "ops.property.rename.examples": [
    {
      title: "One property",
      params: {
        timeline: "main",
        renames: [{ owner: { clip: "clip_title" }, from: "param.size", to: "param.fontSize" }],
      },
    },
  ],

  "ops.marker.add.summary": "adds a marker to a timeline",
  "ops.marker.add.description":
    "Adds a marker at a moment of the timeline, with a name and a note to find it by, or a stretch with duration. Markers have ids among themselves.",
  "ops.marker.add.params.duration": "Length, seconds, for a stretch.",
  "ops.marker.add.errors.not-found": "There is no timeline with this id.",
  "ops.marker.add.errors.id-taken": "There is a marker with this id already.",
  "ops.marker.add.examples": [
    { title: "A marker at 12 seconds", params: { timeline: "main", time: "12", name: "Drop" } },
    {
      title: "A stretch of 4 seconds with a note and a color",
      params: {
        timeline: "main",
        id: "marker_chorus",
        time: "8",
        duration: "4",
        name: "Chorus",
        note: "Second verse starts after it",
        color: "#ff6b8a",
      },
    },
  ],

  "ops.marker.update.summary": "changes the time, name, note, color or duration of a marker",
  "ops.marker.update.description":
    "Changes fields of a marker; what changes leaves out stays as it is.",
  "ops.marker.update.errors.not-found": "There is no timeline or marker with this id.",
  "ops.marker.update.examples": [
    {
      title: "A marker at another time",
      params: { timeline: "main", marker: "marker_turn", changes: { time: "6" } },
    },
  ],

  "ops.marker.remove.summary": "removes a marker",
  "ops.marker.remove.description": "Takes a marker away.",
  "ops.marker.remove.errors.not-found": "There is no timeline or marker with this id.",
  "ops.marker.remove.examples": [
    { title: "A marker", params: { timeline: "main", marker: "marker_hook" } },
  ],
} satisfies TextTable;
