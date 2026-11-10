import {
  ZERO,
  add,
  compare,
  formatTime,
  newId,
  parseTime,
  subtract,
  toSeconds,
  type Rational,
  type SoundManifest,
  type Transition,
  type TransitionUse,
} from "@animaquill/schema";
import {
  clipEnd,
  clipStart,
  effectsOf,
  longestJoin,
  orderedSections,
  projectFrameRate,
  sourceLength,
  timelineLength,
  trackKindFor,
  type ClipState,
  type CommandCall,
  type ProjectStore,
  type WholeJoin,
} from "@animaquill/core";
import type { SettingsStore, WindowMemory } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { projectKeyOf, type ProjectSession } from "../workbench/session.ts";
import { readSetting } from "../workbench/settings.ts";
import { frameAt, frameSeconds, frameTime } from "./frames.ts";
import {
  attachCalls,
  attachContext,
  attachProblem,
  dropCalls,
  transitionDropAt,
  type AttachContext,
  type TransitionDrop,
  type TransitionPick,
} from "./transition-place.ts";
import {
  effectCalls,
  effectContext,
  effectDropAt,
  effectProblem,
  type EffectContext,
} from "./effect-place.ts";
import { sceneTemplate } from "./scene-template.ts";
import { soundTemplate } from "./sound-template.ts";
import type { TouchStart, TouchTarget } from "./touch.ts";
import {
  EndGesture,
  JoinGesture,
  MarqueeGesture,
  MoveGesture,
  RazorGesture,
  ScrubGesture,
  TransitionGesture,
  TransitionPressGesture,
  TrimGesture,
  copiedJoins,
  copiesOf,
  joinsAmong,
  cutAt,
  freeShift,
  splitCall,
  transitionCall,
  type ClipCopy,
  type Gesture,
  type GestureHost,
  type CoveredSpan,
  type Placed,
  type Pointer,
  type Preview,
} from "./gestures.ts";
import { snapPointsOf } from "./snap.ts";
import {
  EDGES,
  NO_ROOM_BELOW,
  buildModel,
  canHaveTransitions,
  clipAt,
  edgesOf,
  firstEndingAfter,
  forEachBetween,
  isInsideClip,
  joinAt,
  rowAt,
  type ClipBox,
  type Edge,
  type JoinBox,
  type RoomBelow,
  type Row,
  type TimelineModel,
} from "./model.ts";

export const RULER_HEIGHT = 28;
/** The button on a clip for what shows under its track. It stays with the name of the clip. */
export const EXPANDER_SIZE = 14;
const EXPANDER_INSET = 6;
const EXPANDER_MIN_WIDTH = 32;
const EXPANDER_HEIGHT = 24;
/** How far the pointer can be from an edge and still grab it. Short clips keep some middle. */
const EDGE_REACH = 7;
/** A fingertip covers more than a mouse pointer. */
const TOUCH_EDGE_REACH = 16;
/**
 * How far down from the top of a clip its transitions at the edges are, as blocks with their
 * names. Below it the clip is the clip.
 */
export const TRANSITION_BAND = 16;
/** How far down the handles of transitions reach: the height they show at, as fades had them. */
const HANDLE_REACH = 10;
const SNAP_REACH = 8;
/**
 * Room after the end of the timeline, as a share of its length: clips need somewhere to go. Not in
 * pixels, so that the scrollbar stands for the same seconds at every zoom level.
 */
const TAIL_SHARE = 0.25;
/** People look at a clip, not at its last frame, when the view follows the playhead. */
const REVEAL_MARGIN = 48;
/** Zoom out to the whole timeline with a little air around it. */
const FIT_SHARE = 0.95;
const MIN_ZOOM_SHARE = 0.8;
/** The closest view: a frame is wide enough to see and to grab. */
const MAX_PIXELS_PER_FRAME = 240;
const ZOOM_STEP = 1.5;
const MIN_ROW_SCALE = 0.6;
const MAX_ROW_SCALE = 3;
const ROW_SCALE_STEP = 1.25;
const END_HANDLE_REACH = 7;
/** How far from a cut a transition dragged there still goes between the clips, in pixels. */
const SEAM_REACH = 10;
const REMEMBER_DELAY_MS = 300;
const NEW_CLIP_SECONDS = 5;
export const DEFAULT_HEADER_WIDTH = 148;
const MIN_HEADER_WIDTH = 96;
const MAX_HEADER_WIDTH = 360;

/** Colours that tell clips apart while they are only placeholders. */
const NEW_CLIP_COLORS = ["#3f6fb5", "#3f9a7a", "#b57a3f", "#8f5fb5", "#b5536a", "#5f8fa8"];

/**
 * Where that button is, past where a press at either edge trims, or undefined when there is no
 * room for it. A finger trims from further in.
 */
export function expanderBox(left: number, width: number, edgeReach: number): number | undefined {
  const reach = Math.min(edgeReach, width / 3);
  const x = Math.max(left, 0) + Math.max(EXPANDER_INSET, reach + 1);
  const fits = width >= EXPANDER_MIN_WIDTH && x + EXPANDER_SIZE <= left + width - reach;
  return fits ? x : undefined;
}

export type Tool = "select" | "razor";

/** Where something dragged here goes. */
export interface DropPlace {
  /** Distance from the top of the first row, or nothing for the first track of the kind. */
  readonly lane?: number;
  readonly seconds: number;
  /** How close in seconds it snaps to the edges of clips, the playhead and the ends. */
  readonly snap?: number;
}

/** Something of the project that people put on the timeline, by what it is. */
export interface MediaPick {
  readonly kind: "asset" | "scene" | "sound";
  readonly id: string;
}

/** Where something went on the timeline, for saying so. */
export interface MediaAdded {
  readonly clips: readonly string[];
  /** The tracks it went on, in the order of its clips, a new one with the number it got. */
  readonly tracks: readonly {
    readonly kind: "video" | "audio";
    readonly number: number;
    readonly name?: string;
  }[];
  /** In seconds, and as the frame it starts on. */
  readonly start: number;
  readonly frame: number;
}

interface MediaPart {
  readonly kind: "video" | "audio";
  readonly source: Readonly<Record<string, unknown>> & { readonly kind: string };
}

/** What putting something on the timeline makes, before where. */
interface MediaWhat {
  readonly parts: readonly MediaPart[];
  readonly duration: Rational;
  readonly name?: string;
  readonly properties?: Readonly<Record<string, number>>;
  /** Commands that go first in the same step, such as adding the scene it shows. */
  readonly before: readonly CommandCall[];
}

type MediaWhere = DropPlace | "free" | "playhead";

/** Where it would land, see `TimelineEditor.#planMedia`. */
interface MediaPlan {
  readonly parts: readonly (MediaPart & { readonly row: Row | undefined })[];
  readonly at: Rational;
  readonly duration: Rational;
  readonly overwriting: boolean;
  /** Where it snapped, or touches what it went after. */
  readonly line?: number;
}

/** What a click on a transition did: how many edges of clips and joins got it. */
export interface TransitionsAttached {
  readonly edges: number;
  readonly joins: number;
  /** It took the place of the one that was selected. */
  readonly replaced: boolean;
}

/** What lights up for a moment after it was added, see `TimelineEditor.flash`. */
export interface FlashTargets {
  /** Whole clips. */
  readonly clips?: ReadonlySet<string>;
  /** The transitions at edges of clips, as `${clip}:${edge}`. */
  readonly edges?: ReadonlySet<string>;
  readonly joins?: ReadonlySet<string>;
  /** The bands of effects of clips. */
  readonly bands?: ReadonlySet<string>;
}

const nameOf = ({ track }: Row) => (track.name === undefined ? {} : { name: track.name });

/** The track that a new one of a kind gets: numbered after those there are. */
function newTrackOf(model: TimelineModel, kind: "video" | "audio") {
  const known = model.rows.filter(({ track, gone }) => track.kind === kind && !gone);
  return { kind, number: known.length + 1 };
}

export type Hit =
  | { readonly kind: "ruler" }
  | { readonly kind: "end" }
  | { readonly kind: "lane"; readonly row: Row; readonly seconds: number }
  | {
      readonly kind: "clip";
      readonly row: Row;
      readonly box: ClipBox;
      readonly edge?: "start" | "end";
      /** On the handle at a top corner, where the transition at that edge ends, or would start. */
      readonly handle?: Edge;
      /** On the block of the transition at that edge. */
      readonly transition?: Edge;
      /** On the button for what shows under the track. */
      readonly expander?: boolean;
    }
  | {
      readonly kind: "join";
      readonly row: Row;
      readonly join: JoinBox;
      /** On an edge of its block, which changes how long it is. */
      readonly edge?: "start" | "end";
    }
  | { readonly kind: "empty" };

/** What shows under the clips of a track. It lives in the room `setRoomBelow` asks for. */
export interface RowExtras {
  /** Starts what a press means there. Undefined means that it is not about this. */
  press(pointer: Pointer): Gesture | undefined;
  /** The cursor there, or undefined when the pointer is somewhere else. */
  hover(pointer: Pointer): string | undefined;
  /** What a finger starts there, or undefined when it is somewhere else. */
  touchAt(pointer: Pointer): TouchStart | undefined;
  /** A long press there. Says whether it was. */
  hold(pointer: Pointer): boolean;
  setTouchInput(on: boolean): void;
  /** Whether a drag there shows a change. */
  readonly holdsDrag: boolean;
  /** Whether a clip has something to show there. */
  canOpen(box: ClipBox): boolean;
  isOpen(box: ClipBox): boolean;
  toggle(box: ClipBox): void;
}

/**
 * A transition, which is what people select instead of clips: at an edge of a clip, or a join on
 * the cut between two.
 */
export type TransitionChoice =
  { readonly clip: string; readonly edge: Edge } | { readonly join: string };

/** Whether a choice is of a join. */
export const isJoinChoice = (
  choice: TransitionChoice | undefined,
): choice is { readonly join: string } => choice !== undefined && "join" in choice;

/** Effects that just went on clips: the id of each, by clip, and which time that was. */
export interface AddedEffects {
  readonly effects: ReadonlyMap<string, string>;
  readonly at: number;
  /** When, by `Date.now()`. */
  readonly time: number;
}

/** How long clips light up when something happened to them, see `TimelineEditor.flash`. */
export const FLASH_MS = 700;
const FLASH_STEP_MS = 40;

/** What React shows. The view changes far more often and goes through `subscribeView`. */
export interface TimelineSnapshot {
  readonly model: TimelineModel | undefined;
  readonly selection: ReadonlySet<string>;
  /** Selected instead of clips. Like them it is no part of the project. */
  readonly transition: TransitionChoice | undefined;
  readonly tool: Tool;
  readonly snapping: boolean;
  /** Whether a drop covers other clips. Off, clips go to the nearest free place. */
  readonly overwriting: boolean;
  /** Whether a click adds to the selection, or takes away from it. For fingers above all. */
  readonly multiSelecting: boolean;
  readonly playing: boolean;
  readonly headerWidth: number;
  /** Cut, and waiting to be pasted somewhere else. They stay until then. */
  readonly cut: ReadonlySet<string>;
}

/** A clip and where it is on screen, in pixels from the top left of the timeline area. */
export interface VisibleClip {
  readonly box: ClipBox;
  readonly row: Row;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface TimelineMessages {
  commandFailed(message: string): void;
  /** Joins went because their clips are no longer next to each other: undo brings them back. */
  joinsRemoved?(count: number): void;
  /** What a new scene is called. */
  sceneName?(number: number): string;
  /** What a new sound is called, and the words for what it has to be told. */
  soundName?(number: number): string;
  soundWords?(): { readonly duration: string; readonly seed: string };
}

interface ViewPlace {
  readonly pixelsPerSecond: number;
  readonly scrollX: number;
}

interface RememberedView {
  readonly rowScale?: number;
  readonly pixelsPerSecond: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly frame: number;
}

/** The range of zoom levels of a timeline, in pixels per second. */
export function zoomRange(width: number, duration: number, fps: number): readonly [number, number] {
  const shortest = Math.max(duration, 1 / fps);
  const low = (Math.max(width, 1) * MIN_ZOOM_SHARE) / shortest;
  const high = fps * MAX_PIXELS_PER_FRAME;
  return [Math.min(low, high), high];
}

function parseRemembered(text: string | undefined): RememberedView | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<RememberedView>;
    const { pixelsPerSecond, scrollX, scrollY, frame } = value;
    const numbers = [pixelsPerSecond, scrollX, scrollY, frame];
    if (!numbers.every((number) => Number.isFinite(number) && (number as number) >= 0)) {
      return undefined;
    }
    return value as RememberedView;
  } catch {
    return undefined;
  }
}

