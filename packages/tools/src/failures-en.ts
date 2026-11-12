import type {
  CommandFailure,
  FailureCode,
  FailureParams,
  InvalidValue,
  ParamIssue,
} from "@animaquill/core";
import { BUILT_IN_TRANSITIONS, EFFECT_TYPES } from "@animaquill/schema";
import { englishRule } from "./issues.ts";

/**
 * What a failure says to AI, in English, from its code and parameters: what went wrong, and where
 * it helps, what to do about it. The editor says the same to people in its own words, see
 * `failures.*` of its texts. Every code has its words here, which the tests hold to.
 */

type Texts = {
  readonly [C in FailureCode]: (params: FailureParams<C>, failure: CommandFailure) => string;
};

type Rule = InvalidValue["rule"];
type RuleTexts = {
  readonly [R in Rule]: (params: Extract<InvalidValue, { readonly rule: R }>) => string;
};

const list = (items: readonly string[]) => items.map((item) => JSON.stringify(item)).join(", ");

const KIND_WORDS: Readonly<Record<string, string>> = {
  timeline: "timeline",
  section: "section",
  track: "track",
  clip: "clip",
  marker: "marker",
  join: "join",
  effect: "effect",
  scene: "scene",
  sound: "sound",
  asset: "asset",
  file: "file",
  folder: "folder of a scene or sound",
  property: "property",
  key: "key at time",
  parameter: "effect parameter",
};

const word = (kind: string) => KIND_WORDS[kind] ?? kind;

const EXPECTS: Readonly<Record<string, string>> = {
  number: "a number",
  boolean: "true or false",
  text: "a string",
  asset: "an asset reference",
  color: 'a color "#rrggbb" or "#rrggbbaa"',
  numbers: "an array of numbers",
};

export const INVALID_VALUE_TEXTS: RuleTexts = {
  format: ({ path, message }) => `${path || "The value"} ${englishRule(message)}.`,
  "retired-property": ({ path }) =>
    `There is no property ${path} any more: cropping is an effect now (effect.add with type "crop").`,
  type: ({ path, expects, length }) =>
    `${path} has to be ${length === undefined ? EXPECTS[expects] : `an array of ${length} numbers`}.`,
  min: ({ path, min }) => `${path} cannot be less than ${min}.`,
  max: ({ path, max }) => `${path} cannot be more than ${max}.`,
  choice: ({ path, options }) => `${path} has to be one of ${list(options)}.`,
  "unknown-property": ({ path, transition }) => `Transition ${transition} has no property ${path}.`,
  "no-keys": ({ path }) => `Properties of transitions cannot have keys: ${path}.`,
  "not-a-path": ({ path }) => `${JSON.stringify(path)} is no property path.`,
  "rename-same": ({ path }) => `A property cannot be renamed to itself: ${path}.`,
  "renamed-twice": ({ path }) => `The same property cannot be renamed twice in one step: ${path}.`,
  "rename-into-one": ({ path }) => `Two properties cannot be renamed to the same path: ${path}.`,
  "scale-numbers-only": () => "Only numbers can be scaled or offset.",
  "track-settings": ({ trackKind }) => `${an(trackKind, true)} track does not have these settings.`,
  "moved-twice": ({ clip }) => `The same clip cannot be moved twice in one step: ${clip}.`,
  "end-before-start": ({ clip }) => `The end of clip ${clip} has to come after its start.`,
  "cut-outside": ({ clip, at }) => `${at} is not inside clip ${clip}: a cut has to be within it.`,
  "key-taken": ({ time }) => `There can be only one key at a time: two at ${time}.`,
  "key-moved-twice": ({ time }) => `The same key cannot be moved twice in one step: ${time}.`,
  "effect-outside": () =>
    "An effect has to work within its clip: start and end are from its start.",
  "effect-backwards": () => "The start of an effect has to come before its end.",
  "replace-same": ({ kind, id }) => `The ${kind} to use instead is the same one: ${id}.`,
  "source-kind": ({ clip, sourceKind, asset, version }) =>
    `Clip ${clip}${version === undefined ? "" : ` in version ${version}`} is ${an(sourceKind)} clip and cannot use asset ${asset}.`,
  "join-one-clip": ({ clip }) => `A join goes between two different clips, not ${clip} and itself.`,
  "join-incomplete": ({ join }) => `Join ${join} is incomplete: it can only be removed.`,
  "sound-entry": ({ entry }) =>
    `The entry of a sound has to be a .js or .mjs file, not ${JSON.stringify(entry)}.`,
  "size-unknown": ({ asset }) => `The size of the file of asset ${asset} is not known yet.`,
};

