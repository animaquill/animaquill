/** Canvas cannot read CSS variables, so the colours come over once. */
export interface Theme {
  readonly font: string;
  /** How much larger than standard the words are, as people chose in the settings. */
  readonly fontScale: number;
  readonly background: string;
  readonly lane: string;
  readonly laneLocked: string;
  /** Over the lane of what has properties under it, in the keyframes. */
  readonly parent: string;
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
  readonly failed: string;
  readonly key: string;
  readonly keyTried: string;
  readonly keySummary: string;
  readonly curve: string;
  readonly handle: string;
  readonly warning: string;
  /** The band of a clip with effects. */
  readonly effect: string;
  /** The outline of what was just added, for a moment. */
  readonly flash: string;
  /** The mark of what came from GitHub lately, see `TimelineEditor.repoMarked`. */
  readonly repo: string;
  /** What is marked with in and out: the band on the ruler and its ends. */
  readonly marked: string;
  /** Over the tracks where something is marked, a little lighter. */
  readonly markedLanes: string;
}

export function readTheme(element: Element): Theme {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(`--aq-timeline-${name}`).trim();
  return {
    font: style.getPropertyValue("--aq-font"),
    fontScale: Number.parseFloat(style.getPropertyValue("--aq-font-scale")) || 1,
    background: color("background"),
    lane: color("lane"),
    laneLocked: color("lane-locked"),
    parent: color("parent"),
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
    failed: style.getPropertyValue("--aq-danger").trim(),
    key: color("key"),
    keyTried: style.getPropertyValue("--aq-trial").trim(),
    keySummary: color("key-summary"),
    curve: color("curve"),
    handle: color("handle"),
    warning: style.getPropertyValue("--aq-warning").trim(),
    effect: color("effect"),
    flash: color("flash"),
    repo: color("repo"),
    marked: color("marked"),
    markedLanes: color("marked-lanes"),
  };
}

/** A canvas that follows the size of its place, and gets drawn once per frame at most. */
export abstract class StagePainter {
  protected readonly canvas: HTMLCanvasElement;
  protected readonly context: CanvasRenderingContext2D;
  protected ratio = 1;
  /** What was on the canvas is gone, so whatever comes next has to draw all of it. */
  protected isWiped = true;
  #pending: number | undefined;
  /** Read at the first paint: a canvas that is not in the page yet has no styles to read. */
  #theme: Theme | undefined;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("No 2D context");
    this.canvas = canvas;
    this.context = context;
    // The browser can drop what a canvas holds, for example after a problem with the graphics card.
    canvas.addEventListener("contextrestored", () => {
      this.isWiped = true;
      this.invalidate();
    });
  }

  protected abstract paint(): void;

  /** The colours and the size of words, as the theme and the settings have them now. */
  protected get theme(): Theme {
    return (this.#theme ??= readTheme(this.canvas));
  }

  /** The theme or the size of words changed: everything is drawn again, in the new ones. */
  restyle(): void {
    this.#theme = undefined;
    this.isWiped = true;
    this.paintNow();
  }

  /** Sizes are in CSS pixels. The canvas itself has as many pixels as the screen shows. */
  resize(width: number, height: number, ratio: number): void {
    this.ratio = ratio;
    this.isWiped = true;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  invalidate(): void {
    this.#pending ??= requestAnimationFrame(() => {
      this.#pending = undefined;
      this.paint();
    });
  }

  paintNow(): void {
    this.dispose();
    this.#pending = undefined;
    this.paint();
  }

  dispose(): void {
    if (this.#pending !== undefined) cancelAnimationFrame(this.#pending);
  }

  /** Lines stay sharp when they sit on the pixels of the screen. */
  protected sharp(value: number): number {
    return Math.round(value * this.ratio) / this.ratio;
  }
}
