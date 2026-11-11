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
  checkUnique,
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

/** What a video, a sound or a picture is like, as the editor found it out. */
export const MediaInfo = z.strictObject({
  duration: Duration.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: Rate.optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  /** Whether a video also has sound. */
  hasAudio: z.boolean().optional(),
});

/**
 * Free words that people find a resource by, each once: not what it is, which its kind says. See
 * docs/design/libraries.md, "分类". Unlike the tags of the project, they lock nothing.
 */
export const ResourceTags = z
  .array(z.string().trim().min(1, "标签不能是空的").max(40, "标签最多 40 个字"))
  .max(30, "最多 30 个标签")
  .refine((tags) => new Set(tags).size === tags.length, "标签不能重复");

/**
 * The SHA-256 of the content of a file: `sha256-` and the digest in URL-safe base64, with the `=`
 * at the end. Other tools may write it in plain base64 or in hexadecimal, see `isSameHash`.
 */
export const AssetHash = z.string().regex(/^sha256-[A-Za-z0-9+/=_-]+$/, "要写成 sha256-…");

declare const atob: (data: string) => string;

const HASH_PREFIX = "sha256-";
const DIGEST_BYTES = 32;

/**
 * The digest a hash stands for, in lower-case hexadecimal, whatever a tool wrote it as: what Git LFS
 * calls the oid of the content, see lfs.ts. Undefined for what is no hash of the format.
 */
export function hexDigestOf(hash: string): string | undefined {
  if (!hash.startsWith(HASH_PREFIX)) return undefined;
  const text = hash.slice(HASH_PREFIX.length);
  if (/^[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  try {
    const bytes = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    if (bytes.length !== DIGEST_BYTES) return undefined;
    return [...bytes].map((byte) => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;
  }
}

/**
 * Whether two hashes of files stand for the same content. The format is public, so one can come
 * from a tool that writes hexadecimal, or base64 with or without padding.
 */
export function isSameHash(a: string, b: string): boolean {
  const digest = hexDigestOf(a);
  return digest !== undefined && digest === hexDigestOf(b);
}

/**
 * Where the file of an asset is kept. The editor keeps the file in the project folder as well, on
 * the computer it came in on: this says where else it is, for other computers to get it from.
 *
 * - `local`: nowhere else. What the editor writes for a file that comes in.
 * - `lfs`: in Git LFS of the repository the project is kept in, which has a pointer file at the
 *   path of the asset. The pointer is made of `hash` and `size`, which the editor always writes;
 *   projects from before 2026-11-10 can be without them, and then the file cannot be downloaded.
 * - `platform`: in the cloud space of the platform that the project syncs with, found by `hash`. It
 *   needs `hash` and `size`.
 * - `remote`: at `url`, such as in the person's own object storage. The file of a private bucket
 *   only comes to an address signed with the keys on that person's computer: others see where it
 *   is, not the file.
 * - `git`: an ordinary file of the person's own Git repository. The editor never writes it, and a
 *   platform that keeps the project in Git leaves the file alone.
 *
 * The editor only says `lfs`, `platform` or `remote` once the file got there and was checked, see
 * `asset.setStorage`.
 */
export const AssetStorage = z.enum(["git", "lfs", "local", "platform", "remote"]);

/**
 * Where the editor puts a file for other computers, which they can download it from: the person's
 * own Git is up to the person.
 */
export type Elsewhere = "lfs" | "platform" | "remote";

export const isElsewhere = (storage: string): storage is Elsewhere =>
  storage === "lfs" || storage === "platform" || storage === "remote";

/**
 * Where else than here the file of an asset can be downloaded from: where it is kept, with the
 * content known to check what comes by, `hash` and `size`. Undefined for a file only here, in the
 * person's own Git, or that nothing could check, such as an `lfs` asset of a project from before.
 */
export function downloadableFrom(
  asset: Pick<Asset, "storage" | "url" | "hash" | "size">,
): Elsewhere | undefined {
  const { storage } = asset;
  if (!isElsewhere(storage) || asset.hash === undefined || asset.size === undefined) {
    return undefined;
  }
  return storage === "remote" && asset.url === undefined ? undefined : storage;
}

/**
 * What a value of `storage` needs besides, see `AssetStorage`. Not `lfs`: projects from before
 * 2026-11-10 have it without, and the format goes on taking them.
 */
const STORAGE_NEEDS: Readonly<Record<string, readonly ("hash" | "size" | "url")[]>> = {
  platform: ["hash", "size"],
  remote: ["url"],
};

export const Asset = z
  .strictObject({
    name: z.string().optional(),
    kind: z.enum(["video", "audio", "image", "font", "model", "other"]),
    /** Where the file is, or would be, inside the project. */
    path: RelativePath,
    storage: AssetStorage,
    /** Where a `remote` file is. */
    url: HttpsUrl.optional(),
    /** Caches and exports know by this whether the content changed. */
    hash: AssetHash.optional(),
    size: z.number().int().nonnegative().optional(),
    info: MediaInfo.optional(),
    license: z.string().optional(),
    credit: z.string().optional(),
    /** Free words for finding it, such as 片头 or 竖屏可用. See `ResourceTags`. */
    tags: ResourceTags.optional(),
  })
  .superRefine((asset, context) => {
    const needs = Object.hasOwn(STORAGE_NEEDS, asset.storage) ? STORAGE_NEEDS[asset.storage] : [];
    for (const field of needs ?? []) {
      if (asset[field] !== undefined) continue;
      const message = `${asset.storage} 素材要写 ${field}`;
      context.addIssue({ code: "custom", path: [field], message });
    }
  })
  // The same in the published JSON Schema, which has no other way to say it.
  .meta({
    allOf: Object.entries(STORAGE_NEEDS).map(([storage, fields]) => ({
      if: { properties: { storage: { const: storage } }, required: ["storage"] },
      // oxlint-disable-next-line unicorn/no-thenable -- it is what JSON Schema calls it
      then: { required: fields },
    })),
  });

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
  /** Free words for finding it, see `ResourceTags`. */
  tags: ResourceTags.optional(),
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
    )
    .superRefine((notes, context) => checkUnique(notes, context, (index) => [index, "id"])),
});

export type ProjectManifest = z.output<typeof ProjectManifest>;
export type Asset = z.output<typeof Asset>;
export type Assets = z.output<typeof Assets>;
export type Libraries = z.output<typeof Libraries>;
export type LibrariesLock = z.output<typeof LibrariesLock>;
export type SceneManifest = z.output<typeof SceneManifest>;
export type SoundManifest = z.output<typeof SoundManifest>;
export type Locale = z.output<typeof Locale>;
export type Notes = z.output<typeof Notes>;
