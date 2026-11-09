import {
  Id,
  PropertyPath,
  PropertyValue,
  TIME_PATTERN,
  ZERO,
  add,
  compare,
  formatTime,
  isAnimation,
  parseTime,
  subtract,
  type Animation,
  type Rational,
} from "@animaquill/schema";
import { z } from "zod";
import { laterValue, looksLikeClockMoved } from "./clip-edits.ts";
import { checkWrite } from "./commands.ts";
import { CommandError, fail, type ClipFact } from "./draft.ts";
import { clipEnd, clipOffset, clipStart, entryOf, type ClipState } from "./model.ts";
import { deepEqual } from "./patch.ts";
import { PropertyEdit, applyEdit } from "./property-edit.ts";
import { convertedValue, type Conversion } from "./rename.ts";
import { effectiveProperties } from "./render-plan.ts";
import { USER, type CommandFailure, type ProjectStore } from "./store.ts";

/** Plenty for going back through an afternoon of trying. A step only holds what it changed. */
const MAX_STEPS = 200;

/**
 * What is set aside waits for its clip to come back, which takes an undo here or in another window.
 * That happens soon or not at all, so waiting has limits. Beyond this many properties the ones that
 * have waited longest go, and people hear about it. After this many days they go when the project
 * opens, without a word: by then nobody knows what they were about.
 */
const MAX_SET_ASIDE = 200;
const SET_ASIDE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One property that is being tried out. */
export interface TrialChange {
  /** What the project held when this started. Anything else there now came from somebody else. */
  readonly base: PropertyValue | undefined;
  /** What it is being tried with. Undefined takes the property away. */
  readonly value: PropertyValue | undefined;
  /**
   * How far the clock of the clip went since, where the keys do not fit on it any more: they would
   * end up before it starts. They stay as they are and get set aside, until the clock comes back.
   */
  readonly moved?: string;
  /** When this got set aside, in milliseconds since 1970. */
  readonly asideSince?: number;
}

/** What is being tried out, by clip and then by property path. */
export type TrialChanges = ReadonlyMap<string, ReadonlyMap<string, TrialChange>>;

export type TrialResult =
  { readonly ok: true } | { readonly ok: false; readonly error: CommandFailure };

export type TrialSaved =
  | {
      readonly ok: true;
      /** How many properties it came to. */
      readonly saved: number;
      /** How many of those somebody else had changed in the meantime. */
      readonly overwritten: number;
    }
  | { readonly ok: false; readonly error: CommandFailure };

export interface TrialRestored {
  /** What is being tried again. What is set aside stays that way, and does not count. */
  readonly restored: number;
  /** What could not come back, because it is not valid any more. */
  readonly dropped: number;
  /** What is of no use any more, and should not stay around: see `Trial.restore`. */
  readonly stale: number;
  /** Nothing in there could be read at all. */
  readonly unreadable: boolean;
}

/** What people should hear about, because it happened without them asking for it. */
export type TrialNotice =
  /** This much cannot be used for now: its clip is gone, or its keys do not fit any more. */
  | { readonly kind: "aside"; readonly count: number }
  /** This much of it is back. */
  | { readonly kind: "back"; readonly count: number }
  /** There was too much of it, and this much went. */
  | { readonly kind: "dropped"; readonly count: number }
  /** A clip changed in a way that cannot be told apart from another one, so nothing moved. */
  | { readonly kind: "unsure" };

/** What one property goes back to, on the clock of its clip as it was then. */
interface Touch {
  readonly clip: string;
  readonly path: string;
  readonly change: TrialChange | undefined;
  /** How far that clock had moved by then, compared to when this started. */
  readonly clock: Rational;
}

/**
 * What a step goes back to, about the properties it changed and nothing else. So undo and redo only
 * reach what the step was about, and what happens to clips in the meantime leaves it alone. Taking
 * a step puts what it replaces on the other stack, which makes redo the exact opposite of undo.
 */
interface Step {
  touches: readonly Touch[];
  /** The step of the project that was the last one at that moment, to tell what came first. */
  after: number;
}

type Clips = Readonly<Record<string, ClipState>>;
type Entries = Map<string, ReadonlyMap<string, TrialChange>>;

const NO_CHANGES: TrialChanges = new Map();
const NO_CLIPS: Clips = {};
const DONE: TrialResult = { ok: true };

/** A property as it gets kept on this device. */
const StoredChange = z.strictObject({
  clip: Id,
  path: PropertyPath,
  base: PropertyValue.optional(),
  value: PropertyValue.optional(),
  moved: z.string().regex(TIME_PATTERN).optional(),
  asideSince: z.number().optional(),
});

