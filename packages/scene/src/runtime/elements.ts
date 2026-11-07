import { isIdPart, type SceneElement } from "@animaquill/core/registration";
import type { Value } from "@animaquill/schema";
import { ELEMENT_PROPERTIES, type PropertySpec } from "@animaquill/schema/properties";
import type { ClipValues, ContentReport } from "./content.ts";

/**
 * Elements of the page of a scene with a stable id: which ones there are, and what the clip says
 * about them. Values go in as the element's own style, marked important, so that they win over the
 * style sheets of the page and its animations, which is what people asked for by setting them.
 * Without a value an element stays as its page has it.
 */

const SVG = "http://www.w3.org/2000/svg";
const HTML = "http://www.w3.org/1999/xhtml";
const ELEMENT_PATH = /^element\.([^.]+)\.([^.]+)$/;

const kindOf = (element: Element): SceneElement["kind"] | undefined => {
  if (element.namespaceURI === SVG) return "svg";
  return element.namespaceURI === HTML ? "html" : undefined;
};

const SPECS = {
  html: new Map(ELEMENT_PROPERTIES.html.map((spec) => [spec.path, spec])),
  svg: new Map(ELEMENT_PROPERTIES.svg.map((spec) => [spec.path, spec])),
} as const;

const byte = (value: number) =>
  Math.round(Math.min(Math.max(value, 0), 255))
    .toString(16)
    .padStart(2, "0");

/** A computed color as the project writes colors. Anything other than plain sRGB is left out. */
function hexOf(color: string): string | undefined {
  const parts = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(
    color,
  );
  if (!parts) return undefined;
  const [, red = "0", green = "0", blue = "0", alpha] = parts;
  const shown =
    alpha === undefined ? 1 : Number.parseFloat(alpha) / (alpha.endsWith("%") ? 100 : 1);
  const rgb = [red, green, blue].map((part) => byte(Number(part))).join("");
  return shown >= 1 ? `#${rgb}` : `#${rgb}${byte(shown * 255)}`;
}

/** What an element starts out with, for properties that have no fixed default. */
function startOf(element: Element, kind: SceneElement["kind"]): Record<string, Value> | undefined {
  const style = getComputedStyle(element);
  const start: Record<string, Value> = {};
  const opacity = Number(style.opacity);
  if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 && opacity !== 1) {
    start.opacity = opacity;
  }
  const colors =
    kind === "html"
      ? { color: style.color, background: style.backgroundColor }
      : { fill: style.fill, stroke: style.stroke };
  for (const [path, value] of Object.entries(colors)) {
    const hex = hexOf(value);
    if (hex !== undefined) start[path] = hex;
  }
  return Object.keys(start).length > 0 ? start : undefined;
}

/** CSS properties this sets, with what they come to from the values of an element. */
type Styles = Map<string, string>;

const number = (values: ReadonlyMap<string, Value>, path: string, fallback: number) => {
  const value = values.get(path);
  return typeof value === "number" ? value : fallback;
};

function stylesOf(values: ReadonlyMap<string, Value>): Styles {
  const styles: Styles = new Map();
  if (values.has("x") || values.has("y")) {
    styles.set("translate", `${number(values, "x", 0)}px ${number(values, "y", 0)}px`);
  }
  if (values.has("rotation")) styles.set("rotate", `${number(values, "rotation", 0)}deg`);
  if (values.has("scale")) styles.set("scale", String(number(values, "scale", 1)));
  if (values.has("opacity")) styles.set("opacity", String(number(values, "opacity", 1)));
  if (values.has("blur")) styles.set("filter", `blur(${Math.max(number(values, "blur", 0), 0)}px)`);
  for (const [path, property] of [
    ["color", "color"],
    ["background", "background-color"],
    ["fill", "fill"],
    ["stroke", "stroke"],
  ] as const) {
    const value = values.get(path);
    if (typeof value === "string") styles.set(property, value);
  }
  return styles;
}

const MOVES = new Set(["translate", "rotate", "scale"]);

export class PageElements {
  readonly #values: ClipValues;
  readonly #report: ContentReport;
  readonly #found: Map<string, SceneElement> = new Map();
  /** What the clip has about each element, by its id: property paths by their own path. */
  #paths = new Map<string, Map<string, string>>();
  #version = -1;
  /** What this set on each element, to take away again. */
  readonly #set = new Map<string, { readonly element: Element; readonly styles: Set<string> }>();
  /** Elements whose turning got put in their middle, and those people heard about. */
  readonly #centered = new WeakSet<Element>();
  readonly #warned = new Set<string>();
  readonly #limit: number;
  #onFound: (() => void) | undefined;

