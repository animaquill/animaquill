import {
  add,
  compare,
  formatTime,
  newId,
  parseTime,
  subtract,
  toSeconds,
  type Rational,
} from "@animaquill/schema";
import {
  clipEnd,
  clipStart,
  orderedSections,
  projectFrameRate,
  sourceLength,
  timelineLength,
  trackKindFor,
  type ClipState,
  type CommandCall,
  type ProjectStore,
} from "@animaquill/core";
import type { SettingsStore, WindowMemory } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { readSetting } from "../workbench/settings.ts";
import { frameAt, frameSeconds, frameTime } from "./frames.ts";
import {
  EndGesture,
  MarqueeGesture,
  MoveGesture,
  RazorGesture,
  ScrubGesture,
  TrimGesture,
  copiesOf,
  cutAt,
  freeShift,
  type ClipCopy,
  type Gesture,
  type GestureHost,
  type Placed,
  type Pointer,
  type Preview,
} from "./gestures.ts";
import {
  buildModel,
  clipAt,
  firstEndingAfter,
  forEachBetween,
  isInsideClip,
  rowAt,
  type ClipBox,
  type Row,
  type TimelineModel,
} from "./model.ts";

export const RULER_HEIGHT = 28;
/** How far the pointer can be from an edge and still grab it. Short clips keep some middle. */
const EDGE_REACH = 7;
/** A fingertip covers more than a mouse pointer. */
const TOUCH_EDGE_REACH = 16;
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
const REMEMBER_DELAY_MS = 300;
const NEW_CLIP_SECONDS = 5;
export const DEFAULT_HEADER_WIDTH = 148;
const MIN_HEADER_WIDTH = 96;
const MAX_HEADER_WIDTH = 360;

/** Colours that tell clips apart while they are only placeholders. */
const NEW_CLIP_COLORS = ["#3f6fb5", "#3f9a7a", "#b57a3f", "#8f5fb5", "#b5536a", "#5f8fa8"];

export type Tool = "select" | "razor";

export type Hit =
  | { readonly kind: "ruler" }
  | { readonly kind: "end" }
  | { readonly kind: "lane"; readonly row: Row; readonly seconds: number }
  | {
      readonly kind: "clip";
      readonly row: Row;
      readonly box: ClipBox;
      readonly edge?: "start" | "end";
    }
  | { readonly kind: "empty" };

/** What React shows. The view changes far more often and goes through `subscribeView`. */
export interface TimelineSnapshot {
  readonly model: TimelineModel | undefined;
  readonly selection: ReadonlySet<string>;
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

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

const sameView = (a: ViewPlace, b: ViewPlace) =>
  a.pixelsPerSecond === b.pixelsPerSecond && a.scrollX === b.scrollX;

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((item) => b.has(item));

/**
 * The timeline of this window: what it shows, what is selected and what the mouse is doing. None of
 * it is part of the project. Changes to the project go through commands, once a drag has ended.
 */
export class TimelineEditor {
  readonly #session: ProjectSession;
  readonly #memory: WindowMemory;
  readonly #settings: SettingsStore;
  readonly #messages: TimelineMessages;
  readonly #emitter = new Emitter();
  readonly #viewEmitter = new Emitter();
  #snapshot: TimelineSnapshot = {
    model: undefined,
    selection: new Set(),
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

