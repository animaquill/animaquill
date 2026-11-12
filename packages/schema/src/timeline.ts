import { z } from "zod";
import {
  Color,
  Duration,
  ExtensionName,
  Id,
  LanguageId,
  Time,
  checkUnique,
  sortById,
  sortByTime,
  sortKeys,
} from "./basics.ts";
import { JOIN_ALIGNS, SPEED_CURVE_REACH } from "./transitions.ts";
import {
  KnownProperties,
  MediaRef,
  PropertyPath,
  PropertyValue,
  StringRef,
  Value,
  checkProperty,
  withoutRetired,
} from "./values.ts";

/**
 * A built-in or plugin effect, for pictures and sounds alike. What it takes are properties of what
 * it is on, `effect.<id>.<parameter>`, so they can have keys like any other: see effects.ts. They
 * used to be in the effect itself, which a file can still have, and reading it drops them.
 */
const EffectFields = z.strictObject({
  /** Unique among the effects of what it is on. */
  id: Id,
  /** One that comes with the editor, or with a plugin, which has a dot. */
  type: ExtensionName,
  /** Off, it does nothing, and keeps its place and its values. */
  enabled: z.boolean().optional(),
  /**
   * When it works, in seconds from the start of the clip on the timeline: from `start` up to
   * `end`. Without `start` it works from the start of the clip, without `end` up to its end, so
   * that it goes along when the clip gets longer. Only what is within the clip counts, and from
   * `start` to an `end` that is not after it, it does nothing.
   */
  start: Time.optional(),
  end: Time.optional(),
});

export const Effect = z.preprocess(
  (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value) && "properties" in value
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "properties"))
      : value,
  EffectFields,
);

/** Effects in the order they work, each id once. */
const Effects = z.array(Effect).superRefine((effects, context) => {
  const seen = new Set<string>();
  effects.forEach((effect, index) => {
    if (seen.has(effect.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `效果 ID 重复：${effect.id}`,
      });
    }
    seen.add(effect.id);
  });
});

const Text = z.union([z.string(), StringRef]);

const CaptionWord = z.strictObject({ text: z.string(), time: Time });

/** What a clip shows or plays. */
const KnownSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("video"), media: MediaRef }),
  z.strictObject({ kind: z.literal("image"), media: MediaRef }),
  z.strictObject({ kind: z.literal("audio"), media: MediaRef }),
  /** Real HTML, CSS, SVG and JavaScript from scenes/, or a scene template of a library. */
  z
    .strictObject({
      kind: z.literal("scene"),
      scene: Id.optional(),
      library: Id.optional(),
      resource: Id.optional(),
    })
    .refine(
      ({ scene, library, resource }) => (scene ? !library && !resource : library && resource),
      "场景要写 scene，或者同时写 library 和 resource",
    ),
  /** Sound made by code in sounds/ or in a library. One program can have several outputs. */
  z
    .strictObject({
      kind: z.literal("sound"),
      sound: Id.optional(),
      library: Id.optional(),
      resource: Id.optional(),
      output: z.string().min(1).optional(),
    })
    .refine(
      ({ sound, library, resource }) => (sound ? !library && !resource : library && resource),
      "声音要写 sound，或者同时写 library 和 resource",
    ),
  /** Notes in music/, so that a piece can still be changed after it was placed. */
  z.strictObject({ kind: z.literal("music"), music: Id }),
  /** Another timeline. It follows the language and format of the one it is in. */
  z.strictObject({ kind: z.literal("timeline"), timeline: Id }),
  z.strictObject({ kind: z.literal("color"), color: Color }),
  /** A caption. With words, each one has its moment on the clip's clock, for karaoke-style lyrics. */
  z.strictObject({
    kind: z.literal("caption"),
    text: Text,
    words: z.array(CaptionWord).optional(),
  }),
]);

/**
 * Content types come as plugins, so a project can contain a kind this build does not know. It is
 * kept as it is. Plugin kinds have a dot, which keeps a typo in a built-in kind an error.
 */
const PluginSource = z
  .looseObject({
    kind: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/),
  })
  .overwrite(({ kind, ...rest }) => ({ kind, ...sortKeys(rest) }));

export const ClipSource = z.union([KnownSource, PluginSource]);

/** x within 0 and 1. */
const share = z.number().min(0).max(1);

/**
 * y within −10 and 10: past 0 and 1 is a transition that overshoots, and that far is more than any
 * overshoot that people would want. Without a limit a number like 1e308 makes the progress NaN.
 */
