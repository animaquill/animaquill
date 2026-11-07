import {
  canMix,
  channelOf,
  clipNodeOf,
  clipOffset,
  clipStart,
  effectiveProperties,
  entryOf,
  firstKeyFrom,
  hasOrphans,
  listedTrack,
  objectsOf,
  secondsOf,
  type ClipChild,
  type ClipNode,
  type ClipState,
  type KeyEase,
  type ListRange,
  type ProjectState,
  type ProjectStore,
  type PropertyEdit,
  type PropertyNode,
  type TrackNode,
  type TreeNode,
} from "@animaquill/core";
import type { SettingsStore, WindowMemory } from "@animaquill/host";
import {
  ZERO,
  add,
  compare,
  formatTime,
  parseTime,
  subtract,
  type Key,
  type PropertySpec,
  type PropertyValue,
  type Rational,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import { inspectProperty, type InspectedProperty } from "../properties/inspect.ts";
import { groupOf, nameOf, textOf } from "../properties/names.ts";
import type { TrialSession } from "../properties/trial.ts";
import type { PropertyWriter } from "../properties/writer.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { frameTime } from "../timeline/frames.ts";
import { forEachBetween, type ClipBox, type Row, type TimelineModel } from "../timeline/model.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { readSetting } from "../workbench/settings.ts";
import { momentOfKey, type KeyArea } from "./area.ts";
import type { ValueLabel } from "./paint.ts";
import { presetOf, type EasePreset } from "./easing.ts";
import { moveEdits, movedSelection, type KeyPreview, type MovingChannel } from "./gestures.ts";
import { tangentOf, withTangent, type TangentMode } from "./handles.ts";
import {
  DEFAULT_TALL_HEIGHT,
  MAX_TALL_HEIGHT,
  MIN_TALL_HEIGHT,
  type Lane,
  type LaneRules,
} from "./lanes.ts";
import { rangeOfChannel, unionOf, type ValueRange } from "./scale.ts";
import { KeySelection, NO_KEYS, type KeyRef } from "./selection.ts";
import { animationIn, hasKeyAt } from "./tables.ts";
import { TimelineLanes } from "./timeline-lanes.ts";
import { KeyframesView } from "./view.ts";

const REMEMBER_DELAY_MS = 300;
const SETTINGS_KEY = "keyframes";
const SETTINGS_VERSION = 1;
const DEFAULT_LIST_WIDTH = 320;
const MIN_LIST_WIDTH = 220;
const MAX_LIST_WIDTH = 640;
/** The moment of a clip can be a little off as a float, and that should not hide it. */
const HERE_MARGIN = 1e-6;

export interface KeyframeMessages {
  /** Pasting would put keys before the clock of their clip starts. */
  pasteTooEarly(): void;
  /** There is no clip to put keys on. */
  pasteNowhere(): void;
  /** Nothing changes while people compare with what is saved. */
  comparing(): void;
  /** The selected keys are on locked tracks. */
  locked(): void;
  /** None of the selected keys show where people asked for something to happen to them. */
  notShown(): void;
  /** What a drag of keys or a handle was about went away meanwhile: an undo, or another window. */
  gone(): void;
}

/** Which clips a place shows keys of. Without one, it is all of them. */
export type ShownClips = (clip: string) => boolean;

const ALL_CLIPS: ShownClips = () => true;

/** What React shows. The view changes far more often and goes through `subscribeView`. */
export interface KeyframeSnapshot {
  readonly range: ListRange;
  readonly query: string;
  readonly pinned: ReadonlySet<string>;
  readonly selection: KeySelection;
  /** The width of the list on the left of the tab. */
  readonly listWidth: number;
  readonly hasClipboard: boolean;
}

interface CopiedKey {
  readonly clip: string;
  readonly path: string;
  /** Where it is on the timeline, which is what stays the same relative to the others. */
  readonly moment: Rational;
  readonly key: Key;
}

/** A row made taller, by clip and path: how tall, and whether it is right now. */
type TallRow = readonly [clip: string, path: string, height: number, on: boolean];

interface RememberedState {
  readonly range?: ListRange;
  readonly toggled?: readonly string[];
  readonly pinned?: readonly string[];
  /** Rows made taller, which stay at their height when they are made taller again. */
  readonly tall?: readonly TallRow[];
  readonly open?: readonly string[];
  readonly view?: { readonly pixelsPerSecond: number; readonly scrollX: number };
  /** How much taller the rows of keys are. */
  readonly rows?: number;
}

/** What the rows of one frame show. */
interface Inspected {
  readonly state: ProjectState | undefined;
  readonly frame: number;
  readonly changes: unknown;
  readonly rows: Map<string, { box: ClipBox; inspected: InspectedProperty }>;
}

const RANGES: readonly ListRange[] = ["here", "all", "keyed"];

function parseRemembered(text: string | undefined): RememberedState {
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text) as RememberedState | null;
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

const stringsIn = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** What was remembered of rows made taller, as far as it makes sense. Anything else goes. */
function tallRowsIn(value: unknown): readonly TallRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is TallRow =>
      Array.isArray(item) &&
      typeof item[0] === "string" &&
      typeof item[1] === "string" &&
      Number.isFinite(item[2]) &&
      typeof item[3] === "boolean",
  );
}

const clampTall = (height: number) =>
  Math.min(Math.max(Math.round(height), MIN_TALL_HEIGHT), MAX_TALL_HEIGHT);

