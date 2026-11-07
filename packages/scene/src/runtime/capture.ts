import type { ScenePicture } from "../protocol.ts";
import type { Stage } from "./stage.ts";

/**
 * How long a picture waits for the browser to paint. A frame that is hidden gets no paint at all,
 * and a walk through time cannot wait for that. Nobody is looking then anyway.
 */
const PAINT_LIMIT_MS = 1000;

/** What only browsers with capture have. */
interface CaptureCanvas extends HTMLCanvasElement {
  requestPaint(): void;
}

interface CaptureContext extends CanvasRenderingContext2D {
  drawElementImage(element: Element, x: number, y: number): unknown;
}

export interface CaptureHooks {
  send(picture: ScenePicture): void;
  report(code: "canvas-layer" | "capture-failed" | "capture-timeout"): void;
  /** Real time, for waiting on the browser. */
  sleep(ms: number): Promise<void>;
  /** Runs something on the next frame of the screen, whenever that comes. */
  onScreenFrame(run: () => void): void;
}

export interface Capture {
  /** Goes on when the frame is on its way, or it is clear that there is not going to be a picture. */
  take(frame: number): Promise<void>;
}

/**
 * Makes pictures of the stage. This is where the browser rules for capture are: what is on the
 * screen is settled in the frame of the screen, and drawing it is only possible in the `paint` event
 * of that frame. The picture has the size of the canvas, which is the size of the output, so that
 * text gets drawn for that size and nothing has to be scaled afterwards.
 *
 * Project code shares this page. It can draw on the canvas, which the next picture wipes out, or
 * replace these functions, which gets it the picture it deserves. Both only ever change what its
 * own scene looks like, and that is up to it anyway.
 */
export function startCapture({ canvas, body }: Stage, hooks: CaptureHooks): Capture | undefined {
  const context = canvas.getContext("2d") as CaptureContext | null;
  if (!context || !("drawElementImage" in context) || !("requestPaint" in canvas)) return undefined;
  const { requestPaint } = canvas as CaptureCanvas;
  const { drawElementImage, reset } = context;
  const makeImage = createImageBitmap.bind(window);
  let onPaint: (() => void) | undefined;
  /** The frame that was asked for last, which is the only one worth another try. */
  let latest = -1;

  canvas.addEventListener("paint", () => {
    const run = onPaint;
    onPaint = undefined;
    run?.();
  });

  /**
   * Whether a canvas in a page gets captured depends on what kind it is and on the graphics card, so
   * it is left out of that for all of them, see `stageStyle`. They go on top of the page instead,
   * where it says they are. That takes no more than their box and their opacity, and what is above
   * one in the page ends up below it.
   */
  const drawCanvases = () => {
    const scale = canvas.width / innerWidth;
    let drawn = false;
    // This list is kept up to date by the browser, so a frame only pays for the canvases there are.
    for (const nested of document.getElementsByTagName("canvas")) {
      if (nested === canvas || nested.width === 0 || nested.height === 0) continue;
      const { left, top, width, height } = nested.getBoundingClientRect();
      if (width === 0 || height === 0) continue;
      context.globalAlpha = Number(getComputedStyle(nested).opacity);
      context.drawImage(nested, left * scale, top * scale, width * scale, height * scale);
      drawn = true;
    }
    if (drawn) hooks.report("canvas-layer");
  };

  const draw = () => {
    reset.call(context);
    drawElementImage.call(context, body, 0, 0);
    drawCanvases();
  };

  /** Whether the canvas holds what the document shows now. */
  const drawn = () =>
    new Promise<boolean>((resolve) => {
      onPaint = () => {
        try {
          draw();
          resolve(true);
        } catch {
          hooks.report("capture-failed");
          resolve(false);
        }
      };
      requestPaint.call(canvas);
    });

  async function take(frame: number): Promise<void> {
    latest = frame;
    const painted = await Promise.race([drawn(), hooks.sleep(PAINT_LIMIT_MS)]);
    if (painted === undefined) {
      // People moved on behind another tab. When they come back, this is what they should see.
      onPaint = undefined;
      hooks.report("capture-timeout");
      hooks.onScreenFrame(() => {
        if (latest === frame) void take(frame);
      });
    }
    if (!painted) return;
    try {
      hooks.send({ frame, image: await makeImage(canvas) });
    } catch {
      hooks.report("capture-failed");
    }
  }

  return { take };
}