const reach = z.number().min(-SPEED_CURVE_REACH).max(SPEED_CURVE_REACH);

/** How a transition gets along over its time, as in CSS `cubic-bezier()`. */
export const TransitionCurve = z.tuple([share, reach, share, reach]);

/** What a transition is, how long it takes and how it gets along. See transitions.ts. */
const transitionFields = {
  /** One that comes with the editor, or with a plugin, which has a dot. */
  type: ExtensionName.optional(),
  /** One of the project, in transitions/<id>/. */
  transition: Id.optional(),
  /** One of a library. */
  library: Id.optional(),
  resource: Id.optional(),
  duration: Duration,
  /** Without it the speed is even. */
  curve: TransitionCurve.optional(),
  /**
   * What it sets for the properties that it says it has, such as which way a wipe goes, each one
   * plain value: none can have keys. What it leaves out is the default.
   */
  values: z.record(PropertyPath, Value).overwrite(sortKeys).optional(),
};

/**
 * The fields of a transition, each checked on its own: what commands take apart and put together
 * again. A whole one also names one thing that it is, see `Transition`.
 */
export const TransitionShape = z.strictObject(transitionFields);

const hasOneReference = (transition: {
  readonly type?: string | undefined;
  readonly transition?: string | undefined;
  readonly library?: string | undefined;
  readonly resource?: string | undefined;
}) => {
  const { type, transition: own, library, resource } = transition;
  const fromLibrary = library !== undefined && resource !== undefined;
  const named = [type !== undefined, own !== undefined, fromLibrary].filter(Boolean).length;
  return named === 1 && (library === undefined) === (resource === undefined);
};

const ONE_REFERENCE = "转场要写 type、transition，或者同时写 library 和 resource";

/**
 * What transitions had once: kinds of one by name, such as which way a wipe goes, which are values
 * of its properties now (2026-11-09). Reading drops it, and what it said is the default again.
 */
const RETIRED_TRANSITION_FIELDS = ["variant"];

/** At the start or the end of a clip, from nothing to the clip or from the clip to nothing. */
export const Transition = z.preprocess(
  without(RETIRED_TRANSITION_FIELDS),
  z.strictObject(transitionFields).refine(hasOneReference, ONE_REFERENCE),
);

/** What a clip does when a section gets longer, for example because English takes more time. */
const SectionFit = z.enum(["stretch", "hold", "span"]);

export const Clip = z.strictObject({
  id: Id,
  name: z.string().optional(),
  /** On the timeline of the master version. */
  start: Time,
  duration: Duration,
  source: ClipSource,
  /**
   * What the clock of the clip reads at its first frame. Keys are on this clock, so trimming and
   * cutting a clip leave them alone. Without `time.speed` it is also where in the source it begins.
   */
  offset: Time.optional(),
  loop: z.boolean().optional(),
  /** From nothing to the clip, from its start on. */
  enter: Transition.optional(),
  /** From the clip to nothing, up to its end. */
  exit: Transition.optional(),
  /** Left out of this version, or of the master when a version shows it. */
  hidden: z.boolean().optional(),
  /** A sketch to look at an idea. Never part of an export. */
  draft: z.boolean().optional(),
  /** Clips with the same link move together, like the picture and sound of a video. */
  link: Id.optional(),
  sectionFit: SectionFit.optional(),
  properties: KnownProperties.optional(),
  effects: Effects.optional(),
});

/**
 * What the format had once and has no more. A file that still has it opens without it: the format
 * was not out yet, so this is no migration and no new version. See the project format.
 */
/** What clips and tracks had before transitions. */
const RETIRED_CLIP_FIELDS = ["fadeIn", "fadeOut"];
const RETIRED_TRACK_FIELDS = ["transitions"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where a timeline file, as JSON, still has fades the way they were before transitions, which
 * reading it drops: the first place, as a path in the file, or nothing when there is none.
 */
export function retiredFieldOf(file: unknown): string | undefined {
  if (!isRecord(file) || !Array.isArray(file["tracks"])) return undefined;
  for (const [index, track] of file["tracks"].entries()) {
    if (!isRecord(track)) continue;
    const field = RETIRED_TRACK_FIELDS.find((name) => Object.hasOwn(track, name));
    if (field) return `tracks.${index}.${field}`;
    const clips = Array.isArray(track["clips"]) ? track["clips"] : [];
    for (const [at, clip] of clips.entries()) {
      const old = isRecord(clip) && RETIRED_CLIP_FIELDS.find((name) => Object.hasOwn(clip, name));
      if (old) return `tracks.${index}.clips.${at}.${old}`;
    }
  }
  return undefined;
}

function without(fields: readonly string[]) {
  return (value: unknown): unknown => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    if (!fields.some((field) => Object.hasOwn(value, field))) return value;
    const rest: Record<string, unknown> = { ...value };
    for (const field of fields) delete rest[field];
    return rest;
  };
}

