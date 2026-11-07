/**
 * Where a project's files appear to be, whatever page the scene runs on. A blob URL has no path, so
 * nothing relative can resolve against one. This address has a path, and the loader turns it into a
 * file.
 */
export const VIRTUAL_ROOT = "aq:/";

/** What a reference in a project points at. */
export type Reference =
  /** A file of the project, by its path from the root of the project. */
  | { readonly kind: "file"; readonly path: string; readonly fragment: string }
  /** Nothing to look up: `#id`, `data:`, `blob:`, or an empty string. */
  | { readonly kind: "inline" }
  /** Somewhere else. The sandbox blocks it, and the project should hear about that. */
  | { readonly kind: "external"; readonly url: string }
  /** It tries to leave the project, or it is not a path at all. */
  | { readonly kind: "refused"; readonly why: "above-root" | "bad-path" };

const INLINE_SCHEMES = new Set(["data", "blob", "about"]);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Reads a reference the way a browser reads a URL, and refuses what would leave the project. A URL
 * parser would quietly stop at the root instead. `from` is the path of the file that has the
 * reference.
 */
export function resolveReference(target: string, from: string): Reference {
  // What the URL parser does before anything else.
  const text = target.replace(/^[\0-\u0020]+|[\0-\u0020]+$/g, "").replace(/[\t\n\r]/g, "");
  if (text === "" || text.startsWith("#")) return { kind: "inline" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme && INLINE_SCHEMES.has(scheme)) return { kind: "inline" };
  if (scheme && scheme !== "aq") return { kind: "external", url: text };
  // A project served from a website would get these treated as slashes.
  const slashed = text.replaceAll("\\", "/");
  if (slashed.startsWith("//")) return { kind: "external", url: text };
  if (scheme === "aq" && !slashed.startsWith(VIRTUAL_ROOT))
    return { kind: "refused", why: "bad-path" };
  if (slashed.startsWith(`${VIRTUAL_ROOT}/`)) return { kind: "external", url: text };

  const local = scheme === "aq" ? slashed.slice(VIRTUAL_ROOT.length - 1) : slashed;
  const fragmentAt = local.indexOf("#");
  const fragment = fragmentAt === -1 ? "" : local.slice(fragmentAt);
  const pathEnd = local.search(/[?#]/);
  const written = pathEnd === -1 ? local : local.slice(0, pathEnd);
  const path = written.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const raw of written.split("/")) {
    const segment = decodeSegment(raw);
    if (/[/\\\0]/.test(segment)) return { kind: "refused", why: "bad-path" };
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") path.push(segment);
    else if (path.length === 0) return { kind: "refused", why: "above-root" };
    else path.pop();
  }
  return { kind: "file", path: path.join("/"), fragment };
}

/** The address of a file, safe to put in a string, an attribute or a stylesheet. */
export function virtualUrl(path: string): string {
  return VIRTUAL_ROOT + path.split("/").map(encodeURIComponent).join("/");
}

/** The file an address of `virtualUrl` stands for. */
export function pathOfVirtual(address: string): string {
  const reference = resolveReference(address, "");
  return reference.kind === "file" ? reference.path : "";
}

/** Line and column of a place in a text, both from 1, as an editor shows them. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

export function positionAt(text: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", lineStart)) {
    line += 1;
    lineStart = at + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** A position inside a text that itself starts at `base` of a bigger one. */
export function positionWithin(base: Position, inner: Position): Position {
  return inner.line === 1
    ? { line: base.line, column: base.column + inner.column - 1 }
    : { line: base.line + inner.line - 1, column: inner.column };
}
