import { rewriteCss } from "./css.ts";
import { rewriteHtml } from "./html.ts";
import { lexerReady, rewriteScript, type RewrittenScript } from "./js.ts";
import {
  positionAt,
  positionWithin,
  resolveReference,
  virtualUrl,
  type Position,
} from "./paths.ts";

const TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  css: "text/css",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  m4a: "audio/mp4",
  mjs: "text/javascript",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain",
  wasm: "application/wasm",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

const extensionOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

/** The type a file has to have for the browser to accept it. */
export const typeOf = (path: string) => TYPES[extensionOf(path)] ?? "application/octet-stream";

const isScript = (path: string) => /\.m?js$/i.test(path);
const isStylesheet = (path: string) => /\.css$/i.test(path);
const isPage = (path: string) => /\.html?$/i.test(path);

/** Files that code can import, and that the import map has to know. */
const isImportable = (path: string) =>
  isScript(path) || isStylesheet(path) || /\.json$/i.test(path);

/** What the loader could not do. Only a code: the words are up to the interface. */
export interface LoadProblem {
  readonly code:
    | "above-root"
    | "bad-import-map"
    | "bad-path"
    | "bare-import"
    | "base-tag"
    | "css-import-cycle"
    | "external-url"
    | "frameset"
    | "import-map-scopes"
    | "missing-entry"
    | "missing-file"
    | "unclosed-script"
    | "worker-import-cycle";
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  /** What the project wrote. */
  readonly target?: string;
}

/** Where a script that runs from a blob URL really is. */
export interface ScriptSource {
  readonly path: string;
  /** How far its first line moved to the right. */
  readonly shift: number;
}

export interface ProjectInput {
  /** The page or module to start with, by path from the root of the project. */
  readonly entry: string;
  /** Everything the scene may read, by path from the root of the project. */
  readonly files: ReadonlyMap<string, Blob>;
  /** Makes a URL that works in this document. Only the document that made one can use it. */
  readonly makeUrl: (content: Blob | string, type: string) => string;
  /** Goes first in the head and first in the body. */
  readonly head: string;
  readonly body: string;
  /** The global that generated code calls for what it only knows at run time. */
  readonly global: string;
  readonly report: (problem: LoadProblem) => void;
}

/** A project that is ready to be written into the document. */
export interface LoadedProject {
  /** Empty when there is nothing to run. */
  readonly html: string;
  /** Script URLs, for telling where an error happened. */
  readonly sources: ReadonlyMap<string, ScriptSource>;
  /** The URL of a file, with what it refers to already rewritten. */
  urlOf(path: string): string;
  /** The rewritten form of a module specifier that only became known at run time. */
  specifier(specifier: string, from: string): string;
  /** Every file as a worker can use it, by path. */
  workerFiles(): ReadonlyMap<string, string>;
  /** A worker's script. `prelude` gives the URL of a script to run first. */
  workerUrl(path: string, module: boolean, prelude: () => string): string;
}

const EMPTY_STYLESHEET = "data:text/css,";
const FILE_START: Position = { line: 1, column: 1 };

const isRelative = (specifier: string) => /^\.{0,2}\//.test(specifier);
const hasScheme = (specifier: string) => /^[a-z][a-z0-9+.-]*:/i.test(specifier);

/** A script's text with `prefix` in front, and how far that moves its first line. */
const joined = ({ prefix, text }: RewrittenScript) => ({
  text: prefix + text,
  shift: prefix.length,
});

class Builder {
  readonly #input: ProjectInput;
  readonly #texts: ReadonlyMap<string, string>;
  readonly #urls = new Map<string, string>();
  readonly #openStylesheets = new Set<string>();
  readonly #workerUrls = new Map<string, string>();
  /** Bare names from the project's import map, with what they stand for. */
  readonly #names = new Map<string, string>();
  /** Scripts that are being followed or were followed already. */
  readonly #visited = new Set<string>();
  /** Files nothing has used yet may belong to another scene, and their problems are not ours. */
  #quiet = false;
  readonly sources = new Map<string, ScriptSource>();

  constructor(input: ProjectInput, texts: ReadonlyMap<string, string>) {
    this.#input = input;
    this.#texts = texts;
  }

  #report(problem: LoadProblem): void {
    if (!this.#quiet) this.#input.report(problem);
  }

  /** The first time a file is used is the time it is rewritten. */
  urlOf(path: string): string {
    const known = this.#urls.get(path);
    if (known !== undefined) return known;
    let url: string;
    if (isStylesheet(path)) url = this.#stylesheetUrl(path);
    else if (isScript(path)) url = this.#scriptUrl(path);
    else url = this.#rawUrl(path);
    this.#urls.set(path, url);
    return url;
  }

