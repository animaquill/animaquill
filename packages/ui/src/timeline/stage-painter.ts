/** Canvas cannot read CSS variables, so the colours come over once. */
export interface Theme {
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
  readonly failed: string;
  readonly key: string;
  readonly keyTried: string;
  readonly keySummary: string;
  readonly curve: string;
}

export function readTheme(element: Element): Theme {
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
    failed: style.getPropertyValue("--aq-danger").trim(),
    key: color("key"),
    keyTried: style.getPropertyValue("--aq-trial").trim(),
    keySummary: color("key-summary"),
    curve: color("curve"),
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
