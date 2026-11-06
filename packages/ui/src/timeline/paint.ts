import { PEAKS_PER_SECOND } from "@animaquill/audio";
import { clipOffset, type ClipState } from "@animaquill/core";
import { toSeconds } from "@animaquill/schema";
import { RULER_HEIGHT, type TimelineEditor } from "./editor.ts";
import { formatTimecode } from "./frames.ts";
import { forEachBetween, type ClipBox, type Row, type TimelineModel } from "./model.ts";
import { rulerSteps } from "./ruler.ts";

const ROW_INSET = 2;
const CLIP_RADIUS = 3;
const LABEL_MIN_WIDTH = 28;
const LABEL_PADDING = 6;
const LABEL_PLATE_PADDING = 3;
const EDGE_HANDLE = 6;
const END_HANDLE = 6;
/** Zoomed far out a pixel covers minutes. A few samples of them look the same and cost far less. */
const MAX_SLOTS_PER_BAR = 8;

/** Canvas cannot read CSS variables, so the colours come over once. */
interface Theme {
  readonly font: string;
  readonly background: string;
  readonly lane: string;
  readonly laneLocked: string;
  readonly line: string;
  readonly ruler: string;
  readonly tick: string;
  readonly label: string;
  readonly picture: string;
  readonly sound: string;
  readonly caption: string;
  readonly selected: string;
  readonly snap: string;
  readonly covered: string;
  readonly outside: string;
  readonly end: string;
  readonly marquee: string;
}

function readTheme(element: Element): Theme {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(`--aq-timeline-${name}`).trim();
  return {
    font: style.getPropertyValue("--aq-font"),
    background: color("background"),
    lane: color("lane"),
    laneLocked: color("lane-locked"),
    line: color("line"),
    ruler: color("ruler"),
    tick: color("tick"),
    label: color("label"),
    picture: color("picture"),
    sound: color("sound"),
    caption: color("caption"),
    selected: color("selected"),
    snap: color("snap"),
    covered: color("covered"),
    outside: color("outside"),
    end: color("end"),
    marquee: color("marquee"),
  };
}

/** Dark text on light colours, light text on dark ones. */
function readableOn(color: string): string {
  const value = Number.parseInt(color.slice(1, 7), 16);
  const [red, green, blue] = [value >> 16, (value >> 8) & 255, value & 255];
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#000000" : "#ffffff";
}

export type ClipLabel = (box: ClipBox) => string;

interface ClipLook {
  readonly row: Row;
  readonly start: number;
  readonly end: number;
  readonly selected: boolean;
  readonly edge?: "start" | "end" | undefined;
}

/**
 * Draws the timeline. Nothing here decides anything: it shows what the editor says, once per frame
 * at most, and only what is on screen.
 */
interface ClipStrip {
  readonly image: ImageBitmap;
  readonly count: number;
  readonly duration: number;
}

