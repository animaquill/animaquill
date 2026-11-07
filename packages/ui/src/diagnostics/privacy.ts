/**
 * What of an error may leave the editor. An error is about the editor, but what it says can contain
 * what people make: the name of a project or a file, a path, a piece of code. Messages lose all of
 * that, and stacks keep only places in the code of the editor itself, which is public anyway.
 */

/** One place in the code of the editor. */
export interface StackFrame {
  /** The name of the function, as the build left it. */
  readonly fn?: string;
  /** The path on the site, such as `/assets/index-1a2b3c4d.js`, without the site. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface CleanStack {
  readonly frames: readonly StackFrame[];
  /** Places that are not in the editor, such as code of a project or of the browser. */
  readonly dropped: number;
}

const MAX_MESSAGE = 200;
const MAX_FRAMES = 30;
/** Shorter ones would take words out of messages, and are no name anybody could recognise. */
const MIN_SECRET = 3;

const QUOTED = [
  /"[^"]*"/g,
  /'[^']*'/g,
  /`[^`]*`/g,
  /“[^”]*”/g,
  /‘[^’]*’/g,
  /「[^」]*」/g,
  /『[^』]*』/g,
];
const URL_LIKE = /\b(?:[a-z][\w+.-]*:\/\/\S*|blob:\S+|data:[\w/+.-]*[;,]\S*)/gi;
const PATH_LIKE = /\S*[/\\]\S*/g;
const FILE_LIKE =
  /\b[\w.-]+\.(?:html?|css|[cm]?[jt]sx?|json|svg|png|jpe?g|gif|webp|avif|webm|mp4|mkv|mov|mp3|wav|ogg|opus|m4a|aac|flac|ttf|otf|woff2?|txt|md|zip)\b/gi;
/** Everything that is not plain ASCII, which is where names and text in other languages are. */
const NOT_ASCII = /[^ -~]+/g;
const NAME = /^[A-Za-z][\w]{0,39}$/;
const FUNCTION = /^[\w$.<>[\]]{1,80}$/;
const CODE_PATH = /^\/[\w./@~+-]{0,200}$/;

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a message says without anything people made. Known names, such as of the open project and
 * its files, go first, then everything that could be one.
 */
export function cleanMessage(text: unknown, secrets: Iterable<string> = []): string {
  let message = typeof text === "string" ? text : String(text);
  const known = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SECRET)
    .toSorted((a, b) => b.length - a.length);
  for (const secret of known)
    message = message.replaceAll(new RegExp(escape(secret), "g"), "<name>");
  message = message.replaceAll(URL_LIKE, "<url>");
  for (const quoted of QUOTED) message = message.replaceAll(quoted, "<…>");
  message = message.replaceAll(PATH_LIKE, (token) => (token === "<url>" ? token : "<path>"));
  message = message.replaceAll(FILE_LIKE, "<file>");
  message = message.replaceAll(NOT_ASCII, "…");
  return message.replaceAll(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
}

/** TypeError, NotFoundError: the kind of an error, or just Error. */
export function cleanName(name: unknown): string {
  return typeof name === "string" && NAME.test(name) ? name : "Error";
}

/** `at fn (url:1:2)` from Chrome, `fn@url:1:2` from Firefox and Safari. */
const V8_FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const OTHER_FRAME = /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/;

function readFrame(
  line: string,
): { fn: string | undefined; url: string; line: number; column: number } | undefined {
  const match = V8_FRAME.exec(line) ?? OTHER_FRAME.exec(line);
  if (!match) return undefined;
  const [, fn, url, row, column] = match;
  if (url === undefined) return undefined;
  return { fn, url, line: Number(row), column: Number(column) };
}

/**
 * The places of a stack that are in the code of the editor, which is what the sites in `origins`
 * serve. A place anywhere else could be code of a project, so it is only counted.
 */
export function cleanStack(stack: unknown, origins: readonly string[]): CleanStack {
  if (typeof stack !== "string") return { frames: [], dropped: 0 };
  const frames: StackFrame[] = [];
  let dropped = 0;
  for (const line of stack.split("\n")) {
    const read = readFrame(line);
    if (!read) continue;
    let url: URL;
    try {
      url = new URL(read.url);
    } catch {
      dropped += 1;
      continue;
    }
    const known = origins.includes(url.origin) && CODE_PATH.test(url.pathname);
    if (!known || frames.length >= MAX_FRAMES) {
      dropped += 1;
      continue;
    }
    const fn = read.fn?.replace(/^(?:async |new )+/, "");
    frames.push({
      ...(fn && FUNCTION.test(fn) && { fn }),
      file: url.pathname,
      line: read.line,
      column: read.column,
    });
  }
  return { frames, dropped };
}

const NAMED = new Set(["name", "title", "label", "file", "path", "entry", "source", "src"]);
const NAMED_BY_KEY = new Set([
  "files",
  "scenes",
  "sounds",
  "timelines",
  "assets",
  "notes",
  "locales",
]);
/** A project with thousands of clips has all its names long before that. */
const MAX_VISITS = 50_000;

/**
 * The names people gave things in a project, and the parts of paths, which a message must never
 * carry. Only for when something went wrong: it goes through the whole project.
 */
export function namesIn(project: unknown): Set<string> {
  const found = new Set<string>();
  const add = (text: string) => {
    found.add(text);
    for (const part of text.split(/[/\\]/)) {
      found.add(part);
      found.add(part.replace(/\.[^.]*$/, ""));
    }
  };
  let visits = 0;
  const visit = (value: unknown, key: string | undefined) => {
    if (visits++ > MAX_VISITS || typeof value !== "object" || value === null) return;
    for (const [name, inner] of Object.entries(value)) {
      if (typeof inner === "string" && NAMED.has(name)) add(inner);
      if (key !== undefined && NAMED_BY_KEY.has(key)) add(name);
      visit(inner, name);
    }
  };
  visit(project, undefined);
  found.delete("");
  return found;
}
