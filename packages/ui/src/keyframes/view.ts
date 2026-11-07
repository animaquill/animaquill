import { RULER_HEIGHT, clamp, zoomRange, type TimelineEditor } from "../timeline/editor.ts";
import { ScrubGesture, type Gesture, type Pointer } from "../timeline/gestures.ts";
import type { StageEditor } from "../timeline/stage.ts";
import type { TouchStart } from "../timeline/touch.ts";
import { Emitter } from "../workbench/emitter.ts";
import { KeyArea } from "./area.ts";
import type { KeyframeEditor } from "./editor.ts";
import { lanesOfTracks, type Lane } from "./lanes.ts";

const SNAP_REACH = 8;
const ZOOM_STEP = 1.5;
/** Room after the end, as on the timeline, and under the last lane. */
const TAIL_SHARE = 0.25;
const BOTTOM_MARGIN = 48;
const FIT_SHARE = 0.95;

interface OwnView {
  readonly pixelsPerSecond: number;
  readonly scrollX: number;
}

const NO_LANES: readonly Lane[] = [];

/**
 * The keyframe tab: the list on the left and the time on the right. It goes along with the timeline
 * by default, so that both show the same stretch of time, and can also go its own way.
 */
export class KeyframesView extends KeyArea implements StageEditor {
  readonly #timeline: TimelineEditor;
  readonly #lanesChanged = new Emitter();
  #lanes = NO_LANES;
  /** Where it looks when it does not go along with the timeline. */
  #own: OwnView | undefined;
  #width = 0;
  #height = 0;
  #scrollY = 0;
  #gesture: Gesture | undefined;

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
    return this.#own ? this.#own.scrollX : this.#timeline.scrollX;
  }

  get pixelsPerSecond(): number {
    return this.#own ? this.#own.pixelsPerSecond : this.#timelineScale();
  }

  /** A timeline that never showed has no scale yet. */
  #timelineScale(): number {
    const scale = this.#timeline.pixelsPerSecond;
    if (scale > 0) return scale;
    const duration = Math.max(this.model?.duration ?? 0, 1);
    return (Math.max(this.#width, 1) * FIT_SHARE) / duration;
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

  get preview(): unknown {
    return this.keyframes.preview;
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
    this.#setLanes(lanesOfTracks(model, this.keyframes.tracks(model), laneRules));
  }

  #setLanes(lanes: readonly Lane[]): void {
    const same =
      lanes.length === this.#lanes.length &&
      lanes.every((lane, index) => {
        const other = this.#lanes[index] as Lane;
        return (
          lane.node === other.node &&
          lane.row === other.row &&
          lane.box === other.box &&
          lane.top === other.top &&
          lane.height === other.height &&
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
    this.#clampScroll();
    this.keyframes.redrawTab();
  }

  #clampScroll(): void {
    this.#scrollY = clamp(this.#scrollY, 0, this.contentHeight - this.#height);
    if (this.#own) {
      const scrollX = clamp(this.#own.scrollX, 0, this.contentWidth - this.#width);
      this.#own = { ...this.#own, scrollX };
    }
  }

  setScroll(x: number, y: number): void {
    if (this.#own) this.#own = { ...this.#own, scrollX: x };
    else this.#timeline.setScroll(x, this.#timeline.scrollY);
    this.#scrollY = y;
    this.#clampScroll();
    this.keyframes.rememberSoon();
    this.keyframes.redrawTab();
  }

  zoomAround(x: number, factor: number): void {
    const own = this.#own;
    if (!own) {
      this.#timeline.zoomAround(x, factor);
      return;
    }
    const { model } = this;
    const moment = this.timeAt(x);
    const [low, high] = zoomRange(this.#width, model?.duration ?? 1, model?.rate.fps ?? 30);
    const pixelsPerSecond = clamp(own.pixelsPerSecond * factor, low, high);
    this.#own = { pixelsPerSecond, scrollX: moment * pixelsPerSecond - x };
    this.#clampScroll();
    this.keyframes.rememberSoon();
    this.keyframes.redrawTab();
  }

  zoomIn(): void {
    this.zoomAround(this.#zoomCenter(), ZOOM_STEP);
  }

  zoomOut(): void {
    this.zoomAround(this.#zoomCenter(), 1 / ZOOM_STEP);
  }

  /** Shows all of the timeline. Going along with it, that is what it does as well. */
  zoomToFit(): void {
    if (!this.#own) {
      this.#timeline.zoomToFit();
      return;
    }
    const duration = Math.max(this.model?.duration ?? 0, 1);
    this.#own = { pixelsPerSecond: (this.#width * FIT_SHARE) / duration, scrollX: 0 };
    this.keyframes.rememberSoon();
    this.keyframes.redrawTab();
  }

  #zoomCenter(): number {
    const { model } = this;
    if (!model) return 0;
    const x = this.xAt(this.frame / model.rate.fps);
    return x >= 0 && x <= this.#width ? x : this.#width / 2;
  }

  /** There are no taller lanes here. */
  zoomRowsAround(): void {}

  /** Keeps what it shows when it stops going along. Going along again, it shows what the timeline does. */
  link(linked: boolean): void {
    this.#own = linked
      ? undefined
      : { pixelsPerSecond: this.pixelsPerSecond, scrollX: this.scrollX };
    this.keyframes.redrawTab();
  }

  /** Where it looks on its own, to come back to. */
  get ownView(): OwnView | undefined {
    return this.#own;
  }

  /** Starts from what was remembered, as far as that makes sense. */
  adoptView(view: OwnView | undefined): void {
    const fits =
      view && Number.isFinite(view.pixelsPerSecond) && view.pixelsPerSecond > 0
        ? Number.isFinite(view.scrollX)
        : false;
    this.#own = fits ? view : undefined;
    this.#scrollY = 0;
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
