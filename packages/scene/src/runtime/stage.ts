import { pixelSizeOf, type SceneLoad, type SceneView } from "../protocol.ts";

/** The canvas that the scene gets captured from. */
const STAGE_ID = "aq-stage";

/**
 * What every page starts with. It comes before anything of the project, so whatever the project
 * says about the same things wins, as it would over a browser's defaults.
 */
export function stageStyle({ width, height, pixelRatio }: SceneView, stage: SceneLoad["stage"]) {
  const variables = `:root{--aq-width:${width}px;--aq-height:${height}px;--aq-pixel-ratio:${pixelRatio}}`;
  if (stage === "plain") return variables;
  // The background goes down from <html>, which is not captured, to <body>, which is.
  return (
    variables +
    `html{overflow:hidden}` +
    `#${STAGE_ID}{position:fixed;left:0;top:0;display:block;width:100vw;height:100vh;background:inherit}` +
    `body{position:relative;width:100%;height:100%;margin:0;overflow:hidden;background:inherit}` +
    // These get drawn by themselves, see `startCapture`, and should not show twice.
    `canvas:not(#${STAGE_ID}){visibility:hidden!important}`
  );
}

/** Tells the page who it is for, before any of its own code runs. */
export function describeDocument({ language, format }: SceneView): void {
  const root = document.documentElement;
  root.lang = language;
  root.dataset.format = format;
}

/** What a scene gets captured from. */
export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly body: HTMLElement;
}

/**
 * Puts the body into the canvas. Only what is in the canvas can be captured. This runs as the first
 * thing in the body, and the parser goes on adding to the element it opened, wherever that went. So
 * the page's own scripts and its markup land in the canvas from the start, in order, and scripts in
 * the body find everything in its final place.
 */
export function enterStage(view: SceneView): Stage {
  const body = document.body;
  const canvas = document.createElement("canvas");
  const { width, height } = pixelSizeOf(view);
  canvas.id = STAGE_ID;
  canvas.setAttribute("content", "drawable");
  canvas.width = width;
  canvas.height = height;
  document.documentElement.replaceChild(canvas, body);
  canvas.append(body);
  body.setAttribute("drawable", "");
  // The browser only takes a child of <html> for the body.
  Object.defineProperty(Document.prototype, "body", { configurable: true, get: () => body });
  return { canvas, body };
}

/**
 * WebGL wipes what it drew once that reached the screen, and a picture gets taken after that. Project
 * code runs later, so that it gets this for the asking.
 */
export function keepDrawings(): void {
  const { getContext } = HTMLCanvasElement.prototype;
  HTMLCanvasElement.prototype.getContext = function kept(
    this: HTMLCanvasElement,
    type: string,
    options?: Readonly<Record<string, unknown>>,
  ) {
    const isWebGl = /^(experimental-)?webgl2?$/.test(type);
    return getContext.call(
      this,
      type,
      isWebGl ? { ...options, preserveDrawingBuffer: true } : options,
    );
  } as typeof getContext;
}

/**
 * What a frame does to the history goes into the history of the whole tab, and the Back button of
 * the editor would have to work its way through it. This only keeps code from doing that by the
 * way: it can still get at the real thing from a frame of its own, and through `location.hash`.
 */
export function keepHistory(): void {
  const { replaceState } = History.prototype;
  const stay = function stay(this: History, state: unknown) {
    replaceState.call(this, state, "");
  };
  History.prototype.pushState = stay;
  History.prototype.replaceState = stay;
  History.prototype.back = () => {};
  History.prototype.forward = () => {};
  History.prototype.go = () => {};
}

/**
 * Nobody is at the keyboard of a scene, and if a scene has the focus the editor does not. Code that
 * means no harm stops here. What does mean harm finds a way around this, and the compositor has to
 * deal with that, see `SceneHost.focusTaken`.
 */
export function keepFocusAway(warn: () => void): void {
  const nowhere = () => warn();
  HTMLElement.prototype.focus = nowhere;
  SVGElement.prototype.focus = nowhere;
  MathMLElement.prototype.focus = nowhere;
  window.focus = nowhere;
}

/** Top layer elements are drawn above the document and never reach the canvas. */
export function warnAboutTopLayer(warn: (api: string) => void): void {
  const wrap = <T extends object>(prototype: T, name: keyof T & string) => {
    const real = prototype[name] as (...args: unknown[]) => unknown;
    prototype[name] = function warned(this: unknown, ...args: unknown[]) {
      warn(name);
      return real.apply(this, args);
    } as never;
  };
  wrap(HTMLDialogElement.prototype, "showModal");
  wrap(HTMLElement.prototype, "showPopover");
  wrap(HTMLElement.prototype, "togglePopover");
  wrap(Element.prototype, "requestFullscreen");
}