export class TimelinePainter {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #editor: TimelineEditor;
  readonly #labelOf: ClipLabel;
  readonly #peaksOf: (clip: ClipState) => Uint8Array | undefined;
  readonly #stripOf: (clip: ClipState) => ClipStrip | undefined;
  /** Read at the first paint: a canvas that is not in the page yet has no styles to read. */
  #theme!: Theme;
  #ratio = 1;
  #pending: number | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    editor: TimelineEditor,
    labelOf: ClipLabel,
    peaksOf: (clip: ClipState) => Uint8Array | undefined,
    stripOf: (clip: ClipState) => ClipStrip | undefined,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("No 2D context");
    this.#canvas = canvas;
    this.#context = context;
    this.#editor = editor;
    this.#labelOf = labelOf;
    this.#peaksOf = peaksOf;
    this.#stripOf = stripOf;
    // The browser can drop what a canvas holds, for example after a problem with the graphics card.
    canvas.addEventListener("contextrestored", () => this.invalidate());
  }

  /** Sizes are in CSS pixels. The canvas itself has as many pixels as the screen shows. */
  resize(width: number, height: number, ratio: number): void {
    this.#ratio = ratio;
    this.#canvas.width = Math.round(width * ratio);
    this.#canvas.height = Math.round(height * ratio);
    this.#canvas.style.width = `${width}px`;
    this.#canvas.style.height = `${height}px`;
  }

  invalidate(): void {
    this.#pending ??= requestAnimationFrame(() => {
      this.#pending = undefined;
      this.#paint();
    });
  }

  paintNow(): void {
    this.dispose();
    this.#pending = undefined;
    this.#paint();
  }

  dispose(): void {
    if (this.#pending !== undefined) cancelAnimationFrame(this.#pending);
  }

  /** Lines stay sharp when they sit on the pixels of the screen. */
  #sharp(value: number): number {
    return Math.round(value * this.#ratio) / this.#ratio;
  }

  #paint(): void {
    const { model, width, height, pixelsPerSecond } = this.#editor;
    // Behind another tab there is nothing to paint on, and no scale to work out positions with.
    if (width === 0 || height === 0 || pixelsPerSecond === 0 || !this.#canvas.isConnected) return;
    this.#theme ??= readTheme(this.#canvas);
    const context = this.#context;
    context.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    context.fillStyle = this.#theme.background;
    context.fillRect(0, 0, width, height);
    if (!model) return;
    context.font = `12px ${this.#theme.font}`;
    context.textBaseline = "middle";

    context.save();
    context.beginPath();
    context.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
    context.clip();
    this.#paintLanes(model);
    this.#paintClips(model);
    this.#paintPreview();
    this.#paintOutside();
    this.#paintMarquee();
    context.restore();

    this.#paintRuler(model);
    this.#paintLines();
  }

  #rowTop(row: Row): number {
    return RULER_HEIGHT - this.#editor.scrollY + row.top;
  }

  #paintLanes(model: TimelineModel): void {
    const { width, height } = this.#editor;
    const context = this.#context;
    for (const row of model.rows) {
      const top = this.#rowTop(row);
      if (top + row.height < RULER_HEIGHT || top > height) continue;
      context.fillStyle = row.track.locked ? this.#theme.laneLocked : this.#theme.lane;
      context.fillRect(0, top, width, row.height);
      context.fillStyle = this.#theme.line;
      context.fillRect(0, this.#sharp(top + row.height) - 1, width, 1);
    }
  }

  #paintClips(model: TimelineModel): void {
    const editor = this.#editor;
    const { selection } = editor.getSnapshot();
    const moved = editor.preview?.copying ? undefined : editor.preview?.clips;
    const { cut } = editor.getSnapshot();
    const from = editor.timeAt(0);
    const to = editor.timeAt(editor.width);
    const { hovered } = editor;
    for (const row of model.rows) {
      const top = this.#rowTop(row);
      if (top + row.height < RULER_HEIGHT || top > editor.height) continue;
      forEachBetween(row, from, to, (box) => {
        const isMoved = moved?.has(box.id) === true;
        const edge = hovered.kind === "clip" && hovered.box === box ? hovered.edge : undefined;
        this.#context.globalAlpha = isMoved || cut.has(box.id) ? 0.35 : 1;
        this.#paintClip(box, {
          row,
          start: box.start,
          end: box.end,
          selected: !isMoved && selection.has(box.id),
          edge,
        });
        this.#context.globalAlpha = 1;
      });
    }
  }

  #paintPreview(): void {
    const editor = this.#editor;
    const { model, preview } = editor;
    if (!model || !preview) return;
    const context = this.#context;
    const first = editor.timeAt(0);
    const last = editor.timeAt(editor.width);
    for (const [id, { row, start, end }] of preview.clips ?? []) {
      const box = model.boxes.get(id);
      if (box && end > first && start < last) {
        this.#paintClip(box, { row, start, end, selected: true });
      }
    }
    // Over the clip that moves, which is exactly where it would overwrite something.
    context.fillStyle = this.#theme.covered;
    context.globalAlpha = 0.7;
    for (const { row, from, to } of preview.covered ?? []) {
      if (to <= first || from >= last) continue;
      const top = this.#rowTop(row) + ROW_INSET;
      const left = editor.xAt(from);
      context.fillRect(left, top, editor.xAt(to) - left, row.height - ROW_INSET * 2 - 1);
    }
    context.globalAlpha = 1;
  }

  #paintClip(box: ClipBox, look: ClipLook): void {
    const editor = this.#editor;
    const context = this.#context;
    const { row } = look;
    const top = this.#rowTop(row) + ROW_INSET;
    const height = row.height - ROW_INSET * 2 - 1;
    const left = this.#sharp(editor.xAt(look.start));
    const right = this.#sharp(editor.xAt(look.end));
    const width = Math.max(right - left, 1 / this.#ratio);
    const fill = this.#fillOf(box);
    const { track } = row;
    const hidden = track.kind === "audio" ? track.muted === true : track.hidden === true;
    const alpha = context.globalAlpha;
    if (hidden) context.globalAlpha = alpha * 0.45;

    context.fillStyle = fill;
    if (width < CLIP_RADIUS * 3) {
      context.fillRect(left, top, width, height);
    } else {
      context.beginPath();
      context.roundRect(left, top, width, height, CLIP_RADIUS);
      context.fill();
    }

    if (box.clip.source.kind === "video") {
      this.#paintFilmstrip(box, look, { left, right, top, height, width });
    }
    if (box.clip.source.kind === "audio") {
      this.#paintWaveform(box, look, { left, right, top, height }, fill);
    }
    if (width >= LABEL_MIN_WIDTH) this.#paintLabel(box, left, top, width, height, fill);

    if (look.edge) {
      context.fillStyle = "#ffffff66";
      const x = look.edge === "start" ? left : right - EDGE_HANDLE;
      context.fillRect(x, top, EDGE_HANDLE, height);
    }
    if (look.selected) {
      context.strokeStyle = this.#theme.selected;
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(left + 0.75, top + 0.75, width - 1.5, height - 1.5, CLIP_RADIUS);
      context.stroke();
    }
    context.globalAlpha = alpha;
  }

  /** Pictures side by side, from the part of the video that plays at each place. */
  #paintFilmstrip(
    box: ClipBox,
    look: { readonly start: number; readonly end: number },
    area: {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly height: number;
      readonly width: number;
    },
  ): void {
    const strip = this.#stripOf(box.clip);
    if (!strip || strip.duration <= 0) return;
    const editor = this.#editor;
    const context = this.#context;
    const { image, count, duration } = strip;
    const frameWidth = image.width / count;
    const tile = Math.max((area.height * frameWidth) / image.height, 8);
    const moved = look.end - look.start === box.end - box.start ? look.start - box.start : 0;
    const offset = toSeconds(clipOffset(box.clip));

    context.save();
    context.beginPath();
    context.roundRect(area.left, area.top, area.width, area.height, CLIP_RADIUS);
    context.clip();
    context.globalAlpha *= 0.8;
    // Tiles stay on a grid that starts at the clip, and only the ones that show get drawn.
    const skipped = Math.max(Math.floor(-area.left / tile), 0);
    const end = Math.min(area.right, editor.width);
    for (let x = area.left + skipped * tile; x < end; x += tile) {
      const clock = offset + editor.timeAt(x + tile / 2) - moved - box.start;
      const slot = Math.min(Math.max(Math.floor((clock / duration) * count), 0), count - 1);
      const from = slot * frameWidth;
      context.drawImage(image, from, 0, frameWidth, image.height, x, area.top, tile, area.height);
    }
    context.restore();
  }

  /** One bar per pixel, and only where it shows, so that a long file costs no more than a short one. */
  #paintWaveform(
    box: ClipBox,
    look: { readonly start: number; readonly end: number },
    area: {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly height: number;
    },
    fill: string,
  ): void {
    const peaks = this.#peaksOf(box.clip);
    if (!peaks) return;
    const editor = this.#editor;
    const context = this.#context;
    // A clip that moves takes its sound along. An edge that moves uncovers what is there.
    const moved = look.end - look.start === box.end - box.start ? look.start - box.start : 0;
    const offset = toSeconds(clipOffset(box.clip));
    const slotAt = (x: number) =>
      Math.floor((offset + editor.timeAt(x) - moved - box.start) * PEAKS_PER_SECOND);
    const middle = area.top + area.height / 2;
    const alpha = context.globalAlpha;
    context.globalAlpha = alpha * 0.6;
    context.fillStyle = readableOn(fill);
    context.beginPath();
    const first = Math.max(Math.floor(area.left), 0);
    const last = Math.min(Math.ceil(area.right), editor.width);
    for (let x = first; x < last; x += 1) {
      const from = Math.max(slotAt(x), 0);
      const to = Math.min(Math.max(slotAt(x + 1), from + 1), peaks.length);
      const step = Math.max(Math.floor((to - from) / MAX_SLOTS_PER_BAR), 1);
      let level = 0;
      for (let slot = from; slot < to; slot += step) level = Math.max(level, peaks[slot] ?? 0);
      if (level === 0) continue;
      const half = Math.max((level / 255) * (area.height / 2), 0.5);
      context.rect(x, middle - half, 1, half * 2);
    }
    context.fill();
    context.globalAlpha = alpha;
  }

  #fillOf({ clip }: ClipBox): string {
    const { source } = clip;
    if (source.kind === "color" && typeof source["color"] === "string") return source["color"];
    if (source.kind === "caption") return this.#theme.caption;
    const sound = ["audio", "sound", "music"].includes(source.kind);
    return sound ? this.#theme.sound : this.#theme.picture;
  }

  /** The name stays in view while a long clip scrolls past. */
  #paintLabel(
    box: ClipBox,
    left: number,
    top: number,
    width: number,
    height: number,
    fill: string,
  ): void {
    const context = this.#context;
    context.save();
    context.beginPath();
    context.rect(left, top, width, height);
    context.clip();
    const x = Math.max(left, 0) + LABEL_PADDING;
    const y = top + Math.min(height / 2, 12);
    const label = this.#labelOf(box);
    // Over pictures no single colour stays readable.
    const onPicture = box.clip.source.kind === "video" && this.#stripOf(box.clip) !== undefined;
    if (onPicture) {
      context.fillStyle = "#000000a6";
      const plate = context.measureText(label).width + LABEL_PLATE_PADDING * 2;
      context.fillRect(x - LABEL_PLATE_PADDING, y - 8, plate, 16);
    }
    context.fillStyle = onPicture ? "#ffffff" : readableOn(fill);
    context.fillText(label, x, y);
    context.restore();
  }

  #paintOutside(): void {
    const editor = this.#editor;
    const context = this.#context;
    const end = this.#sharp(editor.xAt(editor.visibleDuration));
    if (end >= editor.width) return;
    context.fillStyle = this.#theme.outside;
    context.fillRect(Math.max(end, 0), RULER_HEIGHT, editor.width, editor.height);
  }

  #paintMarquee(): void {
    const editor = this.#editor;
    const marquee = editor.preview?.marquee;
    if (!marquee) return;
    const context = this.#context;
    const left = editor.xAt(marquee.from);
    const width = editor.xAt(marquee.to) - left;
    const top = RULER_HEIGHT - editor.scrollY + marquee.top;
    const height = marquee.bottom - marquee.top;
    context.fillStyle = this.#theme.marquee;
    context.globalAlpha = 0.2;
    context.fillRect(left, top, width, height);
    context.globalAlpha = 1;
    context.strokeStyle = this.#theme.marquee;
    context.lineWidth = 1;
    context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
  }

  #paintRuler(model: TimelineModel): void {
    const editor = this.#editor;
    const context = this.#context;
    const { rate } = model;
    context.fillStyle = this.#theme.ruler;
    context.fillRect(0, 0, editor.width, RULER_HEIGHT);
    context.fillStyle = this.#theme.line;
    context.fillRect(0, RULER_HEIGHT - 1, editor.width, 1);

    const { major, minor } = rulerSteps(editor.pixelsPerSecond / rate.fps, rate.nominal);
    const firstFrame = Math.max(editor.timeAt(0) * rate.fps, 0);
    const lastFrame = editor.timeAt(editor.width) * rate.fps;
    context.fillStyle = this.#theme.tick;
    for (let frame = Math.floor(firstFrame / minor) * minor; frame <= lastFrame; frame += minor) {
      const x = this.#sharp(editor.xAt(frame / rate.fps));
      const length = frame % major === 0 ? 10 : 5;
      context.fillRect(x, RULER_HEIGHT - 1 - length, 1, length);
    }
    context.fillStyle = this.#theme.label;
    for (let frame = Math.floor(firstFrame / major) * major; frame <= lastFrame; frame += major) {
      context.fillText(formatTimecode(frame, rate), editor.xAt(frame / rate.fps) + 4, 10);
    }

    const end = this.#sharp(editor.xAt(editor.visibleDuration));
    context.fillStyle = this.#theme.end;
    context.beginPath();
    context.moveTo(end - END_HANDLE, RULER_HEIGHT - 1);
    context.lineTo(end, RULER_HEIGHT - 1 - END_HANDLE * 1.5);
    context.lineTo(end + END_HANDLE, RULER_HEIGHT - 1);
    context.closePath();
    context.fill();
  }

  /** Lines across everything, for what is happening right now. */
  #paintLines(): void {
    const editor = this.#editor;
    const context = this.#context;
    context.fillStyle = this.#theme.end;
    const end = this.#sharp(editor.xAt(editor.visibleDuration));
    if (end >= 0 && end <= editor.width) context.fillRect(end, RULER_HEIGHT, 1, editor.height);
    context.fillStyle = this.#theme.snap;
    for (const moment of [editor.preview?.snap, editor.razorAt]) {
      if (moment === undefined) continue;
      context.fillRect(this.#sharp(editor.xAt(moment)), 0, 1, editor.height);
    }
  }
}