function invalidValue(params: InvalidValue): string {
  const text = INVALID_VALUE_TEXTS[params.rule] as (params: InvalidValue) => string;
  return text(params);
}

function paramIssue({ path, issue, message, keys }: ParamIssue): string {
  const where = path === "" ? "the parameters" : path;
  if (issue === "unrecognized_keys" && keys) return `${where}: unknown parameter ${list(keys)}`;
  return `${where}: ${englishRule(message)}`;
}

const MISSING_TRANSITION: Readonly<Record<string, (why: Record<string, string>) => string>> = {
  unknown: ({ type }) =>
    `There is no transition ${type}. Built-in transitions: ${Object.keys(BUILT_IN_TRANSITIONS.picture).join(", ")} for pictures; ${Object.keys(BUILT_IN_TRANSITIONS.sound).join(", ") || "none"} for sound.`,
  plugin: ({ type }) => `Transition ${type} comes from a plugin that is not installed.`,
  project: ({ transition }) => `Transitions of the project (${transition}) cannot be used yet.`,
  library: ({ library, resource }) =>
    `Transitions of libraries (${library}/${resource}) cannot be used yet.`,
  use: ({ type, use }) => `Transition ${type} cannot be used as ${use}.`,
  media: ({ type, media }) => `Transition ${type} does not work on ${media}.`,
};

const MISSING_EFFECT: Readonly<Record<string, (why: Record<string, string>) => string>> = {
  unknown: ({ type }) =>
    `There is no effect ${type}. Built-in effects: ${EFFECT_TYPES.join(", ")}.`,
  plugin: ({ type }) => `Effect ${type} comes from a plugin that is not installed.`,
  media: ({ type, media }) => `Effect ${type} does not work on ${media}.`,
};