/** Each change gets looked at on its own, so that a bad one does not take the others with it. */
const StoredTrial = z.strictObject({
  version: z.literal(1),
  timeline: Id,
  changes: z.array(z.unknown()),
});

type StoredTrial = z.output<typeof StoredTrial>;

/** Edits the way a command gets them, which also gives every time its one spelling. */
const Edits = z.array(PropertyEdit);

const failed = (error: CommandError): TrialResult => ({
  ok: false,
  error: { code: error.code, message: error.message },
});

const sizeOf = (changes: TrialChanges) =>
  [...changes.values()].reduce((sum, clip) => sum + clip.size, 0);

/** Compares what is there, which is enough: a change that stays the same keeps its identity. */
function sameChanges(a: TrialChanges, b: TrialChanges): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [clip, changes] of a) {
    const others = b.get(clip);
    if (others?.size !== changes.size) return false;
    for (const [path, change] of changes) if (others.get(path) !== change) return false;
  }
  return true;
}

function put(entries: Entries, clip: string, path: string, change: TrialChange | undefined): void {
  const held = new Map(entries.get(clip));
  if (change) held.set(path, change);
  else held.delete(path);
  if (held.size > 0) entries.set(clip, held);
  else entries.delete(clip);
}

const isValid = (value: PropertyValue | undefined) =>
  value === undefined || PropertyValue.safeParse(value).success;

const later = (value: PropertyValue | undefined, by: Rational) =>
  value === undefined ? undefined : laterValue(value, by);

/**
 * A change on a clock that moved. Keys go along, the way they do in the project. Where they would end
 * up before the clock starts they cannot be saved, so they wait as they are until they fit again.
 */
function onMovedClock(change: TrialChange, by: Rational): TrialChange {
  const total = add(change.moved === undefined ? ZERO : parseTime(change.moved), by);
  const { moved: _moved, ...rest } = change;
  const value = later(change.value, total);
  const base = later(change.base, total);
  if (isValid(value) && isValid(base)) return { ...rest, base, value };
  return { ...rest, moved: formatTime(total) };
}

/** Takes what happened to a clip over to what is tried on it right now. */
function applyFact(entries: Entries, fact: ClipFact, clocks: Map<string, Rational>): void {
  switch (fact.kind) {
    case "clock": {
      const by = parseTime(fact.by);
      clocks.set(fact.clip, add(clocks.get(fact.clip) ?? ZERO, by));
      const held = entries.get(fact.clip);
      if (held) {
        const moved = [...held].map(([path, change]) => [path, onMovedClock(change, by)] as const);
        entries.set(fact.clip, new Map(moved));
      }
      break;
    }
    case "cut": {
      // Both parts of a clip keep all its keys, and that goes for keys that are not saved yet.
      const held = entries.get(fact.clip);
      if (held) entries.set(fact.piece, new Map([...held, ...(entries.get(fact.piece) ?? [])]));
      break;
    }
    case "joined": {
      // What the clip holds as well was only a copy. Anything else stays set aside with its part.
      const whole = entries.get(fact.clip);
      for (const [path, { value }] of entries.get(fact.piece) ?? []) {
        const kept = whole?.get(path);
        if (kept && deepEqual(kept.value, value)) put(entries, fact.piece, path, undefined);
      }
      break;
    }
    case "moved": {
      const held = entries.get(fact.from);
      if (held) {
        entries.delete(fact.from);
        entries.set(fact.to, new Map([...held, ...(entries.get(fact.to) ?? [])]));
      }
      break;
    }
    case "renamed":
      applyRenames(entries, [fact]);
      break;
  }
}

type RenamedFact = Extract<ClipFact, { kind: "renamed" }>;

/** Facts in their order. What one step renames moves all at once, see `applyRenames`. */
function applyFacts(entries: Entries, facts: readonly ClipFact[], clocks: Map<string, Rational>) {
  let renames: RenamedFact[] = [];
  const rename = () => {
    if (renames.length > 0) applyRenames(entries, renames);
    renames = [];
  };
  for (const fact of facts) {
    if (fact.kind === "renamed") {
      renames.push(fact);
      continue;
    }
    rename();
    applyFact(entries, fact, clocks);
  }
  rename();
}

/**
 * What is tried goes along with properties that get another path. One step moves its paths all at
 * once, so that two properties can swap, and one can go where another left. Something tried under a
 * path that does not move is newer than what would come there, so that stays, and what would have
 * come stays where it was.
 */