const SETTINGS_KEY = "timeline";
const SETTINGS_VERSION = 1;

interface SavedPreferences {
  readonly version: typeof SETTINGS_VERSION;
  readonly snapping: boolean;
  readonly overwriting: boolean;
  readonly multiSelecting: boolean;
  readonly headerWidth: number;
}

function parsePreferences(value: unknown): SavedPreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { version, snapping, overwriting, multiSelecting, headerWidth } =
    value as Partial<SavedPreferences>;
  if (version !== SETTINGS_VERSION) return undefined;
  if (typeof snapping !== "boolean" || typeof overwriting !== "boolean") return undefined;
  return {
    version,
    snapping,
    overwriting,
    multiSelecting: multiSelecting === true,
    headerWidth: typeof headerWidth === "number" ? headerWidth : DEFAULT_HEADER_WIDTH,
  };
}

export const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high));

const sameView = (a: ViewPlace, b: ViewPlace) =>
  a.pixelsPerSecond === b.pixelsPerSecond && a.scrollX === b.scrollX;

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((item) => b.has(item));

/**
 * The timeline of this window: what it shows, what is selected and what the mouse is doing. None of
 * it is part of the project. Changes to the project go through commands, once a drag has ended.
 */
export class TimelineEditor implements TouchTarget {
  readonly #session: ProjectSession;
  readonly #memory: WindowMemory;
  readonly #settings: SettingsStore;
  readonly #messages: TimelineMessages;
  readonly #emitter = new Emitter();
  readonly #viewEmitter = new Emitter();
  readonly #copied = new Emitter();
  readonly #chosen = new Emitter();
  readonly #addedEmitter = new Emitter();
  #added: AddedEffects | undefined;
  #flash: { readonly targets: FlashTargets; readonly share: number } | undefined;
  #flashTimer: ReturnType<typeof setTimeout> | undefined;
  #snapshot: TimelineSnapshot = {
    model: undefined,
    selection: new Set(),
    transition: undefined,
    tool: "select",
    snapping: true,
    overwriting: false,
    multiSelecting: false,
    playing: false,
    headerWidth: DEFAULT_HEADER_WIDTH,
    cut: new Set(),
  };
  /** What was copied, in this window. */
  #clipboard: readonly ClipState[] = [];
  /** The joins between clips on the clipboard, as they were when they got copied. */
  #clipboardJoins: readonly WholeJoin[] = [];
  #store: ProjectStore | undefined;
  #stopStore: (() => void) | undefined;
  #gesture: Gesture | undefined;
  #preview: Preview | undefined;
  #hovered: Hit = { kind: "empty" };
  #razorAt: number | undefined;
  #frame = 0;
  /** Where the clock and the playhead were together last. */
  #playback: { readonly frame: number; readonly since: number } | undefined;
  #edgeReach = EDGE_REACH;
  /** How to get back from showing everything, while the view is still the one that showed it. */
  #beforeFit: { readonly from: ViewPlace; readonly fitted: ViewPlace } | undefined;
  #pixelsPerSecond = 0;
  #rowScale = 1;
  #scrollX = 0;
  #scrollY = 0;
  #width = 0;
  #height = 0;
  #rememberTimer: ReturnType<typeof setTimeout> | undefined;
  #extras: RowExtras | undefined;
  #roomBelow = NO_ROOM_BELOW;
  #effectContext:
    | {
        readonly model: TimelineModel | undefined;
        readonly selection: ReadonlySet<string>;
        readonly context: EffectContext;
      }
    | undefined;
  #attachContext:
    | {
        readonly model: TimelineModel | undefined;
        readonly selection: ReadonlySet<string>;
        readonly transition: TransitionChoice | undefined;
        readonly context: AttachContext;
      }
    | undefined;

  constructor(
    session: ProjectSession,
    memory: WindowMemory,
    settings: SettingsStore,
    messages: TimelineMessages,
  ) {
    this.#session = session;
    this.#memory = memory;
    this.#settings = settings;
    this.#messages = messages;
    session.subscribe(() => this.#followSession());
    this.#followSession();
  }

  /** Reads how people like to work. Whatever goes wrong, the defaults are fine. */
  async load(): Promise<void> {
    const reading = await readSetting(this.#settings, SETTINGS_KEY, parsePreferences);
    if (reading.kind === "ok") this.#adoptPreferences(reading.value);
    this.#settings.listen(SETTINGS_KEY, (value) => {
      const saved = parsePreferences(value);
      if (saved) this.#adoptPreferences(saved);
    });
  }

  #adoptPreferences(saved: SavedPreferences): void {
    const { snapping, overwriting, multiSelecting } = saved;
    const headerWidth = clamp(saved.headerWidth, MIN_HEADER_WIDTH, MAX_HEADER_WIDTH);
    this.#snapshot = { ...this.#snapshot, snapping, overwriting, multiSelecting, headerWidth };
    this.#emitter.emit();
  }

  #savePreferences(): void {
    const { snapping, overwriting, multiSelecting, headerWidth } = this.#snapshot;
    const saved = { version: SETTINGS_VERSION, snapping, overwriting, multiSelecting, headerWidth };
    this.#settings
      .save(SETTINGS_KEY, saved)
      .catch((error: unknown) => console.warn("Timeline settings could not be saved", error));
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): TimelineSnapshot => this.#snapshot;
  /** Everything that changes what is on screen, up to once per frame. */
  subscribeView = this.#viewEmitter.subscribe;
  /** Hears when clips go on the clipboard, which is when anything else that was there goes. */
  subscribeCopies = this.#copied.subscribe;
  /**
   * Hears when people select clips, also the ones that were selected already: what they do next is
   * about clips then. Keys selecting their clips is not that.
   */
  subscribeChoices = this.#chosen.subscribe;

  get model(): TimelineModel | undefined {
    return this.#snapshot.model;
  }

  get frame(): number {
    return this.#frame;
  }

  get pixelsPerSecond(): number {
    return this.#pixelsPerSecond;
  }

  get scrollX(): number {
    return this.#scrollX;
  }

  get scrollY(): number {
    return this.#scrollY;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get holdsDrag(): boolean {
    return this.preview !== undefined || this.#extras?.holdsDrag === true;
  }

  get preview(): Preview | undefined {
    return this.#preview;
  }

  /** What shows under the clips of tracks. */
  get extras(): RowExtras | undefined {
    return this.#extras;
  }

  setExtras(extras: RowExtras): void {
    this.#extras = extras;
  }

  /** Makes room under tracks. Nothing happens to clips: this is only about where rows are. */
  setRoomBelow(room: RoomBelow): void {
    const same =
      room.size === this.#roomBelow.size &&
      [...room].every(([track, height]) => this.#roomBelow.get(track) === height);
    if (same) return;
    this.#roomBelow = room;
    this.#refresh();
    this.#clampScroll();
  }

  /** Something drawn on the timeline changed that this does not know about. */
  redraw(): void {
    this.#viewEmitter.emit();
  }

  get hovered(): Hit {
    return this.#hovered;
  }

  /** Where the razor would cut, while it is over a clip. */
  get razorAt(): number | undefined {
    return this.#razorAt;
  }

  /** The end of the timeline as it looks right now, which a drag can change. */
  get visibleDuration(): number {
    return this.#preview?.end ?? this.model?.duration ?? 0;
  }

  /** The size of everything that can be scrolled to. */
  get contentWidth(): number {
    let last = this.visibleDuration;
    for (const { end } of this.#preview?.clips?.values() ?? []) last = Math.max(last, end);
    return Math.max(last * (1 + TAIL_SHARE) * this.#pixelsPerSecond, this.#width);
  }

  get contentHeight(): number {
    return Math.max((this.model?.height ?? 0) + RULER_HEIGHT + REVEAL_MARGIN, this.#height);
  }

  xAt(seconds: number): number {
    return seconds * this.#pixelsPerSecond - this.#scrollX;
  }

  timeAt(x: number): number {
    return (x + this.#scrollX) / this.#pixelsPerSecond;
  }

  /** The distance from the top of the first row to a height on screen. */
  laneAt(y: number): number {
    return y - RULER_HEIGHT + this.#scrollY;
  }

  /* The view. */

  setViewport(width: number, height: number): void {
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    // The panel went behind another tab or away. The mouse will not come back from there.
    if (width === 0) this.#cancelGesture();
    if (this.#pixelsPerSecond === 0 && width > 0) this.#fit();
    this.#clampScroll();
    this.#viewChanged();
  }

  setScroll(x: number, y: number): void {
    if (x === this.#scrollX && y === this.#scrollY) return;
    this.#scrollX = x;
    this.#scrollY = y;
    this.#clampScroll();
    this.#viewChanged();
  }

  /** Zooms while the moment under `x` stays where it is. Before the panel has a size, it waits. */
  zoomAround(x: number, factor: number): void {
    if (this.#pixelsPerSecond === 0) return;
    const moment = this.timeAt(x);
    this.#pixelsPerSecond = this.#limitZoom(this.#pixelsPerSecond * factor);
    this.#scrollX = moment * this.#pixelsPerSecond - x;
    this.#clampScroll();
    this.#viewChanged();
  }

  /** The keyboard has no pointer, so the playhead is the point to zoom around. */
  zoomIn(): void {
    this.zoomAround(this.#zoomCenter(), ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomAround(this.#zoomCenter(), 1 / ZOOM_STEP);
  }

  get rowScale(): number {
    return this.#rowScale;
  }

  /** Changes the height of rows while the row at height `y` stays where it is. */
  zoomRowsAround(y: number, factor: number): void {
    if (this.#gesture) return;
    const scale = clamp(this.#rowScale * factor, MIN_ROW_SCALE, MAX_ROW_SCALE);
    const applied = scale / this.#rowScale;
    if (applied === 1) return;
    const lane = this.laneAt(y);
    this.#rowScale = scale;
    this.#refresh();
    this.#scrollY = lane * applied - (y - RULER_HEIGHT);
    this.#clampScroll();
    this.#viewChanged();
  }

  rowsTaller(): void {
    this.zoomRowsAround(RULER_HEIGHT, ROW_SCALE_STEP);
  }

  rowsShorter(): void {
    this.zoomRowsAround(RULER_HEIGHT, 1 / ROW_SCALE_STEP);
  }

  /** The playhead turns into the snap line when that is what something snapped to. */
  get isSnappedToPlayhead(): boolean {
    const { model, preview } = this;
    if (!model || preview?.snap === undefined) return false;
    return Math.abs(preview.snap - frameSeconds(this.#frame, model.rate)) < 1e-9;
  }

  /** Shows the whole timeline. Asked again, it goes back to where people were. */
  zoomToFit(): void {
    if (this.#width === 0) return;
    const here = this.#viewPlace();
    const back = this.#beforeFit;
    this.#beforeFit = undefined;
    if (back && sameView(back.fitted, here)) {
      this.#pixelsPerSecond = this.#limitZoom(back.from.pixelsPerSecond);
      this.#scrollX = back.from.scrollX;
    } else {
      this.#fit();
      this.#scrollX = 0;
    }
    this.#clampScroll();
    const fitted = this.#viewPlace();
    if (!back && !sameView(here, fitted)) this.#beforeFit = { from: here, fitted };
    else if (back && !sameView(back.fitted, here)) this.#beforeFit = { from: here, fitted };
    this.#viewChanged();
  }

  #viewPlace(): ViewPlace {
    return { pixelsPerSecond: this.#pixelsPerSecond, scrollX: this.#scrollX };
  }

  /** Fingers need more room to find an edge, and the rest stays the same. */
  setTouchInput(on: boolean): void {
    this.#edgeReach = on ? TOUCH_EDGE_REACH : EDGE_REACH;
    this.#extras?.setTouchInput(on);
  }

  /** The zoom level from 0 for all of the timeline to 1 for single frames, for a slider. */
  get zoomLevel(): number {
    const [low, high] = this.#zoomRange();
    if (this.#pixelsPerSecond === 0 || high <= low) return 0;
    return clamp(Math.log(this.#pixelsPerSecond / low) / Math.log(high / low), 0, 1);
  }

  setZoomLevel(level: number): void {
    const [low, high] = this.#zoomRange();
    const target = low * (high / low) ** clamp(level, 0, 1);
    this.zoomAround(this.#zoomCenter(), target / this.#pixelsPerSecond);
  }

  #zoomRange(): readonly [number, number] {
    const { model } = this;
    return zoomRange(this.#width, model?.duration ?? 1, model?.rate.fps ?? 30);
  }

  #limitZoom(value: number): number {
    const [low, high] = this.#zoomRange();
    return clamp(value, low, high);
  }

  #zoomCenter(): number {
    const { model } = this;
    if (!model) return 0;
    const x = this.xAt(frameSeconds(this.#frame, model.rate));
    return x >= 0 && x <= this.#width ? x : this.#width / 2;
  }

  #fit(): void {
    const duration = Math.max(this.model?.duration ?? 0, 1);
    this.#pixelsPerSecond = this.#limitZoom((this.#width * FIT_SHARE) / duration);
  }

  #clampScroll(): void {
    this.#scrollX = clamp(this.#scrollX, 0, this.contentWidth - this.#width);
    this.#scrollY = clamp(this.#scrollY, 0, this.contentHeight - this.#height);
  }

  /** Scrolls just far enough that a moment can be seen. */
  #reveal(seconds: number): void {
    const x = this.xAt(seconds);
    const margin = Math.min(REVEAL_MARGIN, this.#width / 4);
    if (x < margin) this.#scrollX += x - margin;
    else if (x > this.#width - margin) this.#scrollX += x - (this.#width - margin);
    this.#clampScroll();
  }

  #viewChanged(): void {
    this.#viewEmitter.emit();
    this.#rememberSoon();
  }

  #rememberSoon(): void {
    clearTimeout(this.#rememberTimer);
    this.#rememberTimer = setTimeout(() => this.#remember(), REMEMBER_DELAY_MS);
  }

  /** Saves the view right away, for when the page is about to go. */
  flush(): void {
    clearTimeout(this.#rememberTimer);
    this.#remember();
  }

  #remember(): void {
    const id = this.#store && projectKeyOf(this.#store);
    if (id === undefined || this.#pixelsPerSecond === 0) return;
    const view: RememberedView = {
      rowScale: this.#rowScale,
      pixelsPerSecond: this.#pixelsPerSecond,
      scrollX: this.#scrollX,
      scrollY: this.#scrollY,
      frame: this.#frame,
    };
    this.#memory.write(`timeline.${id}`, JSON.stringify(view));
  }

  /* The project. */

  #followSession(): void {
    const { store } = this.#session;
    if (store === this.#store) return;
    this.#remember();
    this.#stopStore?.();
    this.#cancelGesture();
    this.#store = store;
    this.#stopStore = store?.subscribe(() => this.#refresh());
    const remembered = store
      ? parseRemembered(this.#memory.read(`timeline.${projectKeyOf(store)}`))
      : undefined;
    this.#pixelsPerSecond = remembered?.pixelsPerSecond ?? 0;
    this.#rowScale = clamp(remembered?.rowScale ?? 1, MIN_ROW_SCALE, MAX_ROW_SCALE);
    this.#scrollX = remembered?.scrollX ?? 0;
    this.#scrollY = remembered?.scrollY ?? 0;
    this.#frame = remembered?.frame ?? 0;
    this.#snapshot = {
      ...this.#snapshot,
      selection: new Set(),
      transition: undefined,
      cut: new Set(),
    };
    this.#clipboard = [];
    this.#clipboardJoins = [];
    this.#beforeFit = undefined;
    this.pause();
    this.#refresh();
    if (this.#pixelsPerSecond === 0 && this.#width > 0) this.#fit();
    this.#clampScroll();
    this.#viewEmitter.emit();
  }

  #refresh(): void {
    const before = this.model;
    const model = this.#buildModel();
    // A frame number means another moment at another rate, and the moment is what counts.
    if (before && model && before.fps !== model.fps) {
      this.#frame = frameAt(frameSeconds(this.#frame, before.rate), model.rate);
    }
    const selection = new Set(this.#present(this.#snapshot.selection, model));
    const same = sameSet(selection, this.#snapshot.selection);
    const cut = new Set(this.#changeable(this.#snapshot.cut, model));
    const chosen = this.#snapshot.transition;
    // A transition that went, or whose clip went, is no longer something to look at.
    const there =
      chosen &&
      (isJoinChoice(chosen)
        ? model?.joins.has(chosen.join) === true
        : model?.boxes.get(chosen.clip)?.clip[chosen.edge] !== undefined);
    this.#snapshot = {
      ...this.#snapshot,
      model,
      selection: same ? this.#snapshot.selection : selection,
      transition: there ? chosen : undefined,
      cut: sameSet(cut, this.#snapshot.cut) ? this.#snapshot.cut : cut,
    };
    if (model) this.#frame = Math.min(this.#frame, frameAt(model.duration, model.rate));
    if (model && this.#gesture?.isStale?.(model)) this.#cancelGesture();
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  #buildModel(): TimelineModel | undefined {
    const state = this.#store?.getState();
    if (!state) return undefined;
    const id = state.manifest.timelines?.find((name) => state.timelines[name]);
    const timeline = id === undefined ? undefined : state.timelines[id];
    if (id === undefined || !timeline) return undefined;
    const fps = projectFrameRate(state.manifest);
    const current = this.model;
    const same =
      current?.id === id &&
      current.state === timeline &&
      current.assets === state.assets &&
      current.fps === fps &&
      current.rowScale === this.#rowScale &&
      current.roomBelow === this.#roomBelow;
    return same ? current : buildModel(id, timeline, fps, this.#rowScale, this.#roomBelow, state);
  }

  /**
   * Runs commands as one change. Failing is rare, because the interface checks first. Joins that
   * went because their clips got taken apart are something people should hear about.
   */
  #run(calls: readonly CommandCall[]): boolean {
    const store = this.#store;
    if (!store) return false;
    const result = store.executeBatch(calls);
    if (!result.ok) {
      this.#messages.commandFailed(result.error.message);
      return false;
    }
    const removed = result.results.flatMap((outcome) => {
      const joins = (outcome as { readonly joinsRemoved?: readonly string[] } | undefined)
        ?.joinsRemoved;
      return joins ?? [];
    });
    if (removed.length > 0) this.#messages.joinsRemoved?.(removed.length);
    return true;
  }

  /* Tools and the selection. */

  setTool(tool: Tool): void {
    if (tool === this.#snapshot.tool) return;
    this.#snapshot = { ...this.#snapshot, tool };
    this.#razorAt = undefined;
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  toggleSnapping(): void {
    this.#snapshot = { ...this.#snapshot, snapping: !this.#snapshot.snapping };
    this.#emitter.emit();
    this.#savePreferences();
  }

  toggleOverwriting(): void {
    this.#snapshot = { ...this.#snapshot, overwriting: !this.#snapshot.overwriting };
    this.#emitter.emit();
    this.#savePreferences();
  }

  toggleMultiSelecting(): void {
    const multiSelecting = !this.#snapshot.multiSelecting;
    this.#snapshot = { ...this.#snapshot, multiSelecting };
    this.#emitter.emit();
    this.#savePreferences();
  }

  /** While the divider is dragged. Saving waits for `saveHeaderWidth`. */
  setHeaderWidth(width: number): void {
    const headerWidth = clamp(Math.round(width), MIN_HEADER_WIDTH, MAX_HEADER_WIDTH);
    if (headerWidth === this.#snapshot.headerWidth) return;
    this.#snapshot = { ...this.#snapshot, headerWidth };
    this.#emitter.emit();
  }

  saveHeaderWidth(): void {
    this.#savePreferences();
  }

  #present(ids: Iterable<string>, model: TimelineModel | undefined): readonly string[] {
    return [...ids].filter((id) => model?.boxes.has(id) === true);
  }

  /**
   * Clips that are there, and not on a locked track. A locked clip can be selected to look at it,
   * so whatever changes clips goes by this and not by the selection as such.
   */
  #changeable(ids: Iterable<string>, model: TimelineModel | undefined): readonly string[] {
    return this.#present(ids, model).filter(
      (id) => model?.rowOfClip.get(id)?.track.locked !== true,
    );
  }

  /** Whether there is anything in the selection that can be deleted. A transition can be. */
  get canChangeSelection(): boolean {
    const { selection, transition } = this.#snapshot;
    if (isJoinChoice(transition)) {
      const join = this.model?.joins.get(transition.join);
      return join !== undefined && this.model?.state.tracks[join.join.track]?.locked !== true;
    }
    if (transition) return this.#changeable([transition.clip], this.model).length > 0;
    return this.#changeable(selection, this.model).length > 0;
  }

  /** Whether there are clips in the selection that can be cut. A transition goes with its clip. */
  get canCut(): boolean {
    return this.#changeable(this.#snapshot.selection, this.model).length > 0;
  }

  #select(wanted: ReadonlySet<string>): void {
    this.#setSelection(wanted);
    this.#chosen.emit();
  }

  #setSelection(wanted: ReadonlySet<string>): void {
    // A drag can hold on to a clip that is gone by now.
    const selection = new Set(this.#present(wanted, this.model));
    const { transition } = this.#snapshot;
    if (sameSet(selection, this.#snapshot.selection) && !transition) return;
    this.#snapshot = { ...this.#snapshot, selection, transition: undefined };
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  /**
   * Selects the transition at an edge of a clip, instead of clips: the properties tab shows what it
   * is then, and Delete takes it away. One on a locked track can be looked at too.
   */
  selectTransition(clip: string, edge: Edge): void {
    if (this.model?.boxes.get(clip)?.clip[edge] === undefined) return;
    const { transition, selection } = this.#snapshot;
    const same = transition && !isJoinChoice(transition) && transition.clip === clip;
    if (same && transition.edge === edge && selection.size === 0) return;
    this.#snapshot = { ...this.#snapshot, selection: new Set(), transition: { clip, edge } };
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  /** Selects a join, instead of clips, as `selectTransition` does for the edges of a clip. */
  selectJoin(join: string): void {
    if (!this.model?.joins.has(join)) return;
    const { transition, selection } = this.#snapshot;
    if (isJoinChoice(transition) && transition.join === join && selection.size === 0) return;
    this.#snapshot = { ...this.#snapshot, selection: new Set(), transition: { join } };
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  /**
   * Goes to something on the timeline, as from where a resource is used: selects it, moves the
   * playhead to its start and scrolls it into view. A transition or a join is selected instead of
   * its clip. Resolves to whether this timeline has it.
   */
  revealClip(clip: string, part?: { readonly edge?: Edge; readonly join?: string }): boolean {
    const model = this.model;
    const join = part?.join === undefined ? undefined : model?.joins.get(part.join);
    const box = model?.boxes.get(clip) ?? join?.from;
    if (!model || (!box && !join)) return false;
    if (join && part?.join !== undefined) this.selectJoin(part.join);
    else if (box && part?.edge !== undefined && box.clip[part.edge] !== undefined) {
      this.selectTransition(box.id, part.edge);
    } else if (box) this.selectOnly(box.id);
    const start = join ? join.start : (box?.start ?? 0);
    this.seek(frameAt(start, model.rate));
    const row = box && model.rowOfClip.get(box.id);
    if (row) {
      if (row.top < this.#scrollY) this.#scrollY = row.top;
      else if (row.top + row.height > this.#scrollY + this.#height) {
        this.#scrollY = row.top + row.height - this.#height;
      }
      this.#clampScroll();
      this.#viewChanged();
    }
    return true;
  }

  addToSelection(clip: string): void {
    this.#select(new Set([...this.#snapshot.selection, ...this.#withLinked(new Set([clip]))]));
  }

  selectOnly(clip: string): void {
    this.#select(this.#withLinked(new Set([clip])));
  }

  /** The clips of selected keys and what is linked to them, which keeps the keys selected. */
  selectClipsOfKeys(clips: Iterable<string>): void {
    this.#setSelection(this.#withLinked(new Set(clips)));
  }

  /** To do something with all of it, which is nothing for a locked clip. */
  selectAll(): void {
    const { model } = this;
    this.#select(new Set(this.#changeable(model?.boxes.keys() ?? [], model)));
  }

  clearSelection(): void {
    this.#select(new Set());
  }

  /* The playhead. */

  /** Starts over at the end of the timeline, like every player. */
  togglePlayback(): void {
    const { model } = this;
    if (!model) return;
    if (this.#snapshot.playing) {
      this.pause();
      return;
    }
    if (this.#frame >= frameAt(model.duration, model.rate)) this.seek(0);
    this.#playback = undefined;
    this.#setPlaying(true);
  }

  pause(): void {
    if (this.#snapshot.playing) this.#setPlaying(false);
  }

  #setPlaying(playing: boolean): void {
    this.#snapshot = { ...this.#snapshot, playing };
    this.#emitter.emit();
  }

  /** The time from whoever keeps the clock. Later that is the audio, for now it is the screen. */
  /** Where playing started from. A new one means the sound has to start over from there. */
  get playbackStart(): { readonly frame: number; readonly since: number } | undefined {
    return this.#playback;
  }

  tick(milliseconds: number): void {
    const { model } = this;
    if (!model || !this.#snapshot.playing) return;
    this.#playback ??= { frame: this.#frame, since: milliseconds };
    const { frame, since } = this.#playback;
    const next = frame + ((milliseconds - since) / 1000) * model.rate.fps;
    const last = frameAt(model.duration, model.rate);
    this.#seekTo(Math.min(next, last));
    if (next >= last) this.pause();
  }

  /** Moves the playhead, and playing carries on from there. */
  seek(frame: number): void {
    this.#playback = undefined;
    this.#seekTo(frame);
  }

  #seekTo(frame: number): void {
    const model = this.model;
    if (!model) return;
    const last = frameAt(this.visibleDuration, model.rate);
    const next = clamp(Math.round(frame), 0, Math.max(last, 0));
    if (next === this.#frame) return;
    this.#frame = next;
    this.#reveal(frameSeconds(next, model.rate));
    this.#viewChanged();
  }

  stepFrames(count: number): void {
    this.seek(this.#frame + count);
  }

  seekToStart(): void {
    this.seek(0);
  }

  seekToEnd(): void {
    const { model } = this;
    if (model) this.seek(frameAt(model.duration, model.rate));
  }

  /** Jumps to the next or the previous place where something starts or ends. */
  jumpToEdit(direction: 1 | -1): void {
    const { model } = this;
    if (!model) return;
    const frames = [0, frameAt(model.duration, model.rate)];
    for (const box of model.boxes.values()) {
      frames.push(frameAt(box.start, model.rate), frameAt(box.end, model.rate));
    }
    const candidates = frames.filter((frame) => (frame - this.#frame) * direction > 0);
    if (candidates.length === 0) return;
    this.seek(direction > 0 ? Math.min(...candidates) : Math.max(...candidates));
  }

  /* Changing the project. */

  deleteSelection(): void {
    const { model } = this;
    const { transition } = this.#snapshot;
    if (isJoinChoice(transition)) {
      this.removeJoin(transition.join);
      return;
    }
    if (transition) {
      this.setTransition(transition.clip, transition.edge, null);
      return;
    }
    const clips = this.#changeable(this.#snapshot.selection, model);
    if (!model || clips.length === 0) return;
    this.#run([{ type: "clip.remove", params: { timeline: model.id, clips } }]);
  }

  get hasClipboard(): boolean {
    return this.#clipboard.length > 0;
  }

  /** Taking a copy leaves a clip as it is, so a locked one can be part of it. */
  copySelection(): void {
    this.#copy(this.#snapshot.selection);
  }

  #copy(clips: Iterable<string>): void {
    const { model } = this;
    const boxes = [...clips].flatMap((id) => model?.boxes.get(id) ?? []);
    if (boxes.length === 0) return;
    this.#clipboard = boxes.map(({ clip }) => clip);
    this.#clipboardJoins = model
      ? joinsAmong(
          model,
          this.#clipboard.map(({ id }) => id),
        )
      : [];
    this.#setCut(new Set());
    this.#copied.emit();
  }

  /** Something else went on the clipboard: what was copied goes, and nothing waits to be moved. */
  forgetClipboard(): void {
    if (this.#clipboard.length === 0 && this.#snapshot.cut.size === 0) return;
    this.#clipboard = [];
    this.#clipboardJoins = [];
    this.#setCut(new Set());
  }

  /** Marks clips to go. They stay in their place until they are pasted, so this can be undone. */
  cutSelection(): void {
    const clips = new Set(this.#changeable(this.#snapshot.selection, this.model));
    if (clips.size === 0) return;
    this.#copy(clips);
    this.#setCut(clips);
  }

  /** Changes nothing when there is no cut, and says so. */
  cancelCut(): boolean {
    if (this.#snapshot.cut.size === 0) return false;
    this.#clipboard = [];
    this.#clipboardJoins = [];
    this.#setCut(new Set());
    return true;
  }

  #setCut(cut: ReadonlySet<string>): void {
    this.#snapshot = { ...this.#snapshot, cut };
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  /**
   * Puts copies at the playhead, as far apart as they were, and takes away what was cut, in one
   * step. They go on their own tracks where those can be used. What is there stays and the copies
   * go after it, unless people overwrite. The playhead stays: people are watching that place.
   */
  paste(): void {
    const { model } = this;
    const [first] = this.#clipboard.toSorted((a, b) => compare(clipStart(a), clipStart(b)));
    if (!model || !first) return;
    const { cut } = this.#snapshot;
    const copies = copiesOf(this.#clipboard);
    const moment = frameTime(this.#frame, model.rate);
    const offset = subtract(moment, clipStart(first));
    const newTracks = new Map<string, string>();
    const rowFor = (clip: ClipState) =>
      model.rows.find(({ id, track, gone }) => id === clip.track && !track.locked && !gone) ??
      model.rows.find(
        ({ track, gone }) => track.kind === trackKindFor(clip) && !track.locked && !gone,
      );
    const placed = this.#clipboard.flatMap((clip): Placed[] => {
      const row = rowFor(clip);
      const start = toSeconds(add(clipStart(clip), offset));
      const end = toSeconds(add(clipEnd(clip), offset));
      const exactStart = () => add(clipStart(clip), offset);
      const exactEnd = () => add(clipEnd(clip), offset);
      return row ? [{ row, start, end, exactStart, exactEnd }] : [];
    });
    const { overwriting } = this.#snapshot;
    const shift = overwriting ? undefined : freeShift(placed, cut, 1);
    const moved = shift ? add(offset, shift.exact()) : offset;

    const trackCalls: CommandCall[] = [];
    const calls = this.#clipboard.map((clip, index) => {
      const kind = trackKindFor(clip);
      let track = rowFor(clip)?.id ?? newTracks.get(kind);
      if (!track) {
        track = newId("track");
        newTracks.set(kind, track);
        trackCalls.push({ type: "track.add", params: { timeline: model.id, id: track, kind } });
      }
      const copy: ClipCopy = copies[index] as ClipCopy;
      return {
        type: "clip.add",
        params: {
          timeline: model.id,
          track,
          clip: { ...copy, start: formatTime(add(clipStart(clip), moved)) },
          ...(overwriting ? { overlap: "overwrite" } : {}),
          ...(cut.has(clip.id) ? { movedFrom: clip.id } : {}),
        },
      };
    });
    const removal: CommandCall[] =
      cut.size > 0
        ? [{ type: "clip.remove", params: { timeline: model.id, clips: [...cut] } }]
        : [];
    // Joins between what was copied come along, which is how cutting and pasting moves them too.
    const originals = this.#clipboard.map(({ id }) => id);
    const joins = copiedJoins(model.id, this.#clipboardJoins, originals, copies);
    if (!this.#run([...removal, ...trackCalls, ...calls, ...joins])) return;
    this.#setCut(new Set());
    this.#select(new Set(copies.map(({ id }) => id)));
  }

  /** What a cut at the playhead would go through: only what people selected. */
  #clipsToSplit(model: TimelineModel): readonly ClipBox[] {
    const seconds = frameSeconds(this.#frame, model.rate);
    const moment = frameTime(this.#frame, model.rate);
    return model.rows.flatMap((row) => {
      const box = row.track.locked ? undefined : clipAt(row, seconds);
      const cuts = box && this.#snapshot.selection.has(box.id) && isInsideClip(box.clip, moment);
      return cuts ? [box] : [];
    });
  }

  get canSplit(): boolean {
    return this.model !== undefined && this.#clipsToSplit(this.model).length > 0;
  }

  splitAtPlayhead(): void {
    const { model } = this;
    if (!model) return;
    const links = new Set<string>();
    const at = formatTime(frameTime(this.#frame, model.rate));
    const calls = this.#clipsToSplit(model).flatMap((box) => {
      const { link } = box.clip;
      if (link !== undefined && links.has(link)) return [];
      if (link !== undefined) links.add(link);
      return [splitCall(model, box.clip, at)];
    });
    if (calls.length > 0) this.#run(calls);
  }

  /** Sets the end of the timeline, which cannot go in front of what is on it. */
  setEnd(frame: number): void {
    const { model } = this;
    const last = model && orderedSections(model.state).at(-1);
    if (!model || !last) return;
    const start = subtract(timelineLength(model.state), parseTime(last.duration));
    let end = frameTime(frame, model.rate);
    const floor = [add(start, frameTime(1, model.rate))];
    for (const { clip } of model.boxes.values()) floor.push(clipEnd(clip));
    for (const limit of floor) if (compare(limit, end) > 0) end = limit;
    const duration = formatTime(subtract(end, start));
    if (duration === last.duration) return;
    const params = { timeline: model.id, section: last.id, duration };
    this.#run([{ type: "section.update", params }]);
  }

  /**
   * Puts a file on the timeline: a video with sound as two linked clips, in one step, which end up
   * selected. Dropped at a place, what is there stays and the clips go after it, unless people
   * overwrite, on the track there or else on one that can take them. Without a place, as with a
   * click in the assets tab, they go right at the playhead, see `#freeRow`. Says where they went,
   * or nothing when they did not.
   */
  addAsset(assetId: string, place?: DropPlace): MediaAdded | undefined {
    return this.addMedia({ kind: "asset", id: assetId }, place);
  }

  /** Puts a scene on the timeline, at a place or else at the playhead, as `addAsset` does. */
  addScene(scene: string, place?: DropPlace): MediaAdded | undefined {
    return this.addMedia({ kind: "scene", id: scene }, place);
  }

  /** Puts a sound on the timeline, at a place or else at the playhead, as `addAsset` does. */
  addSound(sound: string, place?: DropPlace): MediaAdded | undefined {
    return this.addMedia({ kind: "sound", id: sound }, place);
  }

  /** Puts something of the project on the timeline, at a place or else at the playhead. */
  addMedia(pick: MediaPick, place?: DropPlace): MediaAdded | undefined {
    const { model } = this;
    const what = model && this.#mediaOf(model, pick, []);
    if (!model || !what) return undefined;
    return this.#putMedia(model, what, place ?? "free");
  }

  /** A new scene from the template, on the timeline right away, to see it move and to change it. */
  createScene(place?: DropPlace): MediaAdded | undefined {
    const { model } = this;
    const state = this.#store?.getState();
    if (!model || !state) return undefined;
    const number = Object.keys(state.scenes).length + 1;
    const name = this.#messages.sceneName?.(number) ?? `Scene ${number}`;
    const scene = newId("scene");
    const before = [{ type: "scene.add", params: { id: scene, ...sceneTemplate(name) } }];
    const what = this.#codeMedia(model, { kind: "scene", scene }, name, before);
    return this.#putMedia(model, what, place ?? "playhead");
  }

  /** A new sound from the template, on the timeline right away, to hear it and to change it. */
  createSound(place?: DropPlace): MediaAdded | undefined {
    const { model } = this;
    const state = this.#store?.getState();
    if (!model || !state) return undefined;
    const number = Object.keys(state.sounds).length + 1;
    const name = this.#messages.soundName?.(number) ?? `Sound ${number}`;
    const words = this.#messages.soundWords?.() ?? { duration: "Length", seed: "Seed" };
    const sound = newId("sound");
    const before = [{ type: "sound.add", params: { id: sound, ...soundTemplate(name, words) } }];
    const what = this.#codeMedia(model, { kind: "sound", sound }, name, before);
    return this.#putMedia(model, what, place ?? "playhead");
  }

  /**
   * Where a drop at a pointer goes: the place under it, and how close it snaps, which the preview
   * and the drop both go by, so that it lands where it showed.
   */
  dropPlaceAt(pointer: Pointer): DropPlace {
    return {
      lane: this.laneAt(pointer.y),
      seconds: this.timeAt(pointer.x),
      snap: this.#snapReach(pointer),
    };
  }

  #snapReach(pointer: Pointer): number {
    return this.#snapshot.snapping && !pointer.alt && this.#pixelsPerSecond > 0
      ? SNAP_REACH / this.#pixelsPerSecond
      : 0;
  }

  /** What putting something on the timeline makes: its clips, how long, and what comes first. */
  #mediaOf(model: TimelineModel, pick: MediaPick, before: readonly CommandCall[]) {
    const state = this.#store?.getState();
    if (!state) return undefined;
    if (pick.kind === "scene") {
      const known = state.scenes[pick.id];
      return known && this.#codeMedia(model, { kind: "scene", scene: pick.id }, known.name, before);
    }
    if (pick.kind === "sound") {
      const known = state.sounds[pick.id];
      return known && this.#codeMedia(model, { kind: "sound", sound: pick.id }, known.name, before);
    }
    const asset = state.assets?.[pick.id];
    if (!asset) return undefined;
    const known = asset.info?.duration;
    const frames = known ? Math.floor(toSeconds(parseTime(known)) * model.rate.fps) : 0;
    const duration = frames > 0 ? frameTime(frames, model.rate) : this.#newClipDuration(model);
    const media = { asset: pick.id };
    const parts: MediaPart[] = [
      ...(asset.kind === "audio"
        ? []
        : [{ kind: "video" as const, source: { kind: asset.kind, media } }]),
      ...(asset.kind === "audio" || asset.info?.hasAudio
        ? [{ kind: "audio" as const, source: { kind: "audio", media } }]
        : []),
    ];
    return { parts, duration, before, ...(asset.name === undefined ? {} : { name: asset.name }) };
  }

  #codeMedia(
    model: TimelineModel,
    source:
      | { readonly kind: "scene"; readonly scene: string }
      | { readonly kind: "sound"; readonly sound: string },
    name: string,
    before: readonly CommandCall[],
  ): MediaWhat {
    const sound =
      source.kind === "sound" ? this.#soundClip(model, source.sound, before) : undefined;
    const kind = source.kind === "sound" ? ("audio" as const) : ("video" as const);
    return {
      parts: [{ kind, source }],
      duration: sound?.duration ?? this.#newClipDuration(model),
      name,
      before,
      ...(sound?.properties && { properties: sound.properties }),
    };
  }

  /**
   * How long a clip with a sound is, and what it has to write down for that. A sound stays what it
   * is when the clip gets trimmed or cut, so its length cannot come from the clip, and this is the
   * last moment that it can be told.
   */
  #soundClip(
    model: TimelineModel,
    sound: string,
    before: readonly CommandCall[],
  ): { readonly duration: Rational; readonly properties?: Readonly<Record<string, number>> } {
    const added = before.flatMap(({ type, params }) =>
      type === "sound.add" ? [(params as { readonly sound: SoundManifest }).sound] : [],
    );
    const manifest = added[0] ?? this.#store?.getState().sounds[sound];
    const stated = manifest?.params?.find(({ id }) => id === "duration")?.default;
    if (typeof stated === "number" && stated > 0) {
      return { duration: frameTime(Math.max(Math.floor(stated * model.rate.fps), 1), model.rate) };
    }
    const duration = this.#newClipDuration(model);
    return { duration, properties: { "param.duration": toSeconds(duration) } };
  }

  /**
   * Where something would land. At a place: on the track there or else the first one of its kind
   * that can take it, snapped to what is near, and after what is there unless people overwrite.
   * "free" is right at the playhead, see `#freeRow`, and "playhead" there on the first track.
   * Without a track that can take a part, it goes on a new one.
   */
  #planMedia(model: TimelineModel, what: MediaWhat, where: MediaWhere): MediaPlan {
    const { rate } = model;
    const dropped = typeof where === "object" ? where : undefined;
    const free = where === "free";
    const seconds = Math.max(dropped?.seconds ?? frameSeconds(this.#frame, rate), 0);
    let start = frameTime(frameAt(seconds, rate), rate);
    let line: number | undefined;
    const within = dropped?.snap ?? 0;
    if (within > 0) {
      const points = snapPointsOf(model, this.#frame, new Set());
      const length = toSeconds(what.duration);
      const byStart = points.nearest(seconds, within);
      const byEnd = points.nearest(seconds + length, within);
      const startGap = byStart ? Math.abs(byStart.seconds - seconds) : Number.POSITIVE_INFINITY;
      const endGap = byEnd ? Math.abs(byEnd.seconds - seconds - length) : Number.POSITIVE_INFINITY;
      if (byEnd && endGap < startGap && compare(byEnd.exact(), what.duration) >= 0) {
        start = subtract(byEnd.exact(), what.duration);
        line = byEnd.seconds;
      } else if (byStart) {
        start = byStart.exact();
        line = byStart.seconds;
      }
    }
    const end = add(start, what.duration);
    const parts = what.parts.map((part) => ({
      ...part,
      row: free
        ? this.#freeRow(model, part.kind, start, end)
        : this.#rowForNew(model, part.kind, dropped?.lane),
    }));
    const placed = parts.flatMap(({ row }): Placed[] =>
      row
        ? [
            {
              row,
              start: toSeconds(start),
              end: toSeconds(end),
              exactStart: () => start,
              exactEnd: () => end,
            },
          ]
        : [],
    );
    // Right at the playhead the rows are free where it goes, and nothing gets overwritten.
    const overwriting = !free && this.#snapshot.overwriting;
    const shift = overwriting || free ? undefined : freeShift(placed, new Set(), 1);
    const at = shift ? add(start, shift.exact()) : start;
    if (shift && shift.seconds > 0) line = shift.contact;
    return {
      parts,
      at,
      duration: what.duration,
      overwriting,
      ...(line === undefined ? {} : { line }),
    };
  }

  /** Puts it where `#planMedia` says, in one step, selects what it made and says where it went. */
  #putMedia(model: TimelineModel, what: MediaWhat, where: MediaWhere): MediaAdded | undefined {
    const plan = this.#planMedia(model, what, where);
    const link = plan.parts.length > 1 ? { link: newId("link") } : {};
    const trackCalls: CommandCall[] = [];
    const ids: string[] = [];
    const tracks: MediaAdded["tracks"][number][] = [];
    const calls = plan.parts.map(({ kind, source, row }): CommandCall => {
      let track = row?.id;
      if (!track) {
        track = newId("track");
        trackCalls.push({ type: "track.add", params: { timeline: model.id, id: track, kind } });
      }
      tracks.push(row ? { kind, number: row.number, ...nameOf(row) } : newTrackOf(model, kind));
      const id = newId("clip");
      ids.push(id);
      return {
        type: "clip.add",
        params: {
          timeline: model.id,
          track,
          clip: {
            id,
            ...(what.name === undefined ? {} : { name: what.name }),
            start: formatTime(plan.at),
            duration: formatTime(plan.duration),
            source,
            ...(what.properties && { properties: what.properties }),
            ...link,
          },
          ...(plan.overwriting ? { overlap: "overwrite" } : {}),
        },
      };
    });
    if (!this.#run([...what.before, ...trackCalls, ...calls])) return undefined;
    this.#select(new Set(ids));
    const from = toSeconds(plan.at);
    const to = toSeconds(add(plan.at, plan.duration));
    this.#bringIntoView(from, to, ids);
    this.flash({ clips: new Set(ids) });
    return { clips: ids, tracks, start: from, frame: frameAt(from, model.rate) };
  }

  /**
   * Where something dragged from elsewhere would go, or nothing when it left again. Knowing what it
   * is, the clips it would make show where they would land: on which track or a new one, as long as
   * they are, snapped, with what they would overwrite. Files from the computer show the moment.
   */
  showDrop(pointer: Pointer | undefined, pick?: MediaPick): void {
    const { model } = this;
    if (!model) return;
    const what = pointer && pick ? this.#mediaOf(model, pick, []) : undefined;
    if (pointer && what) {
      const plan = this.#planMedia(model, what, this.dropPlaceAt(pointer));
      const from = toSeconds(plan.at);
      const to = toSeconds(add(plan.at, plan.duration));
      const covered: CoveredSpan[] = [];
      const adding = plan.parts.map(({ kind, row }) => {
        if (row && plan.overwriting) {
          forEachBetween(row, from, to, (other) => {
            const left = Math.max(from, other.start);
            const right = Math.min(to, other.end);
            if (right > left) covered.push({ row, from: left, to: right });
          });
        }
        return { kind, row: row?.id, start: from, end: to, label: what.name ?? "" };
      });
      this.#preview = {
        adding,
        covered,
        ...(plan.line === undefined ? {} : { snap: plan.line }),
      };
      this.#viewEmitter.emit();
      return;
    }
    const seconds =
      pointer && frameSeconds(frameAt(this.timeAt(pointer.x), model.rate), model.rate);
    this.#preview = seconds === undefined ? undefined : { snap: Math.max(seconds, 0) };
    this.#viewEmitter.emit();
  }

  /**
   * Scrolls so that what was just added is in the middle, when it is not in sight already: across
   * by its time, and down to its first track. The playhead stays where it is.
   */
  #bringIntoView(from: number, to: number, clips: readonly string[]): void {
    const model = this.model;
    if (!model || this.#width === 0 || this.#pixelsPerSecond === 0) return;
    let x = this.#scrollX;
    let y = this.#scrollY;
    const left = this.xAt(from);
    const right = this.xAt(to);
    if (right < 0 || left > this.#width)
      x = ((from + to) / 2) * this.#pixelsPerSecond - this.#width / 2;
    const rows = clips.flatMap((id) => {
      const row = model.rowOfClip.get(id);
      return row ? [row] : [];
    });
    const first = rows[0];
    if (first) {
      const visible = this.#height - RULER_HEIGHT;
      const top = first.top - this.#scrollY;
      const bottom = top + first.height;
      if (bottom <= 0 || top >= visible) y = first.top + first.height / 2 - visible / 2;
    }
    this.setScroll(x, y);
  }

  /**
   * Where something goes that people add with a click, right at the playhead: the track of a
   * selected clip of the same kind, else the first track of the kind, as long as nothing is in the
   * way there. Undefined when none is free, for a new track. Locked tracks are left alone.
   */
  #freeRow(model: TimelineModel, kind: string, start: Rational, end: Rational): Row | undefined {
    const usable = (row: Row) => row.track.kind === kind && !row.track.locked && !row.gone;
    const from = toSeconds(start);
    const to = toSeconds(end);
    // Floats find what may be in the way, the exact times say whether it is.
    const free = (row: Row) => {
      let clash = false;
      forEachBetween(row, from - 1e-6, to + 1e-6, ({ clip }) => {
        if (compare(clipStart(clip), end) < 0 && compare(clipEnd(clip), start) > 0) clash = true;
      });
      return !clash;
    };
    const tracks = new Set<string>();
    for (const id of this.#snapshot.selection) {
      const track = model.boxes.get(id)?.clip.track;
      if (track !== undefined) tracks.add(track);
    }
    const selected = model.rows.filter((row) => tracks.has(row.id) && usable(row));
    const rest = model.rows.filter(usable).toSorted((a, b) => a.number - b.number);
    return [...selected, ...rest].find(free);
  }

  /** The row at a height when it fits, or else the first one that does. */
  #rowForNew(model: TimelineModel, kind: string, lane: number | undefined): Row | undefined {
    const usable = (row: Row | undefined): row is Row =>
      row !== undefined && row.track.kind === kind && !row.track.locked && !row.gone;
    const pointed = lane === undefined ? undefined : rowAt(model, lane);
    if (usable(pointed)) return pointed;
    return model.rows.filter(usable).toSorted((a, b) => a.number - b.number)[0];
  }

  /** Tracks of a kind that can change places, top to bottom. */
  #sortableRows(model: TimelineModel, kind: string): readonly Row[] {
    return model.rows.filter(({ track, gone }) => track.kind === kind && !gone);
  }

  /** Where a track would land at a height in the rows, and where to show that. */
  trackDrop(track: string, lane: number): { readonly index: number; readonly line: number } {
    const { model } = this;
    const row = model?.rows.find(({ id }) => id === track);
    if (!model || !row) return { index: 0, line: 0 };
    const rows = this.#sortableRows(model, row.track.kind);
    const others = rows.filter(({ id }) => id !== track);
    const index = others.filter(({ top, height }) => top + height / 2 < lane).length;
    const next = others[index];
    const before = others[index - 1];
    const line = next ? next.top : before ? before.top + before.height : row.top;
    return { index, line };
  }

  /** Moves a track among those of its kind. `index` counts from the top, without the track. */
  moveTrack(track: string, index: number): void {
    const { model } = this;
    const row = model?.rows.find(({ id }) => id === track);
    if (!model || !row) return;
    const rows = this.#sortableRows(model, row.track.kind);
    if (rows.indexOf(row) === index) return;
    const others = rows.filter(({ id }) => id !== track);
    // The first track is at the back of the picture, so tracks that show upwards count backwards.
    const upwards = row.track.kind !== "audio";
    const inProject = upwards ? others.toReversed() : others;
    const next = inProject[upwards ? others.length - index : index];
    const params = { timeline: model.id, track, ...(next ? { before: next.id } : {}) };
    this.#run([{ type: "track.move", params }]);
  }

  /** Moves a track up or down one place. */
  shiftTrack(track: string, by: 1 | -1): void {
    const { model } = this;
    const row = model?.rows.find(({ id }) => id === track);
    if (!model || !row) return;
    const rows = this.#sortableRows(model, row.track.kind);
    const index = rows.indexOf(row) + by;
    if (index >= 0 && index < rows.length) this.moveTrack(track, index);
  }

  addTrack(kind: "video" | "audio" | "caption"): void {
    const { model } = this;
    if (model) this.#run([{ type: "track.add", params: { timeline: model.id, kind } }]);
  }

  /** A locked track stays, with what is on it, until people take the lock off. */
  removeTrack(track: string): void {
    const { model } = this;
    if (!model || model.state.tracks[track]?.locked === true) return;
    this.#run([{ type: "track.remove", params: { timeline: model.id, track } }]);
  }

  updateTrack(track: string, changes: Readonly<Record<string, unknown>>): void {
    const { model } = this;
    if (model)
      this.#run([{ type: "track.update", params: { timeline: model.id, track, changes } }]);
  }

  /**
   * Adds a colour where it fits without taking anything away: at the given place, or else at the
   * playhead on the first track with room. The playhead moves past it, so that the next one
   * follows on.
   */
  addColorClip(place?: { readonly row: Row; readonly seconds: number }): void {
    const { model } = this;
    if (!model) return;
    const { rate } = model;
    const seconds = place?.seconds ?? frameSeconds(this.#frame, rate);
    const start = frameTime(frameAt(seconds, rate), rate);
    const rows = place ? [place.row] : this.#videoRowsFirstToLast(model);
    const row = rows.find((candidate) => this.#roomAt(candidate, start, model) !== undefined);
    if (place && !row) return;

    const id = newId("clip");
    const track = row?.id ?? newId("track");
    const duration = (row && this.#roomAt(row, start, model)) ?? this.#newClipDuration(model);
    const color = NEW_CLIP_COLORS[model.boxes.size % NEW_CLIP_COLORS.length] as string;
    const added = this.#run([
      ...(row
        ? []
        : [{ type: "track.add", params: { timeline: model.id, id: track, kind: "video" } }]),
      {
        type: "clip.add",
        params: {
          timeline: model.id,
          track,
          clip: {
            id,
            start: formatTime(start),
            duration: formatTime(duration),
            source: { kind: "color", color },
          },
        },
      },
    ]);
    if (!added) return;
    this.#select(new Set([id]));
    this.seek(frameAt(toSeconds(add(start, duration)), rate));
  }

  #videoRowsFirstToLast(model: TimelineModel): readonly Row[] {
    return model.rows
      .filter(({ track, gone }) => track.kind === "video" && !track.locked && !gone)
      .toSorted((a, b) => a.number - b.number);
  }

  /** A whole number of frames, so that the next clip starts on a frame too. */
  #newClipDuration({ rate }: TimelineModel): Rational {
    return frameTime(frameAt(NEW_CLIP_SECONDS, rate), rate);
  }

  /** How long a new clip can be from a moment on, or undefined when the place is taken. */
  #roomAt(row: Row, start: Rational, model: TimelineModel): Rational | undefined {
    if (row.track.locked) return undefined;
    const wanted = this.#newClipDuration(model);
    // Exact from here on: a float can put the end of a clip just after where the next one starts.
    let index = firstEndingAfter(row, toSeconds(start));
    while (row.clips[index] && compare(clipEnd((row.clips[index] as ClipBox).clip), start) <= 0) {
      index += 1;
    }
    const next = row.clips[index];
    if (!next) return wanted;
    const room = subtract(clipStart(next.clip), start);
    if (toSeconds(room) * model.rate.fps < 0.5) return undefined;
    return compare(room, wanted) < 0 ? room : wanted;
  }

  /** The clips on screen with where they are, up to a limit: this is for reading, not drawing. */
  visibleClips(limit: number): readonly VisibleClip[] {
    const { model } = this;
    if (!model) return [];
    const from = this.timeAt(0);
    const to = this.timeAt(this.#width);
    const found: VisibleClip[] = [];
    for (const row of model.rows) {
      const top = RULER_HEIGHT - this.#scrollY + row.top;
      if (top + row.height <= RULER_HEIGHT || top >= this.#height) continue;
      forEachBetween(row, from, to, (box) => {
        if (found.length >= limit) return;
        const left = Math.max(this.xAt(box.start), 0);
        const right = Math.min(this.xAt(box.end), this.#width);
        found.push({ box, row, left, top, width: right - left, height: row.height });
      });
    }
    return found;
  }

  /* The mouse. */

  hitAt({ x, y }: Pointer): Hit {
    const { model } = this;
    if (!model) return { kind: "empty" };
    if (y < RULER_HEIGHT) {
      const onEnd = Math.abs(x - this.xAt(this.visibleDuration)) <= END_HANDLE_REACH;
      return onEnd ? { kind: "end" } : { kind: "ruler" };
    }
    const row = rowAt(model, this.laneAt(y));
    if (!row) return { kind: "empty" };
    const seconds = this.timeAt(x);
    const inBand = this.laneAt(y) - row.top < TRANSITION_BAND;
    const join = inBand && this.#snapshot.tool === "select" ? this.#joinAt(row, x) : undefined;
    if (join) return join;
    const box = clipAt(row, seconds);
    if (!box) return { kind: "lane", row, seconds };
    const reach = Math.min(this.#edgeReach, ((box.end - box.start) * this.#pixelsPerSecond) / 3);
    const fromStart = x - this.xAt(box.start);
    const fromEnd = this.xAt(box.end) - x;
    if (this.#onExpander(box, row, x, y)) return { kind: "clip", row, box, expander: true };
    const block = inBand ? this.#transitionAt(box, x) : undefined;
    if (row.track.locked || this.#snapshot.tool !== "select") {
      // A transition can be looked at wherever it is, also on a locked track.
      const look = this.#snapshot.tool === "select" ? block : undefined;
      return look ? { kind: "clip", row, box, transition: look } : { kind: "clip", row, box };
    }
    const handle =
      this.laneAt(y) - row.top < HANDLE_REACH ? this.#handleAt(box, row, x) : undefined;
    if (handle) return { kind: "clip", row, box, handle };
    if (fromStart <= reach) return { kind: "clip", row, box, edge: "start" };
    if (fromEnd <= reach) return { kind: "clip", row, box, edge: "end" };
    if (block) return { kind: "clip", row, box, transition: block };
    return { kind: "clip", row, box };
  }

  /**
   * Which handle of a transition is under the pointer: they are at the top of a clip, where each
   * transition ends. An edge without one has none: transitions come from the transitions tab. Over
   * the trim edges, which still have the rest of the height.
   */
  #handleAt(box: ClipBox, row: Row, x: number): Edge | undefined {
    if (!canHaveTransitions(row.track)) return undefined;
    const edges = edgesOf(box.clip);
    const reach = this.#edgeReach;
    // Only an edge with a transition has one. Where a join is, its own edges are what change it.
    const none = (edge: Edge) =>
      edges[edge] <= 0 || this.model?.joined.has(`${box.id} ${edge}`) === true;
    const fromEnter = none("enter") ? Infinity : Math.abs(x - this.xAt(box.start + edges.enter));
    const fromExit = none("exit") ? Infinity : Math.abs(x - this.xAt(box.end - edges.exit));
    if (fromEnter > reach && fromExit > reach) return undefined;
    return fromEnter <= fromExit ? "enter" : "exit";
  }

  /**
   * The join under the pointer, at the top of the clips of a row, and which of its edges when it is
   * on one that can be dragged: in the middle of its cut both can, otherwise the one away from it.
   */
  #joinAt(row: Row, x: number): Extract<Hit, { kind: "join" }> | undefined {
    const join = joinAt(row, this.timeAt(x));
    if (!join) return undefined;
    const align = join.join.transition.align ?? "center";
    const reach = this.#edgeReach;
    const near = (seconds: number) => Math.abs(x - this.xAt(seconds)) <= reach;
    const changeable = !row.track.locked && join.trouble === undefined;
    if (changeable && align !== "after" && near(join.start))
      return { kind: "join", row, join, edge: "start" };
    if (changeable && align !== "before" && near(join.end))
      return { kind: "join", row, join, edge: "end" };
    return { kind: "join", row, join };
  }

  /** Which block of a transition is under the pointer, at the top of a clip. */
  #transitionAt(box: ClipBox, x: number): Edge | undefined {
    const seconds = this.timeAt(x);
    const edges = edgesOf(box.clip);
    // The one at the end is drawn over the one at the start, where they overlap.
    if (edges.exit > 0 && seconds >= box.end - edges.exit) return "exit";
    if (edges.enter > 0 && seconds <= box.start + edges.enter) return "enter";
    return undefined;
  }

  /** Whether clips of a row show the handles of their transitions: only where they can be dragged. */
  showsTransitionHandles(row: Row): boolean {
    const { track } = row;
    return canHaveTransitions(track) && track.locked !== true && this.#snapshot.tool === "select";
  }

  /**
   * Says how long the transition at an edge of a clip is, in one step, as the handles on the
   * timeline do: a new one is a fade. It goes as far as the transition at the other edge lets it.
   * Says whether anything changed.
   */
  setTransitionLength(clip: string, edge: Edge, length: Rational): boolean {
    const { model } = this;
    const [id] = this.#changeable([clip], model);
    const box = id === undefined ? undefined : model?.boxes.get(id);
    if (!model || !box) return false;
    const call = transitionCall(model.id, box.clip, edge, length, model);
    return call !== undefined && this.#run([call]);
  }

  /** Puts a transition at an edge of a clip, or takes it away with null, in one step. */
  setTransition(clip: string, edge: Edge, transition: Transition | null): boolean {
    const { model } = this;
    const [id] = this.#changeable([clip], model);
    if (!model || id === undefined) return false;
    const params = { timeline: model.id, clip: id, [edge]: transition };
    return this.#run([{ type: "clip.setTransition", params }]);
  }

  /* Transitions from the transitions tab, see docs/design/resource-panels.md, section 3. */

  /** Where a transition dragged here would go, or nothing where it cannot go. */
  transitionDropAt(pointer: Pointer, pick: TransitionPick): TransitionDrop | undefined {
    const { model } = this;
    if (!model || pointer.y < RULER_HEIGHT || this.#pixelsPerSecond <= 0) return undefined;
    const row = rowAt(model, this.laneAt(pointer.y));
    const reach = SEAM_REACH / this.#pixelsPerSecond;
    return transitionDropAt(model, row, this.timeAt(pointer.x), reach, pick);
  }

  /**
   * Shows where a transition dragged here would go, or nothing with no pointer. Says whether it can
   * go there: where it cannot, nothing shows.
   */
  showTransitionDrop(pointer: Pointer | undefined, pick?: TransitionPick): boolean {
    const drop = pointer && pick ? this.transitionDropAt(pointer, pick) : undefined;
    const next = drop && { row: drop.row.id, start: drop.start, end: drop.end };
    const was = this.#preview?.transitionDrop;
    const same =
      was === next ||
      (was !== undefined &&
        next !== undefined &&
        was.row === next.row &&
        was.start === next.start &&
        was.end === next.end);
    if (!same) {
      this.#preview = next && { transitionDrop: next };
      this.#viewEmitter.emit();
    }
    return drop !== undefined;
  }

  /** Puts a transition where it was dropped, in one step, and selects it. */
  dropTransition(pointer: Pointer, pick: TransitionPick): boolean {
    const { model } = this;
    const drop = model && this.transitionDropAt(pointer, pick);
    this.showTransitionDrop(undefined);
    const made = model && drop && dropCalls(model, drop, pick);
    if (!made || !this.#run(made.calls)) return false;
    this.#transitionsLit(made.calls);
    const { chosen } = made;
    if ("join" in chosen) this.selectJoin(chosen.join);
    else this.selectTransition(chosen.clip, chosen.edge);
    return true;
  }

  /** What a click on a transition in the tab is about, from what is selected. */
  get attachContext(): AttachContext {
    const { model, selection, transition } = this.#snapshot;
    const known = this.#attachContext;
    const same =
      known !== undefined &&
      known.model === model &&
      known.selection === selection &&
      known.transition === transition;
    if (same) return known.context;
    const context = attachContext(model, selection, transition);
    this.#attachContext = { model, selection, transition, context };
    return context;
  }

  /**
   * Why a click on a transition for a use would do nothing with what is selected, as a key of the
   * texts, or nothing when it would do something.
   */
  attachProblem(use: TransitionUse, pick: TransitionPick) {
    return attachProblem(this.model, this.attachContext, use, pick);
  }

  /**
   * What a click on a transition does, in one step: what is selected becomes it, the clips selected
   * get it at their start or their end, and pairs of them that touch get it between them. Says
   * whether anything changed.
   */
  attachTransition(pick: TransitionPick, use: TransitionUse): TransitionsAttached | undefined {
    const { model } = this;
    if (!model) return undefined;
    const replaced = this.attachContext.kind === "edge" || this.attachContext.kind === "join";
    const calls = attachCalls(model, this.attachContext, use, pick);
    if (calls.length === 0 || !this.#run(calls)) return undefined;
    const targets = this.#transitionsLit(calls);
    return { edges: targets.edges.size, joins: targets.joins.size, replaced };
  }

  /**
   * Lights up the transitions that some commands put on, and brings the first into view when none
   * of them can be seen.
   */
  #transitionsLit(calls: readonly CommandCall[]) {
    const edges = new Set<string>();
    const joins = new Set<string>();
    for (const { type, params } of calls) {
      const values = params as Readonly<Record<string, unknown>>;
      if (type === "clip.setTransition") {
        for (const edge of EDGES)
          if (edge in values) edges.add(`${String(values["clip"])}:${edge}`);
      } else if (type === "join.add") {
        joins.add(String(values["id"]));
      } else if (type === "join.update") {
        joins.add(String(values["join"]));
      }
    }
    this.flash({ edges, joins });
    const model = this.model;
    const spans = [
      ...[...edges].flatMap((key) => {
        const [clip = "", edge] = key.split(":");
        const box = model?.boxes.get(clip);
        if (!box) return [];
        const seconds = edgesOf(box.clip)[edge as Edge];
        const span: [number, number] =
          edge === "enter" ? [box.start, box.start + seconds] : [box.end - seconds, box.end];
        return [{ clip, span }];
      }),
      ...[...joins].flatMap((id) => {
        const join = model?.joins.get(id);
        return join
          ? [{ clip: join.from.id, span: [join.start, join.end] as [number, number] }]
          : [];
      }),
    ];
    const seen = spans.some(({ clip, span: [from, to] }) => this.#inSight(from, to, clip));
    const first = spans[0];
    if (!seen && first) this.#bringIntoView(...first.span, [first.clip]);
    return { edges, joins };
  }

  /* Effects from the effects tab, see docs/design/resource-panels.md, section 4. */

  /** The clip that an effect dragged here would go on, or nothing where none can take it. */
  effectDropAt(pointer: Pointer): ClipBox | undefined {
    const { model } = this;
    if (!model || pointer.y < RULER_HEIGHT || this.#pixelsPerSecond <= 0) return undefined;
    return effectDropAt(rowAt(model, this.laneAt(pointer.y)), this.timeAt(pointer.x))?.box;
  }

  /**
   * Lights up the clip that an effect dragged here would go on, or nothing with no pointer. Says
   * whether it can go there.
   */
  showEffectDrop(pointer: Pointer | undefined): boolean {
    const { model } = this;
    const box = pointer ? this.effectDropAt(pointer) : undefined;
    const row = box && model?.rowOfClip.get(box.id);
    const next = box && row && { row: row.id, start: box.start, end: box.end };
    const was = this.#preview?.transitionDrop;
    const same =
      was === next ||
      (was !== undefined &&
        next !== undefined &&
        was.row === next.row &&
        was.start === next.start &&
        was.end === next.end);
    if (!same) {
      this.#preview = next && { transitionDrop: next };
      this.#viewEmitter.emit();
    }
    return next !== undefined;
  }

  /** Puts an effect last on the clip it was dropped on, in one step, and selects that clip. */
  dropEffect(pointer: Pointer, type: string): boolean {
    const { model } = this;
    const box = model && this.effectDropAt(pointer);
    this.showEffectDrop(undefined);
    if (!model || !box) return false;
    const { calls, added } = effectCalls(model, [box], type);
    if (!this.#run(calls)) return false;
    this.#setSelection(new Set([box.id]));
    this.#effectsAdded(added);
    return true;
  }

  /**
   * Says where effects just went, by clip: the clips light up for a moment, and the list of their
   * effects goes to the new one. See `lastAdded`.
   */
  #effectsAdded(added: ReadonlyMap<string, string>): void {
    this.#added = { effects: added, at: (this.#added?.at ?? 0) + 1, time: Date.now() };
    this.#addedEmitter.emit();
    this.flash({ bands: new Set(added.keys()) });
    this.#showClips([...added.keys()]);
  }

  /** Brings the first of some clips into view, when none of them can be seen. */
  #showClips(clips: readonly string[]): void {
    const boxes = clips.flatMap((id) => {
      const box = this.model?.boxes.get(id);
      return box ? [box] : [];
    });
    if (boxes.some((box) => this.#inSight(box.start, box.end, box.id))) return;
    const first = boxes[0];
    if (first) this.#bringIntoView(first.start, first.end, [first.id]);
  }

  /** Whether some of a time on the track of a clip can be seen. */
  #inSight(from: number, to: number, clip: string): boolean {
    const row = this.model?.rowOfClip.get(clip);
    if (!row) return false;
    const top = row.top - this.#scrollY;
    const across = this.xAt(to) > 0 && this.xAt(from) < this.#width;
    return across && top + row.height > 0 && top < this.#height - RULER_HEIGHT;
  }

  /** Effects that clicks or drops put on clips last, by clip, and a number that tells two apart. */
  get lastAdded(): AddedEffects | undefined {
    return this.#added;
  }

  subscribeAdded = this.#addedEmitter.subscribe;

  /**
   * Lights up clips for a moment, going from bright to nothing over `FLASH_MS`: something just
   * happened to them. See `flashOf`.
   */
  flash(targets: FlashTargets): void {
    clearTimeout(this.#flashTimer);
    const began = Date.now();
    this.#flash = { targets, share: 1 };
    const step = () => {
      const share = 1 - (Date.now() - began) / FLASH_MS;
      this.#flash = share > 0 ? { targets, share } : undefined;
      this.#viewEmitter.emit();
      if (share > 0) this.#flashTimer = setTimeout(step, FLASH_STEP_MS);
    };
    this.#viewEmitter.emit();
    this.#flashTimer = setTimeout(step, FLASH_STEP_MS);
  }

  /**
   * How bright something is lit up now, from 1 down to 0 for not at all: a whole clip, the
   * transition at an edge of it, a join, or the band of effects of a clip.
   */
  flashOf(what: keyof FlashTargets, id: string): number {
    const flash = this.#flash;
    return flash?.targets[what]?.has(id) ? flash.share : 0;
  }

  /** Whether something of a clip is lit up now: all of it, its band, or a transition at an edge. */
  flashesOn(clip: string): boolean {
    const targets = this.#flash?.targets;
    if (!targets) return false;
    const { clips, bands, edges } = targets;
    return (
      clips?.has(clip) === true ||
      bands?.has(clip) === true ||
      EDGES.some((edge) => edges?.has(`${clip}:${edge}`) === true)
    );
  }

  /** What a click on an effect in the tab is about: the clips selected. */
  get effectContext(): EffectContext {
    const { model, selection } = this.#snapshot;
    const known = this.#effectContext;
    if (known && known.model === model && known.selection === selection) return known.context;
    const context = effectContext(model, selection);
    this.#effectContext = { model, selection, context };
    return context;
  }

  /** Why a click on an effect would do nothing with what is selected, or nothing when it would. */
  effectProblem(type: string) {
    return effectProblem(this.effectContext, type);
  }

  /**
   * Puts an effect last on every clip selected that can take one, in one step: also where it is
   * already, as one more. Says how many clips got it.
   */
  attachEffect(type: string): number {
    const { model } = this;
    const context = this.effectContext;
    if (!model || effectProblem(context, type) !== undefined) return 0;
    const { calls, added } = effectCalls(model, context.boxes, type);
    if (!this.#run(calls)) return 0;
    this.#effectsAdded(added);
    return added.size;
  }

  /**
   * Changes when an effect of a clip works, in one step: seconds from the start of the clip, where
   * undefined is the start or the end of the clip, as long as it is.
   */
  setEffectRange(
    clip: string,
    effect: string,
    start: Rational | undefined,
    end: Rational | undefined,
  ): boolean {
    const { model } = this;
    if (!model || !this.canChangeEffects(clip)) return false;
    const box = model.boxes.get(clip);
    const current = box && effectsOf(box.clip).find(({ id }) => id === effect);
    if (!current) return false;
    const next = {
      start: start === undefined ? undefined : formatTime(start),
      end: end === undefined ? undefined : formatTime(end),
    };
    if (next.start === current.start && next.end === current.end) return false;
    const params = {
      timeline: model.id,
      clip,
      effect,
      start: next.start ?? null,
      end: next.end ?? null,
    };
    return this.#run([{ type: "effect.update", params }]);
  }

  /** Whether the effects of a clip can change: it is there, and its track is not locked. */
  canChangeEffects(clip: string): boolean {
    return this.#changeable([clip], this.model).length > 0;
  }

  /** Takes an effect off a clip, with what it took, in one step. */
  removeEffect(clip: string, effect: string): boolean {
    const { model } = this;
    if (!model || !this.canChangeEffects(clip)) return false;
    const params = { timeline: model.id, clip, effects: [effect] };
    return this.#run([{ type: "effect.remove", params }]);
  }

  /** Moves an effect of a clip to a place in its list, counted without it, in one step. */
  moveEffect(clip: string, effect: string, index: number): boolean {
    const { model } = this;
    if (!model || !this.canChangeEffects(clip)) return false;
    const params = { timeline: model.id, clip, effect, index: Math.max(index, 0) };
    return this.#run([{ type: "effect.move", params }]);
  }

  /** Turns an effect of a clip on or off, in one step. */
  setEffectEnabled(clip: string, effect: string, enabled: boolean): boolean {
    const { model } = this;
    if (!model || !this.canChangeEffects(clip)) return false;
    const params = { timeline: model.id, clip, effect, enabled };
    return this.#run([{ type: "effect.update", params }]);
  }

  /** Changes a join in one step, see `join.update`. */
  updateJoin(join: string, changes: Readonly<Record<string, unknown>>): boolean {
    const { model } = this;
    if (!model) return false;
    return this.#run([{ type: "join.update", params: { timeline: model.id, join, changes } }]);
  }

  /** Takes a join away, in one step. */
  removeJoin(join: string): boolean {
    const { model } = this;
    if (!model) return false;
    return this.#run([{ type: "join.remove", params: { timeline: model.id, joins: [join] } }]);
  }

  /** How long a join can be where it is around its cut, see `longestJoin`. */
  longestJoin(join: JoinBox, align = join.join.transition.align): Rational {
    const { model } = this;
    return model ? longestJoin(model.ends, join.from.clip, join.to.clip, align) : ZERO;
  }

  /** Whether a clip shows the button for what is under its track. */
  showsExpander(box: ClipBox): boolean {
    const extras = this.#extras;
    if (!extras?.canOpen(box) || this.#snapshot.tool !== "select") return false;
    return this.#snapshot.selection.has(box.id) || extras.isOpen(box);
  }

  /** Where the button of a clip on screen is. */
  expanderAt(left: number, width: number): number | undefined {
    return expanderBox(left, width, this.#edgeReach);
  }

  #onExpander(box: ClipBox, row: Row, x: number, y: number): boolean {
    const left = this.xAt(box.start);
    const at = this.expanderAt(left, this.xAt(box.end) - left);
    const inside = at !== undefined && x >= at && x < at + EXPANDER_SIZE;
    // At the bottom left of the clip, out of the way of its name and of what is at its top.
    const fromBottom = row.top + row.height - this.laneAt(y);
    return inside && fromBottom <= EXPANDER_HEIGHT && this.showsExpander(box);
  }

  /** What the pointer is over, and how it should look. */
  hover(pointer: Pointer): string {
    const below = this.#extras?.hover(pointer);
    if (below !== undefined) {
      if (this.#hovered.kind !== "empty") this.leave();
      return below;
    }
    const hit = this.hitAt(pointer);
    const before = this.#hovered;
    this.#hovered = hit;
    const razorAt =
      this.#snapshot.tool === "razor" && hit.kind === "clip"
        ? cutAt(this.#host, pointer).seconds
        : undefined;
    const changed =
      hit.kind !== before.kind ||
      (hit.kind === "join" &&
        before.kind === "join" &&
        (hit.join !== before.join || hit.edge !== before.edge)) ||
      (hit.kind === "clip" &&
        before.kind === "clip" &&
        (hit.box !== before.box ||
          hit.edge !== before.edge ||
          hit.handle !== before.handle ||
          hit.transition !== before.transition));
    if (changed || razorAt !== this.#razorAt) {
      this.#razorAt = razorAt;
      this.#viewEmitter.emit();
    }
    return this.#cursorFor(hit);
  }

  /**
   * What to tell about what is under the pointer, as a key of the interface texts: why a join does
   * not do what it says, or that a side of it stands still on a frame there. Nothing otherwise.
   */
  titleAt(pointer: Pointer): string | undefined {
    if (pointer.y < RULER_HEIGHT) return undefined;
    const hit = this.hitAt(pointer);
    if (hit.kind !== "join") return undefined;
    const { join } = hit;
    if (join.trouble) return `transition.why.join.${join.trouble}`;
    const seconds = this.timeAt(pointer.x);
    const still = join.still.find(({ from, to }) => seconds >= from && seconds <= to);
    if (!still) return undefined;
    return still.to <= join.at ? "transition.stillBefore" : "transition.stillAfter";
  }

  leave(): void {
    this.#hovered = { kind: "empty" };
    this.#razorAt = undefined;
    this.#viewEmitter.emit();
  }

  #cursorFor(hit: Hit): string {
    if (hit.kind === "end") return "ew-resize";
    if (hit.kind === "ruler") return "pointer";
    if (hit.kind === "join") return hit.edge ? "col-resize" : "default";
    if (hit.kind !== "clip") return "default";
    if (hit.expander) return "pointer";
    if (this.#snapshot.tool === "razor") return "crosshair";
    if (hit.handle) return "col-resize";
    return hit.edge ? "ew-resize" : "default";
  }

  get isDragging(): boolean {
    return this.#gesture !== undefined;
  }

  /** The cursor while dragging. */
  get dragCursor(): string {
    return this.#preview?.copying ? "copy" : "";
  }

  /** What a finger starts by landing here. A locked clip goes nowhere, so that moves the view. */
  touchAt(pointer: Pointer): TouchStart {
    const below = this.#extras?.touchAt(pointer);
    if (below) return below;
    const hit = this.hitAt(pointer);
    const { selection, tool, transition } = this.#snapshot;
    // A finger takes the edge of a join that is selected, and otherwise it scrolls past.
    if (hit.kind === "join") {
      const chosen = isJoinChoice(transition) && transition.join === hit.join.id;
      return chosen && hit.edge ? "grab" : "plain";
    }
    const usable = hit.kind === "clip" && !hit.row.track.locked && tool === "select";
    const selected = usable && selection.has(hit.box.id);
    // The handles show while a transition of the clip is selected too, and then a finger takes them.
    const chosen =
      usable &&
      transition !== undefined &&
      !isJoinChoice(transition) &&
      transition.clip === hit.box.id;
    const handle = hit.kind === "clip" && hit.handle !== undefined;
    if (
      hit.kind === "ruler" ||
      hit.kind === "end" ||
      (selected && hit.kind === "clip" && hit.edge) ||
      ((selected || chosen) && handle)
    ) {
      return "grab";
    }
    return selected ? "selected" : "plain";
  }

  hold(pointer: Pointer): void {
    if (this.#extras?.hold(pointer)) return;
    const hit = this.hitAt(pointer);
    const { selection, multiSelecting } = this.#snapshot;
    if (hit.kind !== "clip" || selection.has(hit.box.id)) return;
    if (multiSelecting) this.addToSelection(hit.box.id);
    else this.selectOnly(hit.box.id);
  }

  press(pointer: Pointer): void {
    const { model } = this;
    if (!model) return;
    // Whatever was going on, its mouse button is up by now and something got in the way of saying so.
    this.#cancelGesture();
    this.#gesture = this.#extras?.press(pointer);
    if (this.#gesture) return;
    const hit = this.hitAt(pointer);
    const host = this.#host;
    if (hit.kind === "ruler") {
      this.#gesture = new ScrubGesture(host, pointer);
    } else if (hit.kind === "end") {
      const last = orderedSections(model.state).at(-1);
      if (!last) return;
      const start = subtract(timelineLength(model.state), parseTime(last.duration));
      this.#gesture = new EndGesture(host, { id: last.id, start }, pointer);
    } else if (hit.kind === "clip") {
      this.#pressClip(hit, pointer);
    } else if (hit.kind === "join") {
      this.#pressJoin(hit, pointer);
    } else {
      this.#gesture = new MarqueeGesture(host, pointer);
    }
  }

  /**
   * A press on a join: its edge changes how long it is, a click selects it, and a drag from it is
   * what it is from the clip under it, as on any other transition.
   */
  #pressJoin(hit: Extract<Hit, { kind: "join" }>, pointer: Pointer): void {
    const { join, row, edge } = hit;
    if (edge) {
      this.#gesture = new JoinGesture(this.#host, join, edge, pointer);
      return;
    }
    const onClick = () => this.selectJoin(join.id);
    const box = clipAt(row, this.timeAt(pointer.x));
    if (row.track.locked || !box) {
      this.#gesture = new MarqueeGesture(this.#host, pointer, onClick);
      return;
    }
    const drag = () => {
      if (!this.#snapshot.selection.has(box.id)) this.#select(this.#withLinked(new Set([box.id])));
      return new MoveGesture(this.#host, box, row, pointer, onClick);
    };
    this.#gesture = new TransitionPressGesture(pointer, drag, onClick);
  }

  /** Clips that belong together get selected together. */
  #withLinked(clips: ReadonlySet<string>): ReadonlySet<string> {
    const { model } = this;
    const all = new Set(clips);
    for (const id of clips) {
      const link = model?.boxes.get(id)?.clip.link;
      for (const partner of link === undefined ? [] : (model?.links.get(link) ?? [])) {
        all.add(partner);
      }
    }
    return all;
  }

  #pressClip(hit: Extract<Hit, { kind: "clip" }>, pointer: Pointer): void {
    const { box, row, edge, handle, transition } = hit;
    if (this.#snapshot.tool === "razor") {
      this.#gesture = new RazorGesture(this.#host, row, pointer);
      return;
    }
    if (handle) {
      this.#gesture = new TransitionGesture(this.#host, box, handle, pointer);
      return;
    }
    if (transition) {
      const onClick = () => this.selectTransition(box.id, transition);
      // A locked clip can be looked at, but nothing moves it: a drag from there is a drag from nowhere.
      if (row.track.locked) {
        this.#gesture = new MarqueeGesture(this.#host, pointer, onClick);
        return;
      }
      const drag = () => {
        if (!this.#snapshot.selection.has(box.id))
          this.#select(this.#withLinked(new Set([box.id])));
        return new MoveGesture(this.#host, box, row, pointer, onClick);
      };
      this.#gesture = new TransitionPressGesture(pointer, drag, onClick);
      return;
    }
    if (edge) {
      this.#select(this.#withLinked(new Set([box.id])));
      this.#gesture = new TrimGesture(this.#host, box, row, edge, pointer);
      return;
    }
    const { selection } = this.#snapshot;
    const wasSelected = selection.has(box.id);
    const adding = pointer.shift || pointer.mod || this.#snapshot.multiSelecting;
    const own = this.#withLinked(new Set([box.id]));
    const selected = new Set(adding ? [...selection, ...own] : own);
    // What a press on a selected clip means shows when it ends: it may be the start of a drag.
    const onClick = () => {
      if (hit.expander) this.#extras?.toggle(box);
      else if (adding && wasSelected) {
        this.#select(new Set([...selection].filter((id) => !own.has(id))));
      } else this.#select(selected);
    };
    // A locked clip can be looked at, but nothing moves it: a drag from there is a drag from nowhere.
    if (row.track.locked) {
      this.#gesture = new MarqueeGesture(this.#host, pointer, onClick);
      return;
    }
    if (!wasSelected) this.#select(selected);
    this.#gesture = new MoveGesture(this.#host, box, row, pointer, onClick);
  }

  drag(pointer: Pointer): void {
    this.#gesture?.move(pointer);
  }

  release(pointer: Pointer): void {
    const gesture = this.#gesture;
    this.#gesture = undefined;
    gesture?.end(pointer);
  }

  /** Escape, or the pointer got lost. */
  cancelDrag(): boolean {
    if (!this.#gesture) return false;
    this.#cancelGesture();
    return true;
  }

  #cancelGesture(): void {
    this.#gesture?.cancel();
    this.#gesture = undefined;
  }

  /** Keeps a drag going past the edge of the view. */
  scrollDuringDrag(pointer: Pointer, dx: number, dy: number): void {
    if (!this.#gesture) return;
    this.#scrollX += dx;
    if (this.#gesture.reachesRows) this.#scrollY += dy;
    this.#clampScroll();
    this.#gesture.move(pointer);
    this.#viewChanged();
  }

  /** What gestures get to see. It stays current for as long as a gesture goes on. */
  get #host(): GestureHost {
    const snapshot = () => this.#snapshot;
    const playhead = () => this.#frame;
    return {
      get model() {
        return snapshot().model as TimelineModel;
      },
      get selection() {
        return snapshot().selection;
      },
      get overwriting() {
        return snapshot().overwriting;
      },
      get multiSelecting() {
        return snapshot().multiSelecting;
      },
      get frame() {
        return playhead();
      },
      timeAt: (x) => this.timeAt(x),
      laneAt: (y) => this.laneAt(y),
      snapDistance: (pointer) =>
        this.#snapshot.snapping && !pointer.alt ? SNAP_REACH / this.#pixelsPerSecond : 0,
      setPreview: (preview) => {
        this.#preview = preview;
        this.#clampScroll();
        this.#viewEmitter.emit();
      },
      sourceLength: (clip) => {
        const state = this.#store?.getState();
        return state && sourceLength(state, clip);
      },
      select: (clips) => this.#select(this.#withLinked(clips)),
      selectTransition: (clip, edge) => this.selectTransition(clip, edge),
      selectJoin: (join) => this.selectJoin(join),
      seek: (frame) => this.seek(frame),
      run: (calls) => this.#run(calls),
    };
  }
}
