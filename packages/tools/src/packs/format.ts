import { z } from "zod";
import type { TextValue } from "../texts/index.ts";
import { DETAILS, type Detail } from "./detail.ts";

/**
 * The format of a model pack: a folder with `pack.json` and the files it names, or `pack.json` on
 * its own. It only declares: which models it is for, which words of the tools and the system prompt
 * it changes, by key, how to call the model and how much results give. Nothing in it can name a
 * tool, a schema, a result, an error or a permission: there is no field for them, and a field the
 * format does not have is refused. See `docs/model-packs.md` of this repository.
 */
export const PACK_FORMAT = 1;

/** The file every pack has. */
export const MANIFEST = "pack.json";

/** Ids that start so are AnimaQuill's own packs. */
export const BUILTIN_PREFIX = "animaquill/";

/** The steps of reasoning a pack can ask for; pi maps them to what each service has. */
export const REASONING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * How to call a model: a closed list, so that nothing else reaches a request. A pack cannot add
 * tools of a service, servers, metadata or any field of a request this does not name.
 */
export interface CallSettings {
  readonly reasoning?: (typeof REASONING)[number];
  /** The most an answer writes, its thinking included where it thinks. */
  readonly maxOutputTokens?: number;
  /** Sent only where it is set, and only to models that take it. */
  readonly temperature?: number;
  /** Whether an answer may call several tools; tools still run one at a time. */
  readonly parallelToolCalls?: boolean;
  /** How long a service keeps the start of the conversation cached. */
  readonly cache?: "short" | "long";
  /** Only for the Anthropic protocol: whether a summary of the thinking comes back. */
  readonly anthropic?: { readonly thinkingDisplay?: "summarized" | "omitted" };
}

/** The most an answer may write that a pack can ask for; a model that has less gets its own. */
export const MAX_OUTPUT_TOKENS = 256_000;

export const CallSchema = z.strictObject({
  reasoning: z.enum(REASONING).optional(),
  maxOutputTokens: z.number().int().min(1024).max(MAX_OUTPUT_TOKENS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  parallelToolCalls: z.boolean().optional(),
  cache: z.enum(["short", "long"]).optional(),
  anthropic: z
    .strictObject({ thinkingDisplay: z.enum(["summarized", "omitted"]).optional() })
    .optional(),
});

/** A pattern of model names: letters, digits, `.-_:@/+`, and `*` for anything. */
const Pattern = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._:@/+*-]+$/, "a pattern has letters, digits, . - _ : @ / + and *");

const HttpsUrl = z
  .string()
  .max(300)
  .regex(/^https:\/\/[^\s]+$/, "an address that starts with https://");

/** Words, or the file of the pack that has them. */
const FileRef = z.strictObject({ file: z.string().min(1).max(200) });
const Text = z.union([z.string(), FileRef]);
const Append = z.strictObject({ append: Text });
/** Replaces the words, or goes on after them. */
const TextEdit = z.union([Text, Append]);
/** A part of the system prompt can also go: null. */
const PartEdit = z.union([Text, Append, z.null()]);

const OperationExample = z.strictObject({
  title: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()),
});
const EditExample = z.array(z.record(z.string(), z.unknown()));
const OperationExamples = z.union([
  z.array(OperationExample),
  FileRef,
  z.strictObject({ append: z.union([z.array(OperationExample), FileRef]) }),
]);
const EditExamples = z.union([
  z.array(EditExample),
  FileRef,
  z.strictObject({ append: z.union([z.array(EditExample), FileRef]) }),
]);

/** The parts of the system prompt, in the order they go (see `SYSTEM_PARTS`). */
const System = z.strictObject({
  intro: PartEdit.optional(),
  project: PartEdit.optional(),
  work: PartEdit.optional(),
  rules: PartEdit.optional(),
  extra: PartEdit.optional(),
  guard: PartEdit.optional(),
  host: PartEdit.optional(),
});

const Variant = z.strictObject({
  models: z.array(Pattern).min(1).max(50),
  call: CallSchema.optional(),
  results: z.enum(DETAILS).optional(),
  system: z.strictObject({ extra: PartEdit.optional() }).optional(),
});

export const ManifestSchema = z.strictObject({
  format: z.literal(PACK_FORMAT),
  id: z
    .string()
    .max(64)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "author/name, in lower case letters, digits and -",
    ),
  name: z.string().min(1).max(60),
  version: z
    .string()
    .max(40)
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "a version such as 1.2.0"),
  description: z.string().max(300).optional(),
  author: z
    .union([
      z.string().min(1).max(80),
      z.strictObject({ name: z.string().min(1).max(80), url: HttpsUrl.optional() }),
    ])
    .optional(),
  license: z
    .string()
    .max(80)
    .regex(/^[A-Za-z0-9.+\-() ]+$/, "an SPDX identifier, such as MIT")
    .optional(),
  homepage: HttpsUrl.optional(),
  models: z.array(Pattern).max(50).optional(),
  call: CallSchema.optional(),
  results: z.enum(DETAILS).optional(),
  variants: z.array(Variant).max(20).optional(),
  system: System.optional(),
  tools: z
    .record(
      z.string(),
      z.strictObject({
        description: TextEdit.optional(),
        params: z.record(z.string(), TextEdit).optional(),
      }),
    )
    .optional(),
  ops: z
    .record(
      z.string(),
      z.strictObject({
        summary: Text.optional(),
        description: TextEdit.optional(),
        params: z.record(z.string(), Text).optional(),
        examples: OperationExamples.optional(),
      }),
    )
    .optional(),
  params: z.record(z.string(), Text).optional(),
  types: z.record(z.string(), Text).optional(),
  edit: z.strictObject({ examples: EditExamples.optional() }).optional(),
});

export type Manifest = z.output<typeof ManifestSchema>;

/** One change a pack makes to the words: they go, they are replaced, or more goes after them. */
export type PackEdit =
  | { readonly key: string; readonly how: "set" | "append"; readonly value: TextValue }
  | { readonly key: string; readonly how: "remove" };

/** What differs for some of the models of a pack: the first that fits goes over the pack. */
export interface PackVariant {
  readonly models: readonly string[];
  readonly call: CallSettings;
  readonly results?: Detail;
  /** What it does with the part `extra` of the system prompt, after the pack did. */
  readonly extra?: PackEdit;
}

export interface PackAuthor {
  readonly name: string;
  readonly url?: string;
}

/**
 * A pack as the tools use it: checked by `checkPack` (or AnimaQuill's own, made in code), with its
 * words read from its files. What it does not change stays as the default pack has it.
 */
export interface ModelPack {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: PackAuthor;
  readonly license?: string;
  readonly homepage?: string;
  /** It comes with AnimaQuill. */
  readonly builtin: boolean;
  /**
   * Not listed unless people ask to see such packs, and never chosen for a model on its own: only
   * when people choose it. Only packs AnimaQuill makes in code are; pack.json has no such field.
   */
  readonly hidden?: true;
  /** The models it is for, see `fitsModel`; none for the default pack, which is for the rest. */
  readonly models: readonly string[];
  readonly call: CallSettings;
  readonly results?: Detail;
  readonly variants: readonly PackVariant[];
  readonly edits: readonly PackEdit[];
  /** A hash of all of it, which a conversation records with the id and version. */
  readonly hash: string;
}
