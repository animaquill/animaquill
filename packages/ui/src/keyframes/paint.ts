import { channelOf, sample, type Channel } from "@animaquill/core";
import type { Animation, Key, PropertySpec } from "@animaquill/schema";
import { formatNumber } from "../properties/scrub.ts";
import { RULER_HEIGHT } from "../timeline/editor.ts";
import { forEachBetween, type ClipBox } from "../timeline/model.ts";
import { paintRuler } from "../timeline/ruler.ts";
import { StagePainter, readTheme, type Theme } from "../timeline/stage-painter.ts";
import type { KeyArea } from "./area.ts";
import { LANE_HEIGHT, type Lane } from "./lanes.ts";
import {
  KEY_EASED,
  KEY_HOLD,
  animationIn,
  curveRangeOf,
  firstFrom,
  indexAt,
  keyTableOf,
  type KeyTable,
} from "./tables.ts";
import type { KeyframesView } from "./view.ts";

/** Half the size of a key, and of a mark in a summary. */
const KEY_RADIUS = 5;
const SUMMARY_RADIUS = 4;
const TAU = Math.PI * 2;
/** Keys closer than this are one mark. */
const MIN_MARK_GAP = 1;
const CURVE_STEP = 2;
const CURVE_PADDING = 6;
const CURVE_KEY_RADIUS = 2.5;
/** A value that does not change still needs a line in the middle. */
const FLAT_RANGE = 1;
const LABEL_MARGIN = 4;
const MIN_SEGMENT_LABEL = 24;
const TRIMMED_ALPHA = 0.4;
const GHOST_ALPHA = 0.35;
const PARENT_SHADE = "#00000033";
const CLIP_SPAN_ALPHA = 0.18;
const SEGMENT_ALPHA = 0.5;

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

  /** What is in a lane apart from its keys. */
  #content(context: CanvasRenderingContext2D, theme: Theme, lane: Lane, band: Band): void {
    const { node, box } = lane;
    if (node.kind !== "property" || !box) return;
    const stored = this.#area.keyframes.shownValue(box.clip, node.spec.path);
    const value = stored ?? node.spec.default;
    const animation = animationIn(value);
    if (node.rows[0]?.band === "segments" && animation) {
      this.#segments(context, theme, lane, node.spec, box, animation, band);
    }
    if (!lane.open) return;
    const channel = value === undefined ? undefined : channelOf(value, node.spec.type);
    if (channel) this.#curve(context, theme, lane, node.spec, box, channel, animation, band);
  }

  /** What holds its value from one key to the next shows that value. */
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
    const height = LANE_HEIGHT - 7;
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

  #curve(
    context: CanvasRenderingContext2D,
    theme: Theme,
    lane: Lane,
    spec: PropertySpec,
    box: ClipBox,
    channel: Channel,
    animation: Animation | undefined,
    { y, from, to }: Band,
  ): void {
    const area = this.#area;
    const top = y + LANE_HEIGHT;
    const height = lane.height - LANE_HEIGHT - 1;
    const left = Math.max(area.xAt(box.start), 0);
    const right = Math.min(area.xAt(box.end), area.width);
    if (right <= left) return;
    const range = animation ? curveRangeOf(animation) : undefined;
    const still = channel.kind === "still" ? sample(channel, 0) : undefined;
    const middle = typeof still === "number" ? still : 0;
    const min = range?.min ?? middle - FLAT_RANGE;
    const max = range?.max ?? middle + FLAT_RANGE;
    const spread = max > min ? max - min : FLAT_RANGE;
    const low = max > min ? min : min - FLAT_RANGE / 2;
    const room = height - CURVE_PADDING * 2;
    const yOf = (value: number) => top + CURVE_PADDING + room * (1 - (value - low) / spread);

    context.save();
    context.beginPath();
    context.rect(0, top, area.width, height);
    context.clip();
    context.fillStyle = theme.line;
    context.fillRect(left, Math.round(yOf(low + spread)), right - left, 1);
    context.fillRect(left, Math.round(yOf(low)), right - left, 1);

    context.beginPath();
    let started = false;
    for (let x = left; x <= right; x += CURVE_STEP) {
      const value = sample(channel, area.timeAt(x) - box.start + box.offset);
      if (typeof value !== "number") continue;
      if (started) context.lineTo(x, yOf(value));
      else context.moveTo(x, yOf(value));
      started = true;
    }
    context.strokeStyle = theme.curve;
    context.lineWidth = 1.5;
    context.stroke();

    if (animation) {
      const { seconds } = keyTableOf(animation);
      const toClock = box.offset - box.start;
      context.fillStyle = theme.curve;
      context.beginPath();
      for (let index = firstFrom(seconds, from + toClock); index < seconds.length; index += 1) {
        const moment = (seconds[index] as number) - toClock;
        if (moment > to) break;
        const { value } = animation.keys[index] as Key;
        if (typeof value !== "number") continue;
        const x = area.xAt(moment);
        context.moveTo(x + CURVE_KEY_RADIUS, yOf(value));
        context.arc(x, yOf(value), CURVE_KEY_RADIUS, 0, TAU);
      }
      context.fill();
    }

    context.fillStyle = theme.label;
    const labelX = left + LABEL_MARGIN;
    context.fillText(formatNumber(low + spread, spec), labelX, yOf(low + spread) + 8);
    context.fillText(formatNumber(low, spec), labelX, yOf(low) - 8);
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
    const middle = y + LANE_HEIGHT / 2;
    const { seconds, marks: shapes } = table;
    const toClock = box.offset - box.start;
    const selected = keyframes.selectedSeconds(lane, box);
    const tried = keyframes.triedSeconds(lane, box);
    const shift = keyframes.preview?.shift;
    const canMove = keyframes.canMove(box.id);
    const reach = (KEY_RADIUS * 2) / pixelsPerSecond + Math.abs(shift ?? 0);
    const first = firstFrom(seconds, from + toClock - reach);
    const clockEnd = to + toClock + reach;
    const firstX = area.xAt((seconds[first] ?? 0) - toClock);
    const lastIndex = Math.min(firstFrom(seconds, clockEnd), seconds.length - 1);
    const lastX = area.xAt((seconds[lastIndex] ?? 0) - toClock);
    // What holds its value has a band for that, with the value written on it.
    if (lastIndex > first && !(node.kind === "property" && node.rows[0]?.band === "segments")) {
      const line = marks.in(color, 0.45);
      const left = Math.max(firstX, 0);
      line.rect(left, middle - 0.5, Math.min(lastX, width) - left, 1);
    }

    let previousX = Number.NEGATIVE_INFINITY;
    for (let index = first; index < seconds.length; index += 1) {
      const clock = seconds[index] as number;
      if (clock > clockEnd) break;
      const moment = clock - toClock;
      const x = area.xAt(moment);
      const isSelected = selected !== undefined && indexAt(selected, clock) >= 0;
      const isTried = tried !== undefined && indexAt(tried, clock) >= 0;
      if (x - previousX < MIN_MARK_GAP && !isSelected && !isTried) {
        // A pixel can hold thousands of keys when zoomed out, and one of them says it all.
        const next = firstFrom(seconds, area.timeAt(previousX + MIN_MARK_GAP) + toClock);
        if (next > index + 1) index = next - 1;
        continue;
      }
      previousX = x;
      const mark = area.markIn(lane, shapes[index] as number);
      const isTrimmed = moment < box.start || moment >= box.end;
      const alpha = isTrimmed ? TRIMMED_ALPHA : 1;
      if (isSelected && shift !== undefined && canMove) {
        traceKey(marks.in(color, GHOST_ALPHA), mark, x, middle, radius);
        traceKey(marks.in(theme.selected), mark, x + shift * pixelsPerSecond, middle, radius);
      } else if (isSelected) {
        traceKey(marks.in(theme.selected, alpha), mark, x, middle, radius);
      } else if (isTried) {
        traceKey(marks.in(theme.keyTried, alpha), mark, x, middle, radius);
      } else {
        traceKey(marks.in(color, alpha), mark, x, middle, radius);
      }
    }
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
