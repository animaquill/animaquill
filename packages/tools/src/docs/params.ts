/**
 * What the parameters of operations are, by name, for the parameter schema of aq_edit: a name means
 * the same in every operation, apart from the few that `PARAM_WORDS_OF` words for one operation.
 */
export const PARAM_WORDS: Readonly<Record<string, string>> = {
  timeline: "Timeline id (aq_project_status).",
  track: "Track id (aq_timeline_read).",
  clip: "Clip id (aq_timeline_read).",
  section: "Section id (aq_timeline_read).",
  marker: "Marker id (aq_timeline_read).",
  join: "Join id (aq_timeline_read).",
  effect: "Effect id, of the clip (aq_object_read).",
  scene: "Scene id (aq_project_status).",
  sound: "Sound id (aq_project_status).",
  asset: "Asset id (aq_project_status).",
  id: "New id, to use later in the batch; optional.",
  name: "Name people see.",
  fps: 'Frames per second, such as "30" or "30000/1001".',
  changes: "Fields to change; the rest stay.",
  clear: "Fields to take away.",
  withUses: "true also removes what uses it; without, it fails while used.",
  manifest: "As its manifest file: name, entry (first file), runtime 1, params, presets.",
  files: 'Its files by path in its folder, with their text: {"index.html":"…"}. Has the entry.',
  kind: "Which kind.",
  from: "Where from.",
  to: "Where to.",
  path: 'Code file path, such as "scenes/title/main.js".',
  duration: 'Length, seconds as a string: "2.5".',
  before: "Id of the one it goes before; leave out for last.",
  start: 'Seconds as a string: "12.5".',
  end: 'Seconds as a string: "12.5".',
  source: "What it shows or plays.",
  offset: "Where in its media it starts: the clip's clock at its first frame, seconds.",
  loop: "true plays it again from the start when it ends.",
  enter: "Transition at its start; null takes it away.",
  exit: "Transition at its end; null takes it away.",
  hidden: "true leaves it out.",
  draft: "true marks it a sketch no export has.",
  link: "Clips with one link move together.",
  sectionFit: "How it follows a section that changes length in a version.",
  properties: "Properties by path: values, or keyframes (aq_object_read lists a scene's paths).",
  effects: "Effects, in the order they work.",
  overlap: '"overwrite" cuts away clips in the way; default "reject" fails.',
  clips: "Clip ids (aq_timeline_read).",
  type: 'Kind of transition or effect, such as "fade" or "blur".',
  transition: "Id of a transition of the project, instead of type.",
  library: "Library id, with resource, instead of type.",
  resource: "What the library has, with library.",
  curve: "Speed curve, as CSS cubic-bezier().",
  values: "Parameter values by name; the rest default.",
  align: '"center" (default), or all "before" or "after" the cut.',
  enabled: "false turns it off, keeping its place and values.",
  index: "Place in the list, from 0.",
  joins: "Join ids (aq_timeline_read).",
  at: "Moment of the timeline to cut at, seconds.",
  piece: "Id for the part after the cut; leave out for a new one.",
  keep: "Linked clip ids that stay whole.",
  edits:
    'Each {"owner":{"clip":id},"path",…,"op"}: "set" a value or keyframes, "clear", "write" at a time, or "setKey", "removeKey", "moveKey", "putKeys", "setInterp".',
  renames: 'Each {"owner":{"clip":id},"from","to"}; paths may end in ".*".',
  time: 'Seconds as a string: "12.5".',
  note: "A longer note.",
  color: 'Color: "#ff6b8a".',
};

/** Where a name means something else in one operation. */
export const PARAM_WORDS_OF: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "source.replace": {
    kind: '"asset", "scene" or "sound".',
    from: "Id of what clips use now.",
    to: "Id to use instead, same kind.",
  },
  "file.rename": { from: "Path now.", to: "New path." },
  "join.add": {
    from: "Clip id before the cut.",
    to: "Clip id after the cut, starting where the first ends.",
    duration: "Length, seconds; leave out for as much as fits.",
  },
  "track.add": { kind: '"video", "audio" or "caption".' },
  "clip.move": { clips: 'Each {"clip":id,"start"?,"track"?}.' },
  "clip.trim": { start: "New start; what it shows stays put.", end: "New end." },
  "effect.add": { start: "Seconds from the clip's start.", end: "Seconds from the clip's start." },
  "effect.update": {
    start: "Seconds from the clip's start; null for its start.",
    end: "Seconds from the clip's start; null for its end.",
  },
  "effect.remove": { effects: "Effect ids of the clip." },
  "marker.add": { duration: "Length, seconds, for a stretch." },
};

/** What a parameter of an operation means. */
export const paramWords = (operation: string, name: string): string | undefined =>
  PARAM_WORDS_OF[operation]?.[name] ?? PARAM_WORDS[name];
