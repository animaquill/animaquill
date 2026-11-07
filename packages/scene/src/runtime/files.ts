import { rewriteCss } from "../loader/css.ts";
import { rewriteSrcset } from "../loader/html.ts";
import { resolveReference, virtualUrl } from "../loader/paths.ts";
import { typeOf, type LoadedProject, type LoadProblem } from "../loader/project.ts";
import { SCENE_EPOCH } from "./time.ts";
import { workerPrelude } from "./worker.ts";

/** Elements whose address the browser would load, and which attribute has it. */
const ADDRESSES = [
  [HTMLEmbedElement, "src"],
  [HTMLImageElement, "src"],
  [HTMLInputElement, "src"],
  [HTMLLinkElement, "href"],
  [HTMLMediaElement, "src"],
  [HTMLScriptElement, "src"],
  [HTMLSourceElement, "src"],
  [HTMLTrackElement, "src"],
  [HTMLVideoElement, "poster"],
] as const;

const ADDRESS_ELEMENTS = new Set([
  "audio",
  "embed",
  "image",
  "img",
  "input",
  "link",
  "script",
  "source",
  "track",
  "video",
]);

const ADDRESS_ATTRIBUTES = new Set(["href", "poster", "src"]);

const UNREWRITTEN = "audio, embed, img, input, source, track, video";

const scriptUrl = (text: string) =>
  URL.createObjectURL(new Blob([text], { type: "text/javascript" }));

/** Things that take real time, and that the project is likely to wait for before going on. */
function installWaiting(track: FileAccess["track"]): void {
  // Waiting to come near the screen makes no sense in a scene, and may never end.
  const lazy = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "loading");
  Object.defineProperty(HTMLImageElement.prototype, "loading", {
    ...lazy,
    set(this: HTMLImageElement) {
      lazy?.set?.call(this, "eager");
    },
  });
  const image = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    ...image,
    set(this: HTMLImageElement, value: string) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.addEventListener("load", () => resolve(), { once: true });
      this.addEventListener("error", () => resolve(), { once: true });
      void track(promise);
      image?.set?.call(this, value);
    },
  });
  const { decode } = HTMLImageElement.prototype;
  HTMLImageElement.prototype.decode = function decodeImage() {
    return track(decode.call(this));
  };
  const { load } = FontFace.prototype;
  FontFace.prototype.load = function loadFont() {
    return track(load.call(this));
  };
  const { load: loadFonts } = FontFaceSet.prototype;
  FontFaceSet.prototype.load = function loadFontsFor(font, text) {
    return track(loadFonts.call(this, font, text));
  };
  const makeBitmap = window.createImageBitmap.bind(window) as (
    ...args: unknown[]
  ) => Promise<ImageBitmap>;
  window.createImageBitmap = ((...args: unknown[]) =>
    track(makeBitmap(...args))) as typeof createImageBitmap;
}

export interface FileAccess {
  readonly project: LoadedProject;
  readonly entry: string;
  readonly files: ReadonlyMap<string, Blob>;
  readonly seed: number;
  readonly global: string;
  readonly report: (problem: LoadProblem) => void;
  readonly workerFailed: (event: ErrorEvent) => void;
  /** A worker can never be fully on the scene's clock, so people should know there is one. */
  readonly workerStarted: () => void;
  /** Nothing of the runtime gets into a worklet, so people should know about that too. */
  readonly workletStarted: () => void;
  /** Holds time back until something that takes real time has happened. */
  readonly track: <T>(work: Promise<T>) => Promise<T>;
}

/**
 * Paths that code only works out when it runs can not be rewritten beforehand. These are the places
 * they reach the browser. What gets past this is blocked by the sandbox, and reported.
 */
