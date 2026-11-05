import { z } from "zod";
import { Color, Duration, ExtensionName, Id, LanguageId, Time, sortKeys } from "./basics.ts";
import { compare, parseTime } from "./time.ts";
import {
  KnownProperties,
  MediaRef,
  Properties,
  PropertyPath,
  PropertyValue,
  StringRef,
  checkProperty,
} from "./values.ts";

/** A built-in or plugin effect, for pictures and sounds alike. Its values can have keys. */
export const Effect = z.strictObject({
  id: Id,
  type: ExtensionName,
  enabled: z.boolean().optional(),
  properties: Properties.optional(),
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
  /** A caption. With words, each one has its own moment, for karaoke-style lyrics. */
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

/** What a clip does when a section gets longer, for example because English takes more time. */
const SectionFit = z.enum(["stretch", "hold", "span"]);

export const Clip = z.strictObject({
  id: Id,
  name: z.string().optional(),
  /** On the timeline of the master version. */
  start: Time,
  duration: Duration,
  source: ClipSource,
  /** Where in the source the clip begins. */
  offset: Time.optional(),
  loop: z.boolean().optional(),
  fadeIn: Time.optional(),
  fadeOut: Time.optional(),
  /** Left out of this version, or of the master when a version shows it. */
  hidden: z.boolean().optional(),
  /** A sketch to look at an idea. Never part of an export. */
  draft: z.boolean().optional(),
  /** Clips with the same link move together, like the picture and sound of a video. */
  link: Id.optional(),
  sectionFit: SectionFit.optional(),
  properties: KnownProperties.optional(),
  effects: z.array(Effect).optional(),
});

export const Transition = z
  .strictObject({
    id: Id,
    type: ExtensionName,
    /** The clip that goes. Left out when a clip fades in from nothing. */
    from: Id.optional(),
    /** The clip that comes. Left out when a clip fades out to nothing. */
    to: Id.optional(),
    duration: Duration,
    properties: Properties.optional(),
  })
  .refine((transition) => transition.from ?? transition.to, "转场至少要有 from 或 to");

/** Clips in time order, which is how people and AI tools read a track. */
function sortClips<T extends { readonly id: string; readonly start: string }>(clips: T[]): T[] {
  const isValid = clips.every((clip) => Time.safeParse(clip.start).success);
  if (!isValid) return clips;
  return clips.toSorted(
    (a, b) => compare(parseTime(a.start), parseTime(b.start)) || a.id.localeCompare(b.id),
  );
}

const Clips = z.array(Clip).overwrite(sortClips);

const trackBase = {
  id: Id,
  name: z.string().optional(),
  locked: z.boolean().optional(),
  group: z.string().optional(),
};

export const Send = z.strictObject({ bus: Id, properties: KnownProperties.optional() });

const VideoTrack = z.strictObject({
  ...trackBase,
  kind: z.literal("video"),
  hidden: z.boolean().optional(),
  clips: Clips,
  transitions: z.array(Transition).optional(),
});

const AudioTrack = z.strictObject({
  ...trackBase,
  kind: z.literal("audio"),
  /** Voice follows the language, music plays across sections. */
  role: z.enum(["voice", "music", "effects"]).optional(),
  muted: z.boolean().optional(),
  solo: z.boolean().optional(),
  clips: Clips,
  transitions: z.array(Transition).optional(),
  properties: KnownProperties.optional(),
  effects: z.array(Effect).optional(),
  sends: z.array(Send).optional(),
  /** A bus. Without one the track goes to the master. */
  output: Id.optional(),
});

const CaptionTrack = z.strictObject({
  ...trackBase,
  kind: z.literal("caption"),
  hidden: z.boolean().optional(),
  clips: Clips,
});

export const Track = z.discriminatedUnion("kind", [VideoTrack, AudioTrack, CaptionTrack]);

export const Bus = z.strictObject({
  id: Id,
  name: z.string().optional(),
  muted: z.boolean().optional(),
  properties: KnownProperties.optional(),
  effects: z.array(Effect).optional(),
  sends: z.array(Send).optional(),
  output: Id.optional(),
});

/** The rest of the mixing graph. Tracks hold their own part of it. */
export const Mix = z.strictObject({
  buses: z.array(Bus).optional(),
  master: z
    .strictObject({ properties: KnownProperties.optional(), effects: z.array(Effect).optional() })
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

export const Timeline = z
  .strictObject({
    name: z.string().min(1),
    background: Color.optional(),
    /** At least one. Their durations add up to the length of the timeline, kept nowhere else. */
    sections: z.array(Section).min(1),
    markers: z.array(Marker).optional(),
    beatGrid: BeatGrid.optional(),
    /** The first track is at the back of the picture. */
    tracks: z.array(Track),
    mix: Mix.optional(),
  })
  .superRefine((timeline, context) => {
    const seen = new Map<string, string>();
    const claim = (id: string, path: (string | number)[]) => {
      if (seen.has(id)) {
        context.addIssue({ code: "custom", path, message: `ID 重复：${id}` });
      }
      seen.set(id, id);
    };
    timeline.sections.forEach((section, index) => claim(section.id, ["sections", index, "id"]));
    timeline.tracks.forEach((track, trackIndex) => {
      claim(track.id, ["tracks", trackIndex, "id"]);
      track.clips.forEach((clip, clipIndex) => {
        const path = ["tracks", trackIndex, "clips", clipIndex];
        claim(clip.id, [...path, "id"]);
        const { kind } = clip.source;
        if (!kind.includes(".") && !SOURCES_BY_TRACK[track.kind]?.has(kind)) {
          context.addIssue({
            code: "custom",
            path: [...path, "source", "kind"],
            message: `${track.kind} 轨道不能放 ${kind} 片段`,
          });
        }
      });
    });
  });

/** A change a version makes, with the master value it was based on. */
const Change = <T extends z.ZodType>(value: T) => z.strictObject({ value, base: value.optional() });

const ClipChanges = z.strictObject({
  start: Change(Time).optional(),
  duration: Change(Duration).optional(),
  offset: Change(Time).optional(),
  hidden: Change(z.boolean()).optional(),
  source: Change(ClipSource).optional(),
  properties: z
    .record(PropertyPath, Change(PropertyValue))
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
export type Track = z.output<typeof Track>;
export type Timeline = z.output<typeof Timeline>;
export type Overrides = z.output<typeof Overrides>;
