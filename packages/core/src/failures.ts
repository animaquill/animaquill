import type { EffectMissing, Problem, TransitionMissing, ValueIssue } from "@animaquill/schema";
import { z } from "zod";
import type { Path } from "./structure.ts";

/**
 * Why a command or a change did not happen, as a code and what it is about. Each code always means
 * the same thing, and its parameters say the rest: whoever tells about it, a person in the editor or
 * an AI, says it in their own words from these, see `failures.*` of the editor's texts and
 * `@animaquill/tools`. Nothing here is a sentence.
 */

/** What a failure can be about, by what people and AI call it. */
export const FailedKind = z.enum([
  "timeline",
  "section",
  "track",
  "clip",
  "marker",
  "join",
  "effect",
  "scene",
  "sound",
  "asset",
  "file",
  /** The folder of a scene or sound that a file would go in. */
  "folder",
  /** A property of a clip, by its path. */
  "property",
  /** A key of a property, by its time. */
  "key",
  /** A parameter of an effect. */
  "parameter",
]);
export type FailedKind = z.output<typeof FailedKind>;

/** Where something comes from, of the kinds that clips use. */
const ResourceKind = z.enum(["asset", "scene", "sound"]);

const Missing = z.custom<TransitionMissing>((value) => typeof value === "object" && value !== null);
const EffectMissingWhy = z.custom<EffectMissing>(
  (value) => typeof value === "object" && value !== null,
);

/** What the format says about something, from its own checks: where, and what it says. */
const FormatIssue = { path: z.string(), message: z.string() };

/** A value that a property or a parameter cannot take, see `ValueIssue`. */
const Value = <R extends string, S extends z.ZodRawShape>(rule: R, shape: S) =>
  z.strictObject({ rule: z.literal(rule), path: z.string(), ...shape });

/**
 * Values that a command cannot write, each by a rule of its own. The format's own checks come as
 * `format`, with what it says, see `FormatIssue`.
 */
export const InvalidValue = z.discriminatedUnion("rule", [
  /** The format turns it away: the schema of a clip, an asset, a manifest, a join, a path. */
  z.strictObject({ rule: z.literal("format"), ...FormatIssue }),
  /** A property that is no property any more, such as crop, which is an effect now. */
  z.strictObject({ rule: z.literal("retired-property"), path: z.string() }),
  /** A value of a property or a parameter, see `ValueIssue`. */
  Value("type", {
    expects: z.enum(["number", "boolean", "text", "asset", "color", "numbers"]),
    length: z.number().optional(),
  }),
  Value("min", { min: z.number() }),
  Value("max", { max: z.number() }),
  Value("choice", { options: z.array(z.string()).readonly() }),
  /** A transition does not have this property. */
  Value("unknown-property", { transition: z.string() }),
  /** No property of a transition has keys. */
  Value("no-keys", {}),
  /** Not a property path at all. */
  z.strictObject({ rule: z.literal("not-a-path"), path: z.string() }),
  /** A property renamed to itself. */
  z.strictObject({ rule: z.literal("rename-same"), path: z.string() }),
  /** One property renamed twice in a step. */
  z.strictObject({ rule: z.literal("renamed-twice"), path: z.string() }),
  /** Two properties renamed to one. */
  z.strictObject({ rule: z.literal("rename-into-one"), path: z.string() }),
  /** Only numbers can be scaled or offset, see `property.rename`. */
  z.strictObject({ rule: z.literal("scale-numbers-only") }),
  /** A track of this kind has no such settings. */
  z.strictObject({ rule: z.literal("track-settings"), trackKind: z.string() }),
  /** One clip moved twice in a step. */
  z.strictObject({ rule: z.literal("moved-twice"), clip: z.string() }),
  /** The end of a clip has to come after its start. */
  z.strictObject({ rule: z.literal("end-before-start"), clip: z.string() }),
  /** A cut has to be inside the clip. */
  z.strictObject({ rule: z.literal("cut-outside"), clip: z.string(), at: z.string() }),
  /** Two keys at one moment. */
  z.strictObject({ rule: z.literal("key-taken"), time: z.string() }),
  /** One key moved twice in a step. */
  z.strictObject({ rule: z.literal("key-moved-twice"), time: z.string() }),
  /** An effect works within its clip. */
  z.strictObject({ rule: z.literal("effect-outside") }),
  /** An effect starts before it ends. */
  z.strictObject({ rule: z.literal("effect-backwards") }),
  /** Replacing something with itself. */
  z.strictObject({ rule: z.literal("replace-same"), kind: ResourceKind, id: z.string() }),
  /** A clip, or a clip of a version, cannot use an asset of that kind. */
  z.strictObject({
    rule: z.literal("source-kind"),
    clip: z.string(),
    sourceKind: z.string(),
    asset: z.string(),
    version: z.string().optional(),
  }),
  /** A join goes between two clips, not one. */
  z.strictObject({ rule: z.literal("join-one-clip"), clip: z.string() }),
  /** Only some of a join is there, which cannot be changed, only taken away. */
  z.strictObject({ rule: z.literal("join-incomplete"), join: z.string() }),
  /** The entry of a sound has to be a script, as it runs in a worker. */
  z.strictObject({ rule: z.literal("sound-entry"), entry: z.string() }),
  /** Where a file is kept elsewhere cannot be written down without its size. */
  z.strictObject({ rule: z.literal("size-unknown"), asset: z.string() }),
]);
export type InvalidValue = z.output<typeof InvalidValue>;

