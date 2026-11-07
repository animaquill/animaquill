import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { positionAt, type Position } from "./paths.ts";

type Document = DefaultTreeAdapterTypes.Document;
type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type Location = NonNullable<Element["sourceCodeLocation"]>;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** What the page does with the things it finds. */
export interface HtmlRewrite {
  /** The new URL for a reference, or nothing to leave it as it is. */
  readonly url: (value: string, at: Position) => string | undefined;
  /** The new text of a stylesheet that is written in the page. */
  readonly css: (text: string, at: Position) => string;
  /** The URL of a script that is written in the page. */
  readonly script: (text: string, at: Position) => string;
  readonly importMap: (text: string, at: Position) => void;
  readonly problem: (code: "base-tag" | "frameset" | "unclosed-script", at: Position) => void;
  /** Goes first in the head, before anything of the project. Asked for last. */
  readonly head: () => string;
  /** Goes first in the body, so that it runs before anything in there. */
  readonly body: string;
}

/** Attributes that name a file to load, by element. */
const REFERENCES: Readonly<Record<string, readonly string[]>> = {
  audio: ["src"],
  embed: ["src"],
  iframe: ["src"],
  image: ["href", "xlink:href"],
  img: ["src"],
  input: ["src"],
  object: ["data"],
  script: ["src"],
  source: ["src"],
  track: ["src"],
  use: ["href", "xlink:href"],
  video: ["src", "poster"],
  feimage: ["href", "xlink:href"],
};

/** Kinds of `<link>` that load something for this page. */
const LOADING_LINKS = new Set(["stylesheet", "preload", "modulepreload", "prefetch", "icon"]);

