import { RULER_HEIGHT, clamp, zoomRange, type TimelineEditor } from "../timeline/editor.ts";
import { ScrubGesture, type Gesture, type Pointer } from "../timeline/gestures.ts";
import type { StageEditor } from "../timeline/stage.ts";
import type { TouchStart } from "../timeline/touch.ts";
import { Emitter } from "../workbench/emitter.ts";
import { KeyArea } from "./area.ts";
import type { KeyframeEditor, ShownClips } from "./editor.ts";
import { LANE_HEIGHT, laneAt, lanesOfTracks, type Lane } from "./lanes.ts";

const SNAP_REACH = 8;
const ZOOM_STEP = 1.5;
/** Room after the end, as on the timeline, and under the last lane. */
const TAIL_SHARE = 0.25;
const BOTTOM_MARGIN = 48;
const FIT_SHARE = 0.95;
/** How close to an edge the playhead can be before the view follows it, as on the timeline. */
const REVEAL_MARGIN = 48;
/** The rows of keys get taller as on the timeline. Lower than this, the values do not fit. */
const MIN_ROW_SCALE = 20 / LANE_HEIGHT;
const MAX_ROW_SCALE = 3;
const ROW_SCALE_STEP = 1.25;

/** What the tab shows of the time, which is up to it and not to the timeline. */
export interface OwnView {
  readonly pixelsPerSecond: number;
  readonly scrollX: number;
}

const NO_LANES: readonly Lane[] = [];

/**
 * The keyframe tab: the list on the left and the time on the right. It scrolls and zooms on its
 * own, so that people can look closely at keys while the timeline shows all of it. The playhead is
 * the one of the timeline, and the view follows it as the timeline does.
 */
export class KeyframesView extends KeyArea implements StageEditor {
  readonly #timeline: TimelineEditor;
  readonly #lanesChanged = new Emitter();
  #lanes = NO_LANES;
  /** No scale yet means that it shows all of the timeline once it has a size. */
  #pixelsPerSecond = 0;
  #scrollX = 0;
  #rowScale = 1;
  /** The playhead moved while this did not show, so it gets in sight once it does. */
  #revealLater = false;
  #width = 0;
  #height = 0;
  #scrollY = 0;
  #gesture: Gesture | undefined;
  /** What is selected is listed here, wherever it is. */
  readonly shownClips: ShownClips = () => true;

  constructor(keyframes: KeyframeEditor, timeline: TimelineEditor) {
    super(keyframes);
    this.#timeline = timeline;
  }

  /** Hears about a new list of lanes. */
  subscribeLanes = this.#lanesChanged.subscribe;
  getLanes = (): readonly Lane[] => this.#lanes;

  get lanes(): readonly Lane[] {
    return this.#lanes;
  }

  subscribeView = (listener: () => void): (() => void) => this.keyframes.subscribeView(listener);

  get model() {
    return this.keyframes.model;
  }