/** A row of one property of one clip, which is what a row made taller is about. */
const rowKey = (clip: string, path: string) => `${clip} ${path}`;

interface TallState {
  readonly clip: string;
  readonly path: string;
  readonly height: number;
  readonly on: boolean;
}

function parseWidth(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, listWidth } = value as { version?: unknown; listWidth?: unknown };
  return version === SETTINGS_VERSION && typeof listWidth === "number" ? listWidth : undefined;
}

const clampWidth = (width: number) =>
  Math.min(Math.max(Math.round(width), MIN_LIST_WIDTH), MAX_LIST_WIDTH);

/**
 * Keys in this window: what is selected, what is listed and what is open. None of that is part of
 * the project. The tab of its own and the room under a track of the timeline are two places to work
 * on the same keys, so they share all of it. Changes go through `PropertyWriter`, as for any control.
 */
export class KeyframeEditor {
  readonly #session: ProjectSession;
  readonly #timeline: TimelineEditor;
  readonly #trials: TrialSession;
  readonly #writer: PropertyWriter;
  readonly #memory: WindowMemory;
  readonly #settings: SettingsStore;
  readonly #t: TFunction;
  readonly #messages: KeyframeMessages;
  readonly #emitter = new Emitter();
  readonly #viewEmitter = new Emitter();
  /** The tab. */
  readonly panel: KeyframesView;
  /** The room under the tracks of the timeline. */
  readonly inTimeline: TimelineLanes;
  #snapshot: KeyframeSnapshot = {
    range: "here",
    query: "",
    pinned: new Set(),
    selection: NO_KEYS,
    listWidth: DEFAULT_LIST_WIDTH,
    hasClipboard: false,
  };
  /** Nodes that are not the way they start out: tracks are open, everything else closed. */
  readonly #toggled = new Set<string>();
  /** Rows made taller, by clip and path. A row that is back keeps its height for the next time. */
  readonly #tall = new Map<string, TallState>();
  /**
   * What rows of numbers covered when a drag started, by clip and path. While people drag a value
   * or a handle the row does not shrink under the mouse: it only grows to take in what is new.
   */
  #heldRanges: ReadonlyMap<string, ValueRange> = new Map();
  readonly #specs = new WeakMap<ClipNode, ReadonlyMap<string, PropertySpec>>();
  #store: ProjectStore | undefined;
  #clipboard: readonly CopiedKey[] = [];
  #preview: KeyPreview | undefined;
  #previewArea: KeyArea | undefined;
  /** The frame the list is about. It stays while playing, so that the list does not jump. */
  #listedFrame = 0;
  #seenFrame = 0;
  #seenPlaying = false;
  #seenModel: TimelineModel | undefined;
  #seenClips: ReadonlySet<string> | undefined;
  #relisting = false;
  #orphaned: ReadonlySet<string> | undefined;
  #inspected: Inspected = { state: undefined, frame: -1, changes: undefined, rows: new Map() };
  readonly #searchNames = new Map<string, string>();
  /** What is tried on clips, once per clip: a clip with something on it is a new object every time. */
  readonly #looks = new Map<string, { clip: ClipState; shown: ClipState }>();
  /** Worked out once for a selection, because a drag asks for it with every frame. */
  readonly #selected = new WeakMap<KeySelection, Map<string, Float64Array | undefined>>();
  readonly #tried = new WeakMap<ClipState, Map<string, Float64Array | undefined>>();
  /** Keys that are not what is saved, by what a clip looks like and property. */
  readonly #triedTimes = new WeakMap<ClipState, Map<string, ReadonlySet<string>>>();
  #rememberTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    session: ProjectSession,
    timeline: TimelineEditor,
    trials: TrialSession,
    writer: PropertyWriter,
    memory: WindowMemory,
    settings: SettingsStore,
    t: TFunction,
    messages: KeyframeMessages,
  ) {
    this.#session = session;
    this.#timeline = timeline;
    this.#trials = trials;
    this.#writer = writer;
    this.#memory = memory;
    this.#settings = settings;
    this.#t = t;
    this.#messages = messages;
    this.panel = new KeyframesView(this, timeline);
    this.inTimeline = new TimelineLanes(this, timeline);
    timeline.setExtras(this.inTimeline);
    // One clipboard: what was copied last is what goes in.
    timeline.subscribeCopies(() => this.forgetClipboard());
    // Keys select their clips. People selecting clips are about clips, and that lets go of keys.
    timeline.subscribeChoices(() => this.#setKeys(NO_KEYS));
    session.subscribe(this.#followSession);
    timeline.subscribe(this.#followTimeline);
    timeline.subscribeView(this.#followView);
    trials.subscribe(this.#followTrial);
    writer.subscribe(this.redraw);
    this.#followSession();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): KeyframeSnapshot => this.#snapshot;
  /** Everything that changes what is on screen, up to once per frame. */
  subscribeView = this.#viewEmitter.subscribe;

  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parseWidth);
    if (reading.kind === "ok") this.#show({ listWidth: clampWidth(reading.value) });
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const width = parseWidth(value);
      if (width !== undefined) this.#show({ listWidth: clampWidth(width) });
    });
  }

  get model(): TimelineModel | undefined {
    return this.#timeline.model;
  }

  get frame(): number {
    return this.#timeline.frame;
  }

  get state(): ProjectState | undefined {
    return this.#store?.getState();
  }

  get selection(): KeySelection {
    return this.#snapshot.selection;
  }

  get multiSelecting(): boolean {
    return this.#timeline.getSnapshot().multiSelecting;
  }

  get preview(): KeyPreview | undefined {
    return this.#preview;
  }

  /** Whether a drag of keys is about something of this area. */
  isPreviewOf(area: KeyArea): boolean {
    return this.#previewArea === area;
  }

  /** Whether what people look at is what is saved, so that an edit would start from the wrong place. */
  get comparing(): boolean {
    return this.#trials.getSnapshot().comparing;
  }

  #show(changes: Partial<KeyframeSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  /** Everything that shows keys draws again. The tab hears of it through the timeline. */
  redraw = (): void => {
    this.#timeline.redraw();
  };

  /** Only the tab draws again, because what changed is the view of the tab. */
  redrawTab(): void {
    this.#viewEmitter.emit();
  }

  /* The project. */

  #followSession = (): void => {
    const { store } = this.#session;
    if (store === this.#store) return;
    this.#remember();
    this.#store = store;
    this.#clipboard = [];
    this.#looks.clear();
    this.#toggled.clear();
    this.#tall.clear();
    this.#heldRanges = new Map();
    this.inTimeline.forgetAll();
    const remembered = store
      ? parseRemembered(this.#memory.read(`keyframes.${store.getState().manifest.id}`))
      : {};
    const there = (ids: readonly string[]) => ids.filter((id) => this.#isThere(id));
    for (const id of there(stringsIn(remembered.toggled))) this.#toggled.add(id);
    // What came before rows were curves themselves, such as `curves`, is not read at all.
    for (const [clip, path, height, on] of tallRowsIn(remembered.tall)) {
      if (!this.#isThere(clip)) continue;
      this.#tall.set(rowKey(clip, path), { clip, path, height: clampTall(height), on });
    }
    this.inTimeline.openAll(there(stringsIn(remembered.open)));
    this.panel.adoptView(remembered.view, remembered.rows);
    const range = remembered.range;
    this.#show({
      range: range && RANGES.includes(range) ? range : "here",
      query: "",
      pinned: new Set(there(stringsIn(remembered.pinned))),
      selection: NO_KEYS,
      hasClipboard: false,
    });
    this.#seenFrame = this.#timeline.frame;
    this.#listedFrame = this.#timeline.frame;
    this.#relist();
  };

  #followTimeline = (): void => {
    const { model, selection, playing } = this.#timeline.getSnapshot();
    const changed =
      model !== this.#seenModel || selection !== this.#seenClips || playing !== this.#seenPlaying;
    if (!changed) return;
    const onlySelection = model === this.#seenModel && playing === this.#seenPlaying;
    if (model !== this.#seenModel) {
      this.#looks.clear();
      this.#orphaned = undefined;
    }
    this.#seenModel = model;
    this.#seenClips = selection;
    this.#seenPlaying = playing;
    if (!playing) this.#listedFrame = this.#timeline.frame;
    this.panel.checkDrag();
    // All of it is listed anyway, so what is selected changes nothing there. Keys select their
    // clips, and a box of keys across thousands of clips does that with every step.
    if (!onlySelection || this.#snapshot.range !== "all") this.#relist();
    this.#keepSelection();
  };

  #followView = (): void => {
    const { frame } = this.#timeline;
    if (frame !== this.#seenFrame) {
      this.#seenFrame = frame;
      this.panel.followPlayhead();
      const { playing } = this.#timeline.getSnapshot();
      if (!playing && this.#snapshot.range === "here") {
        this.#listedFrame = frame;
        this.panel.relist();
      }
    }
    this.#viewEmitter.emit();
  };

  #followTrial = (): void => {
    this.#looks.clear();
    this.#orphaned = undefined;
    this.#relist();
    this.#keepSelection();
    this.redraw();
    this.#emitter.emit();
  };

  /** Keys that are gone cannot be selected, and undo can take them away. */
  #keepSelection(): void {
    const { selection } = this.#snapshot;
    if (selection.size === 0) return;
    const next = selection.keeping(({ clip, path, time }) => {
      const box = this.model?.boxes.get(clip);
      const animation =
        box && animationIn(entryOf(effectiveProperties(this.shown(box.clip)), path));
      return animation !== undefined && hasKeyAt(animation, time);
    });
    if (next !== selection) this.#setKeys(next);
  }

  /** A clip the way it looks with what is being tried. */
  shown(clip: ClipState): ClipState {
    const { look } = this.#trials;
    if (!look) return clip;
    const known = this.#looks.get(clip.id);
    if (known?.clip === clip) return known.shown;
    const shown = look.apply(clip);
    if (shown !== clip) this.#looks.set(clip.id, { clip, shown });
    return shown;
  }

  /** A property the way it looks right now, also while it is being dragged. */
  shownValue(clip: ClipState, path: string): PropertyValue | undefined {
    const held = this.#writer.getPreviewed().get(clip.id);
    return held?.has(path) ? held.get(path) : entryOf(effectiveProperties(clip), path);
  }

  /** What is shown on top of the project. A new object means that something else shows. */
  get previewedValues(): unknown {
    return this.#writer.getPreviewed();
  }

  /** Whether a clip can change right now. Looking at it is another thing. */
  canMove(clip: string): boolean {
    const model = this.model;
    return (
      !this.comparing &&
      model?.boxes.has(clip) === true &&
      model.rowOfClip.get(clip)?.track.locked !== true
    );
  }

  /** Whether what is being tried on a property shows. */
  isTried(clip: string, path: string): boolean {
    return this.#trials.look?.holds(clip, path) === true;
  }

  /** Whether a key is not what is saved. The list on screen asks for a few hundred at a time. */
  isTriedKey({ clip, path, time }: KeyRef): boolean {
    const box = this.model?.boxes.get(clip);
    if (!box || this.#trials.look?.holds(clip, path) !== true) return false;
    const shown = this.shown(box.clip);
    let known = this.#triedTimes.get(shown);
    if (!known) this.#triedTimes.set(shown, (known = new Map()));
    let times = known.get(path);
    if (!times) {
      const saved = new Map(this.#keysOf(box.clip, path).map((one) => [one.time, one]));
      const tried = this.#keysOf(shown, path).filter((one) => !sameKey(one, saved.get(one.time)));
      times = new Set(tried.map((one) => one.time));
      known.set(path, times);
    }
    return times.has(time);
  }

  #keysOf(clip: ClipState, path: string): readonly Key[] {
    return animationIn(entryOf(effectiveProperties(clip), path))?.keys ?? [];
  }

  /** Where a lane has selected keys on the clock of a clip, in order. Undefined for none. */
  selectedSeconds(lane: Lane, { id }: ClipBox): Float64Array | undefined {
    const { selection } = this;
    if (!selection.hasClip(id)) return undefined;
    let known = this.#selected.get(selection);
    if (!known) this.#selected.set(selection, (known = new Map()));
    const key = `${lane.id} ${id}`;
    if (known.has(key)) return known.get(key);
    const moments = (lane.listed.get(id) ?? []).flatMap((path) =>
      [...(selection.timesOf(id, path) ?? [])].map(secondsOf),
    );
    const found = moments.length > 0 ? Float64Array.from(moments).toSorted() : undefined;
    known.set(key, found);
    return found;
  }

  /** Where a lane has keys that are being tried, on the clock of a clip. Undefined for none. */
  triedSeconds(lane: Lane, { id, clip }: ClipBox): Float64Array | undefined {
    const { look } = this.#trials;
    if (!look || this.#trials.getSnapshot().count === 0) return undefined;
    const paths = (lane.listed.get(id) ?? []).filter((path) => look.holds(id, path));
    if (paths.length === 0) return undefined;
    const shown = this.shown(clip);
    let known = this.#tried.get(shown);
    if (!known) this.#tried.set(shown, (known = new Map()));
    const key = lane.id;
    if (known.has(key)) return known.get(key);
    const moments = paths.flatMap((path) => {
      const saved = new Map(this.#keysOf(clip, path).map((one) => [one.time, one]));
      return this.#keysOf(shown, path)
        .filter((one) => !sameKey(one, saved.get(one.time)))
        .map(({ time }) => secondsOf(time));
    });
    const found = moments.length > 0 ? Float64Array.from(moments).toSorted() : undefined;
    known.set(key, found);
    return found;
  }

  /**
   * What a control shows of a property at the playhead. A row has several parts that follow this, and
   * they all ask with every frame, so it gets worked out once per frame.
   */
  inspect(box: ClipBox, spec: PropertySpec): InspectedProperty | undefined {
    const state = this.state;
    const { model } = this;
    if (!state || !model) return undefined;
    const { look } = this.#trials;
    const { frame, comparing } = this;
    const asked = this.#inspected;
    if (asked.state !== state || asked.frame !== frame || asked.changes !== look?.changes) {
      this.#inspected = {
        state,
        frame,
        changes: look?.changes,
        rows: new Map(),
      };
    }
    const { rows } = this.#inspected;
    const id = `${box.id} ${spec.path}`;
    const known = rows.get(id);
    if (known?.box === box) return known.inspected;
    const inspected = inspectProperty(state, model, box, spec, frame, { look, comparing });
    rows.set(id, { box, inspected });
    return inspected;
  }

  /* What is listed. */

  /** What a value says, in words. */
  labelOfValue: ValueLabel = (spec, value) => {
    const t = this.#t;
    if (typeof value === "boolean") return t(value ? "keyframes.on" : "keyframes.off");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return textOf(t, `property.choice.${spec.path}.${text}`, text);
  };

  /** What a node is called, which is what people search for. */
  nameOfNode(node: TreeNode, row?: Row): string {
    const t = this.#t;
    switch (node.kind) {
      case "track":
        return row ? nameOfTrack(t, row) : "";
      case "clip": {
        const clip = this.model?.boxes.get(node.clip)?.clip;
        const kind = clip?.source.kind ?? "";
        return clip?.name ?? textOf(t, `timeline.kind.${kind}`, kind);
      }
      case "object":
        return node.orphans ? t("keyframes.orphans") : (node.object.name ?? node.object.id);
      case "group":
        return groupOf(t, node.group);
      case "property":
        return nameOf(t, node.spec);
    }
  }

  /** What people call a lane. A group tells its X and Y from those of other groups. */
  labelOf({ node, row, group }: Lane): string {
    const name = this.nameOfNode(node, row);
    return group === undefined ? name : `${groupOf(this.#t, group)} ${name}`;
  }

  isOpen(node: TreeNode): boolean {
    if (this.#snapshot.query !== "" && node.kind !== "property") return true;
    const toggled = this.#toggled.has(node.id);
    return node.kind === "track" ? !toggled : toggled;
  }

  readonly #rules: LaneRules = {
    isOpen: (node) => this.isOpen(node),
    tallHeight: (node: PropertyNode) =>
      this.isTall(node.clip, node.spec.path)
        ? this.tallHeightOf(node.clip, node.spec.path)
        : undefined,
  };

  get laneRules(): LaneRules {
    return this.#rules;
  }

  /* Rows made taller. */

  isTall(clip: string, path: string): boolean {
    return this.#tall.get(rowKey(clip, path))?.on === true;
  }

  /** How tall a row is when it is made taller: as it was last time, or the usual. */
  tallHeightOf(clip: string, path: string): number {
    return this.#tall.get(rowKey(clip, path))?.height ?? DEFAULT_TALL_HEIGHT;
  }

  /** Makes a row taller, or back to what the other rows are. Either way it keeps its height. */
  toggleTall(clip: string, path: string): void {
    const on = !this.isTall(clip, path);
    this.#tall.set(rowKey(clip, path), { clip, path, height: this.tallHeightOf(clip, path), on });
    this.#relist();
    this.#rememberSoon();
  }

  /** While its edge is pulled. It stays taller, at that height, also for the next time. */
  setTallHeight(clip: string, path: string, height: number): void {
    const limited = clampTall(height);
    if (this.isTall(clip, path) && limited === this.tallHeightOf(clip, path)) return;
    this.#tall.set(rowKey(clip, path), { clip, path, height: limited, on: true });
    this.#relist();
    this.#rememberSoon();
  }

  /* What rows of numbers cover. */

  /** What a row of a number covers, and what it covered when a drag started. */
  rangeOf(
    clip: string,
    path: string,
    value: PropertyValue,
    spec: PropertySpec,
  ): ValueRange | undefined {
    const channel = channelOf(value, spec.type);
    const range = channel && rangeOfChannel(channel);
    return range && unionOf(range, this.#heldRanges.get(rowKey(clip, path)));
  }

  /** Something that changes when what rows cover is held or let go, for drawing again. */
  get heldRanges(): unknown {
    return this.#heldRanges;
  }

  /** Keeps rows from shrinking while a drag goes on in them. */
  holdRanges(rows: readonly { readonly clip: string; readonly path: string }[]): void {
    const held = new Map<string, ValueRange>();
    for (const { clip, path } of rows) {
      const box = this.model?.boxes.get(clip);
      const spec = box && this.specOf(clip, path);
      const value = box && this.shownValue(box.clip, path);
      const range = spec && value !== undefined ? this.rangeOf(clip, path, value, spec) : undefined;
      if (range) held.set(rowKey(clip, path), range);
    }
    this.#heldRanges = held;
  }

  releaseRanges(): void {
    if (this.#heldRanges.size === 0) return;
    this.#heldRanges = new Map();
    this.redraw();
  }

  /** What a property of a clip is, as the tree of the clip describes it. */
  specOf(clip: string, path: string): PropertySpec | undefined {
    const box = this.model?.boxes.get(clip);
    if (!box) return undefined;
    const node = clipNodeOf(this.shown(box.clip));
    let specs = this.#specs.get(node);
    if (!specs) {
      const found = new Map<string, PropertySpec>();
      const visit = (child: ClipChild) => {
        if (child.kind === "property") found.set(child.spec.path, child.spec);
        else for (const below of child.children) visit(below);
      };
      for (const child of node.children) visit(child);
      specs = found;
      this.#specs.set(node, specs);
    }
    return specs.get(path);
  }

  /** Whether a property changes gradually, which is what has curves, handles and ways of easing. */
  isGradual(clip: string, path: string): boolean {
    const spec = this.specOf(clip, path);
    return spec !== undefined && canMix(spec.type);
  }

  toggleOpen(id: string): void {
    if (this.#toggled.has(id)) this.#toggled.delete(id);
    else this.#toggled.add(id);
    this.#relist();
    this.#rememberSoon();
  }

  /** What is open on the timeline changed. */
  toggleOpenInTimeline(): void {
    this.#relist();
    this.#rememberSoon();
  }

  setRange(range: ListRange): void {
    if (range === this.#snapshot.range) return;
    this.#show({ range });
    this.#listedFrame = this.#timeline.frame;
    this.#relist();
    this.#rememberSoon();
  }

  setQuery(query: string): void {
    if (query === this.#snapshot.query) return;
    this.#show({ query });
    this.#relist();
  }

  togglePin(id: string): void {
    const pinned = new Set(this.#snapshot.pinned);
    if (!pinned.delete(id)) pinned.add(id);
    this.#show({ pinned });
    this.#relist();
    this.#rememberSoon();
  }

  /** While the divider is dragged. Saving waits for `saveListWidth`. */
  setListWidth(width: number): void {
    const listWidth = clampWidth(width);
    if (listWidth !== this.#snapshot.listWidth) this.#show({ listWidth });
  }

  saveListWidth(): void {
    const { listWidth } = this.#snapshot;
    this.#settings
      .save(SETTINGS_KEY, { version: SETTINGS_VERSION, listWidth })
      .catch((error: unknown) => console.warn("Keyframe settings could not be saved", error));
  }

  /** Clips with keys that nothing describes, which stay listed wherever the moment is. */
  #orphanedIn(model: TimelineModel): ReadonlySet<string> {
    if (this.#orphaned) return this.#orphaned;
    const found = new Set<string>();
    for (const box of model.boxes.values()) {
      if (hasOrphans(clipNodeOf(this.shown(box.clip)))) found.add(box.id);
    }
    this.#orphaned = found;
    return found;
  }

  /**
   * The clips of a track that can be at a moment. Moving the playhead asks for this with every frame,
   * so this does not go through all of them: it finds what is there, and adds what stays anyway.
   */
  #clipsNear(model: TimelineModel, row: Row, seconds: number): readonly ClipBox[] {
    const { pinned } = this.#snapshot;
    const near = new Set<ClipBox>();
    forEachBetween(row, seconds - HERE_MARGIN, seconds + HERE_MARGIN, (box) => near.add(box));
    const stays = [
      ...this.#timeline.getSnapshot().selection,
      ...[...pinned].map((id) => id.split("/")[0] as string),
      ...this.#orphanedIn(model),
    ];
    for (const id of stays) {
      const box = model.boxes.get(id);
      if (box && model.rowOfClip.get(id) === row) near.add(box);
    }
    return [...near].toSorted((a, b) => a.start - b.start);
  }

  /** The tracks with what they list right now. */
  tracks(model: TimelineModel): readonly TrackNode[] {
    const { range, query, pinned } = this.#snapshot;
    const { selection } = this.#timeline.getSnapshot();
    const moment = frameTime(this.#listedFrame, model.rate);
    const seconds = this.#listedFrame / model.rate.fps;
    const wanted = query.toLowerCase();
    const filter = {
      range,
      moment,
      always: (id: string) => pinned.has(id) || selection.has(id),
      ...(wanted === ""
        ? {}
        : { matches: (node: TreeNode) => this.#searchNameOf(node).includes(wanted) }),
    };
    return model.rows.flatMap((row) => {
      const boxes = range === "here" ? this.#clipsNear(model, row, seconds) : row.clips;
      const clips = boxes.map(({ clip }) => this.shown(clip));
      const node = clips.length > 0 ? listedTrack(row.track, clips, filter) : undefined;
      return node ? [node] : [];
    });
  }

  /** What a name goes by, when it is the same on every clip. */
  #searchKeyOf(node: TreeNode): string | undefined {
    if (node.kind === "group") return `group ${node.group}`;
    if (node.kind === "property" && node.spec.name === undefined) return `path ${node.spec.path}`;
    const clip = node.kind === "clip" ? this.model?.boxes.get(node.clip)?.clip : undefined;
    return clip && clip.name === undefined ? `kind ${clip.source.kind}` : undefined;
  }

  /** Thousands of clips have the same few names, and looking for one goes through all of them. */
  #searchNameOf(node: TreeNode): string {
    const id = this.#searchKeyOf(node);
    if (id === undefined) return this.nameOfNode(node).toLowerCase();
    let name = this.#searchNames.get(id);
    if (name === undefined) {
      name = this.nameOfNode(node).toLowerCase();
      this.#searchNames.set(id, name);
    }
    return name;
  }

  #relist(): void {
    if (this.#relisting) return;
    this.#relisting = true;
    try {
      this.inTimeline.relist();
      this.panel.relist();
    } finally {
      this.#relisting = false;
    }
  }

  /* Keys. */

  /** Selected keys select their clips, which is what the timeline and the properties are about then. */
  select(selection: KeySelection): void {
    if (selection === this.#snapshot.selection) return;
    this.#setKeys(selection);
    if (selection.size > 0) this.#timeline.selectClipsOfKeys(selection.clips());
  }

  #setKeys(selection: KeySelection): void {
    if (selection === this.#snapshot.selection) return;
    this.#show({ selection });
    this.redraw();
  }

  clearSelection(): void {
    this.select(NO_KEYS);
  }

  /** A drag stopped because what it was about went away. */
  tellGone(): void {
    this.#messages.gone();
  }

  showPreview(preview: KeyPreview | undefined, area: KeyArea): void {
    this.#preview = preview;
    this.#previewArea = preview ? area : undefined;
    this.redraw();
  }

  previewEdits(edits: readonly PropertyEdit[]): void {
    this.#writer.preview(edits);
  }

  cancelEdits(): void {
    this.#writer.cancel();
  }

  /** What is selected follows the keys, also while the change goes around. */
  commitMove(edits: readonly PropertyEdit[], selection: KeySelection): boolean {
    const before = this.#snapshot.selection;
    this.#show({ selection });
    const done = this.#writer.commit(edits);
    if (!done) this.#show({ selection: before });
    return done;
  }

  /** The selected keys that can change, by property, of the clips a place shows. */
  movingChannels(shown: ShownClips = ALL_CLIPS): readonly MovingChannel[] {
    const channels: MovingChannel[] = [];
    for (const { clip, path, times } of this.selection.channels()) {
      if (shown(clip) && this.canMove(clip)) channels.push({ clip, path, times: [...times] });
    }
    return channels;
  }

  get hasMovableSelection(): boolean {
    return this.movingChannels().length > 0;
  }

  /**
   * The keys that something can happen to, or none after saying why not: they are not where people
   * look, people compare with what is saved, or the tracks are locked.
   */
  #changeable(shown: ShownClips): readonly MovingChannel[] {
    const channels = this.movingChannels(shown);
    if (channels.length > 0 || this.selection.size === 0) return channels;
    const there = this.selection.onClips(shown);
    if (there.size === 0) this.#messages.notShown();
    else if (this.comparing) this.#messages.comparing();
    else this.#messages.locked();
    return channels;
  }

  /** Moves the selected keys by whole frames. It is all or nothing, and the keys stay on their clock. */
  nudge(frames: number, shown: ShownClips = ALL_CLIPS): void {
    const { model } = this;
    const channels = this.movingChannels(shown);
    if (!model || channels.length === 0) return;
    const step = frameTime(Math.abs(frames), model.rate);
    const by = frames < 0 ? subtract(ZERO, step) : step;
    const fits = channels.every(({ times }) =>
      times.every((time) => compare(add(parseTime(time), by), ZERO) >= 0),
    );
    if (!fits) return;
    const moved = KeySelection.of(movedSelection(this.selection, channels, by));
    this.commitMove(moveEdits(channels, by), moved);
  }

  /** Takes the selected keys away, in one step, or says why that cannot be. */
  deleteSelected(shown: ShownClips = ALL_CLIPS): void {
    const edits = this.#changeable(shown).flatMap(({ clip, path, times }) =>
      times.map((time): PropertyEdit => ({ owner: { clip }, path, op: "removeKey", time })),
    );
    if (edits.length > 0) this.#writer.commit(edits);
  }

  /** Copies the selected keys and takes them away, or says why that cannot be. */
  cutSelected(shown: ShownClips = ALL_CLIPS): void {
    const channels = this.#changeable(shown);
    if (channels.length === 0) return;
    const keys = channels.flatMap(({ clip, path, times }) =>
      times.map((time) => ({ clip, path, time })),
    );
    this.#copy(keys);
    this.deleteSelected(shown);
  }

  /** The selected keys that can change and have curves, by property. */
  #gradualChannels(): readonly MovingChannel[] {
    return this.movingChannels().filter(({ clip, path }) => this.isGradual(clip, path));
  }

  /** Whether some selected keys have a way of easing: switches, choices and words only hold. */
  get canEase(): boolean {
    for (const { clip, path } of this.selection.channels()) {
      if (this.isGradual(clip, path)) return true;
    }
    return false;
  }

  /** How the selected keys go on, as far as they all agree on it. */
  get selectedPreset(): EasePreset | undefined {
    const found = new Set<EasePreset | undefined>();
    for (const { clip, path, times } of this.selection.channels()) {
      if (!this.isGradual(clip, path)) continue;
      const box = this.model?.boxes.get(clip);
      const animation =
        box && animationIn(entryOf(effectiveProperties(this.shown(box.clip)), path));
      if (!animation) continue;
      for (const time of times) {
        const index = firstKeyFrom(animation.keys, parseTime(time));
        found.add(presetOf(animation.keys[index] as Key, animation.keys[index + 1]));
        if (found.size > 1) return undefined;
      }
    }
    return [...found][0];
  }

  /**
   * Gives the selected keys a way of going on. A bezier is the preset all through, so automatic keys
   * at either end of it are not worked out any more: they say that their handles are broken now.
   */
  setEase(ease: KeyEase): void {
    const edits = this.#gradualChannels().flatMap(({ clip, path, times }): PropertyEdit[] => {
      const interp: PropertyEdit = {
        owner: { clip },
        path,
        op: "setInterp",
        times: [...times],
        ease,
      };
      const selected =
        ease.interp === "bezier" ? this.#selectedIndices(clip, path, times) : undefined;
      const broken = new Map<number, Key>();
      for (const index of selected?.indices ?? []) {
        for (const at of [index, index + 1]) {
          const key = selected?.keys[at];
          if (key?.tangent === "auto") broken.set(at, { ...key, tangent: "broken" });
        }
      }
      if (broken.size === 0) return [interp];
      return [{ owner: { clip }, path, op: "putKeys", keys: [...broken.values()] }, interp];
    });
    if (edits.length > 0) this.#writer.commit(edits);
  }

  /** The keys of a property of a clip as people see them, with where the selected ones are. */
  #selectedIndices(clip: string, path: string, times: Iterable<string>) {
    const box = this.model?.boxes.get(clip);
    const animation = box && animationIn(entryOf(effectiveProperties(this.shown(box.clip)), path));
    if (!animation) return undefined;
    const indices: number[] = [];
    for (const time of times) {
      const index = firstKeyFrom(animation.keys, parseTime(time));
      if (animation.keys[index]?.time === time) indices.push(index);
    }
    return { keys: animation.keys, indices: indices.toSorted((a, b) => a - b) };
  }

  /** How the selected keys change their handles, as far as they all agree on it. */
  get selectedTangent(): TangentMode | undefined {
    const found = new Set<TangentMode>();
    for (const { clip, path, times } of this.selection.channels()) {
      if (!this.isGradual(clip, path)) continue;
      const selected = this.#selectedIndices(clip, path, times);
      for (const index of selected?.indices ?? []) {
        found.add(tangentOf(selected?.keys ?? [], index));
        if (found.size > 1) return undefined;
      }
    }
    return [...found][0];
  }

  /** Says how the selected keys change their handles, in one step: see `withTangent`. */
  setTangent(mode: TangentMode): void {
    const edits = this.#gradualChannels().flatMap(({ clip, path, times }): PropertyEdit[] => {
      const selected = this.#selectedIndices(clip, path, times);
      if (!selected) return [];
      const changed = withTangent(selected.keys, selected.indices, mode);
      return changed.size > 0
        ? [{ owner: { clip }, path, op: "putKeys", keys: [...changed.values()] }]
        : [];
    });
    if (edits.length > 0) this.#writer.commit(edits);
  }

  /* Copying. */

  /** Taking a copy leaves a key as it is, so a locked one can be part of it. */
  copySelected(shown: ShownClips = ALL_CLIPS): void {
    const keys = this.selection.onClips(shown);
    if (keys.size === 0) {
      if (this.selection.size > 0) this.#messages.notShown();
      return;
    }
    this.#copy(keys);
  }

  #copy(keys: Iterable<KeyRef>): void {
    const copied: CopiedKey[] = [];
    for (const { clip, path, time } of keys) {
      const box = this.model?.boxes.get(clip);
      if (!box) continue;
      const shown = this.shown(box.clip);
      const found = this.#keysOf(shown, path);
      const key = found[firstKeyFrom(found, parseTime(time))];
      if (key) copied.push({ clip, path, moment: momentOfKey(shown, time), key });
    }
    if (copied.length === 0) return;
    this.#clipboard = copied;
    this.#show({ hasClipboard: true });
    this.#timeline.forgetClipboard();
  }

  forgetClipboard(): void {
    if (this.#clipboard.length === 0) return;
    this.#clipboard = [];
    this.#show({ hasClipboard: false });
  }

  /** Where keys of one clip go: to the clip people selected, if that is one other clip. */
  #pasteTarget(source: string): ClipState | undefined {
    const { model } = this;
    let only: ClipState | undefined;
    for (const id of this.#timeline.getSnapshot().selection) {
      const clip = model?.boxes.get(id)?.clip;
      if (!clip || objectsOf(clip).length === 0) continue;
      // Several clips are no one place to go, and there is no need to look any further.
      if (only) return model?.boxes.get(source)?.clip;
      only = clip;
    }
    return only ?? model?.boxes.get(source)?.clip;
  }

  /**
   * Puts copies at the playhead, as far apart as they were, in one step. Keys of one clip can go to
   * another clip, into the same properties. Keys of several clips stay with their clips. They come
   * with how they ease. The playhead stays: people are watching that place.
   */
  paste(): void {
    const copied = this.#clipboard;
    const { model } = this;
    const [first] = copied;
    if (!model || !first) return;
    if (this.comparing) {
      this.#messages.comparing();
      return;
    }
    const sources = new Set(copied.map(({ clip }) => clip));
    const earliest = copied.reduce(
      (found, { moment }) => (compare(moment, found) < 0 ? moment : found),
      first.moment,
    );
    const by = subtract(frameTime(this.frame, model.rate), earliest);
    const edits = new Map<string, { clip: string; path: string; keys: Key[] }>();
    const pasted: KeyRef[] = [];
    const single = sources.size === 1 ? this.#pasteTarget(first.clip) : undefined;
    for (const { clip: source, path, moment, key } of copied) {
      const target = sources.size === 1 ? single : model.boxes.get(source)?.clip;
      if (!target || !this.canMove(target.id)) {
        this.#messages.pasteNowhere();
        return;
      }
      const clock = add(clipOffset(target), subtract(add(moment, by), clipStart(target)));
      if (compare(clock, ZERO) < 0) {
        this.#messages.pasteTooEarly();
        return;
      }
      const time = formatTime(clock);
      const id = `${target.id} ${path}`;
      const edit = edits.get(id) ?? { clip: target.id, path, keys: [] };
      edit.keys.push({ ...key, time });
      edits.set(id, edit);
      pasted.push({ clip: target.id, path, time });
    }
    const done = this.#writer.commit(
      [...edits.values()].map(({ clip, path, keys }) => ({
        owner: { clip },
        path,
        op: "putKeys",
        keys,
      })),
    );
    if (done) this.select(KeySelection.of(pasted));
  }

  /* Remembering. */

  rememberSoon(): void {
    this.#rememberSoon();
  }

  #rememberSoon(): void {
    clearTimeout(this.#rememberTimer);
    this.#rememberTimer = setTimeout(() => this.#remember(), REMEMBER_DELAY_MS);
  }

  /** Saves the state of the view right away, for when the page is about to go. */
  flush(): void {
    clearTimeout(this.#rememberTimer);
    this.#remember();
  }

  #remember(): void {
    const id = this.#store?.getState().manifest.id;
    if (id === undefined) return;
    const { range, pinned } = this.#snapshot;
    const view = this.panel.ownView;
    // What is gone stays out of it, so that it does not grow with every clip there ever was.
    const there = (ids: Iterable<string>) => [...ids].filter((one) => this.#isThere(one));
    const remembered: RememberedState = {
      range,
      toggled: there(this.#toggled),
      pinned: there(pinned),
      tall: [...this.#tall.values()].flatMap(({ clip, path, height, on }): TallRow[] =>
        this.#isThere(clip) ? [[clip, path, height, on]] : [],
      ),
      open: there(this.inTimeline.opened),
      ...(view ? { view } : {}),
      ...(this.panel.rowScale === 1 ? {} : { rows: this.panel.rowScale }),
    };
    this.#memory.write(`keyframes.${id}`, JSON.stringify(remembered));
  }

  /** Whether what an id of the list is about is still in the project: a clip, or a track. */
  #isThere(id: string): boolean {
    const { model } = this;
    if (!model) return true;
    const track = /^track:(.+)$/.exec(id)?.[1];
    if (track !== undefined) return model.rows.some((row) => row.track.id === track);
    return model.boxes.has(id.split("/")[0] as string);
  }
}

/** What a track is called. */
const nameOfTrack = (t: TFunction, { track, number, gone }: Row) =>
  gone ? t("timeline.goneTrack") : (track.name ?? t(`timeline.track.${track.kind}`, { number }));

const sameKey = (a: Key, b: Key | undefined) => JSON.stringify(a) === JSON.stringify(b);
