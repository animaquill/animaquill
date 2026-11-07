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
/** Shorter ones are no name anybody could recognise, and would only take letters out of code. */
const MIN_SECRET = 2;

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
/** A word, unless it is one of the marks put in for what was taken out, such as `<path>`. */
const WORD = /(?<![<\w$])[\w$]+(?:\.[\w$]+)*(?![\w$>])/g;
/**
 * How names in code look, which no name people give looks like: `e.at`, `_cache`, `fromJSON`,
 * `ResizeObserver`, `e`. Words like `Secret` or `Q3` do not.
 */
const IDENTIFIER =
  /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|[A-Za-z$]*[_$][\w$]*|[a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[A-Za-z])$/;
/**
 * The words of what browsers say about code going wrong, and of what the editor says about itself.
 * Every other word in a message goes: it could be a value people typed, without quotes around it.
 */
const WORDS = new Set(
  `a an the of to in on at is are was were be been being not no nor or and as by for from with
  without into onto has have had can cannot could does do did done must should may might only than
  this that these those it its already yet before after while when where out more less too many
  much which other same own all any some one two way such once twice every each per within between
  over under then also there here what why how
  undefined null nan true false infinity object objects function functions class classes
  constructor prototype property properties method methods getter setter value values type types
  key keys index length size string strings number numbers bigint boolean symbol array arrays map
  set promise promises iterable iterator generator async await module modules import export
  default variable variables constant assignment declaration initialization identifier token
  expression statement argument arguments parameter parameters operator operand regular flags flag
  group character characters unicode escape sequence literal template json syntax position line
  column end input output unexpected unterminated invalid illegal missing required expected unknown
  unsupported unable failed failure fail fails error errors exception maximum minimum call called
  stack exceeded exceeds limit range bounds memory recursion reading setting read write writing
  define defined redefine convert converted cast construct apply access accessed execute executing
  cloned clone serialize serialized parse parsing resolve resolved reject rejected rejection abort
  aborted timeout timed network fetch request response load loading loaded decode decoding encode
  encoding frame frames canvas context video audio media element node document window worker
  message port channel transfer transferable buffer detached state permission denied allowed
  security origin cross quota storage database transaction version store operation interface
  implement instance extensible frozen sealed writable configurable enumerable primitive circular
  structure structured readonly private field member super new delete yield return throw catch try
  finally let const var strict mode permitted valid supported available found exist exists matched
  match closed open opened busy ready empty full wrong bad large small long short big deep nested
  depth keyword reserved label uncaught unhandled assigned assign lexical scope global local target
  handler proxy trap revoked invariant weak ref registry shared typed view offset byte bytes item
  items entry entries list sort callback listener event events dispatch observer loop completed
  undelivered notifications script render rendering component hook hooks update mount unmount
  mounted use used using search file files time locked such context2d server answered crash
  crashed`
    .split(/\s+/)
    .filter(Boolean),
);

const NAME = /^[A-Za-z]\w{0,39}$/;
const FUNCTION = /^[\w$.<>[\]]{1,80}$/;
const CODE_PATH = /^\/[\w./@~+-]{0,200}$/;

const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const keeps = (word: string) => WORDS.has(word.toLowerCase()) || IDENTIFIER.test(word);

/**
 * Known names that a message could still show after everything else: those with a word that is kept.
 * The others go anyway. One pattern for all, made once for each set of names, and without regard to
 * upper and lower case.
 */
const patterns = new WeakMap<object, RegExp | undefined>();
function patternOf(secrets: Iterable<string>): RegExp | undefined {
  if (patterns.has(secrets)) return patterns.get(secrets);
  const risky = [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SECRET && (secret.match(WORD) ?? []).some(keeps))
    .toSorted((a, b) => b.length - a.length);
  const pattern =
    risky.length === 0
      ? undefined
      : new RegExp(`(?<![\\w$])(?:${risky.map(escape).join("|")})(?![\\w$])`, "gi");
  patterns.set(secrets, pattern);
  return pattern;
}

/**
 * What a message says without anything people made. Known names go first, then everything that
 * could be one: what is quoted, addresses, paths, files, other languages, numbers, and any word that
 * is neither one of what browsers say about code nor shaped like a name in code. Little is left of a
 * message about a value people typed, which is fine: the stack says where it happened.
 */
export function cleanMessage(text: unknown, secrets: Iterable<string> = []): string {
  let message = (typeof text === "string" ? text : String(text)).slice(0, MAX_MESSAGE * 5);
  const known = patternOf(secrets);
  if (known) message = message.replaceAll(known, "<name>");
  message = message.replaceAll(URL_LIKE, "<url>");
  for (const quoted of QUOTED) message = message.replaceAll(quoted, "<…>");
  message = message.replaceAll(PATH_LIKE, (token) => (token === "<url>" ? token : "<path>"));
  message = message.replaceAll(FILE_LIKE, "<file>");
  message = message.replaceAll(NOT_ASCII, "…");
  message = message.replaceAll(WORD, (word) => (keeps(word) ? word : "…"));
  message = message.replaceAll(/…(?:\s*…)+/g, "…");
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

/** Fields with names, and with text people wrote, which can turn up in a message as it is. */
const NAMED = new Set([
  "name",
  "title",
  "label",
  "file",
  "path",
  "entry",
  "source",
  "src",
  "text",
  "value",
  "caption",
  "description",
  "content",
]);
/** Text that long is no name, and it would not be in a message whole. */
const MAX_NAME = 200;
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
  // The name, its parts, and each of those without an extension: `scenes/intro_v2.html` is also
  // `intro_v2.html` and `intro_v2`. Upper and lower case do not matter where they are used.
  const add = (text: string) => {
    if (text.length > MAX_NAME) return;
    for (const part of [text, ...text.split(/[/\\\s]+/)]) {
      found.add(part);
      found.add(part.replace(/\.[^.]*$/, ""));
    }
  };
  let visits = 0;
  const visit = (value: unknown, key: string | undefined, inLocales: boolean) => {
    if (visits++ > MAX_VISITS || typeof value !== "object" || value === null) return;
    for (const [name, inner] of Object.entries(value)) {
      // What a locale says is all text people wrote.
      if (typeof inner === "string" && (NAMED.has(name) || inLocales)) add(inner);
      if (key !== undefined && NAMED_BY_KEY.has(key)) add(name);
      if (key !== "files") visit(inner, name, inLocales || name === "locales");
    }
  };
  visit(project, undefined, false);
  found.delete("");
  return found;
}
