import { SHAPE, channelOf, componentOf, sample, type Channel } from "@animaquill/core";
import type { Animation, Key, PropertySpec } from "@animaquill/schema";
import { formatNumber } from "../properties/scrub.ts";
import { RULER_HEIGHT } from "../timeline/editor.ts";
import { forEachBetween, type ClipBox } from "../timeline/model.ts";
import { paintRuler } from "../timeline/ruler.ts";
import { StagePainter, readTheme, type Theme } from "../timeline/stage-painter.ts";
import type { KeyArea, ShownHandle } from "./area.ts";
import { liftKey, withinSpec } from "./gestures.ts";
import { specOfLane, type Lane } from "./lanes.ts";
import { yIn, type ValueScale } from "./scale.ts";
import {
  KEY_EASED,
  KEY_HOLD,
  animationIn,
  firstFrom,
  indexAt,
  keyTableOf,
  type KeyTable,
} from "./tables.ts";
import type { KeyframesView } from "./view.ts";

/** Half the size of a key, and of a mark in a summary. */
const KEY_RADIUS = 5;
const SUMMARY_RADIUS = 4;
const HANDLE_RADIUS = 3;
const TAU = Math.PI * 2;
/** Keys closer than this are one mark. */
const MIN_MARK_GAP = 1;
/** Where a curve is worked out point by point, as far apart as this. */
const CURVE_STEP = 2;
/** Keys closer than this are drawn as one line from the lowest to the highest of them. */
const DENSE_GAP = 0.75;
const CURVE_WIDTH = 1.5;
/** Where the highest and the lowest value of a row made taller are written. */
const VALUE_LABEL_MARGIN = 4;
const VALUE_LABEL_OFFSET = 7;
const MIN_SEGMENT_LABEL = 24;
const TRIMMED_ALPHA = 0.4;
const GHOST_ALPHA = 0.35;
const PARENT_SHADE = "#00000033";
const CLIP_SPAN_ALPHA = 0.18;
const SEGMENT_ALPHA = 0.5;
/** How wide a step of the colors on the way from one key to the next is. */
const GRADIENT_STEP = 3;
const GRADIENT_ALPHA = 0.85;

/** What a value says, in words. */
export type ValueLabel = (spec: PropertySpec, value: unknown) => string;

function traceKey(path: Path2D, mark: number, x: number, y: number, radius: number): void {
  if (mark === KEY_HOLD) {
    const side = radius - 1;
    path.rect(x - side, y - side, side * 2, side * 2);
  } else if (mark === KEY_EASED) {
    path.moveTo(x + radius - 0.5, y);
    path.arc(x, y, radius - 0.5, 0, TAU);
  } else {
    path.moveTo(x, y - radius);
    path.lineTo(x + radius, y);
    path.lineTo(x, y + radius);
    path.lineTo(x - radius, y);
    path.closePath();
  }
}

/** Marks in the same look go together, so that a screen of them is a handful of calls. */
class Marks {
  readonly #looks = new Map<string, { color: string; alpha: number; path: Path2D }>();

  in(color: string, alpha = 1): Path2D {
    const id = `${color} ${alpha}`;
    let look = this.#looks.get(id);
    if (!look) this.#looks.set(id, (look = { color, alpha, path: new Path2D() }));
    return look.path;
  }

  fill(context: CanvasRenderingContext2D): void {
    const before = context.globalAlpha;
    for (const { color, alpha, path } of this.#looks.values()) {
      context.fillStyle = color;
      context.globalAlpha = alpha;
      context.fill(path);
    }
    context.globalAlpha = before;
  }
}

/** A stretch of the screen. */
interface Band {
  readonly y: number;
  readonly from: number;
  readonly to: number;
}

/** How the clock of a clip is on screen, and its values in a lane. */
interface Place {
  x(clock: number): number;
  clockAt(x: number): number;
  y(value: number): number;
}