  /** `limit` is how many elements there can be, see `REGISTRATION_LIMITS`. */
  constructor(values: ClipValues, report: ContentReport, limit: number) {
    this.#values = values;
    this.#report = report;
    this.#limit = limit;
  }

  /** The elements there are, as far as they were found. */
  get found(): readonly SceneElement[] {
    return [...this.#found.values()];
  }

  /**
   * Looks through the page once it is there. Elements that code makes later come in when the clip
   * has something for them, see `apply`, and then `onFound` says so.
   */
  scan(onFound: () => void): void {
    this.#onFound = onFound;
    for (const element of document.querySelectorAll("[id]")) {
      if (this.#found.size >= this.#limit) break;
      this.#add(element);
    }
  }

  #add(element: Element): boolean {
    const { id } = element;
    const kind = kindOf(element);
    if (!kind || !isIdPart(id) || this.#found.has(id)) return false;
    const start = startOf(element, kind);
    this.#found.set(id, start ? { id, kind, start } : { id, kind });
    return true;
  }

  #regroup(): void {
    if (this.#version === this.#values.version) return;
    this.#version = this.#values.version;
    const paths = new Map<string, Map<string, string>>();
    for (const path of this.#values.paths()) {
      const match = ELEMENT_PATH.exec(path);
      if (!match) continue;
      const [, id = "", property = ""] = match;
      let own = paths.get(id);
      if (!own) paths.set(id, (own = new Map()));
      own.set(property, path);
    }
    this.#paths = paths;
  }

  /** Puts what the clip says about elements on them, for a reading of the clock of the scene. */
  apply(seconds: number): void {
    this.#regroup();
    let foundMore = false;
    for (const [id, own] of this.#paths) {
      const element = document.getElementById(id);
      const kind = element && kindOf(element);
      if (!element || !kind) {
        this.#clear(id);
        continue;
      }
      if (!this.#found.has(id) && this.#found.size < this.#limit && this.#add(element)) {
        foundMore = true;
      }
      const specs = SPECS[kind];
      const values = new Map<string, Value>();
      for (const [property, path] of own) {
        const spec: PropertySpec | undefined = specs.get(property);
        const value = spec && this.#values.at(path, spec.type, seconds);
        if (value !== undefined) values.set(property, value);
      }
      this.#write(id, element, kind, stylesOf(values));
    }
    for (const id of this.#set.keys()) if (!this.#paths.has(id)) this.#clear(id);
    if (foundMore) this.#onFound?.();
  }

  #write(id: string, element: Element, kind: SceneElement["kind"], styles: Styles): void {
    const style = (element as HTMLElement | SVGElement).style;
    const known = this.#set.get(id);
    // Another element with the id took the place of the one this wrote to.
    if (known && known.element !== element) this.#clear(id);
    const set = this.#set.get(id)?.styles ?? new Set<string>();
    for (const property of set) if (!styles.has(property)) style.removeProperty(property);
    const moves = [...styles.keys()].some((property) => MOVES.has(property));
    if (moves) this.#prepareToMove(id, element, kind);
    for (const [property, value] of styles) style.setProperty(property, value, "important");
    if (styles.size > 0) this.#set.set(id, { element, styles: new Set(styles.keys()) });
    else this.#set.delete(id);
  }

  /**
   * An SVG element turns around the corner of its drawing unless it says otherwise, and an inline
   * element of HTML does not move at all. One is fixed, the other people hear about, once.
   */
  #prepareToMove(id: string, element: Element, kind: SceneElement["kind"]): void {
    if (this.#centered.has(element)) return;
    this.#centered.add(element);
    const computed = getComputedStyle(element);
    if (kind === "svg") {
      const style = (element as SVGElement).style;
      if (computed.transformBox === "view-box" && computed.transformOrigin.startsWith("0px 0px")) {
        style.setProperty("transform-box", "fill-box");
        style.setProperty("transform-origin", "center");
      }
    } else if (computed.display === "inline" && !this.#warned.has(id)) {
      this.#warned.add(id);
      this.#report("element-inline", id);
    }
  }

  #clear(id: string): void {
    const known = this.#set.get(id);
    if (!known) return;
    const style = (known.element as HTMLElement).style;
    for (const property of known.styles) style.removeProperty(property);
    this.#set.delete(id);
  }
}
