import {
  clipOffset,
  clipStart,
  effectiveProperties,
  entryOf,
  secondsOf,
  type ClipPropertyEdit,
} from "@animaquill/core";
import {
  ZERO,
  add,
  compare,
  formatTime,
  fromSeconds,
  subtract,
  toSeconds,
  type Key,
  type Rational,
} from "@animaquill/schema";
import { formatVolume } from "../properties/sound-scale.ts";
import {
  RULER_HEIGHT,
  type ClipBodyHit,
  type ClipExtras,
  type TimelineEditor,
} from "../timeline/editor.ts";
import { frameAt, frameTime } from "../timeline/frames.ts";
import {
  hasMoved,
  landOn,
  type Gesture,
  type Landing,
  type Pointer,
} from "../timeline/gestures.ts";
import { clipAreaOf, type ClipBox, type Row, type TimelineModel } from "../timeline/model.ts";
import { snapPointsOf, type SnapPoints } from "../timeline/snap.ts";
import type { Theme } from "../timeline/stage-painter.ts";
import {
  KEY_HALF,
  VOLUME_PATH,
  addsKey,
  exactVolume,
  gainOfLine,
  keptVolume,
  keyAt,
  lineHitAt,
  raisedKeys,
  secondsOfClock,
  showsLine,
  volumeAtY,
  volumeLineOf,
  yOfVolume,
  type LineArea,
  type LineHit,
  type VolumeLine,
} from "../timeline/volume-line.ts";
import { momentOfKey } from "./area.ts";
import type { KeyframeEditor } from "./editor.ts";
import { KeySelection, type KeyRef } from "./selection.ts";

/** How close to something a drag along the time sticks to it, in pixels. */
const SNAP_REACH = 8;
/** Without snapping a key can go anywhere, to the millisecond. */
const FREE_STEPS_PER_SECOND = 1000;
/** Up and down this far from where a key was, its value stays while it goes along the time. */
const VALUE_STICK = 4;
/** The label of the volume while it is dragged: above the line, by this much. */
const LABEL_ABOVE = 12;
const LABEL_PADDING = 4;

const SOUNDING = new Set(["audio", "sound"]);

/** The volume being dragged, said next to the line. */
interface Label {
  readonly clip: string;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/**
 * The volume line of clips of sound on the timeline (docs/design/audio-mixing.md, 1.1): a line over
 * the waveform at the volume of the clip, which a drag moves up and down. Ctrl (Cmd on a Mac) and
 * a click on it puts a key there, with what the line is there, so that nothing sounds otherwise.
 * Keys are those of the keyframes: they select as those do, Delete takes them away, and a right
 * click says how they go on. A line between two keys takes both along.
 */
export class VolumeLines implements ClipExtras {
  readonly keyframes: KeyframeEditor;
  readonly timeline: TimelineEditor;
  #hover: { readonly clip: string; readonly hit: LineHit; readonly adding: boolean } | undefined;
  #label: Label | undefined;
  /** The clip whose line is being dragged, which is drawn as held. */
  #held: string | undefined;

  constructor(keyframes: KeyframeEditor, timeline: TimelineEditor) {
    this.keyframes = keyframes;
    this.timeline = timeline;
  }

  /** Whether a clip has a volume line. */
  has(box: ClipBox): boolean {
    return SOUNDING.has(box.clip.source.kind);
  }

  /** Where the clip of a row is on screen, up and down. */
  areaOf(row: Row): LineArea {
    return clipAreaOf(RULER_HEIGHT - this.timeline.scrollY + row.top, row);
  }

  /** The line as it shows: what is tried, and what a drag shows on top. */
  lineOf(box: ClipBox): VolumeLine {
    const shown = this.keyframes.shown(box.clip);
    return volumeLineOf(this.keyframes.shownValue(shown, VOLUME_PATH));
  }

  /** The line without what a drag shows: what a drag starts from with every step. */
  savedLineOf(box: ClipBox): VolumeLine {
    const shown = this.keyframes.shown(box.clip);
    return volumeLineOf(entryOf(effectiveProperties(shown), VOLUME_PATH));
  }