function applyRenames(entries: Entries, facts: readonly RenamedFact[]): void {
  const byClip = new Map<string, Map<string, RenamedFact>>();
  for (const fact of facts) {
    const moves = byClip.get(fact.clip) ?? new Map<string, RenamedFact>();
    moves.set(fact.from, fact);
    byClip.set(fact.clip, moves);
  }
  for (const [clip, moves] of byClip) {
    const held = entries.get(clip);
    if (!held) continue;
    const staying = new Set([...held.keys()].filter((path) => !moves.has(path)));
    const moving = new Map<string, TrialChange>();
    for (const [path, change] of held) {
      const fact = moves.get(path);
      const moved = fact && renamedChange(change, fact);
      if (moved) moving.set(path, moved);
      else staying.add(path);
    }
    // What cannot go where it would stays, and then nothing can go where it stays either.
    for (let blocked = true; blocked;) {
      blocked = false;
      for (const path of moving.keys()) {
        if (!staying.has((moves.get(path) as RenamedFact).to)) continue;
        moving.delete(path);
        staying.add(path);
        blocked = true;
      }
    }
    const next = new Map<string, TrialChange>();
    for (const path of staying) next.set(path, held.get(path) as TrialChange);
    for (const [path, change] of moving) next.set((moves.get(path) as RenamedFact).to, change);
    if (next.size > 0) entries.set(clip, next);
    else entries.delete(clip);
  }
}

/** A tried change under its new path, in the unit of that path. Undefined when it cannot be. */
function renamedChange(change: TrialChange, conversion: Conversion): TrialChange | undefined {
  const convert = (value: PropertyValue | undefined) =>
    value === undefined ? undefined : convertedValue(value, conversion);
  try {
    return { ...change, base: convert(change.base), value: convert(change.value) };
  } catch (error) {
    if (error instanceof CommandError) return undefined;
    throw error;
  }
}

const clockZero = (clip: ClipState) => subtract(clipStart(clip), clipOffset(clip));

/**
 * Whether a clip is a piece of what another clip used to be: the same content on the same clock, on
 * the same track, inside of what the other one was. That is what a cut leaves behind.
 */
function isPieceOf(piece: ClipState, whole: ClipState): boolean {
  return (
    piece.track === whole.track &&
    compare(clipStart(piece), clipStart(whole)) > 0 &&
    compare(clipEnd(piece), clipEnd(whole)) <= 0 &&
    compare(clockZero(piece), clockZero(whole)) === 0 &&
    deepEqual(piece.source, whole.source)
  );
}

/** How far all keys of a property moved, if that is what happened to them. */
function keysMovedBy(was: Animation, now: Animation): Rational | undefined {
  if (was === now) return ZERO;
  const [first] = was.keys;
  const [other] = now.keys;
  if (!first || !other || was.keys.length !== now.keys.length) return undefined;
  const by = subtract(parseTime(other.time), parseTime(first.time));
  return deepEqual(laterValue(was, by), now) ? by : undefined;
}

/**
 * What the keys of a clip say about its clock: they are the only thing that can tell a clock that
 * moved from a clip that got another start. Undefined when there are none to go by.
 */
function clockByKeys(was: ClipState, now: ClipState): Rational | "mixed" | undefined {
  let found: Rational | undefined;
  for (const [path, value] of Object.entries(effectiveProperties(was))) {
    const other = entryOf(effectiveProperties(now), path);
    if (!isAnimation(value) || other === undefined || !isAnimation(other)) continue;
    const by = keysMovedBy(value, other);
    if (by === undefined) continue;
    if (found && compare(found, by) !== 0) return "mixed";
    found = by;
  }
  return found;
}

interface Guess {
  readonly facts: readonly ClipFact[];
  /** Something happened that may have meant more, and nothing was done about it. */
  readonly unsure: boolean;
}

/** A clock moves along with where a clip is and how long it is. Keys can move on their own. */
const sameSpan = (a: ClipState, b: ClipState) =>
  compare(clipStart(a), clipStart(b)) === 0 &&
  compare(clipEnd(a), clipEnd(b)) === 0 &&
  compare(clipOffset(a), clipOffset(b)) === 0;

/**
 * What must have happened to clips, for what arrives from elsewhere with nothing but its outcome.
 * Several changes can come as one, so this only goes as far as it can be sure of: what stays unclear
 * stays as it is and gets reported. Moving values on a guess would change what people tried.
 */
