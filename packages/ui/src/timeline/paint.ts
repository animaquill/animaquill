import { PEAKS_PER_SECOND } from "@animaquill/audio";
import { bezierProgress, type ClipState } from "@animaquill/core";
import type { Transition, TransitionRef, TransitionUse } from "@animaquill/schema";
import {
  EXPANDER_SIZE,
  RULER_HEIGHT,
  TRANSITION_BAND,
  isJoinChoice,
  type TimelineEditor,
} from "./editor.ts";
import {
  EDGES,
  edgeWorks,
  edgesOf,
  forEachBetween,
  type ClipBox,
  type Edge,
  type JoinBox,
  type Row,
  type TimelineModel,
} from "./model.ts";
import { effectBandOf } from "./effect-band.ts";
import { paintRuler } from "./ruler.ts";
import type { Preview } from "./gestures.ts";
import { StagePainter, readTheme, type Theme } from "./stage-painter.ts";

const ROW_INSET = 2;
const CLIP_RADIUS = 3;
const LABEL_MIN_WIDTH = 28;
const LABEL_PADDING = 6;
const LABEL_PLATE_PADDING = 3;
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
/** Zoomed far out a pixel covers minutes. A few samples of them look the same and cost far less. */
const MAX_SLOTS_PER_BAR = 8;

/** How big the mark of a clip that AI just changed is. */
const AI_MARK = 7;

/** Dark text on light colours, light text on dark ones. */
function readableOn(color: string): string {
  const value = Number.parseInt(color.slice(1, 7), 16);
  const [red, green, blue] = [value >> 16, (value >> 8) & 255, value & 255];
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? "#000000" : "#ffffff";
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
  /** Read at the first paint: a canvas that is not in the page yet has no styles to read. */
  #theme!: Theme;

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
  }

  protected paint(): void {
    const { model, width, height, pixelsPerSecond } = this.#editor;
    // Behind another tab there is nothing to paint on, and no scale to work out positions with.
    if (width === 0 || height === 0 || pixelsPerSecond === 0 || !this.canvas.isConnected) return;
    this.#theme ??= readTheme(this.canvas);
    const { context, ratio } = this;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
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
    this.#paintJoins(model);
    this.#paintPreview();
    this.#below?.(context, this.#theme, (value) => this.sharp(value));
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
    const { context } = this;
    for (const row of model.rows) {
      const top = this.#rowTop(row);
      if (top + row.height < RULER_HEIGHT || top > height) continue;
      context.fillStyle = row.track.locked ? this.#theme.laneLocked : this.#theme.lane;
      context.fillRect(0, top, width, row.height);
      context.fillStyle = this.#theme.line;
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
    context.fillStyle = this.#theme.covered;
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
        context.fillStyle = this.#theme.selected;
        context.fillRect(0, line - 1, editor.width, 2);
        const number = model.rows.filter(({ track, gone }) => track.kind === part.kind && !gone);
        const name = this.#newTrackName(part.kind, number.length + 1);
        label = label ? `${name} · ${label}` : name;
      }
      context.save();
      context.globalAlpha = 0.55;
      context.fillStyle = part.kind === "audio" ? this.#theme.sound : this.#theme.picture;
      context.beginPath();
      context.roundRect(left, top, width, height, CLIP_RADIUS);
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle = this.#theme.selected;
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
    context.fillStyle = this.#theme.selected;
    context.fillRect(left, top, width, height);
    context.globalAlpha = 1;
    context.strokeStyle = this.#theme.selected;
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
    if (this.#hasFailed(box.clip)) {
      context.fillStyle = this.#theme.failed;
      context.fillRect(left, top + height - FAILED_BAR, width, FAILED_BAR);
    }

    // What AI just changed: a corner, out of the way of the name and the transitions.
    if (editor.marked.has(box.id) && width >= AI_MARK * 2) {
      context.fillStyle = this.#theme.selected;
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
      context.strokeStyle = this.#theme.selected;
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
      context.fillStyle = this.#theme.selected;
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
    context.strokeStyle = chosen ? this.#theme.selected : works ? BLOCK_LINE : this.#theme.warning;
    context.setLineDash(works || chosen ? [] : [3, 2]);
    context.strokeRect(from + 0.5, top + 0.5, width - 1, TRANSITION_BAND - 1);
    context.setLineDash([]);
    if (width < BLOCK_LABEL_MIN_WIDTH) return;
    context.save();
    context.beginPath();
    context.rect(from, top, width, TRANSITION_BAND);
    context.clip();
    context.fillStyle = works ? "#ffffff" : this.#theme.warning;
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
      context.fillStyle = look.handle === edge ? this.#theme.selected : "#ffffff";
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
    if (source.kind === "caption") return this.#theme.caption;
    const sound = ["audio", "sound", "music"].includes(source.kind);
    return sound ? this.#theme.sound : this.#theme.picture;
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
    context.fillStyle = this.#theme.effect;
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
        context.font = `600 10px ${this.#theme.font}`;
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
  #paintLit(share: number, left: number, top: number, width: number, height: number): void {
    const { context } = this;
    context.save();
    context.globalAlpha *= share * 0.4;
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.roundRect(left, top, width, height, CLIP_RADIUS);
    context.fill();
    context.globalAlpha = Math.min(share * 1.5, 1);
    context.strokeStyle = this.#theme.flash;
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
    const x = Math.max(left, 0) + LABEL_PADDING + room;
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
    const { context } = this;
    const end = this.sharp(editor.xAt(editor.visibleDuration));
    if (end >= editor.width) return;
    context.fillStyle = this.#theme.outside;
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
    const { context } = this;
    const theme = this.#theme;
    const look = { ...theme, background: theme.ruler };
    paintRuler(context, editor, model.rate, RULER_HEIGHT, look, (value) => this.sharp(value));

    const end = this.sharp(editor.xAt(editor.visibleDuration));
    context.fillStyle = theme.end;
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
    const { context } = this;
    context.fillStyle = this.#theme.end;
    const end = this.sharp(editor.xAt(editor.visibleDuration));
    if (end >= 0 && end <= editor.width) context.fillRect(end, RULER_HEIGHT, 1, editor.height);
    context.fillStyle = this.#theme.snap;
    for (const moment of [editor.preview?.snap, editor.razorAt]) {
      if (moment === undefined) continue;
      context.fillRect(this.sharp(editor.xAt(moment)), 0, 1, editor.height);
    }
  }
}
