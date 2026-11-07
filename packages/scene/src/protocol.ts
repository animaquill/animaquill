/**
 * What the compositor and a scene say to each other. A scene runs code from the project, so what
 * comes out of one is only ever data to check, never something to trust: see `readFromScene`.
 */

/** The interface a scene's code is written against. Projects name it in `scene.json`. */
export const RUNTIME_VERSION = 1;

/** Frames per second as a fraction, so that 30000/1001 stays exact. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/**
 * The view of a scene. One unit of the world is one CSS pixel, so `width` and `height` are the size
 * of the clip's box, and the size of the viewport the scene gets. `pixelRatio` is how many pixels of
 * the output that makes, which the scene's CSS never sees.
 */
export interface SceneView {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /** The format the project is rendered in, for `data-format`. */
  readonly format: string;
  /** For `lang`. */
  readonly language: string;
}

/** How many pixels of the output a scene's picture has. The canvas it is captured from has as many. */
export const pixelSizeOf = ({ width, height, pixelRatio }: SceneView) => ({
  width: Math.round(width * pixelRatio),
  height: Math.round(height * pixelRatio),
});

/** Everything a scene gets to run. It gets nothing else, so it can leak nothing else. */
export interface SceneLoad {
  /** The page or module to start with, by path from the root of the project. */
  readonly entry: string;
  /** By path from the root of the project. */
  readonly files: ReadonlyMap<string, Blob>;
  /** For `aq.asset(id)`, by ID. */
  readonly assets: ReadonlyMap<string, Blob>;
  /** The scene's frames. Stateful code advances in these steps, whatever the preview does. */
  readonly fps: FrameRate;
  /** Random numbers come from this, so that a frame always looks the same. */
  readonly seed: number;
  readonly view: SceneView;
  /**
   * `canvas` puts the content into a canvas to capture it. `plain` leaves a normal page, which is
   * all a browser without capture can lay out.
   */
  readonly stage: "canvas" | "plain";
}

/** Where the time of a playing scene comes from. Sent once, not with every frame. */
export interface TimeBase {
  /** The frame at the moment `at`. */
  readonly frame: number;
  /** `performance.timeOrigin + performance.now()`, which agrees between processes. */
  readonly at: number;
  /** Timeline seconds per real second. */
  readonly rate: number;
}

/** From the compositor to a scene. */
export type ToScene =
  /** The answer to `hello`. The page runs `code`, and that runs `scene`. */
  | {
      readonly type: "boot";
      readonly runtime: number;
      readonly code: Blob;
      readonly scene: SceneLoad;
    }
  /** Go to a frame and hold it. Answered by `seeked` or `needs-replay`. */
  | { readonly type: "seek"; readonly request: number; readonly frame: number }
  /** Follow the time from now on, by itself. Sending it again corrects the time. */
  | { readonly type: "play"; readonly base: TimeBase }
  /** Stay on the current frame. */
  | { readonly type: "pause" }
  /** New curves for one layer, only those that changed. What is in them comes with properties. */
  | {
      readonly type: "channels";
      readonly layer: string;
      readonly channels: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "ping"; readonly nonce: number };

/** Something a scene wants people to know about, with what it knows of the place. */
export interface SceneProblem {
  /**
   * `error` and `rejection` come from the project's code. `resource` is something that would not
   * load, `blocked` something the sandbox stopped. `loader` is something in the project the loader
   * could not follow, with a `code`. `api` is something that cannot work in a scene, with a `code`.
   */
  readonly kind: "api" | "blocked" | "error" | "loader" | "rejection" | "resource";
  readonly code?: string;
  readonly message?: string;
  /** A path in the project. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  /** What it was about: a URL, an asset, an element. */
  readonly target?: string;
  readonly stack?: string;
  /** The frame the scene was on. */
  readonly frame: number;
}

/** What a scene looks like on a frame. */
export interface ScenePicture {
  readonly frame: number;
  /** It belongs to whoever gets it, and has to be closed. */
  readonly image: ImageBitmap;
}