  #hitOf(pointer: Pointer, hit: ClipBodyHit | undefined): LineHit | undefined {
    if (!hit || !this.has(hit.box) || this.keyframes.comparing) return undefined;
    if (!this.keyframes.canMove(hit.box.id)) return undefined;
    return lineHitAt(this.timeline, hit.box, this.areaOf(hit.row), this.lineOf(hit.box), pointer);
  }

  hover(pointer: Pointer, hit: ClipBodyHit | undefined): string | undefined {
    const found = hit && this.#hitOf(pointer, hit);
    const next =
      found && hit ? { clip: hit.box.id, hit: found, adding: addsKey(pointer) } : undefined;
    const before = this.#hover;
    if (
      before?.clip !== next?.clip ||
      before?.hit.kind !== next?.hit.kind ||
      before?.adding !== next?.adding
    ) {
      this.#hover = next;
      this.timeline.redraw();
    }
    if (!found) return undefined;
    if (found.kind === "key") return "move";
    return addsKey(pointer) ? "copy" : "ns-resize";
  }

  press(pointer: Pointer, hit: ClipBodyHit): Gesture | undefined {
    const found = this.#hitOf(pointer, hit);
    if (!found) return undefined;
    const { box, row } = hit;
    if (found.kind === "key") {
      this.#pressKey(box.id, found.time, pointer.shift);
      return new VolumeKeyGesture(this, box, row, found.time, pointer);
    }
    if (addsKey(pointer)) {
      const time = this.#addKey(box, found.clock);
      return time === undefined ? undefined : new VolumeKeyGesture(this, box, row, time, pointer);
    }
    return new VolumeLineGesture(this, box, row, found, pointer);
  }

  menu(pointer: Pointer, hit: ClipBodyHit): { x: number; y: number } | undefined {
    const found = this.#hitOf(pointer, hit);
    if (found?.kind !== "key") return undefined;
    const ref = this.#ref(hit.box.id, found.time);
    if (!this.keyframes.selection.has(ref)) this.keyframes.select(KeySelection.of([ref]));
    const key = keyAt(this.lineOf(hit.box), found.time);
    const value = typeof key?.value === "number" ? key.value : 0;
    const x = this.timeline.xAt(secondsOfClock(hit.box, hit.box.start, secondsOf(found.time)));
    return { x, y: yOfVolume(this.areaOf(hit.row), value) };
  }

  #ref = (clip: string, time: string): KeyRef => ({ clip, path: VOLUME_PATH, time });

