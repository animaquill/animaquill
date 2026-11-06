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
  timelineLength,
  type CommandCall,
  type ProjectStore,
} from "@animaquill/core";
import type { WindowMemory } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { frameAt, frameSeconds, frameTime } from "./frames.ts";
import {
  EndGesture,
  MarqueeGesture,
  MoveGesture,
  RazorGesture,
  ScrubGesture,
  TrimGesture,
  cutAt,
  type Gesture,
  type GestureHost,
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
const SNAP_REACH = 8;
/** Room after the end of the timeline, as a share of the width: clips need somewhere to go. */
const TAIL_SHARE = 0.5;
/** People look at a clip, not at its last frame, when the view follows the playhead. */
const REVEAL_MARGIN = 48;
/** Zoom out to the whole timeline with a little air around it. */
const FIT_SHARE = 0.95;
const MIN_ZOOM_SHARE = 0.8;
/** The closest view: a frame is wide enough to see and to grab. */
const MAX_PIXELS_PER_FRAME = 240;
/** Browsers stop laying out somewhere above 30 million pixels. */
const MAX_CONTENT_PIXELS = 30_000_000;
const ZOOM_STEP = 1.5;
const END_HANDLE_REACH = 7;
const REMEMBER_DELAY_MS = 300;
const NEW_CLIP_SECONDS = 5;

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

interface RememberedView {
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

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((item) => b.has(item));

/**
 * The timeline of this window: what it shows, what is selected and what the mouse is doing. None of
 * it is part of the project. Changes to the project go through commands, once a drag has ended.
 */
export class TimelineEditor {
  readonly #session: ProjectSession;
  readonly #memory: WindowMemory;
  readonly #messages: TimelineMessages;
  readonly #emitter = new Emitter();
  readonly #viewEmitter = new Emitter();
  #snapshot: TimelineSnapshot = {
    model: undefined,
    selection: new Set(),
    tool: "select",
    snapping: true,
  };
  #store: ProjectStore | undefined;
  #stopStore: (() => void) | undefined;
  #gesture: Gesture | undefined;
  #preview: Preview | undefined;
  #hovered: Hit = { kind: "empty" };
  #razorAt: number | undefined;
  #frame = 0;
  #pixelsPerSecond = 0;
  #scrollX = 0;
  #scrollY = 0;
  #width = 0;
  #height = 0;
  #rememberTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(session: ProjectSession, memory: WindowMemory, messages: TimelineMessages) {
    this.#session = session;
    this.#memory = memory;
    this.#messages = messages;
    session.subscribe(() => this.#followSession());
    this.#followSession();
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
    return Math.max(last * this.#pixelsPerSecond + this.#width * TAIL_SHARE, this.#width);
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

  zoomToFit(): void {
    if (this.#width === 0) return;
    this.#fit();
    this.#scrollX = 0;
    this.#clampScroll();
    this.#viewChanged();
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
    const high = Math.min(fps * MAX_PIXELS_PER_FRAME, MAX_CONTENT_PIXELS / duration);
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
    this.#scrollX = remembered?.scrollX ?? 0;
    this.#scrollY = remembered?.scrollY ?? 0;
    this.#frame = remembered?.frame ?? 0;
    this.#snapshot = { ...this.#snapshot, selection: new Set() };
    this.#refresh();
    if (this.#pixelsPerSecond === 0 && this.#width > 0) this.#fit();
    this.#clampScroll();
    this.#viewEmitter.emit();
  }

  #refresh(): void {
    const model = this.#buildModel();
    const selection = model
      ? new Set([...this.#snapshot.selection].filter((id) => model.boxes.has(id)))
      : new Set<string>();
    const same = sameSet(selection, this.#snapshot.selection);
    this.#snapshot = {
      ...this.#snapshot,
      model,
      selection: same ? this.#snapshot.selection : selection,
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
    const fps = state.manifest.formats[0]?.fps ?? "30";
    const current = this.model;
    if (current?.id === id && current.state === timeline && current.fps === fps) return current;
    return buildModel(id, timeline, fps);
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
  }

  #select(wanted: ReadonlySet<string>): void {
    const { model } = this;
    // A drag can hold on to a clip that is gone by now.
    const selection = new Set([...wanted].filter((id) => model?.boxes.has(id)));
    if (sameSet(selection, this.#snapshot.selection)) return;
    this.#snapshot = { ...this.#snapshot, selection };
    this.#emitter.emit();
    this.#viewEmitter.emit();
  }

  selectOnly(clip: string): void {
    this.#select(new Set([clip]));
  }

  selectAll(): void {
    this.#select(new Set(this.model?.boxes.keys()));
  }

  clearSelection(): void {
    this.#select(new Set());
  }

  /* The playhead. */

  seek(frame: number): void {
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
    if (!model) return;
    const clips = [...this.#snapshot.selection].filter(
      (id) => model.rowOfClip.get(id)?.track.locked !== true,
    );
    if (clips.length === 0) return;
    this.#run([{ type: "clip.remove", params: { timeline: model.id, clips } }]);
  }

  /** What a cut at the playhead would go through: what is selected there, or else everything. */
  #clipsToSplit(model: TimelineModel): readonly ClipBox[] {
    const seconds = frameSeconds(this.#frame, model.rate);
    const moment = frameTime(this.#frame, model.rate);
    const under = model.rows.flatMap((row) => {
      const box = row.track.locked ? undefined : clipAt(row, seconds);
      return box && isInsideClip(box.clip, moment) ? [box] : [];
    });
    const selected = under.filter((box) => this.#snapshot.selection.has(box.id));
    return selected.length > 0 ? selected : under;
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
    const reach = Math.min(EDGE_REACH, ((box.end - box.start) * this.#pixelsPerSecond) / 3);
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

  #pressClip(hit: Extract<Hit, { kind: "clip" }>, pointer: Pointer): void {
    const { box, row, edge } = hit;
    if (this.#snapshot.tool === "razor") {
      this.#gesture = new RazorGesture(this.#host, row, pointer);
      return;
    }
    if (edge) {
      this.#select(new Set([box.id]));
      this.#gesture = new TrimGesture(this.#host, box, row, edge, pointer);
      return;
    }
    const { selection } = this.#snapshot;
    const wasSelected = selection.has(box.id);
    if (pointer.shift || pointer.mod) {
      const next = new Set(selection);
      if (wasSelected) next.delete(box.id);
      else next.add(box.id);
      this.#select(next);
      if (wasSelected) return;
    } else if (!wasSelected) {
      this.#select(new Set([box.id]));
    }
    if (row.track.locked) return;
    // A click on one of several selected clips means that one, but only when no drag followed.
    const narrow = () => {
      if (!pointer.shift && !pointer.mod) this.#select(new Set([box.id]));
    };
    this.#gesture = new MoveGesture(this.#host, box, row, pointer, narrow);
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
      select: (clips) => this.#select(clips),
      seek: (frame) => this.seek(frame),
      run: (calls) => this.#run(calls),
    };
  }
}