/** From a scene to the compositor. */
export type FromScene =
  /** The page is there and can take `boot`. */
  | { readonly type: "hello"; readonly runtime: number; readonly capture: boolean }
  /** The project is loaded, and nothing of it ran past its first moment. */
  | { readonly type: "ready"; readonly width: number; readonly height: number }
  /** It cannot run at all. */
  | { readonly type: "failed"; readonly message: string }
  | {
      readonly type: "seeked";
      readonly request: number;
      readonly frame: number;
      /** Whether going back would need a new scene from some frame on. */
      readonly stateful: boolean;
    }
  /** Code ran between here and that frame, and it cannot run backwards. */
  | { readonly type: "needs-replay"; readonly request: number; readonly frame: number }
  /** Where a playing scene got to. */
  | { readonly type: "position"; readonly frame: number }
  /** A picture of it, for every frame it arrives at. Comes before `seeked` and `position`. */
  | ({ readonly type: "frame" } & ScenePicture)
  /** How far a long way to a frame has come, so that it can be told from a scene that is stuck. */
  | { readonly type: "progress"; readonly frame: number }
  | { readonly type: "problem"; readonly problem: SceneProblem }
  | { readonly type: "pong"; readonly nonce: number };

/** Longer than any line of an error message a person would read. */
const MAX_TEXT = 2000;
const MAX_STACK = 4000;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const count = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;

const text = (value: unknown, limit = MAX_TEXT): string | undefined =>
  typeof value === "string" ? value.slice(0, limit) : undefined;

const PROBLEM_KINDS = new Set(["api", "blocked", "error", "loader", "rejection", "resource"]);

function readProblem(value: unknown): SceneProblem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const problem = value as Record<string, unknown>;
  const frame = count(problem.frame);
  if (typeof problem.kind !== "string" || !PROBLEM_KINDS.has(problem.kind)) return undefined;
  if (frame === undefined) return undefined;
  const optional = {
    code: text(problem.code),
    message: text(problem.message),
    file: text(problem.file),
    line: count(problem.line),
    column: count(problem.column),
    target: text(problem.target),
    stack: text(problem.stack, MAX_STACK),
  };
  return {
    kind: problem.kind as SceneProblem["kind"],
    frame,
    ...Object.fromEntries(Object.entries(optional).filter(([, entry]) => entry !== undefined)),
  };
}

/**
 * A picture out of a message. This is its own case because of what it weighs: a picture is meant to
 * be large, and it never gets copied, so the limits on what a message may weigh are not for this.
 */
export function readPicture(data: unknown): ScenePicture | "malformed" | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { type, frame, image } = data as Record<string, unknown>;
  if (type !== "frame") return undefined;
  // A picture goes without weighing, so nothing may come along with it.
  const keys = Object.keys(data);
  const position = count(frame);
  const isPicture = typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap;
  if (keys.length !== 3 || position === undefined || !isPicture) return "malformed";
  return { frame: position, image };
}

/**
 * Reads a message that came out of a scene. Whatever is in it was made by code from the project, so
 * this keeps what it recognizes, cuts it down to a sane size, and drops the rest. A picture has to
 * be taken out first, see `readPicture`.
 */
export function readFromScene(data: unknown): Exclude<FromScene, { type: "frame" }> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "hello": {
      const runtime = count(message.runtime);
      return runtime === undefined
        ? undefined
        : { type: "hello", runtime, capture: message.capture === true };
    }
    case "ready": {
      const width = number(message.width);
      const height = number(message.height);
      return width === undefined || height === undefined
        ? undefined
        : { type: "ready", width, height };
    }
    case "failed":
      return { type: "failed", message: text(message.message) ?? "" };
    case "seeked": {
      const request = count(message.request);
      const frame = count(message.frame);
      return request === undefined || frame === undefined
        ? undefined
        : { type: "seeked", request, frame, stateful: message.stateful === true };
    }
    case "needs-replay": {
      const request = count(message.request);
      const frame = count(message.frame);
      return request === undefined || frame === undefined
        ? undefined
        : { type: "needs-replay", request, frame };
    }
    case "position":
    case "progress": {
      const frame = count(message.frame);
      return frame === undefined ? undefined : { type: message.type, frame };
    }
    case "problem": {
      const problem = readProblem(message.problem);
      return problem && { type: "problem", problem };
    }
    case "pong": {
      const nonce = count(message.nonce);
      return nonce === undefined ? undefined : { type: "pong", nonce };
    }
    default:
      return undefined;
  }
}