function guessFacts(before: Clips, after: Clips, held: ReadonlySet<string>): Guess {
  const facts: ClipFact[] = [];
  let unsure = false;
  const born = Object.values(after).filter((clip) => !Object.hasOwn(before, clip.id));
  for (const id of held) {
    const was = entryOf(before, id);
    const now = entryOf(after, id);
    if (!was || !now || was === now) continue;
    if (!sameSpan(was, now)) {
      const by = clockByKeys(was, now);
      if (by === "mixed" || (by === undefined && looksLikeClockMoved(was, now))) unsure = true;
      else if (by && compare(by, ZERO) !== 0) {
        facts.push({ kind: "clock", clip: id, by: formatTime(by) });
      }
    }
    const shorter = compare(clipEnd(now), clipEnd(was)) < 0;
    for (const clip of born) {
      if (isPieceOf(clip, was)) facts.push({ kind: "cut", clip: id, piece: clip.id });
      else if (shorter && deepEqual(clip.source, was.source)) unsure = true;
    }
  }
  return { facts, unsure };
}

/** What a step has to put back to get from one state to the other. */
function touchesBetween(
  from: TrialChanges,
  to: TrialChanges,
  clocks: ReadonlyMap<string, Rational>,
): readonly Touch[] {
  const touches: Touch[] = [];
  for (const clip of new Set([...from.keys(), ...to.keys()])) {
    const was = from.get(clip);
    const now = to.get(clip);
    if (was === now) continue;
    const clock = clocks.get(clip) ?? ZERO;
    for (const path of new Set([...(was?.keys() ?? []), ...(now?.keys() ?? [])])) {
      const change = was?.get(path);
      if (change !== now?.get(path)) touches.push({ clip, path, change, clock });
    }
  }
  return touches;
}

/**
 * What people are trying out on a timeline. It is an overlay on the project that goes nowhere: not
 * into the document, not to other windows and not to AI, until it gets saved as one command.
 *
 * It holds whole properties, not the edits that led to them, because that is how far conflicts go:
 * all keys of a property are one value. So saving replaces a property, whoever changed it since.
 *
 * What happens to clips only reaches what is tried right now. Steps keep what they changed, and undo
 * and redo go back to exactly that: in the order people worked in, the clips are as they were then.
 * Nothing goes away because a clip did: it stays here, set aside, and is back when the clip is.
 */
export class Trial {
  readonly #store: ProjectStore;
  readonly #timeline: string;
  readonly #listeners = new Set<() => void>();
  readonly #noticeListeners = new Set<(notice: TrialNotice) => void>();
  readonly #stop: () => void;
  /** All there is, which includes what is set aside. */
  #entries: TrialChanges = NO_CHANGES;
  /** What of that people get to see. */
  #changes = NO_CHANGES;
  #undo: Step[] = [];
  #redo: Step[] = [];
  /** What got taken back, in that order: going forward is the opposite of what happened. */
  #ahead: ("here" | "project")[] = [];
  /**
   * What steps of the project took away here when they went back or forward, for when they go the
   * other way. By the step that does that. Steps here are no help: saving ends those, and what is
   * set aside stays, with a past in the project.
   */
  readonly #returning = new Map<number, readonly Touch[]>();
  /** The clips as they were the last time this looked. */
  #seen: Clips;
  /** How far the clocks of clips moved while this was looking, for steps from before that. */
  readonly #clocks = new Map<string, Rational>();

  constructor(store: ProjectStore, timeline: string) {
    this.#store = store;
    this.#timeline = timeline;
    this.#seen = this.#clips;
    this.#stop = store.subscribe(this.#follow);
  }