const CLASSIC_TYPES = new Set([
  "",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** An attribute as the parser gives it, with the name it has in the location table. */
function attributes(element: Element) {
  return element.attrs.map(({ name, prefix, value }) => ({
    key: prefix ? `${prefix}:${name}` : name,
    value,
  }));
}

const attribute = (element: Element, key: string) =>
  attributes(element).find((candidate) => candidate.key === key)?.value;

/** Splits a `srcset` the way the HTML standard does. A URL can contain commas, but not at its end. */
export function rewriteSrcset(value: string, rewrite: (url: string) => string | undefined): string {
  const candidates: string[] = [];
  let at = 0;
  while (at < value.length) {
    const start = /^[\s,]*/.exec(value.slice(at))?.[0].length ?? 0;
    at += start;
    if (at >= value.length) break;
    const url = /^\S+/.exec(value.slice(at))?.[0] ?? "";
    at += url.length;
    const trimmed = url.replace(/,+$/, "");
    let descriptor = "";
    if (trimmed === url) {
      const end = value.indexOf(",", at);
      descriptor = value.slice(at, end === -1 ? value.length : end).trim();
      at = end === -1 ? value.length : end + 1;
    }
    const written = rewrite(trimmed) ?? trimmed;
    candidates.push(descriptor ? `${written} ${descriptor}` : written);
  }
  return candidates.join(", ");
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  let result = "";
  let copied = 0;
  // What goes in front of something at the same place comes before what replaces it.
  const ordered = edits.toSorted((a, b) => a.start - b.start || a.end - b.end);
  for (const { start, end, text } of ordered) {
    result += source.slice(copied, start) + text;
    copied = end;
  }
  return result + source.slice(copied);
}

const isElement = (node: Node): node is Element => "tagName" in node;

function* walk(node: Node): Generator<Element> {
  if (isElement(node)) {
    yield node;
    if (node.tagName === "template") {
      const { content } = node as DefaultTreeAdapterTypes.Template;
      for (const child of content.childNodes) yield* walk(child);
    }
  }
  if ("childNodes" in node) for (const child of node.childNodes) yield* walk(child);
}

const childElement = (parent: Node, name: string) =>
  "childNodes" in parent
    ? parent.childNodes.filter(isElement).find(({ tagName }) => tagName === name)
    : undefined;

/** The text of a `<script>` or `<style>`, with where it is. */
function textOf(element: Element) {
  const [child] = element.childNodes;
  if (!child || !("value" in child) || !child.sourceCodeLocation) return undefined;
  return { value: child.value, location: child.sourceCodeLocation };
}

/** After the tags that the parser needs to see first, so that the page does not become a quirk. */
function headOffset(document: Document, html: Element | undefined): number {
  const head = html && childElement(html, "head");
  const opened = head?.sourceCodeLocation?.startTag ?? html?.sourceCodeLocation?.startTag;
  if (opened) return opened.endOffset;
  const doctype = document.childNodes.find(({ nodeName }) => nodeName === "#documentType");
  return doctype?.sourceCodeLocation?.endOffset ?? 0;
}

function bodyInsert(source: string, html: Element | undefined, text: string): Edit | undefined {
  const body = html && childElement(html, "body");
  if (!body || text === "") return undefined;
  const opened = body.sourceCodeLocation?.startTag;
  if (opened) return { start: opened.endOffset, end: opened.endOffset, text };
  // The parser opens a body by itself where the first thing that has to be in it comes. Without
  // saying so here, a script in that place would still land in the head.
  const first = body.childNodes.find(({ sourceCodeLocation }) => sourceCodeLocation);
  const at = first?.sourceCodeLocation?.startOffset ?? source.length;
  return { start: at, end: at, text: `<body>${text}` };
}

/**
 * Rewrites a page without running or reserializing it, so everything the project wrote stays as it
 * wrote it. Scripts written in the page become files, because the browser reports errors in them
 * without a usable place, and a file can keep the lines of the page.
 */
export function rewriteHtml(source: string, rewrite: HtmlRewrite): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const positionOf = (location: { readonly startOffset: number }) =>
    positionAt(source, location.startOffset);
  const edits: Edit[] = [];
  const replaceAttribute = (location: Location, key: string, value: string) => {
    const span = location.attrs?.[key];
    if (!span) return;
    const name = source.slice(span.startOffset, span.endOffset).split("=", 1)[0];
    edits.push({
      start: span.startOffset,
      end: span.endOffset,
      text: `${name}="${escapeAttribute(value)}"`,
    });
  };
  const elements = [...walk(document)].filter(({ sourceCodeLocation }) => sourceCodeLocation);
  const isPageScript = (element: Element) =>
    element.tagName === "script" && element.namespaceURI === HTML_NAMESPACE;

  // A browser does not run a script that never closes, and the rest of the text is part of it. So
  // whatever went after it would be gone too.
  const unclosed = elements.filter((element) => {
    const location = element.sourceCodeLocation as Location;
    return isPageScript(element) && !location.endTag;
  });
  for (const element of unclosed) {
    const location = element.sourceCodeLocation as Location;
    rewrite.problem("unclosed-script", positionOf(location));
    edits.push({ start: location.startOffset, end: source.length, text: "" });
  }

  // Modules are rewritten as they come up, and what they import may be named in an import map.
  for (const element of elements) {
    if (!isPageScript(element) || unclosed.includes(element)) continue;
    if (attribute(element, "type")?.toLowerCase() !== "importmap") continue;
    const text = textOf(element);
    if (text) rewrite.importMap(text.value, positionOf(text.location));
    const { startOffset, endOffset } = element.sourceCodeLocation as Location;
    edits.push({ start: startOffset, end: endOffset, text: "" });
  }

  const replaceUrl = (element: Element, location: Location, key: string, value: string) => {
    const span = location.attrs?.[key];
    if (!span) return;
    const url = rewrite.url(value, positionOf(span));
    if (url !== undefined) replaceAttribute(location, key, url);
    if (element.tagName === "script" || element.tagName === "link") {
      // The file is not the one the project hashed: its paths changed.
      const integrity = location.attrs?.integrity;
      if (integrity)
        edits.push({ start: integrity.startOffset, end: integrity.endOffset, text: "" });
    }
  };

  const inlineScript = (element: Element, location: Location, type: string) => {
    const text = textOf(element);
    if (!text || text.value.trim() === "") return;
    const url = rewrite.script(text.value, {
      line: text.location.startLine,
      column: text.location.startCol,
    });
    // These mean nothing for a script without `src`, and would mean something with one.
    const dropped = new Set(type === "module" ? ["integrity"] : ["async", "defer", "integrity"]);
    const kept = attributes(element)
      .filter(({ key }) => !dropped.has(key))
      .map(({ key, value }) => ` ${key}="${escapeAttribute(value)}"`);
    edits.push({
      start: location.startOffset,
      end: location.endOffset,
      text: `<script${kept.join("")} src="${escapeAttribute(url)}"></script>`,
    });
  };

  for (const element of elements) {
    if (unclosed.includes(element)) continue;
    const location = element.sourceCodeLocation as Location;
    const name = element.tagName.toLowerCase();
    const style = attribute(element, "style");
    if (style !== undefined && location.attrs?.style) {
      const rewritten = rewrite.css(style, positionOf(location.attrs.style));
      if (rewritten !== style) replaceAttribute(location, "style", rewritten);
    }
    if (name === "style") {
      const text = textOf(element);
      if (text) {
        edits.push({
          start: text.location.startOffset,
          end: text.location.endOffset,
          text: rewrite.css(text.value, positionOf(text.location)),
        });
      }
    } else if (name === "base" && element.namespaceURI === HTML_NAMESPACE) {
      rewrite.problem("base-tag", positionOf(location));
      edits.push({ start: location.startOffset, end: location.endOffset, text: "" });
    } else if (name === "link") {
      const rel = attribute(element, "rel")?.toLowerCase().split(/\s+/) ?? [];
      const href = attribute(element, "href");
      if (href !== undefined && rel.some((kind) => LOADING_LINKS.has(kind))) {
        replaceUrl(element, location, "href", href);
      }
    } else if (name === "frameset") {
      rewrite.problem("frameset", positionOf(location));
    } else if (name === "template" && attribute(element, "shadowrootmode") === "closed") {
      // Nothing can get at a closed one, and what is in there has to run on the scene's clock.
      replaceAttribute(location, "shadowrootmode", "open");
    }
    if (isPageScript(element)) {
      const type = attribute(element, "type")?.toLowerCase() ?? "";
      if (type !== "module" && !CLASSIC_TYPES.has(type.trim())) continue;
      if (attribute(element, "src") === undefined) {
        inlineScript(element, location, type);
        continue;
      }
    }
    for (const key of REFERENCES[name] ?? []) {
      const value = attribute(element, key);
      if (value !== undefined) replaceUrl(element, location, key, value);
    }
    const srcset = attribute(element, "srcset");
    if (srcset !== undefined && location.attrs?.srcset) {
      const at = positionOf(location.attrs.srcset);
      replaceAttribute(
        location,
        "srcset",
        rewriteSrcset(srcset, (url) => rewrite.url(url, at)),
      );
    }
  }

  const html = childElement(document, "html");
  const headAt = headOffset(document, html);
  edits.push({ start: headAt, end: headAt, text: rewrite.head() });
  const body = bodyInsert(source, html, rewrite.body);
  if (body) edits.push(body);
  return applyEdits(source, edits);
}