  get preview(): Preview | undefined {
    return this.#preview;
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
    const fps = model?.rate.fps ?? 30;
    const duration = Math.max(model?.duration ?? 1, 1 / fps);
    const low = (Math.max(this.#width, 1) * MIN_ZOOM_SHARE) / duration;
    const high = fps * MAX_PIXELS_PER_FRAME;
    return [Math.min(low, high), high];
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
    const id = this.#store?.getState().manifest.id;
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
      ? parseRemembered(this.#memory.read(`timeline.${store.getState().manifest.id}`))
      : undefined;
    this.#pixelsPerSecond = remembered?.pixelsPerSecond ?? 0;
    this.#rowScale = clamp(remembered?.rowScale ?? 1, MIN_ROW_SCALE, MAX_ROW_SCALE);
    this.#scrollX = remembered?.scrollX ?? 0;
    this.#scrollY = remembered?.scrollY ?? 0;
    this.#frame = remembered?.frame ?? 0;
    this.#snapshot = { ...this.#snapshot, selection: new Set(), cut: new Set() };
    this.#clipboard = [];
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
    const selection = new Set(this.#selectable(this.#snapshot.selection, model));
    const same = sameSet(selection, this.#snapshot.selection);
    const cut = new Set(this.#selectable(this.#snapshot.cut, model));
    this.#snapshot = {
      ...this.#snapshot,
      model,
      selection: same ? this.#snapshot.selection : selection,
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
      current.fps === fps &&
      current.rowScale === this.#rowScale;
    return same ? current : buildModel(id, timeline, fps, this.#rowScale);
  }

  /** Runs commands as one change. Failing is rare, because the interface checks first. */
  #run(calls: readonly CommandCall[]): boolean {
    const store = this.#store;
    if (!store) return false;
    const result = store.executeBatch(calls);
    if (!result.ok) this.#messages.commandFailed(result.error.message);
    return result.ok;
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

  /** Clips that are there, and not on a locked track: nothing can be done with those. */
  #selectable(ids: Iterable<string>, model: TimelineModel | undefined): readonly string[] {
    return [...ids].filter(
      (id) => model?.boxes.has(id) === true && model.rowOfClip.get(id)?.track.locked !== true,
    );
  }

  #select(wanted: ReadonlySet<string>): void {
    // A drag can hold on to a clip that is gone by now.
    const selection = new Set(this.#selectable(wanted, this.model));
    if (sameSet(selection, this.#snapshot.selection)) return;
    this.#snapshot = { ...this.#snapshot, selection };
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  addToSelection(clip: string): void {
    this.#select(new Set([...this.#snapshot.selection, ...this.#withLinked(new Set([clip]))]));
  }

  selectOnly(clip: string): void {
    this.#select(this.#withLinked(new Set([clip])));
  }

  selectAll(): void {
    this.#select(new Set(this.model?.boxes.keys()));
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
    const clips = [...this.#snapshot.selection];
    if (!model || clips.length === 0) return;
    this.#run([{ type: "clip.remove", params: { timeline: model.id, clips } }]);
  }

  get hasClipboard(): boolean {
    return this.#clipboard.length > 0;
  }

  copySelection(): void {
    const { model } = this;
    const { selection } = this.#snapshot;
    const boxes = [...selection].flatMap((id) => model?.boxes.get(id) ?? []);
    if (boxes.length === 0) return;
    this.#clipboard = boxes.map(({ clip }) => clip);
    this.#setCut(new Set());
  }

  /** Marks clips to go. They stay in their place until they are pasted, so this can be undone. */
  cutSelection(): void {
    const { selection } = this.#snapshot;
    if (selection.size === 0) return;
    this.copySelection();
    this.#setCut(selection);
  }

  /** Changes nothing when there is no cut, and says so. */
  cancelCut(): boolean {
    if (this.#snapshot.cut.size === 0) return false;
    this.#clipboard = [];
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
        },
      };
    });
    const removal: CommandCall[] =
      cut.size > 0
        ? [{ type: "clip.remove", params: { timeline: model.id, clips: [...cut] } }]
        : [];
    if (!this.#run([...removal, ...trackCalls, ...calls])) return;
    this.#setCut(new Set());
    this.#select(new Set(copies.map(({ id }) => id)));
  }

  /** What a cut at the playhead would go through: only what people selected. */
  #clipsToSplit(model: TimelineModel): readonly ClipBox[] {
    const seconds = frameSeconds(this.#frame, model.rate);
    const moment = frameTime(this.#frame, model.rate);
    return model.rows.flatMap((row) => {
      const box = clipAt(row, seconds);
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
      return [{ type: "clip.split", params: { timeline: model.id, clip: box.id, at } }];
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
   * Puts a file on the timeline, at a place or else at the playhead: a video with sound as two
   * linked clips. What is there stays and the clips go after it, unless people overwrite. A track
   * that can take them is found or made.
   */
  addAsset(assetId: string, place?: { readonly lane: number; readonly seconds: number }): void {
    const { model } = this;
    const asset = this.#store?.getState().assets?.[assetId];
    if (!model || !asset) return;
    const { rate } = model;
    const seconds = place?.seconds ?? frameSeconds(this.#frame, rate);
    const start = frameTime(frameAt(Math.max(seconds, 0), rate), rate);
    const known = asset.info?.duration;
    const frames = known ? Math.floor(toSeconds(parseTime(known)) * rate.fps) : 0;
    const duration = frames > 0 ? frameTime(frames, rate) : this.#newClipDuration(model);
    const media = { asset: assetId };
    const parts = [
      ...(asset.kind === "audio"
        ? []
        : [{ kind: "video" as const, source: { kind: asset.kind, media } }]),
      ...(asset.kind === "audio" || asset.info?.hasAudio
        ? [{ kind: "audio" as const, source: { kind: "audio", media } }]
        : []),
    ].map((part) => ({ ...part, row: this.#rowForNew(model, part.kind, place?.lane) }));

    const placed = parts.flatMap(({ row }): Placed[] => {
      if (!row) return [];
      const end = add(start, duration);
      return [
        {
          row,
          start: toSeconds(start),
          end: toSeconds(end),
          exactStart: () => start,
          exactEnd: () => end,
        },
      ];
    });
    const { overwriting } = this.#snapshot;
    const shift = overwriting ? undefined : freeShift(placed, new Set(), 1);
    const at = shift ? add(start, shift.exact()) : start;
    const link = parts.length > 1 ? { link: newId("link") } : {};
    const trackCalls: CommandCall[] = [];
    const ids: string[] = [];
    const calls = parts.map(({ kind, source, row }) => {
      let track = row?.id;
      if (!track) {
        track = newId("track");
        trackCalls.push({ type: "track.add", params: { timeline: model.id, id: track, kind } });
      }
      const id = newId("clip");
      ids.push(id);
      return {
        type: "clip.add",
        params: {
          timeline: model.id,
          track,
          clip: {
            id,
            ...(asset.name === undefined ? {} : { name: asset.name }),
            start: formatTime(at),
            duration: formatTime(duration),
            source,
            ...link,
          },
          ...(overwriting ? { overlap: "overwrite" } : {}),
        },
      };
    });
    if (this.#run([...trackCalls, ...calls])) this.#select(new Set(ids));
  }

  /** The row at a height when it fits, or else the first one that does. */
  #rowForNew(model: TimelineModel, kind: string, lane: number | undefined): Row | undefined {
    const usable = (row: Row | undefined): row is Row =>
      row !== undefined && row.track.kind === kind && !row.track.locked && !row.gone;
    const pointed = lane === undefined ? undefined : rowAt(model, lane);
    if (usable(pointed)) return pointed;
    return model.rows.filter(usable).toSorted((a, b) => a.number - b.number)[0];
  }

  /** Where something dragged from elsewhere would go, or nothing when it left again. */
  showDrop(pointer: Pointer | undefined): void {
    const { model } = this;
    if (!model) return;
    const seconds =
      pointer && frameSeconds(frameAt(this.timeAt(pointer.x), model.rate), model.rate);
    this.#preview = seconds === undefined ? undefined : { snap: Math.max(seconds, 0) };
    this.#viewEmitter.emit();
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

  removeTrack(track: string): void {
    const { model } = this;
    if (model) this.#run([{ type: "track.remove", params: { timeline: model.id, track } }]);
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
    const box = clipAt(row, seconds);
    if (!box) return { kind: "lane", row, seconds };
    const reach = Math.min(this.#edgeReach, ((box.end - box.start) * this.#pixelsPerSecond) / 3);
    const fromStart = x - this.xAt(box.start);
    const fromEnd = this.xAt(box.end) - x;
    if (row.track.locked || this.#snapshot.tool !== "select") return { kind: "clip", row, box };
    if (fromStart <= reach) return { kind: "clip", row, box, edge: "start" };
    if (fromEnd <= reach) return { kind: "clip", row, box, edge: "end" };
    return { kind: "clip", row, box };
  }

  /** What the pointer is over, and how it should look. */
  hover(pointer: Pointer): string {
    const hit = this.hitAt(pointer);
    const before = this.#hovered;
    this.#hovered = hit;
    const razorAt =
      this.#snapshot.tool === "razor" && hit.kind === "clip"
        ? cutAt(this.#host, pointer).seconds
        : undefined;
    const changed =
      hit.kind !== before.kind ||
      (hit.kind === "clip" &&
        before.kind === "clip" &&
        (hit.box !== before.box || hit.edge !== before.edge));
    if (changed || razorAt !== this.#razorAt) {
      this.#razorAt = razorAt;
      this.#viewEmitter.emit();
    }
    return this.#cursorFor(hit);
  }

  leave(): void {
    this.#hovered = { kind: "empty" };
    this.#razorAt = undefined;
    this.#viewEmitter.emit();
  }

  #cursorFor(hit: Hit): string {
    if (hit.kind === "end") return "ew-resize";
    if (hit.kind === "ruler") return "pointer";
    if (hit.kind !== "clip") return "default";
    if (this.#snapshot.tool === "razor") return "crosshair";
    return hit.edge ? "ew-resize" : "default";
  }

  get isDragging(): boolean {
    return this.#gesture !== undefined;
  }

  press(pointer: Pointer): void {
    const { model } = this;
    if (!model) return;
    // Whatever was going on, its mouse button is up by now and something got in the way of saying so.
    this.#cancelGesture();
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
    } else {
      this.#gesture = new MarqueeGesture(host, pointer);
    }
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
    const { box, row, edge } = hit;
    if (this.#snapshot.tool === "razor") {
      this.#gesture = new RazorGesture(this.#host, row, pointer);
      return;
    }
    if (edge) {
      this.#select(this.#withLinked(new Set([box.id])));
      this.#gesture = new TrimGesture(this.#host, box, row, edge, pointer);
      return;
    }
    // Nothing can be done with a locked clip, so it counts as empty space.
    if (row.track.locked) {
      this.#gesture = new MarqueeGesture(this.#host, pointer);
      return;
    }
    const { selection } = this.#snapshot;
    const wasSelected = selection.has(box.id);
    const adding = pointer.shift || pointer.mod || this.#snapshot.multiSelecting;
    const own = this.#withLinked(new Set([box.id]));
    if (!wasSelected) this.#select(new Set(adding ? [...selection, ...own] : own));
    // What a press on a selected clip means shows when it ends: it may be the start of a drag.
    const onClick = () => {
      if (!adding) this.#select(own);
      else if (wasSelected) this.#select(new Set([...selection].filter((id) => !own.has(id))));
    };
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
      seek: (frame) => this.seek(frame),
      run: (calls) => this.#run(calls),
    };
  }
}
