import { PEAKS_PER_SECOND } from "@animaquill/audio";
import { bezierProgress, type ClipState } from "@animaquill/core";
import {
  parseTime,
  toSeconds,
  type Transition,
  type TransitionRef,
  type TransitionUse,
} from "@animaquill/schema";
import {
  EXPANDER_SIZE,
  MARKER_BAND,
  MARKER_HALF,
  MARKER_TOP,
  RULER_HEIGHT,
  TRANSITION_BAND,
  isJoinChoice,
  type TimelineEditor,
} from "./editor.ts";
import { MARKER_COLORS, markerColorOf, type MarkerBox } from "./markers.ts";
import {
  EDGES,
  edgeWorks,
  edgesOf,
  forEachBetween,
  signedFrames,
  type ClipBox,
  type Edge,
  type JoinBox,
  type Row,
  type TimelineModel,
} from "./model.ts";
import { effectBandOf } from "./effect-band.ts";
import { RULER_LABEL_Y, paintRuler, rulerLabels } from "./ruler.ts";
import type { Preview } from "./gestures.ts";
import { StagePainter, type Theme } from "./stage-painter.ts";

const ROW_INSET = 2;
const CLIP_RADIUS = 3;
const LABEL_MIN_WIDTH = 28;
const LABEL_PADDING = 6;
const LABEL_PLATE_PADDING = 3;
/** Room around the frames that a clip out of step with its partner says. */
const SYNC_PADDING = 3;
const EDGE_HANDLE = 6;
/** The mark of a clip with effects. */
/** The band of effects along the bottom of a clip, and a thin one on a low track. */
const EFFECT_BAND_HEIGHT = 13;
const EFFECT_BAND_THIN = 4;
const EFFECT_BAND_MIN_CLIP = 34;
const EFFECT_BAND_LABEL_MIN = 20;
const TRANSITION_HANDLE = 8;
/** How tall a track that a drop would make shows, before it is there: as rows of its kind are. */
const NEW_TRACK_HEIGHT = { video: 52, audio: 44 } as const;
/**
 * What goes on clips, whose colours are what they are in either theme, so these are too: words and
 * marks, and a transition that does not work, on the dark plate of its block.
 */
const ON_CLIP = "#ffffff";
const ON_CLIP_WARNING = "#cca700";
/** Over what fades, darker the less of the clip shows, as the line says. */
const FADE_SHADE = "#00000066";
const FADE_LINE = "#ffffffd9";
const BLOCK_FILL = "#000000a6";
const BLOCK_HOVERED = "#000000d0";
const BLOCK_LINE = "#ffffff59";
const BLOCK_LABEL_MIN_WIDTH = 24;
/** Stripes over where a frame stands still, as far apart as this. */
const STILL_STRIPES = 5;
const STILL_LINE = "#ffffffa6";
const CUT_LINE = "#ffffff80";
/** Points along a speed curve, enough for it to look smooth at the size of a clip. */
const CURVE_STEPS = 24;
const END_HANDLE = 6;
/** The band of what is marked along the bottom of the ruler, and the handles at its ends. */
const MARK_BAND = 9;
const MARK_BAR = 3;
const MARK_FOOT = 7;
/** How far the handles reach down past the ruler. */
const MARK_OVERHANG = 4;
/** Names of markers: how far from the flag, the least room they take, and where they sit. */
const MARKER_NAME_GAP = 3;
const MARKER_NAME_MIN = 18;
/** The line of a marker with a duration, along the bottom of the ruler. */
const MARKER_BAR = 2;
/** The handle at the end of a marker with a duration. */
const MARKER_END_BAR = 2;
/** Zoomed far out a pixel covers minutes. A few samples of them look the same and cost far less. */
const MAX_SLOTS_PER_BAR = 8;

/** How big the mark of a clip that AI just changed is. */
const AI_MARK = 7;

/**
 * Dark text on light colours, light text on dark ones, whichever stands out more, as WCAG measures
 * contrast: white on the green of sound reads at 3:1, black at 6:1. Words and waveforms of clips.
 */
export function readableOn(color: string): string {
  const value = Number.parseInt(color.slice(1, 7), 16);
  const linear = (channel: number) => {
    const part = channel / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linear(value >> 16) +
    0.7152 * linear((value >> 8) & 255) +
    0.0722 * linear(value & 255);
  // Where black and white stand out as much: (1 + 0.05) / (L + 0.05) = (L + 0.05) / 0.05.
  return luminance > Math.sqrt(1.05 * 0.05) - 0.05 ? "#000000" : "#ffffff";
}

/** Text cut short with an ellipsis to fit a width, as the canvas measures it. */
function fitText(context: CanvasRenderingContext2D, text: string, width: number): string {
  if (context.measureText(text).width <= width) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(`${text.slice(0, middle)}…`).width <= width) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? `${text.slice(0, low)}…` : "";
}

export type ClipLabel = (box: ClipBox) => string;

/** What people call a transition, where it is. */
export type TransitionLabel = (transition: TransitionRef, use: TransitionUse, row: Row) => string;

/** Draws over the lanes, in the area under the ruler. */
export type BelowPainter = (
  context: CanvasRenderingContext2D,
  theme: Theme,
  sharp: (value: number) => number,
) => void;

interface ClipLook {
  readonly row: Row;
  readonly start: number;
  readonly end: number;
  readonly selected: boolean;
  readonly edge?: "start" | "end" | undefined;
  /** The pointer is over the clip, which shows the handles of its transitions. */
  readonly hovered?: boolean;
  /** The handle of a transition under the pointer. */
  readonly handle?: Edge | undefined;
  /** The block of a transition under the pointer. */
  readonly transition?: Edge | undefined;
}

/**
 * Draws the timeline. Nothing here decides anything: it shows what the editor says, once per frame
 * at most, and only what is on screen.
 */
