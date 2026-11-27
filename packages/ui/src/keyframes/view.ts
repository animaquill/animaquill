import { RULER_HEIGHT, clamp, zoomRange, type TimelineEditor } from "../timeline/editor.ts";
import { ScrubGesture, type Gesture, type Pointer } from "../timeline/gestures.ts";
import type { StageEditor } from "../timeline/stage.ts";
import type { TouchStart } from "../timeline/touch.ts";
import {
  ViewFollower,
  followedView,
  type PlayheadMove,
  type PlayState,
} from "../timeline/follow.ts";
import { Emitter } from "../workbench/emitter.ts";
import { KeyArea } from "./area.ts";
import type { KeyframeEditor, ShownClips } from "./editor.ts";
import { LANE_HEIGHT, laneAt, lanesOfTracks, type Lane } from "./lanes.ts";
import {
  SOUND_ROW_FOLDED,
  SOUND_ROW_HEIGHT,
  soundMemoryIn,
  soundPictureOf,
  type SoundMemory,
  type SoundPicture,
} from "./sound-row.ts";

const SNAP_REACH = 8;
const ZOOM_STEP = 1.5;
/** Room after the end, as on the timeline, and under the last lane. */
const TAIL_SHARE = 0.25;
const BOTTOM_MARGIN = 48;
const FIT_SHARE = 0.95;
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
  /** Rows are this much taller for the size of words people chose, apart from their zoom. */
  #sizeScale = 1;
  /** Keeps the view along with the playhead, as the timeline sets it. */
  readonly #follower: ViewFollower;
  #width = 0;
  #height = 0;
  #scrollY = 0;
  #gesture: Gesture | undefined;
  /** A drag scrolled the view by itself, see `TimelineEditor.scrollDuringDrag`. */
  #dragScrolled = false;
  /** What is selected is listed here, wherever it is. */
  readonly shownClips: ShownClips = () => true;
  /** The row of sound at the top: folded or not, and the track it shows by itself, if one. */
  #soundFolded = false;
  #soundTrack: string | undefined;
  /** Goes up when waveforms arrive, which the drawing has to show. */
  #soundsArrived = 0;
  #soundKnown: {
    readonly by: readonly unknown[];
    readonly picture: SoundPicture | undefined;
  } = { by: [], picture: undefined };
  #peaksOf: (clip: string) => Uint8Array | undefined = () => undefined;

  constructor(keyframes: KeyframeEditor, timeline: TimelineEditor) {
    super(keyframes);
    this.#timeline = timeline;
    this.#follower = new ViewFollower(
      followedView({
        width: () => this.#width,
        pixelsPerSecond: () => this.#pixelsPerSecond,
        scrollX: () => this.#scrollX,
        frame: () => this.frame,
        fps: () => this.model?.rate.fps ?? 30,
        lastFrame: () => (this.model ? Math.round(this.model.duration * this.model.rate.fps) : 0),
        end: () => this.visibleDuration,
        contentWidth: () => this.contentWidth,
        placeX: (x) => this.#placeX(x),
      }),
      () => timeline.getSnapshot().follow,
      timeline.followClock,
      this,
    );
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
    const [low, high] = this.#zoomRange();
    return clamp((Math.max(this.#fitWidth, 1) * FIT_SHARE) / duration, low, high);
  }

  /** Holding the playhead in the middle, all of it fits in half of the view, as on the timeline. */
  get #fitWidth(): number {
    return this.#follower.centred ? this.#width / 2 : this.#width;
  }

  #zoomRange(): readonly [number, number] {
    const { model } = this;
    return zoomRange(this.#fitWidth, model?.duration ?? 1, model?.rate.fps ?? 30);
  }

  /** How far across it can scroll, see `TimelineEditor.scrollRange`. */
  get scrollRange(): { readonly min: number; readonly max: number } {
    return this.#follower.range();
  }

  get pinnedPlayhead(): boolean {
    return this.#follower.centred;
  }

  get followMode(): "off" | "page" | "center" {
    return this.#timeline.followMode;
  }

  /** How much taller the rows of keys are than usual. */
  get rowScale(): number {
    return this.#rowScale;
  }

  get #keyHeight(): number {
    return Math.round(LANE_HEIGHT * this.#rowScale * this.#sizeScale);
  }

  xAt(seconds: number): number {
    return seconds * this.pixelsPerSecond - this.scrollX;
  }

  timeAt(x: number): number {
    return (x + this.scrollX) / this.pixelsPerSecond;
  }

  laneY(y: number): number {
    return y - this.lanesTop + this.#scrollY;
  }

  screenY(laneTop: number): number {
    return this.lanesTop - this.#scrollY + laneTop;
  }

  override get lanesTop(): number {
    return RULER_HEIGHT + this.soundHeight;
  }

  /* The row of sound. */

  /** What the row of sound shows, or nothing when there is no sound and so no row. */
  get sound(): SoundPicture | undefined {
    const { model } = this;
    const state = this.keyframes.state;
    const by = [state, model, this.#soundTrack];
    const known = this.#soundKnown;
    if (by.every((item, index) => item === known.by[index])) return known.picture;
    const picture = state && model ? soundPictureOf(state, model, this.#soundTrack) : undefined;
    this.#soundKnown = { by, picture };
    return picture;
  }

  get soundFolded(): boolean {
    return this.#soundFolded;
  }

  /** How tall the row of sound is on screen: nothing without sound. */
  get soundHeight(): number {
    if (!this.sound) return 0;
    const height = this.#soundFolded ? SOUND_ROW_FOLDED : SOUND_ROW_HEIGHT;
    return Math.round(height * this.#sizeScale);
  }

  foldSound(folded: boolean): void {
    if (folded === this.#soundFolded) return;
    this.#soundFolded = folded;
    this.#clampScroll();
    this.#viewChanged();
  }

  /** Shows one track by itself, or all that is heard again without one. */
  pickSoundTrack(track: string | undefined): void {
    if (track === this.#soundTrack) return;
    this.#soundTrack = track;
    this.#viewChanged();
  }

  /** What to keep of the row of sound for this window. */
  get soundMemory(): SoundMemory {
    // A track that is gone is forgotten. Without any sound there is nothing to tell, so it stays.
    const { sound } = this;
    const track = sound ? sound.track : this.#soundTrack;
    return {
      ...(this.#soundFolded && { folded: true as const }),
      ...(track !== undefined && { track }),
    };
  }

  /** Where the waveform of a clip comes from. It can show up later. */
  setPeaksSource(peaksOf: (clip: string) => Uint8Array | undefined): void {
    this.#peaksOf = peaksOf;
    this.soundsArrived();
  }

  peaksOf(clip: string): Uint8Array | undefined {
    return this.#peaksOf(clip);
  }

  /** Waveforms came, so the row shows them. */
  soundsArrived(): void {
    this.#soundsArrived += 1;
    this.keyframes.redrawTab();
  }

  override get whatIsDrawn(): readonly unknown[] {
    return [...super.whatIsDrawn, this.sound, this.soundHeight, this.#soundsArrived];
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
    return Math.max(bottom + this.lanesTop + BOTTOM_MARGIN, this.#height);
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
    this.#follower.resized();
    this.keyframes.redrawTab();
  }

  #clampScroll(): void {
    const { min, max } = this.#follower.range();
    this.#scrollY = clamp(this.#scrollY, 0, this.contentHeight - this.#height);
    this.#scrollX = clamp(this.#scrollX, min, max);
  }

  /**
   * Scrolls as people do, see `TimelineEditor.setScroll`: holding the playhead in the middle, going
   * across moves the playhead of the timeline. What this scrolls by itself goes through `#placeX`.
   */
  setScroll(x: number, y: number, since = this.#timeline.followClock.now()): void {
    const dx = x - this.#scrollX;
    const timeline = this.#timeline;
    const outcome = dx === 0 ? undefined : this.#follower.scrolled(dx, since, timeline.playState);
    this.#scrollY = y;
    if (outcome?.kind === "scrub") {
      timeline.pause();
      this.#clampScroll();
      timeline.scrubTo(outcome.frame, this, "scroll");
      this.#viewChanged();
      return;
    }
    if (outcome?.kind !== "drop") this.#scrollX = x;
    this.#clampScroll();
    this.#viewChanged();
  }

  #placeX(x: number): void {
    const before = this.#scrollX;
    this.#scrollX = x;
    this.#clampScroll();
    if (this.#scrollX !== before) this.#viewChanged();
  }

  zoomAround(x: number, factor: number): void {
    if (this.#pixelsPerSecond === 0) return;
    const around = this.#follower.zoomCenter(x, this.#timeline.playState);
    const moment = this.timeAt(around);
    const [low, high] = this.#zoomRange();
    this.#pixelsPerSecond = clamp(this.#pixelsPerSecond * factor, low, high);
    this.#scrollX = moment * this.#pixelsPerSecond - around;
    this.#clampScroll();
    this.#follower.pin();
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
    this.#follower.pin();
    this.#viewChanged();
  }

  #zoomCenter(): number {
    const { model } = this;
    if (!model) return 0;
    const x = this.xAt(this.frame / model.rate.fps);
    return x >= 0 && x <= this.#width ? x : this.#width / 2;
  }

  setSizeScale(scale: number): void {
    if (scale === this.#sizeScale || !(scale > 0)) return;
    this.#sizeScale = scale;
    this.relist();
    this.#clampScroll();
    this.#viewChanged();
  }

  /** Changes the height of the rows of keys while what is at height `y` stays where it is. */
  zoomRowsAround(y: number, factor: number): void {
    if (this.#gesture) return;
    const scale = clamp(this.#rowScale * factor, MIN_ROW_SCALE, MAX_ROW_SCALE);
    if (scale === this.#rowScale) return;
    const top = this.lanesTop;
    const inLanes = this.laneY(Math.max(y, top));
    const lane = laneAt(this.#lanes, inLanes);
    const share = lane ? (inLanes - lane.top) / lane.height : 0;
    const before = this.#rowScale;
    this.#rowScale = scale;
    this.relist();
    const after = lane && this.#lanes.find(({ id }) => id === lane.id);
    const target = after ? after.top + share * after.height : (inLanes * scale) / before;
    this.#scrollY = target - (Math.max(y, top) - top);
    this.#clampScroll();
    this.#viewChanged();
  }

  rowsTaller(): void {
    this.zoomRowsAround(this.lanesTop, ROW_SCALE_STEP);
  }

  rowsShorter(): void {
    this.zoomRowsAround(this.lanesTop, 1 / ROW_SCALE_STEP);
  }

  /**
   * The playhead of the timeline moved. This follows it as the timeline does, with the same setting:
   * behind another tab it waits until it shows, see `ViewFollower`.
   */
  followPlayhead(move: PlayheadMove | undefined, play: PlayState): void {
    if (move) this.#follower.moved(move, play);
  }

  /** Following was set another way, from `before`. */
  followChanged(before: { readonly on: boolean; readonly mode: "page" | "center" }): void {
    this.#follower.changed(before);
    this.#clampScroll();
    this.#viewChanged();
  }

  /** Playing started. */
  playStarted(play: PlayState): void {
    this.#follower.started(play);
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
  adoptView(view: OwnView | undefined, rowScale: unknown, sound?: unknown): void {
    const { folded, track } = soundMemoryIn(sound);
    this.#soundFolded = folded === true;
    this.#soundTrack = track;
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
    this.#clampScroll();
    this.#follower.pin();
  }

  /* The mouse. */

  setTouchInput(on: boolean): void {
    this.setTouch(on);
  }

  hover(pointer: Pointer): string {
    return pointer.y < this.lanesTop ? "pointer" : this.cursorAt(pointer);
  }

  leave(): void {}

  press(pointer: Pointer): void {
    const { model } = this;
    if (!model) return;
    this.#cancelGesture();
    this.#follower.pressed();
    this.#gesture =
      pointer.y < this.lanesTop
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
    this.#afterDrag(gesture);
  }

  /** As on the timeline: in the centred way a drag that scrolled leaves the playhead in the middle. */
  #afterDrag(gesture: Gesture | undefined): void {
    const scrolled = this.#dragScrolled && !(gesture instanceof ScrubGesture);
    this.#dragScrolled = false;
    const { model } = this;
    if (scrolled && model && this.#follower.centred) {
      const frame = Math.round(Math.max(this.timeAt(this.#width / 2), 0) * model.rate.fps);
      this.#timeline.scrubTo(frame, this, "scroll");
    }
    this.#follower.released(this.#timeline.playState);
  }

  cancelDrag(): boolean {
    if (!this.#gesture) return false;
    this.#cancelGesture();
    return true;
  }

  #cancelGesture(): void {
    const gesture = this.#gesture;
    gesture?.cancel();
    this.#gesture = undefined;
    if (gesture) this.#afterDrag(gesture);
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
    this.#follower.stopGliding();
    if (dx !== 0) this.#dragScrolled = true;
    this.#scrollX += dx;
    if (reachesRows) this.#scrollY += dy;
    this.#clampScroll();
    this.#viewChanged();
    this.#gesture.move(pointer);
  }

  touchAt(pointer: Pointer): TouchStart {
    return pointer.y < this.lanesTop ? "grab" : this.touchAtLanes(pointer);
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
      seek: (frame: number) => timeline.scrubTo(frame, this),
    };
  }
}
