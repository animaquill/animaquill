import type { ClipNode } from "@animaquill/core";
import type { LaneKeys } from "../timeline/actions.ts";
import { RULER_HEIGHT, type RowExtras, type TimelineEditor } from "../timeline/editor.ts";
import type { Gesture, Pointer } from "../timeline/gestures.ts";
import type { ClipBox, Row, TimelineModel } from "../timeline/model.ts";
import type { Theme } from "../timeline/stage-painter.ts";
import type { TouchStart } from "../timeline/touch.ts";
import { Emitter } from "../workbench/emitter.ts";
import { KeyArea } from "./area.ts";
import {
  RangeGesture,
  barOf,
  cursorOfPart,
  paintRangeBars,
  partAt,
  type RangeHost,
  type RangePreview,
} from "./effect-ranges.ts";
import type { KeyframeEditor, ShownClips } from "./editor.ts";
import { lanesOfClip, laneAt, type Lane, type LaneRules } from "./lanes.ts";

const SNAP_REACH = 8;

const NO_LANES: readonly Lane[] = [];

/** What is left of a list of lanes once they all start at a height. */
const bottomOf = (lanes: readonly Lane[], top: number) => {
  const last = lanes.at(-1);
  return last ? last.top + last.height : top;
};

/**
 * Keys on the timeline itself. A clip that is opened shows its properties in the room under its
 * track, with the same rows and the same keys as the keyframe tab.
 */
export class TimelineLanes extends KeyArea implements RowExtras, LaneKeys {
  readonly #timeline: TimelineEditor;
  readonly #lanesChanged = new Emitter();
  readonly #open = new Set<string>();
  #lanes = NO_LANES;
  #range: RangePreview | undefined;

  constructor(keyframes: KeyframeEditor, timeline: TimelineEditor) {
    super(keyframes);
    this.#timeline = timeline;
  }

  subscribeLanes = this.#lanesChanged.subscribe;
  getLanes = (): readonly Lane[] => this.#lanes;

  get lanes(): readonly Lane[] {
    return this.#lanes;
  }

  get width(): number {
    return this.#timeline.width;
  }

  get screenHeight(): number {
    return this.#timeline.height;
  }

  get scrollX(): number {
    return this.#timeline.scrollX;
  }

  get scrollY(): number {
    return this.#timeline.scrollY;
  }

  get pixelsPerSecond(): number {
    return this.#timeline.pixelsPerSecond;
  }

  xAt(seconds: number): number {
    return this.#timeline.xAt(seconds);
  }

  timeAt(x: number): number {
    return this.#timeline.timeAt(x);
  }

  laneY(y: number): number {
    return this.#timeline.laneAt(y);
  }

  screenY(laneTop: number): number {
    return RULER_HEIGHT - this.#timeline.scrollY + laneTop;
  }

  snapDistance(pointer: Pointer): number {
    const { snapping } = this.#timeline.getSnapshot();
    return snapping && !pointer.alt ? SNAP_REACH / this.pixelsPerSecond : 0;
  }

  /* Which clips are open. */