export function installFileAccess(access: FileAccess): () => ReadonlySet<string> {
  const { project, entry, files, track, report } = access;
  // `new URL("a.png", location.href)` is what code that knows no better does.
  const page = new URL(".", location.href).href;

  /** The file an address means, if it means one. */
  const locate = (address: string) => {
    const relative = address.startsWith(page) ? address.slice(page.length) : address;
    const reference = resolveReference(relative, entry);
    if (reference.kind !== "file") return undefined;
    return reference;
  };

  const urlFor = (address: string) => {
    const reference = locate(address);
    if (!reference) return address;
    if (files.has(reference.path)) return project.urlOf(reference.path) + reference.fragment;
    report({ code: "missing-file", file: entry, target: address });
    return address;
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const address = input instanceof Request ? input.url : String(input);
    const reference = locate(address);
    if (!reference) return track(realFetch(input, init));
    const file = files.get(reference.path);
    if (file) {
      const headers = { "Content-Type": file.type || typeOf(reference.path) };
      return track(Promise.resolve(new Response(file, { status: 200, headers })));
    }
    report({ code: "missing-file", file: entry, target: address });
    return track(Promise.resolve(new Response(null, { status: 404 })));
  };

  // Reading a body takes real time as well, and code goes on when it is done.
  for (const prototype of [Response.prototype, Request.prototype, Blob.prototype]) {
    for (const name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const) {
      const read = (
        prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
      )[name];
      if (!read) continue;
      Object.defineProperty(prototype, name, {
        configurable: true,
        writable: true,
        value(this: unknown, ...args: unknown[]) {
          return track(read.apply(this, args));
        },
      });
    }
  }

  const open = XMLHttpRequest.prototype.open as (...args: unknown[]) => void;
  XMLHttpRequest.prototype.open = function openFile(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    open.call(this, method, urlFor(String(url)), ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  for (const [element, name] of ADDRESSES) {
    const { prototype } = element;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    Object.defineProperty(prototype, name, {
      ...descriptor,
      set(this: HTMLElement, value: string) {
        descriptor?.set?.call(this, urlFor(String(value)));
      },
    });
  }

  installWaiting(track);

  const { setAttribute } = Element.prototype;
  Element.prototype.setAttribute = function setAddress(this: Element, name, value) {
    const attribute = String(name).toLowerCase();
    if (attribute === "loading") {
      setAttribute.call(this, name, "eager");
      return;
    }
    const isAddress = ADDRESS_ATTRIBUTES.has(attribute) && ADDRESS_ELEMENTS.has(this.localName);
    setAttribute.call(this, name, isAddress ? urlFor(String(value)) : value);
  };

  const RealFontFace = window.FontFace;
  window.FontFace = class extends RealFontFace {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      const written =
        typeof source === "string" ? rewriteCss(source, ({ url }) => urlFor(url)) : source;
      super(family, written, descriptors);
    }
  };

  if ("Worklet" in window) {
    const { addModule } = Worklet.prototype;
    Worklet.prototype.addModule = function addFile(this: Worklet, url, options) {
      access.workletStarted();
      return track(addModule.call(this, urlFor(String(url)), options));
    };
  }

  /** A path in a worker means something next to the worker's own file. */
  const preludeUrl = (path: string) => {
    const text = workerPrelude({
      files: Object.fromEntries(project.workerFiles()),
      base: virtualUrl(path),
      seed: access.seed,
      epoch: SCENE_EPOCH,
      global: access.global,
    });
    return scriptUrl(text);
  };

  /** A worker that code made itself gets what any other gets. */
  const blobWorkerUrl = (address: string, module: boolean) => {
    const first = `importScripts(${JSON.stringify(preludeUrl(entry))});`;
    const then = JSON.stringify(address);
    return scriptUrl(
      first + (module ? `${access.global}.start(${then});` : `importScripts(${then});`),
    );
  };

  const RealWorker = window.Worker;
  window.Worker = class extends RealWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      const address = String(url);
      const reference = locate(address);
      const known = reference && files.has(reference.path) ? reference.path : undefined;
      const module = options?.type === "module";
      let script: string | undefined;
      if (known !== undefined) script = project.workerUrl(known, module, () => preludeUrl(known));
      else if (address.startsWith("blob:")) script = blobWorkerUrl(address, module);
      if (script === undefined) super(url, options);
      else super(script, { ...options, type: "classic" });
      this.addEventListener("error", access.workerFailed);
      access.workerStarted();
    }
  };

  return () =>
    putRight((address) => {
      const reference = locate(address);
      return reference && files.has(reference.path)
        ? project.urlOf(reference.path) + reference.fragment
        : address;
    });
}

/**
 * The loader sees a page through its own parser, and the browser may disagree about what is in it:
 * a browser keeps `<img>` in a `<select>`, for example. So after the page is there, what is still
 * written the way the project wrote it gets another chance. Gives what got put right.
 */
function putRight(urlFor: (address: string) => string): ReadonlySet<string> {
  const right = new Set<string>();
  const put = (element: Element, name: string, value: string) => {
    if (value === element.getAttribute(name)) return;
    element.setAttribute(name, value);
  };
  for (const element of document.querySelectorAll(UNREWRITTEN)) {
    for (const name of ["src", "poster"]) {
      const written = element.getAttribute(name);
      if (written === null) continue;
      const url = urlFor(written);
      if (url !== written) right.add(new URL(written, location.href).href);
      put(element, name, url);
    }
    const srcset = element.getAttribute("srcset");
    if (srcset !== null) {
      const written = rewriteSrcset(srcset, (url) => {
        const file = urlFor(url);
        if (file !== url) right.add(new URL(url, location.href).href);
        return file;
      });
      put(element, "srcset", written);
    }
  }
  return right;
}
