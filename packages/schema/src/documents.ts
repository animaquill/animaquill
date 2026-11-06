import { z } from "zod";
import {
  Color,
  Duration,
  HttpsUrl,
  Id,
  LanguageId,
  Rate,
  RelativePath,
  Time,
  sortKeys,
} from "./basics.ts";
import { Value } from "./values.ts";

const Language = z.strictObject({
  id: LanguageId,
  name: z.string().min(1),
  /** Font family for this language, from the fonts of the project. */
  font: z.string().optional(),
});

/** Fractions of the picture that a platform covers with its own buttons and text. */
const SafeArea = z.strictObject({
  top: z.number().min(0).max(1),
  right: z.number().min(0).max(1),
  bottom: z.number().min(0).max(1),
  left: z.number().min(0).max(1),
});

const Format = z.strictObject({
  id: Id,
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: Rate,
  safeArea: SafeArea.optional(),
});

const Font = z.strictObject({
  family: z.string().min(1),
  asset: Id,
  weight: z.number().int().min(1).max(1000).optional(),
  style: z.enum(["normal", "italic"]).optional(),
});

const Tag = z.strictObject({
  name: z.string().min(1),
  color: Color.optional(),
  /** Nobody can change the project, neither people nor AI, until the tag is taken away. */
  locked: z.boolean().optional(),
});

/** animaquill.json: what makes a folder a project. */
export const ProjectManifest = z
  .strictObject({
    formatVersion: z.number().int().positive(),
    id: Id,
    name: z.string().min(1),
    description: z.string().optional(),
    /** The first one is the master language. */
    languages: z.array(Language).min(1),
    /** The first one is the master format. */
    /**
     * The frame rate of editing: what the ruler counts and what things land on. Times in a project
     * do not depend on it, so every format can have its own frame rate when it is exported.
     * Without it, the first format decides.
     */
    fps: Rate.optional(),
    formats: z.array(Format).min(1),
    /** The first one opens by default. */
    timelines: z.array(Id).min(1),
    fonts: z.array(Font).optional(),
    tags: z.array(Tag).optional(),
    /** Which frame stands for the project. */
    cover: z.strictObject({ timeline: Id, time: Time }).optional(),
    credits: z.array(z.strictObject({ role: z.string(), name: z.string() })).optional(),
  })
  .superRefine((project, context) => {
    const unique = (items: readonly string[], field: string) => {
      items.forEach((item, index) => {
        if (items.indexOf(item) !== index) {
          context.addIssue({ code: "custom", path: [field, index], message: `重复：${item}` });
        }
      });
    };
    unique(
      project.languages.map((language) => language.id),
      "languages",
    );
    unique(
      project.formats.map((format) => format.id),
      "formats",
    );
    unique(project.timelines, "timelines");
  });

const MediaInfo = z.strictObject({
  duration: Duration.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: Rate.optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
});

const Asset = z
  .strictObject({
    name: z.string().optional(),
    kind: z.enum(["video", "audio", "image", "font", "model", "other"]),
    /** Where the file is, or would be, inside the project. */
    path: RelativePath,
    /**
     * git and lfs travel with the repository. local stays on one computer, remote is in the
     * person's own object storage: the repository only holds this entry.
     */
    storage: z.enum(["git", "lfs", "local", "remote"]),
    url: HttpsUrl.optional(),
    /** Caches and exports know by this whether the content changed. */
    hash: z
      .string()
      .regex(/^sha256-[A-Za-z0-9+/=_-]+$/, "要写成 sha256-…")
      .optional(),
    size: z.number().int().nonnegative().optional(),
    info: MediaInfo.optional(),
    license: z.string().optional(),
    credit: z.string().optional(),
  })
  .refine((asset) => asset.storage !== "remote" || asset.url, "remote 素材要写 url");

/** assets.json: every file a project uses, so that renaming one breaks nothing. */
export const Assets = z.strictObject({
  assets: z.record(Id, Asset).overwrite(sortKeys),
});