  get frame(): number {
    return this.keyframes.frame;
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get screenHeight(): number {
    return this.#height;
  }

  get scrollY(): number {
    return this.#scrollY;
  }

  get scrollX(): number {
    return this.#scrollX;
  }

  /** Before it ever had a size, what it would show all of the timeline at. */
  get pixelsPerSecond(): number {
    return this.#pixelsPerSecond > 0 ? this.#pixelsPerSecond : this.#fitScale();
  }

  #fitScale(): number {
    const { model } = this;
    const duration = Math.max(model?.duration ?? 0, 1);
    const [low, high] = zoomRange(this.#width, model?.duration ?? 1, model?.rate.fps ?? 30);
    return clamp((Math.max(this.#width, 1) * FIT_SHARE) / duration, low, high);
  }

  /** How much taller the rows of keys are than usual. */
  get rowScale(): number {
    return this.#rowScale;
  }

  get #keyHeight(): number {
    return Math.round(LANE_HEIGHT * this.#rowScale);
  }

  xAt(seconds: number): number {
    return seconds * this.pixelsPerSecond - this.scrollX;
  }

  timeAt(x: number): number {
    return (x + this.scrollX) / this.pixelsPerSecond;
  }

  laneY(y: number): number {
    return y - RULER_HEIGHT + this.#scrollY;
  }

  screenY(laneTop: number): number {
    return RULER_HEIGHT - this.#scrollY + laneTop;
  }

  snapDistance(pointer: Pointer): number {
    const { snapping } = this.#timeline.getSnapshot();
    return snapping && !pointer.alt ? SNAP_REACH / this.pixelsPerSecond : 0;
  }

  /** The end of the timeline. */
  get visibleDuration(): number {
    return this.model?.duration ?? 0;
  }

  get contentWidth(): number {
    return Math.max(this.visibleDuration * (1 + TAIL_SHARE) * this.pixelsPerSecond, this.#width);
  }

  get contentHeight(): number {
    const last = this.#lanes.at(-1);
    const bottom = last ? last.top + last.height : 0;
    return Math.max(bottom + RULER_HEIGHT + BOTTOM_MARGIN, this.#height);
  }

  /** Whether the playhead turned into the line of what something snapped to. */
  get isSnappedToPlayhead(): boolean {
    const { model } = this;
    const snap = this.keyframes.preview?.snap;
    if (!model || snap === undefined) return false;
    return Math.abs(snap - this.frame / model.rate.fps) < 1e-9;
  }

  get isDragging(): boolean {
    return this.#gesture !== undefined;
  }

  get dragCursor(): string {
    return "";
  }

  get holdsDrag(): boolean {
    return this.keyframes.preview !== undefined;
  }

  toggleLane({ id }: Lane): void {
    this.keyframes.toggleOpen(id);
  }

  /** Works out the lanes again. Behind another tab that can wait until it shows. */
  relist(): void {
    const { model } = this;
    if (!model || this.#width === 0) {
      if (!model) this.#setLanes(NO_LANES);
      return;
    }
    const { laneRules } = this.keyframes;
    this.#setLanes(lanesOfTracks(model, this.keyframes.tracks(model), laneRules, this.#keyHeight));
  }

  #setLanes(lanes: readonly Lane[]): void {
    const same =
      lanes.length === this.#lanes.length &&
      lanes.every((lane, index) => {
        const other = this.#lanes[index] as Lane;
        return (
          lane.id === other.id &&
          lane.node === other.node &&
          lane.row === other.row &&
          lane.box === other.box &&
          lane.top === other.top &&
          lane.height === other.height &&
          lane.keyHeight === other.keyHeight &&
          lane.tall === other.tall &&
          lane.open === other.open
        );
      });
    if (same) return;
    this.#lanes = lanes;
    this.#clampScroll();
    this.#lanesChanged.emit();
    this.keyframes.redrawTab();
  }

  /* The view. */

  setViewport(width: number, height: number): void {
    if (width === this.#width && height === this.#height) return;
    const showing = this.#width === 0 && width > 0;
    this.#width = width;
    this.#height = height;
    if (width === 0) this.cancelDrag();
    if (showing) this.relist();
    if (this.#pixelsPerSecond === 0 && width > 0) this.#pixelsPerSecond = this.#fitScale();
    this.#clampScroll();
    if (this.#revealLater) this.#revealPlayhead();
    this.keyframes.redrawTab();
  }

  #clampScroll(): void {
    this.#scrollY = clamp(this.#scrollY, 0, this.contentHeight - this.#height);
    this.#scrollX = clamp(this.#scrollX, 0, this.contentWidth - this.#width);
  }

  setScroll(x: number, y: number): void {
    this.#scrollX = x;
    this.#scrollY = y;
    this.#clampScroll();
    this.#viewChanged();
  }

  zoomAround(x: number, factor: number): void {
    if (this.#pixelsPerSecond === 0) return;
    const { model } = this;
    const moment = this.timeAt(x);
    const [low, high] = zoomRange(this.#width, model?.duration ?? 1, model?.rate.fps ?? 30);
    this.#pixelsPerSecond = clamp(this.#pixelsPerSecond * factor, low, high);
    this.#scrollX = moment * this.#pixelsPerSecond - x;
    this.#clampScroll();
    this.#viewChanged();
  }

  zoomIn(): void {
    this.zoomAround(this.#zoomCenter(), ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomAround(this.#zoomCenter(), 1 / ZOOM_STEP);
  }

  /** Shows all of the timeline. */
  zoomToFit(): void {
    if (this.#width === 0) return;
    this.#pixelsPerSecond = this.#fitScale();
    this.#scrollX = 0;
    this.#clampScroll();
    this.#viewChanged();
  }

  #zoomCenter(): number {
    const { model } = this;
    if (!model) return 0;
    const x = this.xAt(this.frame / model.rate.fps);
    return x >= 0 && x <= this.#width ? x : this.#width / 2;
  }

  /** Changes the height of the rows of keys while what is at height `y` stays where it is. */
  zoomRowsAround(y: number, factor: number): void {
    if (this.#gesture) return;
    const scale = clamp(this.#rowScale * factor, MIN_ROW_SCALE, MAX_ROW_SCALE);
    if (scale === this.#rowScale) return;
    const inLanes = this.laneY(Math.max(y, RULER_HEIGHT));
    const lane = laneAt(this.#lanes, inLanes);
    const share = lane ? (inLanes - lane.top) / lane.height : 0;
    const before = this.#rowScale;
    this.#rowScale = scale;
    this.relist();
    const after = lane && this.#lanes.find(({ id }) => id === lane.id);
    const target = after ? after.top + share * after.height : (inLanes * scale) / before;
    this.#scrollY = target - (Math.max(y, RULER_HEIGHT) - RULER_HEIGHT);
    this.#clampScroll();
    this.#viewChanged();
  }

  rowsTaller(): void {
    this.zoomRowsAround(RULER_HEIGHT, ROW_SCALE_STEP);
  }

  rowsShorter(): void {
    this.zoomRowsAround(RULER_HEIGHT, 1 / ROW_SCALE_STEP);
  }

  /** The playhead moved. Like the timeline, this scrolls just far enough that it can be seen. */
  followPlayhead(): void {
    this.#revealPlayhead();
  }

  #revealPlayhead(): void {
    const { model } = this;
    this.#revealLater = this.#width === 0;
    if (!model || this.#revealLater || this.#pixelsPerSecond === 0) return;
    const x = this.xAt(this.frame / model.rate.fps);
    const margin = Math.min(REVEAL_MARGIN, this.#width / 4);
    const before = this.#scrollX;
    if (x < margin) this.#scrollX += x - margin;
    else if (x > this.#width - margin) this.#scrollX += x - (this.#width - margin);
    this.#clampScroll();
    if (this.#scrollX !== before) this.keyframes.rememberSoon();
  }

  #viewChanged(): void {
    this.keyframes.rememberSoon();
    this.keyframes.redrawTab();
  }

  /** What it shows, to come back to. Nothing before it ever had a size. */
  get ownView(): OwnView | undefined {
    const pixelsPerSecond = this.#pixelsPerSecond;
    return pixelsPerSecond > 0 ? { pixelsPerSecond, scrollX: this.#scrollX } : undefined;
  }

  /** Starts from what was remembered, as far as that makes sense. */
  adoptView(view: OwnView | undefined, rowScale: unknown): void {
    const fits =
      view && Number.isFinite(view.pixelsPerSecond) && view.pixelsPerSecond > 0
        ? Number.isFinite(view.scrollX)
        : false;
    this.#pixelsPerSecond = fits && view ? view.pixelsPerSecond : 0;
    this.#scrollX = fits && view ? view.scrollX : 0;
    if (this.#pixelsPerSecond === 0 && this.#width > 0) this.#pixelsPerSecond = this.#fitScale();
    this.#rowScale =
      typeof rowScale === "number" && Number.isFinite(rowScale)
        ? clamp(rowScale, MIN_ROW_SCALE, MAX_ROW_SCALE)
        : 1;
    this.#scrollY = 0;
    this.#revealLater = false;
  }

  /* The mouse. */

  setTouchInput(on: boolean): void {
    this.setTouch(on);
  }

  hover(pointer: Pointer): string {
    return pointer.y < RULER_HEIGHT ? "pointer" : this.cursorAt(pointer);
  }

  leave(): void {}

  press(pointer: Pointer): void {
    const { model } = this;
    if (!model) return;
    this.#cancelGesture();
    this.#gesture =
      pointer.y < RULER_HEIGHT
        ? new ScrubGesture(this.#scrubHost, pointer)
        : this.pressLanes(pointer);
  }

  drag(pointer: Pointer): void {
    this.#gesture?.move(pointer);
  }

  release(pointer: Pointer): void {
    const gesture = this.#gesture;
    this.#gesture = undefined;
    gesture?.end(pointer);
  }

  cancelDrag(): boolean {
    if (!this.#gesture) return false;
    this.#cancelGesture();
    return true;
  }

  #cancelGesture(): void {
    this.#gesture?.cancel();
    this.#gesture = undefined;
  }

  /** A change in the project can pull the ground from under a drag. */
  checkDrag(): void {
    const { model } = this;
    if (model && this.#gesture?.isStale?.(model)) this.#cancelGesture();
  }

  /** Keeps a drag going past the edge of the view. */
  scrollDuringDrag(pointer: Pointer, dx: number, dy: number): void {
    if (!this.#gesture) return;
    const reachesRows = this.#gesture.reachesRows === true;
    this.setScroll(this.scrollX + dx, reachesRows ? this.#scrollY + dy : this.#scrollY);
    this.#gesture.move(pointer);
  }

  touchAt(pointer: Pointer): TouchStart {
    return pointer.y < RULER_HEIGHT ? "grab" : this.touchAtLanes(pointer);
  }

  hold(pointer: Pointer): void {
    this.holdLanes(pointer);
  }

  get #scrubHost() {
    const { keyframes } = this;
    const timeline = this.#timeline;
    return {
      get model() {
        return keyframes.model as NonNullable<typeof keyframes.model>;
      },
      get frame() {
        return keyframes.frame;
      },
      timeAt: (x: number) => this.timeAt(x),
      snapDistance: (pointer: Pointer) => this.snapDistance(pointer),
      seek: (frame: number) => timeline.seek(frame),
    };
  }
}