  dispose(): void {
    this.#stop();
    this.#listeners.clear();
    this.#noticeListeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Hears about what happened without anybody asking for it. */
  onNotice(listener: (notice: TrialNotice) => void): () => void {
    this.#noticeListeners.add(listener);
    return () => this.#noticeListeners.delete(listener);
  }

  /** What is being tried right now. It never changes in place. */
  get changes(): TrialChanges {
    return this.#changes;
  }

  /** All that has to be kept, which is what is being tried and what is set aside. */
  get kept(): TrialChanges {
    return this.#entries;
  }

  get count(): number {
    return sizeOf(this.#changes);
  }

  /** How many properties wait for their clip, or for their keys to fit on it again. */
  get setAside(): number {
    return sizeOf(this.#entries) - this.count;
  }

  /** How many of the properties somebody else changed since they went in here. */
  get conflicts(): number {
    let conflicts = 0;
    for (const [clip, changes] of this.#changes) {
      for (const path of changes.keys()) if (this.changedElsewhere(clip, path)) conflicts += 1;
    }
    return conflicts;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /**
   * Trying and structural changes go on side by side, and people expect undo to go back in the order
   * they worked in. So the last thing they did decides whether undo is about this or the project.
   */
  get undoesFirst(): boolean {
    const step = this.#undo.at(-1);
    return step !== undefined && step.after >= this.#store.lastStep;
  }

  /** And going forward is the exact opposite of going back. */
  get redoesFirst(): boolean {
    return this.canRedo && (this.#ahead.at(-1) === "here" || !this.#store.canRedo);
  }

  holds(clip: string, path: string): boolean {
    return this.#changes.get(clip)?.has(path) === true;
  }

  changedElsewhere(clip: string, path: string): boolean {
    const change = this.#changes.get(clip)?.get(path);
    const saved = entryOf(this.#clips, clip);
    return change !== undefined && saved !== undefined
      ? !deepEqual(change.base, this.#saved(saved, path))
      : false;
  }

  /** A clip the way it looks with what is being tried. */
  apply(clip: ClipState): ClipState {
    const changes = this.#changes.get(clip.id);
    if (!changes) return clip;
    const properties = { ...effectiveProperties(clip) };
    for (const [path, { value }] of changes) {
      if (value === undefined) delete properties[path];
      else properties[path] = value;
    }
    return { ...clip, properties };
  }

  /**
   * Tries out edits as one step, under the same rules as writing them: whatever a command would
   * refuse is refused here, so that nothing gets in that cannot be saved.
   */
  write(edits: readonly PropertyEdit[]): TrialResult {
    if (edits.length === 0) return DONE;
    const parsed = Edits.safeParse(edits);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const message = `${issue?.path.join(".")}：${issue?.message}`;
      return { ok: false, error: { code: "invalid-params", message } };
    }
    let values: ReadonlyMap<string, ReadonlyMap<string, PropertyValue | undefined>>;
    try {
      values = this.#valuesAfter(parsed.data);
    } catch (error) {
      if (error instanceof CommandError) return failed(error);
      throw error;
    }
    const check = this.#store.execute(
      {
        type: "property.edit",
        params: { timeline: this.#timeline, edits: editsFor(values) },
      },
      { dryRun: true },
    );
    if (!check.ok) return check;
    this.#step(this.#with(values));
    return DONE;
  }

  /** What properties hold after edits, each one seeing the ones before it. */
  #valuesAfter(edits: readonly PropertyEdit[]) {
    const clips = this.#clips;
    const values = new Map<string, Map<string, PropertyValue | undefined>>();
    for (const edit of edits) {
      const { path, owner } = edit;
      const clip = entryOf(clips, owner.clip) ?? fail("not-found", `没有这个片段：${owner.clip}`);
      const touched = values.get(clip.id) ?? new Map<string, PropertyValue | undefined>();
      values.set(clip.id, touched);
      const start = touched.has(path) ? touched.get(path) : this.#shown(clip, path);
      touched.set(path, applyEdit(start, edit));
    }
    return values;
  }

  /**
   * What is being tried with these properties in it. A property that comes back to what the project
   * holds is not being tried any more, so "N changes" only counts what would make a difference.
   */
  #with(values: ReadonlyMap<string, ReadonlyMap<string, PropertyValue | undefined>>): TrialChanges {
    const next: Entries = new Map(this.#entries);
    const clips = this.#clips;
    for (const [id, touched] of values) {
      const clip = entryOf(clips, id) as ClipState;
      for (const [path, value] of touched) {
        const saved = this.#saved(clip, path);
        const before = this.#changes.get(id)?.get(path);
        if (deepEqual(value, saved)) {
          if (before) put(next, id, path, undefined);
        } else if (!before || !deepEqual(value, before.value)) {
          put(next, id, path, { base: before ? before.base : saved, value });
        }
      }
    }
    return next;
  }

  /** Back one step. The project stays as it is. */
  undo(): boolean {
    const step = this.#undo.pop();
    if (!step) return false;
    this.#redo.push(this.#take(step));
    this.#ahead.push("here");
    return true;
  }

  redo(): boolean {
    const step = this.#redo.pop();
    if (!step) return false;
    this.#undo.push({ ...this.#take(step), after: this.#store.lastStep });
    this.#behind("here");
    return true;
  }

  /** One of what was taken back is not ahead any more. */
  #behind(where: "here" | "project"): void {
    const index = this.#ahead.lastIndexOf(where);
    if (index >= 0) this.#ahead.splice(index, 1);
  }

  /** Puts back what a step says. Returns the step that goes back to what is here now. */
  #take({ touches, after }: Step): Step {
    const next: Entries = new Map(this.#entries);
    const opposite = touches.map(({ clip, path }) => ({
      clip,
      path,
      change: next.get(clip)?.get(path),
      clock: this.#clocks.get(clip) ?? ZERO,
    }));
    for (const { clip, path, change, clock } of touches) {
      const by = subtract(this.#clocks.get(clip) ?? ZERO, clock);
      put(next, clip, path, change && compare(by, ZERO) !== 0 ? onMovedClock(change, by) : change);
    }
    this.#withoutSaved(next);
    this.#entries = next;
    this.#changed();
    return { touches: opposite, after };
  }

  /**
   * Gives up on everything, also on what is set aside, or on one property. It is a step like the
   * others, so that a click in the wrong place can be taken back.
   */
  discard(only?: { readonly clip: string; readonly path: string }): void {
    if (only) {
      const next: Entries = new Map(this.#entries);
      put(next, only.clip, only.path, undefined);
      this.#step(next);
    } else {
      this.#step(NO_CHANGES);
    }
  }

  /**
   * Writes everything as one command, which is one step to undo. What people tried wins over what
   * somebody else wrote in the meantime: they looked at it and said it is what they want. What is
   * set aside stays out of it, and stays.
   */
  save(): TrialSaved {
    const saved = this.count;
    if (saved === 0) return { ok: true, saved: 0, overwritten: 0 };
    const overwritten = this.conflicts;
    const tried = this.#changes;
    const values = new Map(
      [...tried].map(([clip, changes]) => [
        clip,
        new Map([...changes].map(([path, { value }]) => [path, value])),
      ]),
    );
    const result = this.#store.execute({
      type: "property.edit",
      params: { timeline: this.#timeline, edits: editsFor(values) },
    });
    if (!result.ok) return result;
    const next: Entries = new Map(this.#entries);
    for (const [clip, changes] of tried) {
      for (const path of changes.keys()) put(next, clip, path, undefined);
    }
    this.#entries = next;
    this.#undo = [];
    this.#redo = [];
    this.#ahead = [];
    this.#changed();
    return { ok: true, saved, overwritten };
  }

  /** What to keep so that this survives the page. Undefined when there is nothing to keep. */
  toStored(): StoredTrial | undefined {
    if (this.#entries.size === 0) return undefined;
    const changes = [...this.#entries].flatMap(([clip, held]) =>
      [...held].map(([path, change]) => {
        const { base, value, moved, asideSince } = change;
        return {
          clip,
          path,
          ...(base === undefined ? {} : { base }),
          ...(value === undefined ? {} : { value }),
          ...(moved === undefined ? {} : { moved }),
          ...(asideSince === undefined ? {} : { asideSince }),
        };
      }),
    );
    return { version: 1, timeline: this.#timeline, changes };
  }

  /**
   * Takes back what was kept. It can be old and from another version, and the project moved on in the
   * meantime, so nothing about it is taken for granted: what is not valid stays out, and that is all
   * that can go wrong here. A clip that is gone leaves what was tried on it set aside. What the
   * project holds by now, and what has been set aside for too long, is stale: it does not come back,
   * and whoever keeps this should write it off. What was tried since this started goes first, and
   * the steps that led there go back to what was kept.
   */
  restore(stored: unknown): TrialRestored {
    const parsed = StoredTrial.safeParse(stored);
    if (!parsed.success || parsed.data.timeline !== this.#timeline) {
      return { restored: 0, dropped: 0, stale: 0, unreadable: stored !== undefined };
    }
    const clips = this.#clips;
    const next: Entries = new Map(this.#entries);
    const oldest = Date.now() - SET_ASIDE_DAYS * DAY_MS;
    let restored = 0;
    let dropped = 0;
    let stale = 0;
    for (const raw of parsed.data.changes) {
      const entry = StoredChange.safeParse(raw);
      if (!entry.success) {
        dropped += 1;
        continue;
      }
      const { clip: id, path, base, value, moved, asideSince } = entry.data;
      const clip = entryOf(clips, id);
      const saved = clip && this.#saved(clip, path);
      const isUsable = clip !== undefined && moved === undefined;
      if (!canHold(path, saved, value)) dropped += 1;
      else if (asideSince !== undefined && asideSince < oldest && !isUsable) stale += 1;
      else if (isUsable && deepEqual(value, saved)) stale += 1;
      else {
        const change: TrialChange = {
          base,
          value,
          ...(moved === undefined ? {} : { moved }),
          ...(asideSince === undefined ? {} : { asideSince }),
        };
        this.#beneathSteps(id, path, change);
        if (next.get(id)?.has(path) !== true) {
          put(next, id, path, change);
          if (isUsable) restored += 1;
        }
      }
    }
    if (!sameChanges(next, this.#entries)) {
      this.#entries = next;
      this.#changed();
    }
    return { restored, dropped, stale, unreadable: false };
  }

  /** Makes this what going back to the start ends up at for a property, instead of nothing. */
  #beneathSteps(clip: string, path: string, change: TrialChange): void {
    for (const step of this.#undo) {
      const index = step.touches.findIndex((one) => one.clip === clip && one.path === path);
      const touch = step.touches[index];
      if (touch) {
        if (!touch.change) step.touches = step.touches.with(index, { ...touch, change });
        return;
      }
    }
  }

  get #clips(): Clips {
    return entryOf(this.#store.getState().timelines, this.#timeline)?.clips ?? NO_CLIPS;
  }

  #saved(clip: ClipState, path: string): PropertyValue | undefined {
    return entryOf(effectiveProperties(clip), path);
  }

  /** What an edit starts from. */
  #shown(clip: ClipState, path: string): PropertyValue | undefined {
    const change = this.#changes.get(clip.id)?.get(path);
    return change ? change.value : this.#saved(clip, path);
  }

  #step(next: TrialChanges): void {
    const touches = touchesBetween(this.#entries, next, this.#clocks);
    if (touches.length === 0) return;
    this.#undo.push({ touches, after: this.#store.lastStep });
    if (this.#undo.length > MAX_STEPS) this.#undo.shift();
    this.#redo = [];
    this.#ahead = this.#ahead.filter((where) => where === "project");
    this.#entries = next;
    this.#changed();
  }

  /** Sorts out what is usable after any change, and tells who is listening. */
  #changed(): void {
    const dropped = this.#sortOut();
    for (const listener of this.#listeners) listener();
    if (dropped > 0) this.#tell({ kind: "dropped", count: dropped });
  }

  /** Works out what people see, and what waits since when, and keeps the waiting within limits. */
  #sortOut(): number {
    const clips = this.#clips;
    const now = Date.now();
    const next: Entries = new Map(this.#entries);
    const shown: Entries = new Map();
    const waiting: { readonly clip: string; readonly path: string; readonly since: number }[] = [];
    for (const [clip, held] of this.#entries) {
      const isThere = entryOf(clips, clip) !== undefined;
      for (const [path, change] of held) {
        const { asideSince, ...plain } = change;
        if (isThere && change.moved === undefined) {
          const usable = asideSince === undefined ? change : plain;
          if (usable !== change) put(next, clip, path, usable);
          put(shown, clip, path, usable);
        } else {
          if (asideSince === undefined) put(next, clip, path, { ...change, asideSince: now });
          waiting.push({ clip, path, since: asideSince ?? now });
        }
      }
    }
    const tooMany = waiting.length - MAX_SET_ASIDE;
    if (tooMany > 0) {
      const oldest = waiting.toSorted((a, b) => a.since - b.since).slice(0, tooMany);
      for (const { clip, path } of oldest) put(next, clip, path, undefined);
    }
    this.#entries = sameChanges(next, this.#entries) ? this.#entries : next;
    this.#changes = sameChanges(shown, this.#changes) ? this.#changes : shown;
    return Math.max(tooMany, 0);
  }

  /** Without what the project holds by now anyway, of what is there to compare. */
  #withoutSaved(entries: Entries): void {
    const clips = this.#clips;
    for (const [id, held] of entries) {
      const clip = entryOf(clips, id);
      if (!clip) continue;
      for (const [path, { value, moved }] of held) {
        if (moved === undefined && deepEqual(value, this.#saved(clip, path))) {
          put(entries, id, path, undefined);
        }
      }
    }
  }

  /** All clips that anything here is about, also in what can come back. */
  get #held(): ReadonlySet<string> {
    const held = new Set(this.#entries.keys());
    for (const { touches } of [...this.#undo, ...this.#redo]) {
      for (const { clip } of touches) held.add(clip);
    }
    for (const touches of this.#returning.values()) {
      for (const { clip } of touches) held.add(clip);
    }
    return held;
  }

  /**
   * What a step of the project took away from `entries` to get to `next`, for when it goes the other
   * way, apart from what its facts bring back by themselves. Those do too much in one way: a cut
   * brings all that the clip has by then, so what a part did not have has to stay away from it.
   */
  #leftBehind(entries: TrialChanges, next: TrialChanges, facts: readonly ClipFact[]) {
    const followed = new Set(
      facts.flatMap((fact) => {
        if (fact.kind === "joined") return [fact.piece];
        return fact.kind === "moved" ? [fact.from] : [];
      }),
    );
    const touches = touchesBetween(entries, next, this.#clocks).filter(
      ({ clip, path }) => !followed.has(clip) && next.get(clip)?.has(path) !== true,
    );
    for (const fact of facts) {
      if (fact.kind !== "joined") continue;
      const clock = this.#clocks.get(fact.piece) ?? ZERO;
      for (const path of entries.get(fact.clip)?.keys() ?? []) {
        if (entries.get(fact.piece)?.has(path) === true) continue;
        touches.push({ clip: fact.piece, path, change: undefined, clock });
      }
    }
    return touches;
  }

  #tell(notice: TrialNotice): void {
    for (const listener of this.#noticeListeners) listener(notice);
  }

  /**
   * Whatever happens to the project goes on working with what is tried on it, and only with that.
   * Changes of other people stay out of it: the picture keeps showing what people are trying. Only
   * clips matter here, and while an update is missing the project shows what it had, so nothing
   * looks gone that is not.
   */
  #follow = (): void => {
    const { change } = this.#store;
    if (change?.origin === USER) {
      if (change.takesBack === "undo") this.#ahead.push("project");
      else if (change.takesBack === "redo") this.#behind("project");
      else {
        // People went on from here, and what they took back is not ahead of them any more.
        this.#redo = [];
        this.#ahead = [];
        this.#returning.clear();
      }
    }
    const before = this.#seen;
    const after = this.#clips;
    if (before === after) return;
    this.#seen = after;
    const held = this.#held;
    if (held.size === 0) return;
    const known = change?.facts;
    const { facts, unsure } = known
      ? { facts: known, unsure: false }
      : guessFacts(before, after, held);
    const entries = this.#entries;
    const shown = this.#changes;
    const next: Entries = new Map(entries);
    const back = change?.back === undefined ? undefined : this.#returning.get(change.back);
    // What was tried on a property since then stays.
    const returning = back?.filter(({ clip, path }) => entries.get(clip)?.has(path) !== true);
    applyFacts(next, facts, this.#clocks);
    for (const { clip, path, change: value } of returning ?? []) put(next, clip, path, value);
    this.#withoutSaved(next);
    if (change?.takesBack) {
      if (change.back !== undefined) this.#returning.delete(change.back);
      const left = this.#leftBehind(entries, next, facts);
      if (left.length > 0) this.#returning.set(change.step, left);
    }
    this.#entries = next;
    const dropped = this.#sortOut();
    for (const listener of this.#listeners) listener();
    this.#report(entries, shown, dropped, unsure);
  };

  /** Says what became of what people could see, and of what they could not. */
  #report(entries: TrialChanges, shown: TrialChanges, dropped: number, unsure: boolean): void {
    let aside = 0;
    let back = 0;
    for (const [clip, held] of shown) {
      for (const path of held.keys()) {
        if (!this.holds(clip, path) && this.#entries.get(clip)?.has(path) === true) aside += 1;
      }
    }
    for (const [clip, held] of this.#changes) {
      for (const path of held.keys()) {
        if (entries.get(clip)?.has(path) === true && shown.get(clip)?.has(path) !== true) back += 1;
      }
    }
    if (aside > 0) this.#tell({ kind: "aside", count: aside });
    if (back > 0) this.#tell({ kind: "back", count: back });
    if (dropped > 0) this.#tell({ kind: "dropped", count: dropped });
    if (unsure) this.#tell({ kind: "unsure" });
  }
}

/** Whether a command would write this value, apart from what the project is like right now. */
function canHold(
  path: string,
  saved: PropertyValue | undefined,
  value: PropertyValue | undefined,
): boolean {
  if (value === undefined) return true;
  try {
    checkWrite(path, saved, value);
    return true;
  } catch (error) {
    if (error instanceof CommandError) return false;
    throw error;
  }
}

/** Properties as edits of a command, always in the same order. */
function editsFor(
  values: ReadonlyMap<string, ReadonlyMap<string, PropertyValue | undefined>>,
): readonly PropertyEdit[] {
  const edits: PropertyEdit[] = [];
  for (const clip of [...values.keys()].toSorted()) {
    const touched = values.get(clip) as ReadonlyMap<string, PropertyValue | undefined>;
    for (const path of [...touched.keys()].toSorted()) {
      const value = touched.get(path);
      const target = { owner: { clip }, path };
      edits.push(
        value === undefined ? { ...target, op: "clear" } : { ...target, op: "set", value },
      );
    }
  }
  return edits;
}