const Clips = z
  .array(z.preprocess(without(RETIRED_CLIP_FIELDS), Clip))
  .overwrite((clips) => sortByTime(clips, (clip) => clip.start));

/** On the cut between two clips that follow each other on its track, from the first to the second. */
export const Join = z.preprocess(
  without(RETIRED_TRANSITION_FIELDS),
  z
    .strictObject({
      id: Id,
      from: Id,
      to: Id,
      ...transitionFields,
      /** Where it is around the cut. Without it, half before and half after. */
      align: z.enum(JOIN_ALIGNS).optional(),
    })
    .refine(hasOneReference, ONE_REFERENCE),
);

const Joins = z.array(Join).overwrite(sortById);

const trackBase = {
  id: Id,
  name: z.string().optional(),
  locked: z.boolean().optional(),
  group: z.string().optional(),
};

export const Send = z.strictObject({ bus: Id, properties: KnownProperties.optional() });

/** The tracks of a timeline, with what they take as their clips, see `TimelineOutline`. */
const tracksOf = <C extends z.ZodType>(clips: C) =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      ...trackBase,
      kind: z.literal("video"),
      hidden: z.boolean().optional(),
      clips,
      joins: Joins.optional(),
    }),
    z.strictObject({
      ...trackBase,
      kind: z.literal("audio"),
      /** Voice follows the language, music plays across sections. */
      role: z.enum(["voice", "music", "effects"]).optional(),
      muted: z.boolean().optional(),
      solo: z.boolean().optional(),
      clips,
      joins: Joins.optional(),
      properties: KnownProperties.optional(),
      effects: Effects.optional(),
      sends: z.array(Send).optional(),
      /** A bus. Without one the track goes to the master. */
      output: Id.optional(),
    }),
    z.strictObject({
      ...trackBase,
      kind: z.literal("caption"),
      hidden: z.boolean().optional(),
      clips,
    }),
  ]);

export const Track = tracksOf(Clips);

export const Bus = z.strictObject({
  id: Id,
  name: z.string().optional(),
  muted: z.boolean().optional(),
  properties: KnownProperties.optional(),
  effects: Effects.optional(),
  sends: z.array(Send).optional(),
  output: Id.optional(),
});

/** The rest of the mixing graph. Tracks hold their own part of it. */
export const Mix = z.strictObject({
  buses: z.array(Bus).optional(),
  master: z
    .strictObject({ properties: KnownProperties.optional(), effects: Effects.optional() })
    .optional(),
});

/** A stretch of the timeline. Sections end to end make up its length, in every language. */
export const Section = z.strictObject({
  id: Id,
  name: z.string().optional(),
  duration: Duration,
});

export const Marker = z.strictObject({
  id: Id,
  time: Time,
  name: z.string().optional(),
  note: z.string().optional(),
  color: Color.optional(),
  duration: Duration.optional(),
});

const BeatSegment = z.strictObject({
  start: Time,
  bpm: z.number().positive(),
  meter: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  /** The first beat of a bar, when that is not where the segment starts. */
  downbeat: Time.optional(),
});

/** The beat lines of a timeline. Analysis fills them in, and people can correct them. */
export const BeatGrid = z.strictObject({ segments: z.array(BeatSegment).min(1) });

const SOURCES_BY_TRACK: Readonly<Record<string, ReadonlySet<string>>> = {
  video: new Set(["video", "image", "scene", "timeline", "color"]),
  audio: new Set(["audio", "sound", "music", "timeline"]),
  caption: new Set(["caption"]),
};

/** Whether a track of this kind can hold a clip of this kind. Plugin kinds decide for themselves. */
export const canHold = (track: string, source: string): boolean =>
  source.includes(".") || SOURCES_BY_TRACK[track]?.has(source) === true;

/** What the rules of a whole timeline look at of its clips, see `checkTimeline`. */
interface OutlinedTimeline {
  readonly sections: readonly { readonly id: string }[];
  readonly markers?: readonly { readonly id: string }[] | undefined;
  readonly tracks: readonly {
    readonly id: string;
    readonly kind: string;
    readonly joins?: readonly { readonly id: string }[] | undefined;
    readonly clips: readonly { readonly id: string; readonly source: { readonly kind: string } }[];
  }[];
}