/** How high the line is under what could not be made. */
const FAILED_BAR = 3;

interface ClipStrip {
  readonly image: ImageBitmap;
  readonly count: number;
  readonly duration: number;
}

export class TimelinePainter extends StagePainter {
  readonly #editor: TimelineEditor;
  readonly #labelOf: ClipLabel;
  readonly #transitionLabelOf: TransitionLabel;
  /** What people call effects of these types, together, as the band of a clip says it. */
  readonly #effectNamesOf: (types: readonly string[]) => string;
  readonly #peaksOf: (clip: ClipState) => Uint8Array | undefined;
  readonly #stripOf: (clip: ClipState) => ClipStrip | undefined;
  readonly #hasFailed: (clip: ClipState) => boolean;
  /** What a track that a drop would make is called, as a new track of its kind. */
  readonly #newTrackName: (kind: "video" | "audio", number: number) => string;
  /** Draws what is under the clips of a track, over the rest. */
  readonly #below: BelowPainter | undefined;
  /**
   * How far the files a clip shows have come where this computer lacks them, in percent, or that
   * one did not come: a bar along its bottom, as the mark of the picture of the asset.
   */
  readonly #downloadOf: ((clip: ClipState) => number | "failed" | undefined) | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    editor: TimelineEditor,
    labelOf: ClipLabel,
    peaksOf: (clip: ClipState) => Uint8Array | undefined,
    stripOf: (clip: ClipState) => ClipStrip | undefined,
    hasFailed: (clip: ClipState) => boolean,
    transitionLabelOf: TransitionLabel,
    effectNamesOf: (types: readonly string[]) => string,
    newTrackName: (kind: "video" | "audio", number: number) => string,
    below?: BelowPainter,
    downloadOf?: (clip: ClipState) => number | "failed" | undefined,
  ) {
    super(canvas);
    this.#editor = editor;
    this.#labelOf = labelOf;
    this.#transitionLabelOf = transitionLabelOf;
    this.#effectNamesOf = effectNamesOf;
    this.#peaksOf = peaksOf;
    this.#stripOf = stripOf;
    this.#hasFailed = hasFailed;
    this.#newTrackName = newTrackName;
    this.#below = below;
    this.#downloadOf = downloadOf;
  }

  protected paint(): void {
    const { model, width, height, pixelsPerSecond } = this.#editor;
    // Behind another tab there is nothing to paint on, and no scale to work out positions with.
    if (width === 0 || height === 0 || pixelsPerSecond === 0 || !this.canvas.isConnected) return;
    const { context, ratio } = this;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = this.theme.background;
    context.fillRect(0, 0, width, height);
    if (!model) return;
    context.font = `${12 * this.theme.fontScale}px ${this.theme.font}`;
    context.textBaseline = "middle";

    context.save();
    context.beginPath();
    context.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
    context.clip();
    this.#paintLanes(model);
    this.#paintGap(model);
    this.#paintClips(model);
    this.#paintJoins(model);
    this.#paintMarkedLanes();
    this.#paintPreview();
    this.#below?.(context, this.theme, (value) => this.sharp(value));
    this.#paintOutside();
    this.#paintMarquee();
    context.restore();

    this.#paintRuler(model);
    this.#paintLines();
  }

  #rowTop(row: Row): number {
    return RULER_HEIGHT - this.#editor.scrollY + row.top;
  }

  /** The selected empty time between two clips: a light block where clips would be. */
  #paintGap(model: TimelineModel): void {
    const editor = this.#editor;
    const gap = editor.selectedGap;
    const row = gap && model.rows.find(({ id, gone }) => id === gap.track && !gone);
    if (!gap || !row) return;
    const left = editor.xAt(toSeconds(parseTime(gap.from)));
    const right = editor.xAt(toSeconds(parseTime(gap.to)));
    if (right < 0 || left > editor.width) return;
    const top = this.#rowTop(row) + ROW_INSET;
    const height = row.height - ROW_INSET * 2 - 1;
    const { context } = this;
    context.save();
    context.fillStyle = this.theme.selected;
    context.globalAlpha = 0.22;
    context.beginPath();
    context.roundRect(left, top, right - left, height, CLIP_RADIUS);
    context.fill();
    context.globalAlpha = 0.9;
    context.strokeStyle = this.theme.selected;
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(left + 0.5, top + 0.5, right - left - 1, height - 1, CLIP_RADIUS);
    context.stroke();
    context.restore();
  }

  #paintLanes(model: TimelineModel): void {
    const { width, height } = this.#editor;
    const { context } = this;
    for (const row of model.rows) {
      const top = this.#rowTop(row);
      if (top + row.height < RULER_HEIGHT || top > height) continue;
      context.fillStyle = row.track.locked ? this.theme.laneLocked : this.theme.lane;
      context.fillRect(0, top, width, row.height);
      context.fillStyle = this.theme.line;
      context.fillRect(0, this.sharp(top + row.height) - 1, width, 1);
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
        const over = hovered.kind === "clip" && hovered.box === box ? hovered : undefined;
        this.context.globalAlpha = isMoved || cut.has(box.id) ? 0.35 : 1;
        this.#paintClip(box, {
          row,
          start: box.start,
          end: box.end,
          selected: !isMoved && selection.has(box.id),
          edge: over?.edge,
          hovered: over !== undefined && !isMoved,
          handle: over?.handle,
          transition: over?.transition,
        });
        this.context.globalAlpha = 1;
      });
    }
  }

  #paintPreview(): void {
    const editor = this.#editor;
    const { model, preview } = editor;
    if (!model || !preview) return;
    const { context } = this;
    const first = editor.timeAt(0);
    const last = editor.timeAt(editor.width);
    for (const [id, { row, start, end }] of preview.clips ?? []) {
      const box = model.boxes.get(id);
      if (box && end > first && start < last) {
        this.#paintClip(box, { row, start, end, selected: true });
      }
    }
    // Over the clip that moves, which is exactly where it would overwrite something.
    context.fillStyle = this.theme.covered;
    context.globalAlpha = 0.7;
    for (const { row, from, to } of preview.covered ?? []) {
      if (to <= first || from >= last) continue;
      const top = this.#rowTop(row) + ROW_INSET;
      const left = editor.xAt(from);
      context.fillRect(left, top, editor.xAt(to) - left, row.height - ROW_INSET * 2 - 1);
    }
    context.globalAlpha = 1;
    this.#paintAdding(model, preview.adding);
    this.#paintTransitionDrop(model, preview.transitionDrop);
  }

  /**
   * Where what is dragged here from elsewhere would land: each clip it makes, as long as it is, on
   * its track, outlined. On a new track it shows where that track would come in, with its name.
   */
  #paintAdding(model: TimelineModel, adding: Preview["adding"]): void {
    if (!adding) return;
    const editor = this.#editor;
    const { context } = this;
    for (const part of adding) {
      const left = this.sharp(editor.xAt(part.start));
      const width = Math.max(this.sharp(editor.xAt(part.end)) - left, 2);
      const row = part.row === undefined ? undefined : model.rows.find(({ id }) => id === part.row);
      let top: number;
      let height: number;
      let label = part.label;
      if (row) {
        top = this.#rowTop(row) + ROW_INSET;
        height = row.height - ROW_INSET * 2 - 1;
      } else {
        // A new track of pictures comes in on top of the others, one of sound under all.
        const first = model.rows.find(({ track }) => track.kind === part.kind);
        const lane = part.kind === "video" && first ? first.top : model.height;
        const line = this.sharp(RULER_HEIGHT - editor.scrollY + lane);
        height = Math.round(NEW_TRACK_HEIGHT[part.kind] * model.rowScale);
        top = part.kind === "video" && first ? line - height : line;
        context.fillStyle = this.theme.selected;
        context.fillRect(0, line - 1, editor.width, 2);
        const number = model.rows.filter(({ track, gone }) => track.kind === part.kind && !gone);
        const name = this.#newTrackName(part.kind, number.length + 1);
        label = label ? `${name} · ${label}` : name;
      }
      context.save();
      context.globalAlpha = 0.55;
      context.fillStyle = part.kind === "audio" ? this.theme.sound : this.theme.picture;
      context.beginPath();
      context.roundRect(left, top, width, height, CLIP_RADIUS);
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = this.theme.selected;
      context.lineWidth = 2;
      context.setLineDash([5, 3]);
      context.beginPath();
      context.roundRect(left + 1, top + 1, width - 2, height - 2, CLIP_RADIUS);
      context.stroke();
      context.setLineDash([]);
      if (width >= LABEL_MIN_WIDTH && label) {
        context.beginPath();
        context.rect(left, top, width, height);
        context.clip();
        context.fillStyle = "#ffffff";
        context.fillText(label, left + LABEL_PADDING, top + Math.min(height / 2, 12));
      }
      context.restore();
    }
  }

  /** Where a transition dragged from its tab would go: what of the clips it would take, lit up. */
  #paintTransitionDrop(model: TimelineModel, drop: Preview["transitionDrop"]): void {
    const row = drop && model.rows.find(({ id }) => id === drop.row);
    if (!drop || !row) return;
    const editor = this.#editor;
    const { context } = this;
    const top = this.#rowTop(row) + ROW_INSET;
    const height = row.height - ROW_INSET * 2 - 1;
    const left = this.sharp(editor.xAt(drop.start));
    const width = Math.max(this.sharp(editor.xAt(drop.end)) - left, TRANSITION_HANDLE);
    context.globalAlpha = 0.35;
    context.fillStyle = this.theme.selected;
    context.fillRect(left, top, width, height);
    context.globalAlpha = 1;
    context.strokeStyle = this.theme.selected;
    context.lineWidth = 2;
    context.strokeRect(left + 1, top + 1, width - 2, height - 2);
  }

  #paintClip(box: ClipBox, look: ClipLook): void {
    const editor = this.#editor;
    const { context } = this;
    const { row } = look;
    const top = this.#rowTop(row) + ROW_INSET;
    const height = row.height - ROW_INSET * 2 - 1;
    const left = this.sharp(editor.xAt(look.start));
    const right = this.sharp(editor.xAt(look.end));
    const width = Math.max(right - left, 1 / this.ratio);
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
    if (box.clip.source.kind === "audio" || box.clip.source.kind === "sound") {
      this.#paintWaveform(box, look, { left, right, top, height }, fill);
    }
    const expander = editor.showsExpander(box) ? editor.expanderAt(left, width) : undefined;
    const edges = this.#edgesOf(box);
    if (width >= LABEL_MIN_WIDTH) {
      // The name of the clip starts after what comes in, which has a name of its own, and so does
      // a join at its start, where the clip has not moved.
      const join =
        look.start === box.start ? row.joins.find(({ to }) => to.id === box.id) : undefined;
      const intoClip = Math.max(edges.enter, join ? join.end - box.start : 0);
      const entering = intoClip > 0 ? editor.xAt(look.start + intoClip) - left : 0;
      this.#paintLabel(box, left, top, width, height, fill, entering);
    }
    this.#paintTransitions(box, look, edges, { left, right, top, height, width });
    this.#paintEffectsBand(box, look, { left, right, top, height, width }, expander);
    if (expander !== undefined) this.#paintExpander(box, expander, top + height, fill);
    this.#paintFlash(box, { left, top, height, width });
    // Too narrow for words it should still show, and on any clip it stays out of the way.
    const coming = this.#downloadOf?.(box.clip);
    if (this.#hasFailed(box.clip) || coming === "failed") {
      context.fillStyle = this.theme.failed;
      context.fillRect(left, top + height - FAILED_BAR, width, FAILED_BAR);
    } else if (coming !== undefined) {
      context.fillStyle = "#00000080";
      context.fillRect(left, top + height - FAILED_BAR, width, FAILED_BAR);
      context.fillStyle = ON_CLIP;
      context.fillRect(left, top + height - FAILED_BAR, (width * coming) / 100, FAILED_BAR);
    }

    // What AI just changed: a corner, out of the way of the name and the transitions.
    // What came from GitHub lately: the same corner, in a colour of its own.
    const isRepo = editor.repoMarked.has(box.id);
    if ((isRepo || editor.marked.has(box.id)) && width >= AI_MARK * 2) {
      context.fillStyle = isRepo ? this.theme.repo : ON_CLIP;
      context.beginPath();
      context.moveTo(right - AI_MARK - 1, top + 1);
      context.lineTo(right - 1, top + 1);
      context.lineTo(right - 1, top + 1 + AI_MARK);
      context.closePath();
      context.fill();
    }

    if (look.edge) {
      context.fillStyle = "#ffffff66";
      const x = look.edge === "start" ? left : right - EDGE_HANDLE;
      context.fillRect(x, top, EDGE_HANDLE, height);
    }
    const choice = editor.getSnapshot().transition;
    const chosen = choice !== undefined && !isJoinChoice(choice) && choice.clip === box.id;
    if (look.selected || look.hovered || chosen) {
      this.#paintTransitionHandles(box, look, edges, { left, right, top });
    }
    if (look.selected) {
      context.strokeStyle = this.theme.selected;
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(left + 0.75, top + 0.75, width - 1.5, height - 1.5, CLIP_RADIUS);
      context.stroke();
    }
    context.globalAlpha = alpha;
  }

  /** How long the transitions at the edges of a clip are, while a handle is dragged as well. */
  #edgesOf(box: ClipBox): Readonly<Record<Edge, number>> {
    const dragged = this.#editor.preview?.transition;
    const edges = edgesOf(box.clip);
    return dragged?.clip === box.id ? { ...edges, [dragged.edge]: dragged.seconds } : edges;
  }

  /**
   * The transitions at the edges of a clip: a block at the top with its name, as long as it is.
   * Under it, its speed curve: how far it has got over its time, as the fades of most video editors
   * look, and what does not show yet is shaded. Every transition draws it, whatever it does with
   * its progress. One that does not do what it says is drawn as a warning.
   */
  #paintTransitions(
    box: ClipBox,
    look: ClipLook,
    edges: Readonly<Record<Edge, number>>,
    area: {
      readonly left: number;
      readonly right: number;
      readonly top: number;
      readonly height: number;
      readonly width: number;
    },
  ): void {
    if (edges.enter <= 0 && edges.exit <= 0) return;
    const editor = this.#editor;
    const { context } = this;
    const { left, right, top, height, width } = area;
    const { model } = editor;
    const chosen = editor.getSnapshot().transition;
    context.save();
    context.beginPath();
    context.roundRect(left, top, width, height, CLIP_RADIUS);
    context.clip();
    for (const edge of EDGES) {
      const seconds = edges[edge];
      if (seconds <= 0) continue;
      const transition = box.clip[edge] ?? { type: "fade", duration: String(seconds) };
      const [from, to] =
        edge === "enter"
          ? [left, Math.min(editor.xAt(look.start + seconds), right)]
          : [Math.max(editor.xAt(look.end - seconds), left), right];
      this.#paintCurve(edge, transition, { from, to, top, bottom: top + height });
      const works = !box.clip[edge] || (model !== undefined && edgeWorks(model, box, edge));
      const isChosen =
        chosen !== undefined &&
        !isJoinChoice(chosen) &&
        chosen.clip === box.id &&
        chosen.edge === edge;
      this.#paintBlock({
        from,
        to,
        top,
        label: this.#transitionLabelOf(transition, edge, look.row),
        hovered: look.transition === edge,
        chosen: isChosen,
        works,
      });
      const lit = editor.flashOf("edges", `${box.id}:${edge}`);
      if (lit > 0) this.#paintLit(lit, from, top, Math.max(to - from, 4), TRANSITION_BAND);
    }
    context.restore();
  }

  /**
   * The joins of each row, as blocks across their cuts with their names, over the clips on both
   * sides. Where a side stands still on a frame, stripes say so. One that does not do what it says
   * is drawn as a warning. While its clips are dragged somewhere else, it waits for where they land.
   */
  #paintJoins(model: TimelineModel): void {
    const editor = this.#editor;
    const { context } = this;
    const moved = editor.preview?.clips;
    const dragged = editor.preview?.join;
    const choice = editor.getSnapshot().transition;
    const { hovered } = editor;
    const first = editor.timeAt(0);
    const last = editor.timeAt(editor.width);
    for (const row of model.rows) {
      const top = this.#rowTop(row) + ROW_INSET;
      if (top + row.height < RULER_HEIGHT || top > editor.height || row.joins.length === 0)
        continue;
      for (const join of row.joins) {
        if (moved?.has(join.from.id) || moved?.has(join.to.id)) continue;
        const span = dragged?.id === join.id ? dragged : join;
        if (span.end < first || span.start > last) continue;
        const left = editor.xAt(span.start);
        const right = Math.max(editor.xAt(span.end), left + 1);
        const isChosen = isJoinChoice(choice) && choice.join === join.id;
        const isHovered = hovered.kind === "join" && hovered.join.id === join.id;
        const bottom = top + row.height - ROW_INSET * 2 - 1;
        this.#paintCurve("join", join.join.transition, { from: left, to: right, top, bottom });
        this.#paintBlock({
          from: left,
          to: right,
          top,
          label: this.#transitionLabelOf(join.join.transition, "join", row),
          hovered: isHovered,
          chosen: isChosen,
          works: join.trouble === undefined,
          under: () => {
            this.#paintStill(join, span, top);
            context.fillStyle = CUT_LINE;
            context.fillRect(this.sharp(editor.xAt(join.at)), top, 1, TRANSITION_BAND);
          },
        });
        if (isChosen && !row.track.locked) this.#paintJoinHandles(join, left, right, top);
        const lit = editor.flashOf("joins", join.id);
        if (lit > 0) this.#paintLit(lit, left, top, Math.max(right - left, 4), TRANSITION_BAND);
      }
    }
  }

  /** Stripes where a side of a join shows a frame that stands still. */
  #paintStill(join: JoinBox, span: { start: number; end: number }, top: number): void {
    const editor = this.#editor;
    const { context } = this;
    for (const still of join.still) {
      const from = editor.xAt(Math.max(still.from, span.start));
      const to = editor.xAt(Math.min(still.to, span.end));
      if (to <= from) continue;
      context.save();
      context.beginPath();
      context.rect(from, top, to - from, TRANSITION_BAND);
      context.clip();
      context.strokeStyle = STILL_LINE;
      context.lineWidth = 1;
      context.beginPath();
      for (let x = from - TRANSITION_BAND; x < to; x += STILL_STRIPES) {
        context.moveTo(x, top + TRANSITION_BAND);
        context.lineTo(x + TRANSITION_BAND, top);
      }
      context.stroke();
      context.restore();
    }
  }

  /** The edges of a selected join that change how long it is. */
  #paintJoinHandles(join: JoinBox, left: number, right: number, top: number): void {
    const { context } = this;
    const align = join.join.transition.align ?? "center";
    const at = [...(align === "after" ? [] : [left]), ...(align === "before" ? [] : [right])];
    for (const middle of at) {
      const x = this.sharp(middle - TRANSITION_HANDLE / 4);
      context.fillStyle = this.theme.selected;
      context.fillRect(x, top, TRANSITION_HANDLE / 2, TRANSITION_BAND);
    }
  }

  /**
   * The speed curve of a transition: its progress over its time, from nothing at the edge of the
   * clip to all of it, with what does not show yet shaded. A join goes the way the clip it brings
   * in does.
   */
  #paintCurve(
    edge: Edge | "join",
    transition: Transition,
    { from, to, top, bottom }: { from: number; to: number; top: number; bottom: number },
  ): void {
    const { context } = this;
    const curve = transition.curve;
    const points: [number, number][] = [];
    for (let step = 0; step <= CURVE_STEPS; step++) {
      const share = step / CURVE_STEPS;
      const progress = curve ? Math.min(Math.max(bezierProgress(...curve, share), 0), 1) : share;
      const shown = edge === "exit" ? 1 - progress : progress;
      points.push([from + (to - from) * share, bottom - (bottom - top) * shown]);
    }
    context.fillStyle = FADE_SHADE;
    context.beginPath();
    context.moveTo(from, top);
    for (const [x, y] of points) context.lineTo(x, y);
    context.lineTo(to, top);
    context.closePath();
    context.fill();
    context.strokeStyle = FADE_LINE;
    context.lineWidth = 1;
    context.beginPath();
    points.forEach(([x, y], index) => (index === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
    context.stroke();
  }

  /**
   * The block of a transition at the top of its clip, with its name where that fits. What else is
   * on it goes in between: over its background, under its outline and its name.
   */
  #paintBlock(block: {
    readonly from: number;
    readonly to: number;
    readonly top: number;
    readonly label: string;
    readonly hovered: boolean;
    readonly chosen: boolean;
    readonly works: boolean;
    readonly under?: () => void;
  }): void {
    const { context } = this;
    const { from, to, top, label, hovered, chosen, works, under } = block;
    const width = Math.max(to - from, 1);
    context.fillStyle = hovered ? BLOCK_HOVERED : BLOCK_FILL;
    context.fillRect(from, top, width, TRANSITION_BAND);
    if (under) {
      context.save();
      context.beginPath();
      context.rect(from, top, width, TRANSITION_BAND);
      context.clip();
      under();
      context.restore();
    }
    context.lineWidth = chosen ? 1.5 : 1;
    context.strokeStyle = chosen ? this.theme.selected : works ? BLOCK_LINE : this.theme.warning;
    context.setLineDash(works || chosen ? [] : [3, 2]);
    context.strokeRect(from + 0.5, top + 0.5, width - 1, TRANSITION_BAND - 1);
    context.setLineDash([]);
    if (width < BLOCK_LABEL_MIN_WIDTH) return;
    context.save();
    context.beginPath();
    context.rect(from, top, width, TRANSITION_BAND);
    context.clip();
    context.fillStyle = works ? ON_CLIP : ON_CLIP_WARNING;
    context.fillText(label, from + LABEL_PLATE_PADDING + 2, top + TRANSITION_BAND / 2);
    context.restore();
  }

  /** The handles at the top corners, where each transition ends. They stay inside the clip. */
  #paintTransitionHandles(
    box: ClipBox,
    look: ClipLook,
    edges: Readonly<Record<Edge, number>>,
    { left, right, top }: { readonly left: number; readonly right: number; readonly top: number },
  ): void {
    const editor = this.#editor;
    if (!editor.showsTransitionHandles(look.row) || right - left < TRANSITION_HANDLE * 2) return;
    const { context } = this;
    const at = { enter: look.start + edges.enter, exit: look.end - edges.exit };
    const joined = editor.model?.joined;
    for (const edge of EDGES) {
      // Only an edge with a transition has a handle, and where a join is, it has its own.
      if (edges[edge] <= 0 || joined?.has(`${box.id} ${edge}`) === true) continue;
      const middle = editor.xAt(at[edge]);
      const x = Math.min(Math.max(middle - TRANSITION_HANDLE / 2, left), right - TRANSITION_HANDLE);
      context.fillStyle = look.handle === edge ? this.theme.selected : "#ffffff";
      context.strokeStyle = "#000000b3";
      context.lineWidth = 1;
      context.fillRect(this.sharp(x), top + 1, TRANSITION_HANDLE, TRANSITION_HANDLE);
      context.strokeRect(
        this.sharp(x) + 0.5,
        top + 1.5,
        TRANSITION_HANDLE - 1,
        TRANSITION_HANDLE - 1,
      );
    }
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
    const { context } = this;
    const { image, count, duration } = strip;
    const frameWidth = image.width / count;
    const tile = Math.max((area.height * frameWidth) / image.height, 8);
    const moved = look.end - look.start === box.end - box.start ? look.start - box.start : 0;
    const { offset } = box;

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
    const { context } = this;
    // A clip that moves takes its sound along. An edge that moves uncovers what is there.
    const moved = look.end - look.start === box.end - box.start ? look.start - box.start : 0;
    const { offset } = box;
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
    if (source.kind === "caption") return this.theme.caption;
    const sound = ["audio", "sound", "music"].includes(source.kind);
    return sound ? this.theme.sound : this.theme.picture;
  }

  /**
   * Says that a clip has effects, and where they work: a colored band along its bottom over that
   * much of it, with their names on it where there is room, dimmed when all of them are off. A
   * low track gets a thin band without names. The button at the bottom left goes over it, and the
   * names start after that.
   */
  #paintEffectsBand(
    box: ClipBox,
    look: ClipLook,
    area: { left: number; right: number; top: number; height: number; width: number },
    expander: number | undefined,
  ): void {
    const band = effectBandOf(box.clip);
    if (!band || band.spans.length === 0) return;
    const editor = this.#editor;
    const { context } = this;
    const { left, right, top, height, width } = area;
    const thick = height >= EFFECT_BAND_MIN_CLIP;
    const size = thick ? EFFECT_BAND_HEIGHT : EFFECT_BAND_THIN;
    const y = top + height - size;
    context.save();
    context.beginPath();
    context.roundRect(left, top, width, height, CLIP_RADIUS);
    context.clip();
    context.globalAlpha *= band.off ? 0.4 : 1;
    context.fillStyle = this.theme.effect;
    let widest: { from: number; to: number } | undefined;
    for (const [from, to] of band.spans) {
      const x = Math.max(this.sharp(editor.xAt(look.start + from)), left);
      const end = Math.min(this.sharp(editor.xAt(look.start + to)), right);
      if (end <= x) continue;
      context.fillRect(x, y, Math.max(end - x, 1), size);
      if (!widest || end - x > widest.to - widest.from) widest = { from: x, to: end };
    }
    const names = this.#effectNamesOf(band.types);
    if (thick && widest && names) {
      // The button at the bottom left of the clip comes first.
      const after = expander === undefined ? widest.from : expander + EXPANDER_SIZE + 2;
      const from = Math.max(widest.from, after) + 4;
      const room = widest.to - from - 4;
      if (room >= EFFECT_BAND_LABEL_MIN) {
        context.beginPath();
        context.rect(from, y, room, size);
        context.clip();
        context.fillStyle = "#ffffff";
        context.font = `600 ${10 * this.theme.fontScale}px ${this.theme.font}`;
        context.textBaseline = "middle";
        context.fillText(fitText(context, names, room), from, y + size / 2 + 0.5);
      }
    }
    context.restore();
  }

  /** Lights up a clip, or its band of effects, that something just happened to, fading away. */
  #paintFlash(
    box: ClipBox,
    { left, top, height, width }: { left: number; top: number; height: number; width: number },
  ): void {
    const editor = this.#editor;
    const whole = editor.flashOf("clips", box.id);
    if (whole > 0) this.#paintLit(whole, left, top, width, height);
    const blocked = editor.flashOf("blocked", box.id);
    if (blocked > 0) this.#paintLit(blocked, left, top, width, height, this.theme.failed);
    const band = editor.flashOf("bands", box.id);
    if (band > 0) {
      const size = height >= EFFECT_BAND_MIN_CLIP ? EFFECT_BAND_HEIGHT : EFFECT_BAND_THIN;
      this.#paintLit(band, left, top + height - size, width, size);
    }
  }

  /**
   * The one way something that was just added lights up, fading away over `FLASH_MS`: a clip, the
   * block of a transition or a join, or the band of effects of a clip.
   */
  #paintLit(
    share: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color = this.theme.flash,
  ): void {
    const { context } = this;
    context.save();
    context.globalAlpha *= share * 0.4;
    context.fillStyle = color === this.theme.flash ? "#ffffff" : color;
    context.beginPath();
    context.roundRect(left, top, width, height, CLIP_RADIUS);
    context.fill();
    context.globalAlpha = Math.min(share * 1.5, 1);
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(left + 1, top + 1, width - 2, height - 2, CLIP_RADIUS);
    context.stroke();
    context.restore();
  }

  /**
   * Says whether the keys of a clip show under its track, at its bottom left: the top has its name
   * and the blocks of its transitions.
   */
  #paintExpander(box: ClipBox, x: number, bottom: number, fill: string): void {
    const { context } = this;
    const open = this.#editor.extras?.isOpen(box) === true;
    const middle = x + EXPANDER_SIZE / 2;
    const y = bottom - 10;
    context.save();
    if (box.clip.source.kind === "video" && this.#stripOf(box.clip) !== undefined) {
      context.fillStyle = "#000000a6";
      context.fillRect(x, y - 8, EXPANDER_SIZE, 16);
      context.fillStyle = "#ffffff";
    } else context.fillStyle = readableOn(fill);
    context.beginPath();
    if (open) {
      context.moveTo(middle - 4, y - 2);
      context.lineTo(middle + 4, y - 2);
      context.lineTo(middle, y + 3);
    } else {
      context.moveTo(middle - 2, y - 4);
      context.lineTo(middle + 3, y);
      context.lineTo(middle - 2, y + 4);
    }
    context.closePath();
    context.fill();
    context.restore();
  }

  /** The name stays in view while a long clip scrolls past. */
  #paintLabel(
    box: ClipBox,
    left: number,
    top: number,
    width: number,
    height: number,
    fill: string,
    room: number,
  ): void {
    const { context } = this;
    context.save();
    context.beginPath();
    context.rect(left, top, width, height);
    context.clip();
    const y = top + Math.min(height / 2, 12);
    const label = this.#labelOf(box);
    const named = label ? context.measureText(label).width : 0;
    const scale = this.theme.fontScale;
    const font = context.font;
    const syncFont = `600 ${10 * scale}px ${this.theme.font}`;
    // Out of step with its partner: how many frames, in red, right after the name; first where
    // both do not fit, so that a short clip still shows it.
    const { model } = this.#editor;
    const sync = model?.outOfSync.get(box.id);
    const syncText = sync ? signedFrames(sync) : "";
    context.font = syncFont;
    const plate = sync ? context.measureText(syncText).width + SYNC_PADDING * 2 : 0;
    context.font = font;
    const start = Math.max(left, 0) + LABEL_PADDING + room;
    const gap = named > 0 && sync ? 6 : 0;
    const syncFirst = sync !== undefined && start + named + gap + plate > left + width;
    const x = syncFirst ? start + plate + gap : start;
    const syncAt = syncFirst ? start : x + named + gap;
    // Over pictures no single colour stays readable.
    const onPicture = box.clip.source.kind === "video" && this.#stripOf(box.clip) !== undefined;
    if (onPicture && named > 0) {
      context.fillStyle = "#000000a6";
      context.fillRect(x - LABEL_PLATE_PADDING, y - 8, named + LABEL_PLATE_PADDING * 2, 16);
    }
    const color = onPicture ? "#ffffff" : readableOn(fill);
    context.fillStyle = color;
    context.fillText(label, x, y);
    // Linked clips have their names underlined, as in Premiere.
    const link = box.clip.link;
    if (named > 0 && link !== undefined && (model?.links.get(link)?.length ?? 0) > 1) {
      context.fillRect(x, Math.round(y + 7 * scale), named, Math.max(1, Math.round(scale)));
    }
    if (sync) {
      const tall = Math.round(14 * scale);
      context.font = syncFont;
      context.fillStyle = this.theme.unsynced;
      context.beginPath();
      context.roundRect(syncAt, y - tall / 2, plate, tall, 2);
      context.fill();
      context.fillStyle = ON_CLIP;
      context.fillText(syncText, syncAt + SYNC_PADDING, y + 0.5);
    }
    context.restore();
  }

  #paintOutside(): void {
    const editor = this.#editor;
    const { context } = this;
    const end = this.sharp(editor.xAt(editor.visibleDuration));
    if (end >= editor.width) return;
    context.fillStyle = this.theme.outside;
    context.fillRect(Math.max(end, 0), RULER_HEIGHT, editor.width, editor.height);
  }

  #paintMarquee(): void {
    const editor = this.#editor;
    const marquee = editor.preview?.marquee;
    if (!marquee) return;
    const { context } = this;
    const left = editor.xAt(marquee.from);
    const width = editor.xAt(marquee.to) - left;
    const top = RULER_HEIGHT - editor.scrollY + marquee.top;
    const height = marquee.bottom - marquee.top;
    context.fillStyle = this.theme.marquee;
    context.globalAlpha = 0.2;
    context.fillRect(left, top, width, height);
    context.globalAlpha = 1;
    context.strokeStyle = this.theme.marquee;
    context.lineWidth = 1;
    context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
  }

  #paintRuler(model: TimelineModel): void {
    const editor = this.#editor;
    const { context } = this;
    const theme = this.theme;
    const look = { ...theme, background: theme.ruler };
    paintRuler(context, editor, model.rate, RULER_HEIGHT, look, (value) => this.sharp(value));
    this.#paintMarkers(model);
    this.#paintMarks();

    const end = this.sharp(editor.xAt(editor.visibleDuration));
    context.fillStyle = theme.end;
    context.beginPath();
    context.moveTo(end - END_HANDLE, RULER_HEIGHT - 1);
    context.lineTo(end, RULER_HEIGHT - 1 - END_HANDLE * 1.5);
    context.lineTo(end + END_HANDLE, RULER_HEIGHT - 1);
    context.closePath();
    context.fill();
  }

  /** The colour a marker shows in: one of the theme's, or its own. */
  #markerColor(box: MarkerBox): string {
    const id = markerColorOf(box.marker);
    const index = MARKER_COLORS.findIndex((color) => color.id === id);
    return index < 0 ? (box.marker.color ?? "") : (this.theme.markers[index] ?? "");
  }

  /**
   * Markers along the lower part of the ruler, as Premiere has them: a flag that points down at
   * its moment, with a thin line along the bottom as long as its duration. A name shows to the right
   * of its flag between the timecodes and that line, where it fits and runs into no timecode and no
   * next marker. Where it does not, it shows only for the marker under the pointer and the selected
   * one, over what is there. The selected one is outlined, and one being dragged shows where it goes.
   */
  #paintMarkers(model: TimelineModel): void {
    const editor = this.#editor;
    const { context } = this;
    const moving = editor.preview?.marker;
    const { marker: selected } = editor.getSnapshot();
    const { hovered } = editor;
    const pointed = hovered.kind === "marker" ? hovered.box.id : undefined;
    const boxes = model.markers
      .map((box) => (moving?.id === box.id ? { ...box, time: moving.time, end: moving.end } : box))
      .toSorted((a, b) => a.time - b.time);
    if (boxes.length === 0) return;
    const scale = this.theme.fontScale;
    const bottom = RULER_HEIGHT - 1;
    // The timecodes, in the font they are drawn in, which takes up to here from the top.
    const labels = rulerLabels(editor, model.rate).map(({ x, text }) => ({
      from: x,
      to: x + context.measureText(text).width,
    }));
    const below = RULER_LABEL_Y + 6 * scale;
    const nameSize = 10 * scale;
    const roomy = bottom - MARKER_BAR - below >= nameSize * 0.9;
    const nameY = roomy ? (below + bottom - MARKER_BAR) / 2 : bottom - MARKER_BAR - nameSize / 2;
    const meetsLabel = (from: number, to: number) =>
      labels.some(
        (label) => label.from < to + MARKER_NAME_GAP && label.to + MARKER_NAME_GAP > from,
      );
    context.save();
    context.font = `${nameSize}px ${this.theme.font}`;
    boxes.forEach((box, index) => {
      const x = this.sharp(editor.xAt(box.time));
      const end = box.end === undefined ? undefined : this.sharp(editor.xAt(box.end));
      if ((end ?? x) + MARKER_HALF < 0 || x - MARKER_HALF > editor.width) return;
      const color = this.#markerColor(box);
      if (end !== undefined) {
        context.fillStyle = color;
        context.fillRect(x, bottom - MARKER_BAR, end - x, MARKER_BAR);
        context.fillRect(end - MARKER_END_BAR, MARKER_TOP, MARKER_END_BAR, bottom - MARKER_TOP);
      }
      const focused = box.id === selected || box.id === pointed;
      const name = box.marker.name;
      const next = boxes[index + 1];
      const left = x + MARKER_HALF + MARKER_NAME_GAP;
      const right = Math.min(
        next && !focused
          ? this.sharp(editor.xAt(next.time)) - MARKER_HALF - MARKER_NAME_GAP
          : Number.POSITIVE_INFINITY,
        editor.width,
      );
      const text =
        name && right - left >= MARKER_NAME_MIN ? fitText(context, name, right - left) : "";
      if (text !== "") {
        const width = context.measureText(text).width;
        if (focused) {
          context.fillStyle = this.theme.ruler;
          const top = nameY - nameSize / 2 - 1;
          context.fillRect(left - 2, top, width + 4, bottom - MARKER_BAR - top);
        }
        if (focused || (roomy && !meetsLabel(left, left + width))) {
          context.fillStyle = this.theme.label;
          context.fillText(text, left, nameY);
        }
      }
      context.beginPath();
      context.moveTo(x - MARKER_HALF, MARKER_TOP);
      context.lineTo(x + MARKER_HALF, MARKER_TOP);
      context.lineTo(x + MARKER_HALF, MARKER_TOP + MARKER_BAND);
      context.lineTo(x, bottom);
      context.lineTo(x - MARKER_HALF, MARKER_TOP + MARKER_BAND);
      context.closePath();
      context.fillStyle = color;
      context.fill();
      if (box.id === selected) {
        context.strokeStyle = this.theme.selected;
        context.lineWidth = 1.5;
        context.stroke();
        if (end !== undefined)
          context.strokeRect(x, bottom - MARKER_BAR - 1, end - x, MARKER_BAR + 1);
      }
    });
    context.restore();
  }

  /** The tracks are a little lighter where something is marked, as in Premiere. */
  #paintMarkedLanes(): void {
    const editor = this.#editor;
    const span = editor.markedSpan;
    if (!span) return;
    const left = Math.max(this.sharp(editor.xAt(span.from)), 0);
    const right = Math.min(this.sharp(editor.xAt(span.to)), editor.width);
    if (right <= left) return;
    this.context.fillStyle = this.theme.markedLanes;
    this.context.fillRect(left, RULER_HEIGHT, right - left, editor.height - RULER_HEIGHT);
  }

  /**
   * A light band along the bottom of the ruler, between two handles: a bold [ at the in and ] at the
   * out, a little longer than the ruler, so that they look like something to take hold of.
   */
  #paintMarks(): void {
    const editor = this.#editor;
    const span = editor.markedSpan;
    if (!span) return;
    const { context } = this;
    const { in: from, out } = editor.marks;
    const left = this.sharp(editor.xAt(span.from));
    const right = this.sharp(editor.xAt(span.to));
    context.fillStyle = this.theme.marked;
    context.globalAlpha = 0.3;
    context.fillRect(left, RULER_HEIGHT - MARK_BAND, right - left, MARK_BAND - 1);
    context.globalAlpha = 1;
    const bottom = RULER_HEIGHT + MARK_OVERHANG;
    const bracket = (x: number, toward: 1 | -1) => {
      const bar = toward > 0 ? x : x - MARK_BAR;
      context.fillRect(bar, 0, MARK_BAR, bottom);
      const foot = toward > 0 ? x : x - MARK_FOOT;
      context.fillRect(foot, 0, MARK_FOOT, MARK_BAR);
      context.fillRect(foot, bottom - MARK_BAR, MARK_FOOT, MARK_BAR);
    };
    if (from !== undefined) bracket(left, 1);
    if (out !== undefined) bracket(right, -1);
  }

  /** Lines across everything, for what is happening right now. */
  #paintLines(): void {
    const editor = this.#editor;
    const { context } = this;
    context.fillStyle = this.theme.end;
    const end = this.sharp(editor.xAt(editor.visibleDuration));
    if (end >= 0 && end <= editor.width) context.fillRect(end, RULER_HEIGHT, 1, editor.height);
    context.fillStyle = this.theme.snap;
    for (const moment of [editor.preview?.snap, editor.razorAt, editor.pointedAt]) {
      if (moment === undefined) continue;
      context.fillRect(this.sharp(editor.xAt(moment)), 0, 1, editor.height);
    }
  }
}