/** One thing wrong with the parameters of a command, as zod tells it. */
export const ParamIssue = z.strictObject({
  /** Where, such as `clips.0.start`; empty for the parameters as a whole. */
  path: z.string(),
  /** What zod calls it, such as `invalid_type` or `unrecognized_keys`. */
  issue: z.string(),
  /** What zod or the format says about it, which can be in Chinese for rules of the format. */
  message: z.string(),
  /** Keys that are not there, for `unrecognized_keys`. */
  keys: z.array(z.string()).optional(),
});
export type ParamIssue = z.output<typeof ParamIssue>;

const none = z.strictObject({});

/** Every failure there is, with what it is about. */
export const FAILURES = {
  // What any command can run into, whatever it does.
  /** The parameters do not fit, every place where they do not. */
  "invalid-params": z.strictObject({ issues: z.array(ParamIssue) }),
  "unknown-command": z.strictObject({ command: z.string() }),
  /** Only a person can do this, or use this parameter. */
  "user-only": z.strictObject({ command: z.string().optional(), param: z.string().optional() }),
  /** Uploads only write down where files are. */
  "storage-only": z.strictObject({ command: z.string().optional() }),
  "project-locked": none,
  "read-only": none,
  "missing-updates": none,
  /** Somebody else changed what this would change since the revision it was given, see `conflicts`. */
  conflict: none,
  /** The revision it was given is of another time of this project, such as before a reload. */
  "stale-revision": z.strictObject({ given: z.string(), current: z.string() }),
  /** A document that was valid would no longer be. */
  "would-break-document": z.strictObject({ file: z.string(), ...FormatIssue }),

  // What commands find, see their `failures`.
  "not-found": z.strictObject({
    kind: FailedKind,
    id: z.string(),
    /** The clip that it would be on, for effects, properties, keys and parameters. */
    clip: z.string().optional(),
    /** For an effect that this editor does not have. */
    why: EffectMissingWhy.optional(),
  }),
  /** Sections, tracks and clips of a timeline share their ids: `by` is what has it. */
  "id-taken": z.strictObject({ kind: FailedKind, id: z.string(), by: FailedKind }),
  /** A track that cannot hold this: a clip of another kind, effects, joins. */
  "wrong-track": z.strictObject({
    trackKind: z.string(),
    holds: z.enum(["clip", "effect", "join"]),
    sourceKind: z.string().optional(),
  }),
  /** Clips in the way, by id and name; `moved` when they are all being moved there at once. */
  overlap: z.strictObject({
    clips: z.array(z.strictObject({ id: z.string(), name: z.string().optional() })),
    moved: z.boolean().optional(),
  }),
  /** A join needs two clips next to each other on one track. */
  "not-adjacent": z.strictObject({
    from: z.string(),
    to: z.string(),
    why: z.enum(["tracks", "gap"]),
  }),
  "last-section": z.strictObject({ timeline: z.string() }),
  /** A clip cannot start before what it shows does. */
  "source-start": z.strictObject({ clip: z.string(), name: z.string().optional() }),
  "source-end": z.strictObject({ clip: z.string(), name: z.string().optional() }),
  "transition-missing": z.strictObject({ why: Missing }),
  /** This editor does not do it yet; `caption` for transitions of captions, which do not show yet. */
  "transition-unsupported": z.strictObject({
    type: z.string(),
    media: z.enum(["picture", "sound"]),
    use: z.enum(["enter", "exit", "join"]),
    caption: z.boolean().optional(),
  }),
  /**
   * Longer than there is room for: both edges together (`edges`), with a join at the other end
   * (`join`), a join longer than `longest` (`longest`), no room at all (`no-room`).
   */
  "transition-too-long": z.strictObject({
    why: z.enum(["edges", "join", "longest", "no-room"]),
    longest: z.string().optional(),
  }),
  "not-animatable": z.strictObject({ path: z.string() }),
  "join-taken": z.strictObject({ join: z.string() }),
  /** Clips or versions use it (`clips`), or code does (`code`, in `file`). */
  "asset-in-use": z.strictObject({
    asset: z.string(),
    by: z.enum(["clips", "code"]),
    file: z.string().optional(),
  }),
  "scene-in-use": z.strictObject({ scene: z.string() }),
  "sound-in-use": z.strictObject({ sound: z.string() }),
  /** An entry cannot go: removed (`remove`), or moved out of its folder (`move`). */
  "entry-in-use": z.strictObject({ path: z.string(), why: z.enum(["remove", "move"]) }),
  "missing-entry": z.strictObject({ kind: z.enum(["scene", "sound"]), entry: z.string() }),
  /** Something has this path already: a manifest, a file, a folder or, for renames, a property. */
  "path-taken": z.strictObject({
    path: z.string(),
    by: z.enum(["manifest", "file", "folder", "property"]),
  }),
  "file-too-large": z.strictObject({ path: z.string(), limit: z.number() }),
  "runtime-too-new": z.strictObject({ runtime: z.number(), current: z.number() }),
  "invalid-value": InvalidValue,
  "not-moved": z.strictObject({ clip: z.string() }),
  "not-in-use": z.strictObject({ kind: ResourceKind, id: z.string() }),
  "upload-only": none,
  /** The file of an asset is not the one an upload is about any more. */
  "asset-file-changed": z.strictObject({ asset: z.string() }),

  // Taking things back.
  "nothing-to-undo": none,
  /** The person's own changes go back one at a time. */
  "undo-one-by-one": none,
  /** Nothing could go back, see `obstacle` and `conflicts`. */
  "undo-blocked": none,

  // Files that come in, see `problems`.
  "invalid-file": z.strictObject({ path: z.string() }),
  "format-mismatch": none,
  "invalid-batch": z.strictObject({ path: z.string().optional() }),
  "merge-failed": z.strictObject({ detail: z.string() }),
  "manifest-deleted": none,
  "merge-unsettled": none,
  /** What came in and what the editor has not written yet would break the project together. */
  "merge-would-break": z.strictObject({ why: z.enum(["uses-removed", "breaks"]) }),

  // Temporary copies of a project, see `ProjectCopy`.
  /** The project is too large to copy: its update has `bytes`, more than `limit`. */
  "copy-too-large": z.strictObject({ bytes: z.number(), limit: z.number() }),
  /** The copy was discarded. */
  "copy-discarded": none,
  /** A copy cannot do this: take in new assets or files from a folder (`command`). */
  "not-in-copy": z.strictObject({ command: z.string() }),
} as const;