export const FAILURE_TEXTS: Texts = {
  "invalid-params": ({ issues }) =>
    `The parameters do not fit: ${issues.map(paramIssue).join("; ")}.`,
  "unknown-command": ({ command }) => `There is no operation ${command}; aq_guide lists them.`,
  "user-only": ({ command, param }) =>
    param !== undefined
      ? `Only the user can use the parameter ${param}${command ? ` of ${command}` : ""}. Leave it out.`
      : command !== undefined
        ? `Only the user can do ${command}. Ask the user to do it if it is needed.`
        : "Only the user can change the tags of the project.",
  "storage-only": () => "Uploads only write down where files are.",
  "project-locked": () =>
    "The project has a tag that locks it. Tell the user; do not try again until it is unlocked.",
  "read-only": () => "The project is read-only for now. Tell the user; do not try again.",
  "missing-updates": () => "Changes from elsewhere are still arriving. Try again in a moment.",
  conflict: () =>
    "Somebody else changed what you are changing after you last read it. Read it again with aq_object_read, then decide whether your change still fits.",
  "stale-revision": () =>
    "The project was reopened since you read it, so what you read is out of date. Read again what you are about to change; the tools keep track of revisions for you.",
  "would-break-document": ({ file, path, message }) =>
    `This would make ${file} invalid at ${path || "the top"} (${path || "it"} ${englishRule(message)}). Often an id that is taken or a value out of range.`,
  "not-found": ({ kind, id, clip, why }) => {
    if (why !== undefined) {
      const missing = why as unknown as Record<string, string>;
      return MISSING_EFFECT[missing.reason ?? ""]?.(missing) ?? `There is no effect ${id}.`;
    }
    return `There is no ${word(kind)} ${id}${clip === undefined ? "" : ` on clip ${clip}`}.`;
  },
  "id-taken": ({ kind, id, by }) =>
    `The id ${id} is taken by a ${word(by)}${by === kind ? "" : ` (sections, tracks and clips of a timeline share their ids)`}. Use another id, or leave it out to get a new one.`,
  "wrong-track": ({ trackKind, holds, sourceKind }) =>
    holds === "clip"
      ? `${an(trackKind, true)} track cannot hold ${sourceKind ? `${an(sourceKind)} clip` : "this clip"}: ${trackFor(sourceKind)}`
      : holds === "effect"
        ? `Only clips on video tracks can have effects so far, not on a ${trackKind} track.`
        : `${an(trackKind, true)} track cannot have joins; joins go between clips on video and audio tracks.`,
  overlap: ({ clips, moved }) =>
    moved
      ? `Clips would land on the same place: ${clips.map((clip) => clip.id).join(", ")}. Give them starts that do not overlap.`
      : `There are clips in the way: ${clips.map((clip) => clip.id).join(", ")}. Choose a free place, or pass overlap: "overwrite".`,
  "not-adjacent": ({ from, to, why }) =>
    why === "tracks"
      ? `Clips ${from} and ${to} are on different tracks: a join needs both on one track.`
      : `There is a gap between clips ${from} and ${to}: a join needs the second to start where the first ends.`,
  "last-section": ({ timeline }) =>
    `Timeline ${timeline} needs at least one section: change its duration with section.update instead, or add another section first.`,
  "source-start": ({ clip }) =>
    `Clip ${clip} would start before what it shows starts: trim its start to a later time.`,
  "source-end": ({ clip }) =>
    `Clip ${clip} would go on after what it shows ends: end it earlier with clip.trim, or set loop: true with clip.update.`,
  "transition-missing": ({ why }) => {
    const missing = why as unknown as Record<string, string>;
    return MISSING_TRANSITION[missing.reason ?? ""]?.(missing) ?? "There is no such transition.";
  },
  "transition-unsupported": ({ type, media, use, caption }) =>
    caption
      ? "Transitions of captions cannot be shown yet."
      : `This editor cannot do ${type} as ${use} on ${media} yet.`,
  "transition-too-long": ({ why, longest }) =>
    why === "edges"
      ? "The enter and exit transitions together would be longer than the clip."
      : why === "join"
        ? "This transition and the join at the other end would be longer than the clip."
        : why === "longest"
          ? `The join is too long: at most ${longest} seconds here.`
          : "There is no room for a join at this cut.",
  "not-animatable": ({ path }) => `${path} cannot have keys.`,
  "join-taken": ({ join }) => `This cut has a join already: ${join}. Use join.update to change it.`,
  "asset-in-use": ({ asset, by, file }) =>
    by === "code"
      ? `Code uses asset ${asset} (${file ?? ""}): change the code first.`
      : `Clips or versions use asset ${asset}: replace or remove them first, or pass withUses: true.`,
  "scene-in-use": ({ scene }) =>
    `Clips or versions use scene ${scene}: replace or remove them first, or pass withUses: true.`,
  "sound-in-use": ({ sound }) =>
    `Clips or versions use sound ${sound}: replace or remove them first, or pass withUses: true.`,
  "entry-in-use": ({ path, why }) =>
    why === "remove"
      ? `${path} is an entry: give its scene or sound another entry first.`
      : `${path} is an entry and cannot leave its folder.`,
  "missing-entry": ({ kind, entry }) =>
    `The entry of the ${kind} is not there: ${entry}. Give its files an entry of that name, or name one of its files as entry.`,
  "path-taken": ({ path, by }) =>
    by === "manifest"
      ? `${path} is where the folder keeps its own manifest.`
      : `There is a ${by} at ${path} already.`,
  "file-too-large": ({ path, limit }) => `${path} is larger than ${limit / 1024 ** 2} MiB.`,
  "runtime-too-new": ({ runtime, current }) =>
    `Runtime ${runtime} is newer than this editor's ${current}: use runtime ${current}.`,
  "invalid-value": invalidValue,
  "not-moved": ({ clip }) => `This batch did not take away clip ${clip}.`,
  "not-in-use": ({ kind, id }) => `No clip uses the ${kind} ${id}.`,
  "upload-only": () => "Only uploads can write down that a file is kept elsewhere.",
  "asset-file-changed": ({ asset }) => `The file of asset ${asset} is another one by now.`,
  "nothing-to-undo": () => "There is nothing to undo.",
  "undo-one-by-one": () => "The user's own changes are undone one at a time.",
  "undo-blocked": (_, { obstacle }) =>
    obstacle === "inUse"
      ? "Nothing could be undone: other things use it, or what it uses is gone."
      : "Nothing could be undone: others changed it since.",
  "invalid-file": ({ path }) => `${path} does not fit the project format, so it did not come in.`,
  "format-mismatch": () => "The format version of the project cannot be changed here.",
  "invalid-batch": ({ path }) =>
    path === undefined ? "The batch of files is malformed." : `The batch has ${path} twice.`,
  "merge-failed": ({ detail }) => `Merging the files went wrong: ${detail}.`,
  "manifest-deleted": () => "animaquill.json is gone from the project folder.",
  "merge-unsettled": () => "Some changes of the files could not be settled.",
  "merge-would-break": ({ why }) =>
    why === "uses-removed"
      ? "The files use what the editor just removed."
      : "The files and what the editor has not written yet would break the project together.",
};