/**
 * The curve of a number from one side of the screen to the other, the way it is worked out: lines,
 * steps for what holds, and the beziers themselves. Keys closer than a pixel are a line from the
 * lowest to the highest of them, so that thousands of them cost what a few do.
 */
function traceCurve(path: Path2D, channel: Channel, place: Place, left: number, right: number) {
  if (channel.kind === "still") {
    const y = place.y(channel.value as number);
    path.moveTo(left, y);
    path.lineTo(right, y);
    return;
  }
  const { times, shapes, handles, before, after } = channel;
  const values = channel.values as Float64Array;
  const last = times.length - 1;
  const xOf = (index: number) => place.x(times[index] as number);
  const valueOf = (index: number) => values[index] as number;
  let started = false;
  const to = (x: number, y: number) => {
    if (started) path.lineTo(x, y);
    else path.moveTo(x, y);
    started = true;
  };
  const sampled = (from: number, until: number) => {
    for (let x = from; x < until; x += CURVE_STEP) {
      to(x, place.y(sample(channel, place.clockAt(x)) as number));
    }
    to(until, place.y(sample(channel, place.clockAt(until)) as number));
  };
  const firstX = xOf(0);
  if (left < firstX) {
    if (before === "hold") to(left, place.y(valueOf(0)));
    else sampled(left, Math.min(firstX, right));
  }
  let index = Math.max(firstFrom(times, place.clockAt(left)) - 1, 0);
  const end = Math.min(firstFrom(times, place.clockAt(right)), last);
  to(xOf(index), place.y(valueOf(index)));
  while (index < end) {
    const x0 = xOf(index);
    const x1 = xOf(index + 1);
    if (x1 - x0 < DENSE_GAP) {
      let next = index + 1;
      let low = Math.min(valueOf(index), valueOf(next));
      let high = Math.max(valueOf(index), valueOf(next));
      while (next < end && xOf(next + 1) - x0 < 1) {
        next += 1;
        low = Math.min(low, valueOf(next));
        high = Math.max(high, valueOf(next));
      }
      to(x0, place.y(low));
      to(x0, place.y(high));
      to(xOf(next), place.y(valueOf(next)));
      index = next;
      continue;
    }
    const from = valueOf(index);
    const into = valueOf(index + 1);
    const shape = shapes[index];
    if (shape === SHAPE.hold) {
      to(x1, place.y(from));
      to(x1, place.y(into));
    } else if (shape === SHAPE.bezier) {
      const change = into - from;
      const at = index * 4;
      const width = x1 - x0;
      path.bezierCurveTo(
        x0 + (handles[at] as number) * width,
        place.y(from + (handles[at + 1] as number) * change),
        x0 + (handles[at + 2] as number) * width,
        place.y(from + (handles[at + 3] as number) * change),
        x1,
        place.y(into),
      );
    } else to(x1, place.y(into));
    index += 1;
  }
  const lastX = xOf(last);
  if (right > lastX) {
    if (after === "hold") to(right, place.y(valueOf(last)));
    else sampled(Math.max(lastX, left), right);
  }
}

/** Draws lanes wherever they are. It shows what the area says, and only what is on screen. */
export class LanePainter {
  readonly #area: KeyArea;
  readonly #labelOf: ValueLabel;

  constructor(area: KeyArea, labelOf: ValueLabel) {
    this.#area = area;
    this.#labelOf = labelOf;
  }

  paint(context: CanvasRenderingContext2D, theme: Theme, sharp: (value: number) => number): void {
    const area = this.#area;
    const lanes = area.lanesBetween(area.laneY(RULER_HEIGHT), area.laneY(area.screenHeight));
    if (lanes.length === 0) return;
    const marks = new Marks();
    const from = area.timeAt(0);
    const to = area.timeAt(area.width);
    const band: Omit<Band, "y"> = { from, to };
    for (const lane of lanes) {
      const y = area.screenY(lane.top);
      this.#background(context, theme, lane, y, sharp, band);
      this.#content(context, theme, lane, { ...band, y });
      this.#keys(theme, marks, lane, { ...band, y });
    }
    // Handles reach over other rows, and the keys they belong to are on top of them.
    this.#handles(context, theme);
    marks.fill(context);
  }

