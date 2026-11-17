import { formatTimecode, type FrameRate } from "./frames.ts";

/** Where the timecodes are, from the top: the middle of their line. */
export const RULER_LABEL_Y = 10;
/** Labels need this much room to be read, and ticks closer than this turn into a grey band. */
const MIN_LABEL_GAP = 110;
const MIN_TICK_GAP = 7;

const SMALL_FRAME_STEPS = [1, 2, 5, 10];
const SECOND_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18_000, 36_000,
];
const SUBDIVISIONS = [10, 6, 5, 4, 3, 2];

export interface RulerSteps {
  /** Frames between labels. */
  readonly major: number;
  /** Frames between ticks. */
  readonly minor: number;
}

/**
 * The spacing of the ruler at a zoom level. Steps are counted in frames, so that labels stay round
 * numbers at rates like 29.97, where a whole second does not fall on a frame.
 */
export function rulerSteps(pixelsPerFrame: number, nominal: number): RulerSteps {
  const steps = [
    ...SMALL_FRAME_STEPS.filter((frames) => frames < nominal / 2),
    ...(nominal % 2 === 0 ? [nominal / 2] : []),
    ...SECOND_STEPS.map((seconds) => seconds * nominal),
  ];
  const major =
    steps.find((frames) => frames * pixelsPerFrame >= MIN_LABEL_GAP) ?? (steps.at(-1) as number);
  const parts = SUBDIVISIONS.find(
    (count) => major % count === 0 && (major / count) * pixelsPerFrame >= MIN_TICK_GAP,
  );
  return { major, minor: parts === undefined ? major : major / parts };
}

/** What a ruler goes by. */
export interface RulerView {
  readonly width: number;
  readonly pixelsPerSecond: number;
  xAt(seconds: number): number;
  timeAt(x: number): number;
}

export interface RulerLook {
  readonly background: string;
  readonly line: string;
  readonly tick: string;
  readonly label: string;
}

/** The timecodes along the ruler that show on screen, each with where its words start. */
export function rulerLabels(
  view: RulerView,
  rate: FrameRate,
): readonly { readonly x: number; readonly text: string }[] {
  const { major } = rulerSteps(view.pixelsPerSecond / rate.fps, rate.nominal);
  const firstFrame = Math.max(view.timeAt(0) * rate.fps, 0);
  const lastFrame = view.timeAt(view.width) * rate.fps;
  const labels: { x: number; text: string }[] = [];
  for (let frame = Math.floor(firstFrame / major) * major; frame <= lastFrame; frame += major) {
    labels.push({ x: view.xAt(frame / rate.fps) + LABEL_INSET, text: formatTimecode(frame, rate) });
  }
  return labels;
}

const LABEL_INSET = 4;

/** Draws a ruler along the top, as tall as `height`. */
export function paintRuler(
  context: CanvasRenderingContext2D,
  view: RulerView,
  rate: FrameRate,
  height: number,
  look: RulerLook,
  sharp: (value: number) => number,
): void {
  context.fillStyle = look.background;
  context.fillRect(0, 0, view.width, height);
  context.fillStyle = look.line;
  context.fillRect(0, height - 1, view.width, 1);

  const { major, minor } = rulerSteps(view.pixelsPerSecond / rate.fps, rate.nominal);
  const firstFrame = Math.max(view.timeAt(0) * rate.fps, 0);
  const lastFrame = view.timeAt(view.width) * rate.fps;
  context.fillStyle = look.tick;
  for (let frame = Math.floor(firstFrame / minor) * minor; frame <= lastFrame; frame += minor) {
    const x = sharp(view.xAt(frame / rate.fps));
    const length = frame % major === 0 ? 10 : 5;
    context.fillRect(x, height - 1 - length, 1, length);
  }
  context.fillStyle = look.label;
  for (const { x, text } of rulerLabels(view, rate)) context.fillText(text, x, RULER_LABEL_Y);
}