export type FailureCode = keyof typeof FAILURES;
export const FAILURE_CODES = Object.keys(FAILURES) as readonly FailureCode[];
export type FailureParams<C extends FailureCode> = z.input<(typeof FAILURES)[C]>;

/**
 * What every command can run into, whatever it does: the store checks these, so they are no
 * command's own `failures`.
 */
export const GENERAL_FAILURES = [
  "invalid-params",
  "unknown-command",
  "user-only",
  "storage-only",
  "project-locked",
  "read-only",
  "missing-updates",
  "conflict",
  "stale-revision",
  "would-break-document",
] as const satisfies readonly FailureCode[];

/** A failure, with the code and its parameters. Every one has the shape `FAILURES` gives it. */
export type Failure = {
  readonly [C in FailureCode]: { readonly code: C; readonly params: FailureParams<C> };
}[FailureCode];

/** Why a command did not happen. Commands throw it, callers get it as a result. */
export class CommandError extends Error {
  readonly code: FailureCode;
  readonly params: Readonly<Record<string, unknown>>;

  constructor(failure: Failure) {
    super(failure.code);
    this.code = failure.code;
    this.params = failure.params;
  }
}

/** Stops a command. Nothing it planned so far gets written. */
export const fail = <C extends FailureCode>(code: C, params: FailureParams<C>): never => {
  throw new CommandError({ code, params } as Failure);
};

/** Something with a name, as failures tell it: by id, and by name where it has one. */
export const named = ({
  id,
  name,
}: {
  readonly id: string;
  readonly name?: string | undefined;
}) => ({
  id,
  ...(name !== undefined && { name }),
});

/** Only the name of something, where it has one. */
export const nameOf = ({ name }: { readonly name?: string | undefined }) =>
  name === undefined ? {} : { name };

/** How a value issue of the format becomes a failure. */
export const invalidValue = (issue: ValueIssue | InvalidValue): never =>
  fail("invalid-value", issue);

/** What a failure is about, as a result says it. */
export interface CommandFailure {
  readonly code: FailureCode;
  readonly params: Readonly<Record<string, unknown>>;
  /** Which command of a batch it was, from 0. */
  readonly index?: number;
  /** What changed in the meantime, for a conflict; what stayed, for an undo. */
  readonly conflicts?: readonly Path[];
  /** Why a change cannot be taken back. */
  readonly obstacle?: "changed" | "inUse";
  /** What is wrong with a file, for an import or a merge. */
  readonly problems?: readonly Problem[];
}

/** The failure of a command error, with where it happened. */
export const failureOf = (error: CommandError, index?: number): CommandFailure => ({
  code: error.code,
  params: error.params,
  ...(index !== undefined && { index }),
});

/** What zod found wrong, as the parameters of `invalid-params`. */
export function paramIssues(error: z.ZodError): ParamIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    issue: issue.code,
    message: issue.message,
    ...(issue.code === "unrecognized_keys" && { keys: [...issue.keys] }),
  }));
}

/** The first thing the format says is wrong, as `invalid-value`. */
export function formatFailure(error: z.ZodError, under?: string): never {
  const issue = error.issues[0];
  const inner = issue?.path.map(String).join(".") ?? "";
  const path = under === undefined ? inner : inner ? `${under}.${inner}` : under;
  return fail("invalid-value", { rule: "format", path, message: issue?.message ?? "" });
}