  #background(
    context: CanvasRenderingContext2D,
    theme: Theme,
    lane: Lane,
    y: number,
    sharp: (value: number) => number,
    { from, to }: Omit<Band, "y">,
  ): void {
    const area = this.#area;
    const { width } = area;
    const { height, box, row, node } = lane;
    context.fillStyle = row.track.locked ? theme.laneLocked : theme.lane;
    context.fillRect(0, y, width, height);
    if (node.kind !== "property") {
      context.fillStyle = PARENT_SHADE;
      context.fillRect(0, y, width, height);
    }
    if (box) {
      const left = sharp(area.xAt(box.start));
      const right = sharp(area.xAt(box.end));
      context.fillStyle = theme.outside;
      if (left > 0) context.fillRect(0, y, Math.min(left, width), height);
      if (right < width) context.fillRect(Math.max(right, 0), y, width, height);
      context.fillStyle = theme.tick;
      if (left >= 0 && left <= width) context.fillRect(left, y, 1, height);
      if (right >= 0 && right <= width) context.fillRect(right - 1, y, 1, height);
    } else {
      // A track shows where its clips are, which is what its keys are about.
      const alpha = context.globalAlpha;
      context.globalAlpha = alpha * CLIP_SPAN_ALPHA;
      context.fillStyle = theme.picture;
      let covered = Number.NEGATIVE_INFINITY;
      forEachBetween(row, from, to, ({ id, start, end }) => {
        const right = area.xAt(end);
        if (right <= covered || !lane.listed.has(id)) return;
        const left = Math.max(area.xAt(start), covered);
        context.fillRect(left, y + 2, Math.max(right - left, 1), height - 5);
        covered = Math.max(right, left + 1);
      });
      context.globalAlpha = alpha;
    }
    context.fillStyle = theme.line;
    context.fillRect(0, sharp(y + height) - 1, width, 1);
  }

  /**
   * What is in a lane apart from its keys: the curve of a number, or the values of what holds. A
   * part of a vector has the curve of its number, and the vector itself only its keys.
   */
  #content(context: CanvasRenderingContext2D, theme: Theme, lane: Lane, band: Band): void {
    const { node, box, component } = lane;
    const spec = specOfLane(lane);
    if (node.kind !== "property" || !box || !spec) return;
    const stored = this.#area.keyframes.shownValue(box.clip, node.spec.path) ?? node.spec.default;
    const animation = animationIn(component ? componentOf(stored, component.index) : stored);
    if (!animation) return;
    const shape = node.rows[component ? component.index + 1 : 0];
    if (shape?.band === "segments") {
      this.#segments(context, theme, lane, node.spec, box, animation, band);
      return;
    }
    if (shape?.band === "gradient") {
      this.#gradient(context, lane, node.spec, box, animation, band);
      return;
    }
    if (shape?.curve !== "value") return;
    const scale = this.#area.scaleOf(lane, box);
    const channel = channelOf(animation, spec.type);
    if (!scale || !channel) return;
    if (lane.tall) this.#valueAxis(context, theme, spec, box, scale, band);
    this.#curve(context, theme, lane, box, animation, channel, scale, band);
  }

  /** What holds its value from one key to the next shows that value, as tall as its row is. */
  #segments(
    context: CanvasRenderingContext2D,
    theme: Theme,
    lane: Lane,
    spec: PropertySpec,
    box: ClipBox,
    animation: Animation,
    { y, from, to }: Band,
  ): void {
    const area = this.#area;
    const alpha = context.globalAlpha;
    const colors = [theme.picture, theme.sound, theme.caption];
    const top = y + 3;
    const height = lane.height - 7;
    const { seconds } = keyTableOf(animation);
    const toClock = box.offset - box.start;
    const first = Math.max(firstFrom(seconds, from + toClock) - 1, 0);
    for (let index = first; index < seconds.length; index += 1) {
      const start = (seconds[index] as number) - toClock;
      if (start > to) break;
      const next = seconds[index + 1];
      const left = area.xAt(start);
      const right = Math.max(area.xAt(next === undefined ? box.end : next - toClock), left);
      const { value } = animation.keys[index] as Key;
      context.globalAlpha = alpha * SEGMENT_ALPHA;
      context.fillStyle = value === false ? theme.tick : (colors[index % colors.length] as string);
      context.fillRect(left, top, right - left, height);
      context.globalAlpha = alpha;
      if (right - left >= MIN_SEGMENT_LABEL) {
        context.save();
        context.beginPath();
        context.rect(left, top, right - left, height);
        context.clip();
        context.fillStyle = theme.label;
        const x = Math.max(left, 0) + KEY_RADIUS * 2;
        context.fillText(this.#labelOf(spec, value), x, top + height / 2);
        context.restore();
      }
    }
  }

  /**
   * A color shows what it is on the way from one key to the next, as a band under its keys. It goes
   * as far as the clip does: outside of it nothing shows the color.
   */
  #gradient(
    context: CanvasRenderingContext2D,
    lane: Lane,
    spec: PropertySpec,
    box: ClipBox,
    animation: Animation,
    { y, from, to }: Band,
  ): void {
    const channel = channelOf(animation, spec.type);
    if (!channel) return;
    const area = this.#area;
    const toClock = box.offset - box.start;
    const left = Math.max(area.xAt(Math.max(box.start, from)), 0);
    const right = Math.min(area.xAt(Math.min(box.end, to)), area.width);
    const top = y + 3;
    const height = lane.height - 7;
    const alpha = context.globalAlpha;
    context.globalAlpha = alpha * GRADIENT_ALPHA;
    for (let x = left; x < right; x += GRADIENT_STEP) {
      const color = sample(channel, area.timeAt(x + GRADIENT_STEP / 2) + toClock);
      if (typeof color !== "string") continue;
      context.fillStyle = color;
      context.fillRect(x, top, Math.min(GRADIENT_STEP, right - x), height);
    }
    context.globalAlpha = alpha;
  }

  /**
   * The row of a number is its curve: keys at the height of their values, and between them what
   * the value does on the way. It goes as far as the clip and its keys do, fainter outside the clip.
   */
  #curve(
    context: CanvasRenderingContext2D,
    theme: Theme,
    lane: Lane,
    box: ClipBox,
    animation: Animation,
    channel: Channel,
    scale: ValueScale,
    { y, from, to }: Band,
  ): void {
    const area = this.#area;
    const toClock = box.offset - box.start;
    const { seconds } = keyTableOf(animation);
    const firstKey = (seconds[0] ?? 0) - toClock;
    const lastKey = (seconds.at(-1) ?? 0) - toClock;
    const left = Math.max(Math.min(box.start, firstKey), from);
    const right = Math.min(Math.max(box.end, lastKey), to);
    if (!(right > left)) return;
    const place: Place = {
      x: (clock) => area.xAt(clock - toClock),
      clockAt: (x) => area.timeAt(x) + toClock,
      y: (value) => y + yIn(scale, value),
    };
    const path = new Path2D();
    traceCurve(path, channel, place, area.xAt(left), area.xAt(right));
    const height = lane.height - 1;
    context.save();
    context.beginPath();
    context.rect(0, y, area.width, height);
    context.clip();
    context.strokeStyle = theme.curve;
    context.lineWidth = CURVE_WIDTH;
    context.lineJoin = "round";
    const alpha = context.globalAlpha;
    context.globalAlpha = alpha * TRIMMED_ALPHA;
    context.stroke(path);
    const inside = area.xAt(box.start);
    context.beginPath();
    context.rect(inside, y, area.xAt(box.end) - inside, height);
    context.clip();
    context.globalAlpha = alpha;
    context.stroke(path);
    context.restore();
  }

  /**
   * A row made taller reads like the side of a graph: faint lines at the highest and the lowest
   * value it has room for, with those values next to them.
   */
  #valueAxis(
    context: CanvasRenderingContext2D,
    theme: Theme,
    spec: PropertySpec,
    box: ClipBox,
    scale: ValueScale,
    { y }: Band,
  ): void {
    const area = this.#area;
    const top = Math.round(y + yIn(scale, scale.high));
    const bottom = Math.round(y + yIn(scale, scale.low));
    context.save();
    context.fillStyle = theme.line;
    context.fillRect(0, top, area.width, 1);
    context.fillRect(0, bottom, area.width, 1);
    context.fillStyle = theme.label;
    context.font = `11px ${theme.font}`;
    context.textBaseline = "middle";
    const x = Math.max(area.xAt(box.start), 0) + VALUE_LABEL_MARGIN;
    context.fillText(formatNumber(scale.high, spec), x, top + VALUE_LABEL_OFFSET);
    context.fillText(formatNumber(scale.low, spec), x, bottom - VALUE_LABEL_OFFSET);
    context.restore();
  }

  #keys(theme: Theme, marks: Marks, lane: Lane, band: Band): void {
    const area = this.#area;
    const { from, to } = band;
    const reach = KEY_RADIUS / area.pixelsPerSecond;
    const { keyframes } = area;
    const widest = Math.abs(keyframes.preview?.shift ?? 0);
    let covered = Number.NEGATIVE_INFINITY;
    area.forEachBox(lane, from - reach - widest, to + reach + widest, (box) => {
      // Zoomed out a pixel holds many clips, and it does not take all of them to say that.
      const right = area.xAt(box.end);
      if (right <= covered && !keyframes.selection.hasClip(box.id)) return;
      const table = area.tableOf(lane, box);
      if (!table || table.seconds.length === 0) return;
      this.#keysOf(theme, marks, lane, box, table, band);
      covered = Math.max(right, area.xAt(box.start) + MIN_MARK_GAP);
    });
  }

  #keysOf(
    theme: Theme,
    marks: Marks,
    lane: Lane,
    box: ClipBox,
    table: KeyTable,
    { y, from, to }: Band,
  ): void {
    const area = this.#area;
    const { keyframes, pixelsPerSecond, width } = area;
    const { node } = lane;
    const isSummary = node.kind !== "property";
    const radius = isSummary ? SUMMARY_RADIUS : KEY_RADIUS;
    const color = isSummary ? theme.keySummary : theme.key;
    const middle = y + lane.height / 2;
    const { seconds, marks: shapes } = table;
    const toClock = box.offset - box.start;
    const selected = keyframes.selectedSeconds(lane, box);
    const tried = keyframes.triedSeconds(lane, box);
    const { preview } = keyframes;
    const shift = preview?.shift;
    const canMove = keyframes.canMove(box.id);
    const scale = area.scaleOf(lane, box);
    const numbers = scale ? table.numbers : undefined;
    const spec = specOfLane(lane);
    const lift = spec && preview?.lift?.get(liftKey(box.id, spec.path, lane.component?.index));
    const yOf = (index: number) =>
      numbers && scale ? y + yIn(scale, numbers[index] as number) : middle;
    const reach = (KEY_RADIUS * 2) / pixelsPerSecond + Math.abs(shift ?? 0);
    const first = firstFrom(seconds, from + toClock - reach);
    const clockEnd = to + toClock + reach;
    // A summary joins its keys. A row of a number has its curve, and what holds has its values.
    if (isSummary) {
      const lastIndex = Math.min(firstFrom(seconds, clockEnd), seconds.length - 1);
      if (lastIndex > first) {
        const firstX = area.xAt((seconds[first] ?? 0) - toClock);
        const lastX = area.xAt((seconds[lastIndex] ?? 0) - toClock);
        const line = marks.in(color, 0.45);
        const left = Math.max(firstX, 0);
        line.rect(left, middle - 0.5, Math.min(lastX, width) - left, 1);
      }
    }

    let previousX = Number.NEGATIVE_INFINITY;
    let previousY = Number.NEGATIVE_INFINITY;
    for (let index = first; index < seconds.length; index += 1) {
      const clock = seconds[index] as number;
      if (clock > clockEnd) break;
      const moment = clock - toClock;
      const x = area.xAt(moment);
      const keyY = yOf(index);
      const isSelected = selected !== undefined && indexAt(selected, clock) >= 0;
      const isTried = tried !== undefined && indexAt(tried, clock) >= 0;
      // A pixel can hold thousands of keys when zoomed out, and one of them says it all. On a
      // curve one says it for as far up and down as it covers.
      const isHidden =
        x - previousX < MIN_MARK_GAP && (!numbers || Math.abs(keyY - previousY) < KEY_RADIUS);
      if (isHidden && !isSelected && !isTried) {
        if (!numbers) {
          const next = firstFrom(seconds, area.timeAt(previousX + MIN_MARK_GAP) + toClock);
          if (next > index + 1) index = next - 1;
        }
        continue;
      }
      previousX = x;
      previousY = keyY;
      const mark = area.markIn(lane, shapes[index] as number);
      const isTrimmed = moment < box.start || moment >= box.end;
      const alpha = isTrimmed ? TRIMMED_ALPHA : 1;
      const moving = isSelected && canMove && (shift !== undefined || lift !== undefined);
      if (moving) {
        const lifted =
          lift !== undefined && numbers && scale && spec
            ? y + yIn(scale, withinSpec(spec, (numbers[index] as number) + lift))
            : keyY;
        traceKey(marks.in(color, GHOST_ALPHA), mark, x, keyY, radius);
        traceKey(
          marks.in(theme.selected),
          mark,
          x + (shift ?? 0) * pixelsPerSecond,
          lifted,
          radius,
        );
      } else if (isSelected) {
        traceKey(marks.in(theme.selected, alpha), mark, x, keyY, radius);
      } else if (isTried) {
        traceKey(marks.in(theme.keyTried, alpha), mark, x, keyY, radius);
      } else {
        traceKey(marks.in(color, alpha), mark, x, keyY, radius);
      }
    }
  }

  /**
   * The handles of the selected keys: a line from the key and a dot at its end. One that stopped at
   * what a key can hold shows that, with a dashed line to where the pointer is.
   */
  #handles(context: CanvasRenderingContext2D, theme: Theme): void {
    const area = this.#area;
    const handles = area.visibleHandles();
    if (handles.length === 0) return;
    const { keyframes } = area;
    const hint = keyframes.isPreviewOf(area) ? keyframes.preview?.handle : undefined;
    const isHinted = (handle: ShownHandle) =>
      hint?.clamped === true &&
      handle.box.id === hint.clip &&
      handle.path === hint.path &&
      handle.component === hint.component &&
      handle.time === hint.time &&
      handle.side === hint.side;
    const lines = new Path2D();
    const ends = new Marks();
    const dots = ends.in(theme.handle);
    let stopped: ShownHandle | undefined;
    for (const handle of handles) {
      if (isHinted(handle)) {
        stopped = handle;
        continue;
      }
      lines.moveTo(handle.keyX, handle.keyY);
      lines.lineTo(handle.x, handle.y);
      dots.moveTo(handle.x + HANDLE_RADIUS, handle.y);
      dots.arc(handle.x, handle.y, HANDLE_RADIUS, 0, TAU);
    }
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = theme.handle;
    context.stroke(lines);
    ends.fill(context);
    if (stopped && hint) {
      context.strokeStyle = theme.warning;
      context.fillStyle = theme.warning;
      context.beginPath();
      context.moveTo(stopped.keyX, stopped.keyY);
      context.lineTo(stopped.x, stopped.y);
      context.stroke();
      context.setLineDash([3, 3]);
      context.beginPath();
      context.moveTo(stopped.x, stopped.y);
      context.lineTo(hint.x, hint.y);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.arc(stopped.x, stopped.y, HANDLE_RADIUS + 1, 0, TAU);
      context.fill();
    }
    context.restore();
  }
}