  #rawUrl(path: string): string {
    const file = this.#input.files.get(path);
    if (!file) throw new Error(`No such file: ${path}`);
    return this.#input.makeUrl(file, file.type || typeOf(path));
  }

  /**
   * What a reference means. Reports what is wrong with it, because the sandbox would only block it
   * and the person who wrote it would not know why it does nothing.
   */
  #resolved(target: string, from: string, at: Position | undefined) {
    const reference = resolveReference(target, from);
    const place = { file: from, ...at, target };
    if (reference.kind === "external") this.#report({ code: "external-url", ...place });
    else if (reference.kind === "refused") this.#report({ code: reference.why, ...place });
    else if (reference.kind === "file") {
      if (this.#input.files.has(reference.path)) return reference;
      this.#report({ code: "missing-file", ...place });
    }
    return undefined;
  }

  css(css: string, from: string, base: Position): string {
    return rewriteCss(css, ({ url, start }) => {
      const at = positionWithin(base, positionAt(css, start));
      const reference = this.#resolved(url, from, at);
      if (!reference) return undefined;
      if (this.#openStylesheets.has(reference.path)) {
        this.#report({ code: "css-import-cycle", file: from, ...at, target: url });
        return EMPTY_STYLESHEET;
      }
      return this.urlOf(reference.path) + reference.fragment;
    });
  }

  #stylesheetUrl(path: string): string {
    this.#openStylesheets.add(path);
    const css = this.css(this.#texts.get(path) ?? "", path, FILE_START);
    this.#openStylesheets.delete(path);
    return this.#input.makeUrl(css, "text/css");
  }

  /** What a project calls a shared module, through its import map. */
  #named(specifier: string): string | undefined {
    const exact = this.#names.get(specifier);
    if (exact !== undefined) return exact;
    let best: string | undefined;
    for (const name of this.#names.keys()) {
      if (name.endsWith("/") && specifier.startsWith(name) && name.length > (best?.length ?? 0)) {
        best = name;
      }
    }
    return best === undefined
      ? undefined
      : `${this.#names.get(best)}${specifier.slice(best.length)}`;
  }

  /** Module specifiers differ from URLs: `three` is a name, not a file next to this one. */
  #module(specifier: string, from: string, at: Position | undefined) {
    if (isRelative(specifier) || hasScheme(specifier)) return this.#resolved(specifier, from, at);
    const named = this.#named(specifier);
    if (named !== undefined) return this.#resolved(named, this.#input.entry, at);
    this.#report({ code: "bare-import", file: from, ...at, target: specifier });
    return undefined;
  }

  specifier(specifier: string, from: string): string {
    const reference = this.#module(specifier, from, undefined);
    if (!reference) return specifier;
    // Code may compute a name that nothing named before, so this one has not been loaded yet.
    return virtualUrl(reference.path);
  }

  /**
   * `address` says how one script names another. In the document that is a virtual address the
   * import map knows. Using a file here is what gets it loaded, so an import takes its problems along.
   */
  #rewrite(
    text: string,
    from: string,
    base: Position,
    address: (path: string) => string | undefined,
  ): RewrittenScript {
    const self = JSON.stringify(virtualUrl(from));
    const { global } = this.#input;
    return (
      rewriteScript(text, {
        specifier: (specifier, offset) => {
          const at = positionWithin(base, positionAt(text, offset));
          const reference = this.#module(specifier, from, at);
          return reference && address(reference.path);
        },
        computed: [`${global}.spec(`, `,${self})`],
        dynamic: [`${global}.load(`, ")"],
        meta:
          `import.meta.url=${self};` +
          `import.meta.resolve=(s)=>new URL(${global}.spec(s,${self}),${self}).href;`,
      }) ?? { prefix: "", text }
    );
  }

  /** Follows an import, so that its problems show up now. Cycles end at the file being rewritten. */
  #inDocument = (path: string): string => {
    if (!this.#visited.has(path)) {
      this.#visited.add(path);
      this.urlOf(path);
    }
    return virtualUrl(path);
  };

  #scriptUrl(path: string): string {
    this.#visited.add(path);
    const script = this.#rewrite(this.#texts.get(path) ?? "", path, FILE_START, this.#inDocument);
    const { text, shift } = joined(script);
    const url = this.#input.makeUrl(text, "text/javascript");
    this.sources.set(url, { path, shift });
    return url;
  }

  /** A script written in the page keeps its lines in the page, so errors point at them. */
  inlineScript(text: string, from: string, at: Position): string {
    const { prefix, text: rewritten } = this.#rewrite(text, from, at, this.#inDocument);
    const padding = "\n".repeat(at.line - 1) + " ".repeat(at.column - 1);
    const url = this.#input.makeUrl(prefix + padding + rewritten, "text/javascript");
    this.sources.set(url, { path: from, shift: at.line === 1 ? prefix.length : 0 });
    return url;
  }

  importMap(text: string, from: string, at: Position): void {
    let map: unknown;
    try {
      map = JSON.parse(text);
    } catch {
      this.#report({ code: "bad-import-map", file: from, ...at });
      return;
    }
    if (typeof map !== "object" || map === null) return;
    const { imports, scopes } = map as { imports?: unknown; scopes?: unknown };
    if (scopes !== undefined) this.#report({ code: "import-map-scopes", file: from, ...at });
    for (const [name, target] of Object.entries(imports ?? {})) {
      if (typeof target === "string") this.#names.set(name, target);
    }
  }

  /**
   * The import map of the document. Code can compute what it imports, so it has every file in it
   * and not only those something names.
   */
  importMapOfDocument(): string {
    this.#quiet = true;
    const imports: Record<string, string> = {};
    for (const path of this.#input.files.keys()) {
      if (isImportable(path)) imports[virtualUrl(path)] = this.urlOf(path);
    }
    this.#quiet = false;
    return JSON.stringify({ imports }).replaceAll("<", "\\u003c");
  }

  page(text: string, from: string): string {
    return rewriteHtml(text, {
      url: (value, at) => {
        const reference = this.#resolved(value, from, at);
        return reference && this.urlOf(reference.path) + reference.fragment;
      },
      css: (css, at) => this.css(css, from, at),
      script: (script, at) => this.inlineScript(script, from, at),
      importMap: (map, at) => this.importMap(map, from, at),
      problem: (code, at) => this.#report({ code, file: from, ...at }),
      head: () =>
        `${this.#input.head}<script type="importmap">${this.importMapOfDocument()}</script>`,
      body: this.#input.body,
    });
  }

  /**
   * Workers have no import maps, so a script in one has to name others by what they really are.
   * That only works one way round: a cycle of modules has no order to make the URLs in.
   */
  #workerText(path: string, chain: readonly string[]) {
    return this.#rewrite(this.#texts.get(path) ?? "", path, FILE_START, (target) => {
      if (!isScript(target)) return this.urlOf(target);
      if (!chain.includes(target)) return this.#workerScript(target, [...chain, target]);
      this.#report({ code: "worker-import-cycle", file: path, target });
      return undefined;
    });
  }

  #workerScript(path: string, chain: readonly string[]): string {
    const known = this.#workerUrls.get(path);
    if (known !== undefined) return known;
    const { text, shift } = joined(this.#workerText(path, chain));
    const url = this.#input.makeUrl(text, "text/javascript");
    this.sources.set(url, { path, shift });
    this.#workerUrls.set(path, url);
    return url;
  }

  workerFiles(): ReadonlyMap<string, string> {
    this.#quiet = true;
    const files = new Map<string, string>();
    for (const path of this.#input.files.keys()) {
      files.set(path, isScript(path) ? this.#workerScript(path, [path]) : this.urlOf(path));
    }
    this.#quiet = false;
    return files;
  }

  workerUrl(path: string, module: boolean, prelude: () => string): string {
    const { makeUrl, global } = this.#input;
    if (module) {
      // A page without an origin cannot start a module worker, but a classic one can import.
      const main = JSON.stringify(this.#workerScript(path, [path]));
      const first = `importScripts(${JSON.stringify(prelude())});`;
      return makeUrl(`${first}${global}.start(${main});`, "text/javascript");
    }
    const { text, shift } = joined(this.#workerText(path, [path]));
    const first = `importScripts(${JSON.stringify(prelude())});`;
    const url = makeUrl(first + text, "text/javascript");
    this.sources.set(url, { path, shift: shift + first.length });
    return url;
  }
}

/** The page for an entry that is a script. */
function pageFor(entry: string): string {
  const name = encodeURIComponent(entry.slice(entry.lastIndexOf("/") + 1));
  return `<!doctype html><html><head></head><body><script type="module" src="./${name}"></script></body></html>`;
}

/**
 * Turns a project into a page that works from blob URLs. This only reads and rewrites: nothing of
 * the project runs here, and nothing here needs a document, so it can be tested on its own.
 */
export async function loadProject(input: ProjectInput): Promise<LoadedProject> {
  await lexerReady;
  const { entry, files } = input;
  const texts = new Map<string, string>();
  await Promise.all(
    [...files].map(async ([path, file]) => {
      if (isScript(path) || isStylesheet(path) || isPage(path)) texts.set(path, await file.text());
    }),
  );
  const builder = new Builder(input, texts);
  let html = "";
  if (files.has(entry)) {
    html = builder.page(isScript(entry) ? pageFor(entry) : (texts.get(entry) ?? ""), entry);
  } else {
    input.report({ code: "missing-entry", file: entry });
  }
  return {
    html,
    sources: builder.sources,
    urlOf: (path) => builder.urlOf(path),
    specifier: (specifier, from) => builder.specifier(specifier, from),
    workerFiles: () => builder.workerFiles(),
    workerUrl: (path, module, prelude) => builder.workerUrl(path, module, prelude),
  };
}