  /** A press on a key selects it; with Shift it goes in or out of what is selected. */
  #pressKey(clip: string, time: string, adding: boolean): void {
    const ref = this.#ref(clip, time);
    const { selection } = this.keyframes;
    if (adding || this.keyframes.multiSelecting) {
      this.keyframes.select(selection.has(ref) ? selection.without([ref]) : selection.with([ref]));
    } else if (!selection.has(ref)) {
      this.keyframes.select(KeySelection.of([ref]));
    }
  }

  /**
   * Puts a key on the line at the frame nearest to a reading of the clock, with what the line is
   * there, and selects it. Returns its time, or nothing when it could not be.
   */
  #addKey(box: ClipBox, clock: number): string | undefined {
    const { model } = this.timeline;
    if (!model) return undefined;
    const frame = frameAt(secondsOfClock(box, box.start, clock), model.rate);
    const moment = subtract(
      add(frameTime(frame, model.rate), clipOffset(box.clip)),
      clipStart(box.clip),
    );
    if (compare(moment, ZERO) < 0) return undefined;
    const time = formatTime(moment);
    const value = exactVolume(this.savedLineOf(box), toSeconds(moment));
    const edit: ClipPropertyEdit = {
      owner: { clip: box.id },
      path: VOLUME_PATH,
      op: "setKey",
      time,
      value,
    };
    const selected = KeySelection.of([this.#ref(box.id, time)]);
    return this.keyframes.commitMove([edit], selected) ? time : undefined;
  }

  /** What a drag shows next to the line, and which line it holds. */
  show(clip: string | undefined, label?: Label): void {
    this.#held = clip;
    this.#label = label;
    this.timeline.redraw();
  }

  gainOf(box: ClipBox): ((seconds: number) => number) | undefined {
    if (!this.has(box)) return undefined;
    const line = this.lineOf(box);
    if (line.keys.length === 0 && line.at(0) === 0) return undefined;
    return (seconds) => gainOfLine(line, seconds - box.start + box.offset);
  }

  paint(
    context: CanvasRenderingContext2D,
    box: ClipBox,
    look: { readonly start: number; readonly end: number },
    area: {
      readonly left: number;
      readonly top: number;
      readonly height: number;
      readonly width: number;
    },
    on: string,
    theme: Theme,
  ): void {
    if (!this.has(box) || !showsLine(area.height)) return;
    const { timeline } = this;
    const line = this.lineOf(box);
    // A clip that moves takes its line along; an edge that moves uncovers what is there.
    const moved = look.end - look.start === box.end - box.start ? look.start - box.start : 0;
    const first = Math.max(Math.floor(area.left), 0);
    const last = Math.min(Math.ceil(area.left + area.width), timeline.width);
    if (last <= first) return;
    const clockAt = (x: number) => timeline.timeAt(x) - moved - box.start + box.offset;
    const held = this.#held === box.id || this.#hover?.clip === box.id;
    context.save();
    context.beginPath();
    context.rect(area.left, area.top, area.width, area.height);
    context.clip();
    const alpha = context.globalAlpha;
    context.strokeStyle = on;
    context.globalAlpha = alpha * (held ? 1 : 0.85);
    context.lineWidth = held ? 2 : 1.25;
    context.beginPath();
    if (line.keys.length === 0) {
      const y = yOfVolume(area, line.at(0));
      context.moveTo(first, y);
      context.lineTo(last, y);
    } else {
      for (let x = first; x <= last; x += 1) {
        const y = yOfVolume(area, line.at(clockAt(x)));
        if (x === first) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
    }
    context.stroke();
    const { selection } = this.keyframes;
    // A selected key is larger, and the other way round: light on dark, dark on light.
    const other = on === "#000000" ? "#ffffff" : "#000000";
    for (const key of line.keys) {
      const x = timeline.xAt(secondsOfClock(box, box.start + moved, secondsOf(key.time)));
      if (x < first - KEY_HALF * 2 || x > last + KEY_HALF * 2) continue;
      const y = yOfVolume(area, typeof key.value === "number" ? key.value : 0);
      const selected = selection.has(this.#ref(box.id, key.time));
      const half = selected ? KEY_HALF + 1.5 : KEY_HALF;
      context.beginPath();
      context.moveTo(x, y - half);
      context.lineTo(x + half, y);
      context.lineTo(x, y + half);
      context.lineTo(x - half, y);
      context.closePath();
      context.fillStyle = selected ? other : on;
      context.globalAlpha = alpha;
      context.fill();
      context.lineWidth = selected ? 1.5 : 1;
      context.strokeStyle = selected ? on : other;
      context.globalAlpha = alpha * (selected ? 1 : 0.6);
      context.stroke();
      context.globalAlpha = alpha;
    }
    context.restore();
    const label = this.#label;
    if (label?.clip === box.id) this.#paintLabel(context, label, theme);
  }

  #paintLabel(context: CanvasRenderingContext2D, label: Label, theme: Theme): void {
    context.save();
    const width = context.measureText(label.text).width + LABEL_PADDING * 2;
    const height = 16 * theme.fontScale;
    const left = Math.min(Math.max(label.x - width / 2, 0), this.timeline.width - width);
    const top = Math.max(label.y - LABEL_ABOVE - height, RULER_HEIGHT);
    context.fillStyle = theme.background;
    context.globalAlpha = 0.9;
    context.beginPath();
    context.roundRect(left, top, width, height, 3);
    context.fill();
    context.globalAlpha = 1;
    context.fillStyle = theme.label;
    context.textBaseline = "middle";
    context.fillText(label.text, left + LABEL_PADDING, top + height / 2);
    context.restore();
  }
}

/** The reading of the clock of a clip at a moment on the timeline, as a key time. */
const clockTimeOf = (box: ClipBox, moment: Rational): string =>
  formatTime(add(subtract(moment, clipStart(box.clip)), clipOffset(box.clip)));

/**
 * Up and down with the line: without keys the volume of the clip, otherwise the keys around where
 * it was pressed. A click without a drag selects the clip, as a click on it anywhere else does.
 */
class VolumeLineGesture implements Gesture {
  readonly #lines: VolumeLines;
  readonly #box: ClipBox;
  readonly #row: Row;
  readonly #hit: Extract<LineHit, { kind: "line" }>;
  readonly #press: Pointer;
  /** What the line was where it was pressed, and how far the press was from it. */
  readonly #from: number;
  readonly #offset: number;
  #dragging = false;
  #edits: readonly ClipPropertyEdit[] = [];

  constructor(
    lines: VolumeLines,
    box: ClipBox,
    row: Row,
    hit: Extract<LineHit, { kind: "line" }>,
    press: Pointer,
  ) {
    this.#lines = lines;
    this.#box = box;
    this.#row = row;
    this.#hit = hit;
    this.#press = press;
    const line = lines.savedLineOf(box);
    this.#from = line.at(hit.clock);
    this.#offset = press.y - yOfVolume(lines.areaOf(row), this.#from);
  }

  move(pointer: Pointer): void {
    if (!this.#dragging && !hasMoved(this.#press, pointer)) return;
    this.#dragging = true;
    const lines = this.#lines;
    const box = this.#box;
    const area = lines.areaOf(this.#row);
    const wanted = keptVolume(volumeAtY(area, pointer.y - this.#offset));
    const { keys } = this.#hit;
    const edits = keys.length === 0 ? this.#write(wanted) : this.#raise(keys, wanted - this.#from);
    if (!edits) return;
    this.#edits = edits;
    lines.keyframes.previewEdits(edits);
    lines.show(box.id, {
      clip: box.id,
      x: pointer.x,
      y: yOfVolume(area, wanted),
      text: formatVolume(wanted),
    });
  }

  /** The volume of a clip without keys, at the playhead when it is on the clip, as a control does. */
  #write(value: number): readonly ClipPropertyEdit[] {
    const box = this.#box;
    const { timeline } = this.#lines;
    const { model } = timeline;
    if (!model) return [];
    // With automatic keys on, the playhead is where a key goes, as with every control.
    const playhead = frameTime(timeline.frame, model.rate);
    const seconds = toSeconds(playhead);
    const onClip = seconds >= box.start && seconds < box.end;
    const time = onClip
      ? clockTimeOf(box, playhead)
      : formatTime(fromSeconds(Math.max(this.#hit.clock, 0)));
    return [{ owner: { clip: box.id }, path: VOLUME_PATH, op: "write", time, value }];
  }

  /** The keys around the press, up or down by as much, as they are now. */
  #raise(times: readonly string[], by: number): readonly ClipPropertyEdit[] | undefined {
    const keys: readonly Key[] = this.#lines.savedLineOf(this.#box).keys;
    const raised = raisedKeys(keys, times, by);
    if (raised.length !== times.length) {
      this.cancel();
      this.#lines.keyframes.tellGone();
      return undefined;
    }
    return [{ owner: { clip: this.#box.id }, path: VOLUME_PATH, op: "putKeys", keys: raised }];
  }

  end(pointer: Pointer): void {
    const lines = this.#lines;
    if (!this.#dragging) {
      const { timeline } = lines;
      if (pointer.shift || timeline.getSnapshot().multiSelecting)
        timeline.addToSelection(this.#box.id);
      else timeline.selectOnly(this.#box.id);
      return;
    }
    this.move(pointer);
    lines.show(undefined);
    if (this.#edits.length > 0) lines.keyframes.commitMove(this.#edits, lines.keyframes.selection);
    else lines.keyframes.cancelEdits();
  }

  cancel(): void {
    this.#lines.keyframes.cancelEdits();
    this.#lines.show(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return !model.boxes.has(this.#box.id);
  }
}

/**
 * A key of the line, along the time and up and down. It lands on a frame or on what it snaps to,
 * as keys do in the keyframes; with Alt anywhere. Shift keeps it to the way it went furthest.
 */
class VolumeKeyGesture implements Gesture {
  readonly #lines: VolumeLines;
  readonly #box: ClipBox;
  readonly #row: Row;
  readonly #time: string;
  readonly #press: Pointer;
  readonly #seconds: number;
  readonly #exact: Rational;
  readonly #grabTime: number;
  readonly #from: number;
  readonly #points: SnapPoints | undefined;
  #dragging = false;
  #edits: readonly ClipPropertyEdit[] = [];
  #landed: string;

  constructor(lines: VolumeLines, box: ClipBox, row: Row, time: string, press: Pointer) {
    this.#lines = lines;
    this.#box = box;
    this.#row = row;
    this.#time = time;
    this.#landed = time;
    this.#press = press;
    this.#exact = momentOfKey(box.clip, time);
    this.#seconds = toSeconds(this.#exact);
    this.#grabTime = lines.timeline.timeAt(press.x);
    const key = keyAt(lines.savedLineOf(box), time);
    this.#from = typeof key?.value === "number" ? key.value : 0;
    const { model, frame } = lines.timeline;
    this.#points = model && snapPointsOf(model, frame, new Set());
  }

  move(pointer: Pointer): void {
    if (!this.#dragging && !hasMoved(this.#press, pointer)) return;
    this.#dragging = true;
    const lines = this.#lines;
    const box = this.#box;
    const area = lines.areaOf(this.#row);
    const across = Math.abs(pointer.x - this.#press.x);
    const down = pointer.y - this.#press.y;
    const along = !pointer.shift || across >= Math.abs(down);
    const landing = along ? this.#land(pointer) : undefined;
    const time = landing ? clockTimeOf(box, landing.exact()) : this.#time;
    const still = (pointer.shift && along) || Math.abs(down) < VALUE_STICK;
    const value = still
      ? this.#from
      : keptVolume(volumeAtY(area, yOfVolume(area, this.#from) + down));
    const key = keyAt(lines.savedLineOf(box), this.#time);
    if (!key) {
      this.cancel();
      lines.keyframes.tellGone();
      return;
    }
    const owner = { clip: box.id };
    const moved = time !== this.#time;
    this.#landed = time;
    const edits: ClipPropertyEdit[] = [];
    if (moved) {
      edits.push({
        owner,
        path: VOLUME_PATH,
        op: "moveKey",
        moves: [{ from: this.#time, to: time }],
      });
    }
    if (moved || value !== this.#from) {
      edits.push({ owner, path: VOLUME_PATH, op: "putKeys", keys: [{ ...key, time, value }] });
    }
    this.#edits = edits;
    if (edits.length === 0) lines.keyframes.cancelEdits();
    else lines.keyframes.previewEdits(edits);
    const x = lines.timeline.xAt(landing?.seconds ?? this.#seconds);
    lines.show(box.id, { clip: box.id, x, y: yOfVolume(area, value), text: formatVolume(value) });
  }

  #land(pointer: Pointer): Landing {
    const { timeline } = this.#lines;
    const start = this.#seconds;
    const wanted = start + timeline.timeAt(pointer.x) - this.#grabTime;
    const { snapping } = timeline.getSnapshot();
    const within = snapping && !pointer.alt ? SNAP_REACH / timeline.pixelsPerSecond : 0;
    const lowest = this.#box.start - this.#box.offset;
    if (Math.abs(wanted - start) < Math.max(within, 1 / FREE_STEPS_PER_SECOND)) {
      return { seconds: start, exact: () => this.#exact };
    }
    const { model } = timeline;
    let landing: Landing;
    if (pointer.alt || !model) {
      const seconds = Math.round(wanted * FREE_STEPS_PER_SECOND) / FREE_STEPS_PER_SECOND;
      landing = { seconds, exact: () => fromSeconds(Math.max(seconds, 0)) };
    } else {
      landing = landOn({ model }, wanted, this.#points?.nearest(wanted, within));
    }
    // Nothing goes before the clock of the clip starts.
    if (landing.seconds < lowest) {
      const exact = subtract(clipStart(this.#box.clip), clipOffset(this.#box.clip));
      return { seconds: lowest, exact: () => exact };
    }
    return landing;
  }

  end(pointer: Pointer): void {
    if (!this.#dragging) return;
    this.move(pointer);
    const { keyframes } = this.#lines;
    this.#lines.show(undefined);
    if (this.#edits.length === 0) return;
    const from = { clip: this.#box.id, path: VOLUME_PATH, time: this.#time };
    const selection = keyframes.selection.without([from]).with([{ ...from, time: this.#landed }]);
    keyframes.commitMove(this.#edits, selection);
  }

  cancel(): void {
    this.#lines.keyframes.cancelEdits();
    this.#lines.show(undefined);
  }

  isStale(model: TimelineModel): boolean {
    return !model.boxes.has(this.#box.id);
  }
}