  get opened(): readonly string[] {
    return [...this.#open];
  }

  forgetAll(): void {
    this.#open.clear();
  }

  openAll(clips: readonly string[]): void {
    for (const clip of clips) this.#open.add(clip);
  }

  get holdsDrag(): boolean {
    if (this.#range !== undefined) return true;
    return this.keyframes.preview !== undefined && this.keyframes.isPreviewOf(this);
  }

  /* When effects work: a bar in the row of each, see effect-ranges.ts. */

  /** The bar of an effect being dragged, where it is so far. */
  get rangePreview(): RangePreview | undefined {
    return this.#range;
  }

  /** The bar under a point on screen, and which part of it, on a track that is not locked. */
  #barAt(pointer: Pointer) {
    if (pointer.y < RULER_HEIGHT) return undefined;
    const lane = laneAt(this.#lanes, this.laneY(pointer.y));
    if (!lane || lane.row.track.locked === true) return undefined;
    const bar = barOf(lane, this.screenY(lane.top), (seconds) => this.xAt(seconds), this.#range);
    const part = bar && partAt(bar, pointer.x, pointer.y);
    return bar && part && { ...bar, part };
  }

  #pressBar(pointer: Pointer): Gesture | undefined {
    const hit = this.#barAt(pointer);
    const rate = this.#timeline.model?.rate;
    if (!hit || !rate) return undefined;
    const host: RangeHost = {
      rate,
      timeAt: (x) => this.timeAt(x),
      show: (preview) => {
        this.#range = preview;
        this.#timeline.redraw();
      },
      commit: (clip, effect, from, to) => {
        this.#timeline.setEffectRange(clip, effect, from, to);
      },
    };
    return new RangeGesture(host, hit.box, hit.effect, hit.part, pointer);
  }

  /** Draws the bars of the effects of the rows on screen. */
  paintRanges(context: CanvasRenderingContext2D, theme: Theme): void {
    const lanes = this.lanesBetween(this.laneY(RULER_HEIGHT), this.laneY(this.screenHeight));
    paintRangeBars(context, theme, lanes, {
      screenY: (top) => this.screenY(top),
      xAt: (seconds) => this.xAt(seconds),
      preview: this.#range,
    });
  }

  canOpen({ clip }: ClipBox): boolean {
    return this.keyframes.nodeOf(this.keyframes.shown(clip)).children.length > 0;
  }

  isOpen({ id }: ClipBox): boolean {
    return this.#open.has(id);
  }

  toggle({ id }: ClipBox): void {
    if (!this.#open.delete(id)) this.#open.add(id);
    this.keyframes.toggleOpenInTimeline();
  }

  toggleLane(lane: Lane): void {
    if (lane.node.kind === "clip" && lane.box) this.toggle(lane.box);
    else this.keyframes.toggleOpen(lane.id);
  }

  /** A clip is open here as long as it shows here at all. */
  get #rules(): LaneRules {
    const { laneRules } = this.keyframes;
    return { ...laneRules, isOpen: (node) => node.kind === "clip" || laneRules.isOpen(node) };
  }

  #nodesOf(model: TimelineModel, row: Row): readonly ClipNode[] {
    return row.clips.flatMap((box) => {
      if (!this.#open.has(box.id)) return [];
      const node = this.keyframes.nodeOf(this.keyframes.shown(box.clip));
      return node.children.length > 0 && model.boxes.has(box.id) ? [node] : [];
    });
  }

  /** The lanes of all that is open under a row, from a height on. */
  #lanesUnder(model: TimelineModel, row: Row, top: number): readonly Lane[] {
    const lanes: Lane[] = [];
    let next = top;
    for (const node of this.#nodesOf(model, row)) {
      const own = lanesOfClip(model, node, row, next, this.#rules);
      lanes.push(...own);
      next = bottomOf(own, next);
    }
    return lanes;
  }

  /**
   * Asks for the room the lanes need, and then places them. Room comes first: it moves the rows, and
   * where the lanes go depends on those.
   */
  relist(): void {
    const before = this.#timeline.model;
    if (!before) {
      this.#setLanes(NO_LANES);
      return;
    }
    const room = new Map<string, number>();
    for (const row of before.rows) {
      const height = bottomOf(this.#lanesUnder(before, row, 0), 0);
      if (height > 0) room.set(row.id, height);
    }
    this.#timeline.setRoomBelow(room);
    const model = this.#timeline.model;
    if (!model) return;
    const lanes = model.rows.flatMap((row) => this.#lanesUnder(model, row, row.top + row.height));
    this.#setLanes(lanes);
  }

  #setLanes(lanes: readonly Lane[]): void {
    if (lanes.length === 0 && this.#lanes.length === 0) return;
    this.#lanes = lanes;
    this.#lanesChanged.emit();
    this.#timeline.redraw();
  }

  /* What the keys of the timeline mean for keys. */

  /** Only keys of clips that are open here show here. */
  readonly shownClips: ShownClips = (clip) => this.#open.has(clip);

  get hasSelection(): boolean {
    return this.keyframes.selection.size > 0;
  }

  get canChangeSelection(): boolean {
    return this.keyframes.movingChannels(this.shownClips).length > 0;
  }

  get hasClipboard(): boolean {
    return this.keyframes.getSnapshot().hasClipboard;
  }

  nudge(frames: number): void {
    this.keyframes.nudge(frames, this.shownClips);
  }

  deleteSelected(): void {
    this.keyframes.deleteSelected(this.shownClips);
  }

  copySelected(): void {
    this.keyframes.copySelected(this.shownClips);
  }

  cutSelected(): void {
    this.keyframes.cutSelected(this.shownClips);
  }

  paste(): void {
    this.keyframes.paste();
  }

  /* The mouse, for as far as it is about lanes. */

  /**
   * Whether a place is about keys: a row of them, or a handle of a selected key, which can reach
   * up over the row of a clip and is on top of it.
   */
  #isOnLanes(pointer: Pointer): boolean {
    if (pointer.y < RULER_HEIGHT) return false;
    return laneAt(this.#lanes, this.laneY(pointer.y)) !== undefined || this.isOnHandle(pointer);
  }

  press(pointer: Pointer): Gesture | undefined {
    const bar = this.#pressBar(pointer);
    if (bar) return bar;
    if (this.#isOnLanes(pointer)) return this.pressLanes(pointer);
    // What people do next is about clips. The ruler is about neither.
    if (pointer.y >= RULER_HEIGHT) this.keyframes.clearSelection();
    return undefined;
  }

  hover(pointer: Pointer): string | undefined {
    const bar = this.#barAt(pointer);
    if (bar) return cursorOfPart(bar.part);
    return this.#isOnLanes(pointer) ? this.cursorAt(pointer) : undefined;
  }

  touchAt(pointer: Pointer): TouchStart | undefined {
    return this.#isOnLanes(pointer) ? this.touchAtLanes(pointer) : undefined;
  }

  hold(pointer: Pointer): boolean {
    if (!this.#isOnLanes(pointer)) return false;
    this.holdLanes(pointer);
    return true;
  }

  setTouchInput(on: boolean): void {
    this.setTouch(on);
  }
}