/**
 * The code AI sees for a code of the core: what only people may do is `not-allowed` to AI, and an
 * operation there is not is `unknown-operation`, as the tools say for operations they do not take.
 */
export function aiCode(code: FailureCode): string {
  if (code === "user-only") return "not-allowed";
  if (code === "unknown-command") return "unknown-operation";
  return code;
}

/** What a failure says, without its code. */
export function failureWords(failure: CommandFailure): string {
  const text = FAILURE_TEXTS[failure.code] as (
    params: Readonly<Record<string, unknown>>,
    failure: CommandFailure,
  ) => string;
  return text(failure.params, failure);
}

/** What a failure says, with its code first, as AI reads it. */
export const failureText = (failure: CommandFailure): string =>
  `${aiCode(failure.code)}: ${failureWords(failure)}`;

/**
 * The same, for a batch of operations: which of them it was, counted from 0 as the parameters are,
 * and what it was. Nothing of a batch is written when one of it fails.
 */
export function operationFailureText(failure: CommandFailure, names: readonly string[]): string {
  const { index } = failure;
  if (index === undefined) return `error ${failureText(failure)} Nothing was written.`;
  const name = names[index];
  const fine =
    index === 0
      ? ""
      : index === 1
        ? "operations[0] was fine; "
        : `operations[0] ${index === 2 ? "and" : "to"} [${index - 1}] were fine; `;
  const after = index < names.length - 1 ? `; operations after [${index}] were not checked` : "";
  return `error ${aiCode(failure.code)} in operations[${index}] (${name}): ${failureWords(failure)}\n${fine}nothing was written${after}`;
}

/** A word with its article: "an audio", "a video". */
function an(noun: string, first = false): string {
  const article = /^[aeiou]/i.test(noun) ? "an" : "a";
  return `${first ? article[0]?.toUpperCase() + article.slice(1) : article} ${noun}`;
}

/** Where a clip of a kind goes. */
function trackFor(kind: string | undefined): string {
  if (kind === "caption") return "captions go on caption tracks.";
  if (kind === "audio" || kind === "sound" || kind === "music")
    return "sound goes on audio tracks.";
  return "pictures go on video tracks.";
}