/** The time side of the keyframe tab. */
export class KeyframesPainter extends StagePainter {
  readonly #view: KeyframesView;
  readonly #lanes: LanePainter;
  /** Read at the first paint: a canvas that is not in the page yet has no styles to read. */
  #theme!: Theme;
  /** What the last drawing went by. The playhead is an element, so playing changes none of it. */
  #drawn: readonly unknown[] = [];

  constructor(canvas: HTMLCanvasElement, view: KeyframesView, labelOf: ValueLabel) {
    super(canvas);
    this.#view = view;
    this.#lanes = new LanePainter(view, labelOf);
  }

  protected paint(): void {
    const view = this.#view;
    const { model, width, height, pixelsPerSecond } = view;
    // Behind another tab there is nothing to paint on, and no scale to work out positions with.
    if (width === 0 || height === 0 || pixelsPerSecond === 0 || !this.canvas.isConnected) return;
    const drawing = view.whatIsDrawn;
    if (!this.isWiped && drawing.every((item, index) => item === this.#drawn[index])) return;
    this.#drawn = drawing;
    this.isWiped = false;
    this.#theme ??= readTheme(this.canvas);
    const theme = this.#theme;
    const { context, ratio } = this;
    const sharp = (value: number) => this.sharp(value);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, width, height);
    if (!model) return;
    context.font = `12px ${theme.font}`;
    context.textBaseline = "middle";

    context.save();
    context.beginPath();
    context.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
    context.clip();
    this.#lanes.paint(context, theme, sharp);
    const end = sharp(view.xAt(view.visibleDuration));
    if (end < width) {
      context.fillStyle = theme.outside;
      context.fillRect(Math.max(end, 0), RULER_HEIGHT, width, height);
    }
    paintMarquee(context, view, theme);
    context.restore();

    paintRuler(
      context,
      view,
      model.rate,
      RULER_HEIGHT,
      { ...theme, background: theme.ruler },
      sharp,
    );
    paintSnapLine(context, view, theme, sharp);
  }
}

/** The box of a drag, on the area it is about. */
export function paintMarquee(context: CanvasRenderingContext2D, area: KeyArea, theme: Theme): void {
  const { keyframes } = area;
  const marquee = keyframes.isPreviewOf(area) ? keyframes.preview?.marquee : undefined;
  if (!marquee) return;
  const left = area.xAt(marquee.from);
  const width = area.xAt(marquee.to) - left;
  const top = area.screenY(marquee.top);
  const height = marquee.bottom - marquee.top;
  context.fillStyle = theme.marquee;
  context.globalAlpha = 0.2;
  context.fillRect(left, top, width, height);
  context.globalAlpha = 1;
  context.strokeStyle = theme.marquee;
  context.lineWidth = 1;
  context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
}

export function paintSnapLine(
  context: CanvasRenderingContext2D,
  area: KeyArea,
  theme: Theme,
  sharp: (value: number) => number,
): void {
  const moment = area.keyframes.preview?.snap;
  if (moment === undefined) return;
  context.fillStyle = theme.snap;
  context.fillRect(sharp(area.xAt(moment)), 0, 1, area.screenHeight);
}