const timelineOf = <T extends z.ZodType>(track: T) =>
  z
    .strictObject({
      name: z.string().min(1),
      background: Color.optional(),
      /** At least one. Their durations add up to the length of the timeline, kept nowhere else. */
      sections: z.array(Section).min(1),
      markers: z
        .array(Marker)
        .overwrite((markers) => sortByTime(markers, (marker) => marker.time))
        .optional(),
      beatGrid: BeatGrid.optional(),
      /** The first track is at the back of the picture. */
      tracks: z.array(z.preprocess(without(RETIRED_TRACK_FIELDS), track)),
      mix: Mix.optional(),
    })
    .superRefine((timeline, context) => checkTimeline(timeline as OutlinedTimeline, context));

export const Timeline = timelineOf(Track);

/**
 * A timeline with each of its clips only as far as the rules of the whole timeline look at it: its
 * id and the kind of what it shows. A timeline is valid when this is and every clip is a valid
 * `Clip` on its own, so that a large one can be checked again by what changed of it.
 */
export const TimelineOutline = timelineOf(
  tracksOf(z.array(z.looseObject({ id: z.string(), source: z.looseObject({ kind: z.string() }) }))),
);

/** What only a whole timeline can tell: ids it shares, and what its tracks can hold. */
function checkTimeline(
  timeline: OutlinedTimeline,
  context: { addIssue(issue: { code: "custom"; path: PropertyKey[]; message: string }): void },
): void {
  const seen = new Map<string, string>();
  const claim = (id: string, path: (string | number)[]) => {
    if (seen.has(id)) {
      context.addIssue({ code: "custom", path, message: `ID 重复：${id}` });
    }
    seen.set(id, id);
  };
  timeline.sections.forEach((section, index) => claim(section.id, ["sections", index, "id"]));
  checkUnique(timeline.markers ?? [], context, (index) => ["markers", index, "id"]);
  const joins = new Set<string>();
  timeline.tracks.forEach((track, trackIndex) => {
    claim(track.id, ["tracks", trackIndex, "id"]);
    if (track.kind !== "caption") {
      const path = (index: number) => ["tracks", trackIndex, "joins", index, "id"];
      checkUnique(track.joins ?? [], context, path, joins);
    }
    track.clips.forEach((clip, clipIndex) => {
      const path = ["tracks", trackIndex, "clips", clipIndex];
      claim(clip.id, [...path, "id"]);
      const { kind } = clip.source;
      if (!canHold(track.kind, kind)) {
        context.addIssue({
          code: "custom",
          path: [...path, "source", "kind"],
          message: `${track.kind} 轨道不能放 ${kind} 片段`,
        });
      }
    });
  });
}

/** A change a version makes, with the master value it was based on. */
const Change = <T extends z.ZodType>(value: T) => z.strictObject({ value, base: value.optional() });

const ClipChanges = z.strictObject({
  start: Change(Time).optional(),
  duration: Change(Duration).optional(),
  offset: Change(Time).optional(),
  hidden: Change(z.boolean()).optional(),
  source: Change(ClipSource).optional(),
  properties: z
    .preprocess(withoutRetired, z.record(PropertyPath, Change(PropertyValue)))
    .overwrite(sortKeys)
    .superRefine((properties, context) => {
      for (const [path, { value }] of Object.entries(properties)) {
        checkProperty(path, value, (message) => {
          context.addIssue({ code: "custom", path: [path, "value"], message });
        });
      }
    })
    .optional(),
});

/**
 * What a language, a format or one version changes. Nothing can be added here: every object exists
 * in the master, so every difference points at something that has a stable id.
 */
export const Overrides = z
  .strictObject({
    scope: z.strictObject({ language: LanguageId.optional(), format: Id.optional() }),
    sections: z
      .record(Id, z.strictObject({ duration: Change(Duration) }))
      .overwrite(sortKeys)
      .optional(),
    clips: z.record(Id, ClipChanges).overwrite(sortKeys).optional(),
  })
  .refine(({ scope }) => scope.language ?? scope.format, "scope 至少要有 language 或 format");

export type ClipSource = z.output<typeof ClipSource>;
export type Clip = z.output<typeof Clip>;
export type Transition = z.output<typeof Transition>;
export type Join = z.output<typeof Join>;
export type Track = z.output<typeof Track>;
export type Timeline = z.output<typeof Timeline>;
export type Overrides = z.output<typeof Overrides>;