/** libraries.json */
export const Libraries = z.strictObject({
  libraries: z.array(
    z.strictObject({
      id: Id,
      type: z.enum(["assets", "experience"]),
      source: HttpsUrl,
      /** A branch or a release to follow. */
      track: z.string().min(1),
      /** When two libraries offer the same thing, the lower number wins. */
      priority: z.number().int().optional(),
      /** Own libraries can follow the latest state while they are being worked on. */
      followLatest: z.boolean().optional(),
    }),
  ),
});

/** libraries.lock.json: what makes a render repeatable even when a library moves on. */
export const LibrariesLock = z.strictObject({
  libraries: z
    .record(
      Id,
      z.strictObject({
        commit: z.string().regex(/^[0-9a-f]{7,64}$/, "要写成 Git 提交的十六进制编号"),
        integrity: z.string().regex(/^sha256-[A-Za-z0-9+/=_-]+$/, "要写成 sha256-…"),
      }),
    )
    .overwrite(sortKeys),
});

const ParamType = z.enum(["text", "number", "color", "boolean", "choice", "asset"]);

const Param = z.strictObject({
  id: z.string().regex(/^[^\s.]+$/, "参数名不能有空格和点"),
  name: z.string().min(1),
  type: ParamType,
  default: Value.optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string()).optional(),
});

const scriptManifest = {
  name: z.string().min(1),
  description: z.string().optional(),
  /** Which file starts it, relative to its folder. Runs as it is, so it has to be JavaScript. */
  entry: RelativePath.refine(
    (path) => /\.(html|js|mjs)$/.test(path),
    "入口要是 .html、.js 或 .mjs 文件：代码直接运行，不做 TypeScript 转换",
  ),
  /**
   * The version of the runtime interface it was written for. New editors keep supporting old
   * versions, so old projects still render the same.
   */
  runtime: z.number().int().positive(),
  params: z.array(Param).optional(),
};

/** scenes/<id>/scene.json */
export const SceneManifest = z.strictObject({
  ...scriptManifest,
  presets: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        values: z.record(z.string(), Value).overwrite(sortKeys),
      }),
    )
    .optional(),
});

/** sounds/<id>/sound.json: code that makes sound, the way a scene makes pictures. */
export const SoundManifest = z.strictObject({
  ...scriptManifest,
  /** Named results of one program, for example one per kind of effect. */
  outputs: z.array(z.string().min(1)).optional(),
});

/** locales/<language>.json */
export const Locale = z.strictObject({
  strings: z
    .record(
      z.string().min(1),
      z.strictObject({
        text: z.string(),
        /** The master text this was translated from. When it differs, the translation is stale. */
        base: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .overwrite(sortKeys),
});

const Point = z.tuple([z.number(), z.number()]);

const Mark = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("area"),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  z.strictObject({ type: z.literal("arrow"), from: Point, to: Point }),
  z.strictObject({ type: z.literal("stroke"), points: z.array(Point).min(2) }),
]);

const Note = z.strictObject({
  id: Id,
  status: z.enum(["pending", "working", "review", "done", "rejected"]),
  text: z.string(),
  timeline: Id,
  time: Time,
  end: Time.optional(),
  /** The version it was written in. */
  language: z.string().optional(),
  format: z.string().optional(),
  /** Objects it points at, by clip and property tree path. */
  targets: z
    .array(
      z.strictObject({ clip: Id, path: z.string().min(1).optional(), name: z.string().optional() }),
    )
    .optional(),
  /** Coordinates are fractions of the picture. */
  marks: z.array(Mark).optional(),
  /** What was shown by dragging: an illustration, not a change to the project. */
  changes: z
    .array(z.strictObject({ path: z.string().min(1), from: Value.optional(), to: Value }))
    .optional(),
  createdAt: z.iso.datetime(),
});

/** notes.json: annotations, which live with the project but never reach an export. */
export const Notes = z.strictObject({
  notes: z
    .array(Note)
    .overwrite((notes) =>
      notes.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    ),
});

export type ProjectManifest = z.output<typeof ProjectManifest>;
export type Assets = z.output<typeof Assets>;
export type Libraries = z.output<typeof Libraries>;
export type LibrariesLock = z.output<typeof LibrariesLock>;
export type SceneManifest = z.output<typeof SceneManifest>;
export type SoundManifest = z.output<typeof SoundManifest>;
export type Locale = z.output<typeof Locale>;
export type Notes = z.output<typeof Notes>;
