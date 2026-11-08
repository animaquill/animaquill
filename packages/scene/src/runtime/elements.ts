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
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

/** A 2D transform: `[a, b, c, d, e, f]`, as CSS has it in `matrix()`. */
type Affine = readonly [number, number, number, number, number, number];

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** The computed `transform` of an element as a 2D matrix. Anything else counts as none. */
function affineOf(transform: string): Affine {
  const values = /^matrix(3d)?\((.*)\)$/.exec(transform);
  const numbers = values?.[2]?.split(",").map(Number) ?? [];
  if (!numbers.every(Number.isFinite)) return IDENTITY;
  if (values?.[1] === undefined && numbers.length === 6) return numbers as unknown as Affine;
  if (values?.[1] && numbers.length === 16) {
    const [a = 1, b = 0, , , c = 0, d = 1, , , , , , , e = 0, f = 0] = numbers;
    return [a, b, c, d, e, f];
  }
  return IDENTITY;
}

/**
 * Where the middle of an element is as it shows, from the point that it turns and scales around:
 * `transform-origin`. The page decides that point, and the element's own `transform` stays what it
 * is. The middle is that of its box, or what it draws for SVG, after its own transform.
 */
function middleFromOrigin(element: Element, computed: CSSStyleDeclaration) {
  const [ox = 0, oy = 0] = computed.transformOrigin
    .split(" ")
    .map((part) => Number.parseFloat(part));
  let cx: number;
  let cy: number;
  if (element instanceof SVGGraphicsElement) {
    const box = element.getBBox();
    // The point is in the user space with `view-box`, which SVG has unless the page says otherwise.
    const inBox = computed.transformBox !== "view-box";
    cx = box.x + box.width / 2 - (inBox ? box.x : 0);
    cy = box.y + box.height / 2 - (inBox ? box.y : 0);
  } else if (element instanceof HTMLElement) {
    cx = element.offsetWidth / 2;
    cy = element.offsetHeight / 2;
  } else return undefined;
  const [a, b, c, d, e, f] = affineOf(computed.transform);
  const x = cx - ox;
  const y = cy - oy;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

/** Parts of a CSS value that are separated by spaces, with whatever is in parentheses kept whole. */
function partsOf(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const char of text.trim()) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === " " && depth === 0) {
      if (part !== "") parts.push(part);
      part = "";
    } else part += char;
  }
  if (part !== "") parts.push(part);
  return parts;
}

const ANGLE_UNITS: Readonly<Record<string, number>> = {
  deg: 1,
  rad: 180 / Math.PI,
  grad: 0.9,
  turn: 360,
};

/** A computed `rotate` in degrees, as long as it turns in the plane of the page. */
function degreesOf(rotate: string): number | undefined {
  if (rotate === "none") return 0;
  const parts = partsOf(rotate);
  const angle = /^(-?[\d.e+-]+)(deg|rad|grad|turn)$/.exec(parts.at(-1) ?? "");
  const flat = parts.length === 1 || (parts.length === 2 && parts[0] === "z");
  if (!angle || !flat) return undefined;
  return Number(angle[1]) * (ANGLE_UNITS[angle[2] ?? "deg"] ?? 1);
}

/** A computed `scale`, across and down. */
function scalesOf(scale: string): readonly [number, number] | undefined {
  if (scale === "none") return [1, 1];
  const [x, y = x] = partsOf(scale).map(Number);
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)
    ? [x, y]
    : undefined;
}

/**
 * What the values of an element come to as CSS. Each value replaces what the page has for that CSS
 * property, and nothing else. Turning and scaling go around the middle of what shows, wherever the
 * page puts the point that an element turns around: a move makes up for it, on top of the move that
 * the element has, of its own or from the clip.
 */
function stylesOf(
  element: Element,
  values: ReadonlyMap<string, Value>,
  /** What the page has for the element, apart from what the clip says. */
  page: { readonly translate: () => string; readonly style: () => CSSStyleDeclaration },
): Styles {
  const styles: Styles = new Map();
  const moves = values.has("x") || values.has("y");
  const turns = values.has("rotation") || values.has("scale");
  if (moves || turns) {
    const [x = "0px", y = "0px", z] = moves
      ? [`${number(values, "x", 0)}px`, `${number(values, "y", 0)}px`]
      : page.translate() === "none"
        ? []
        : partsOf(page.translate());
    let [dx, dy] = [0, 0];
    if (turns) {
      const style = page.style();
      const degrees = values.has("rotation")
        ? number(values, "rotation", 0)
        : degreesOf(style.rotate);
      const scales = values.has("scale")
        ? ([number(values, "scale", 1), number(values, "scale", 1)] as const)
        : scalesOf(style.scale);
      const middle =
        degrees === undefined || !scales ? undefined : middleFromOrigin(element, style);
      if (middle && degrees !== undefined && scales) {
        const radians = (degrees * Math.PI) / 180;
        const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
        const [sx, sy] = [scales[0] * middle.x, scales[1] * middle.y];
        dx = middle.x - (cos * sx - sin * sy);
        dy = middle.y - (sin * sx + cos * sy);
      }
    }
    const by = (base: string, delta: number) =>
      Math.abs(delta) < 1e-9 ? base : `calc(${base} + ${delta}px)`;
    styles.set("translate", [by(x, dx), by(y, dy), ...(z === undefined ? [] : [z])].join(" "));
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

/** What an element had of its own for a property before this took it over, to give back. */
interface Kept {
  readonly value: string;
  readonly priority: string;
}

interface Controlled {
  readonly element: Element;
  /** By CSS property, what was there before. */
  readonly kept: Map<string, Kept>;
  /**
   * The move the element had of its own when this took it over, which a turn of the clip goes on
   * top of. The computed style only has what this wrote from then on.
   */
  pageTranslate?: string;
}

export class PageElements {
  readonly #values: ClipValues;
  readonly #report: ContentReport;
  readonly #found: Map<string, SceneElement> = new Map();
  /** What the clip has about each element, by its id: property paths by their own path. */
  #paths = new Map<string, Map<string, string>>();
  #version = -1;
  /** What this set on each element, with what it had before. */
  readonly #set = new Map<string, Controlled>();
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
      // An id that no path can hold is no element of the editor, so nothing happens to it here either.
      if (!match || !isIdPart(match[1])) continue;
      const [, id = "", property = ""] = match;
      let own = paths.get(id);
      if (!own) paths.set(id, (own = new Map()));
      own.set(property, path);
    }
    this.#paths = paths;
  }

  /**
   * Puts what the clip says about elements on them, for a reading of the clock of the scene. This
   * comes after animations got to the frame, so that it goes by where they are.
   */
  apply(seconds: number): void {
    this.#regroup();
    let foundMore = false;
    for (const [id, own] of this.#paths) {
      const element = document.getElementById(id);
      const kind = element && kindOf(element);
      if (!element || !kind) {
        this.#release(id);
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
      this.#write(id, element, kind, values);
    }
    for (const id of this.#set.keys()) if (!this.#paths.has(id)) this.#release(id);
    if (foundMore) this.#onFound?.();
  }

  #write(
    id: string,
    element: Element,
    kind: SceneElement["kind"],
    values: ReadonlyMap<string, Value>,
  ): void {
    const known = this.#set.get(id);
    // Another element with the id took the place of the one this wrote to.
    if (known && known.element !== element) this.#release(id);
    const style = (element as HTMLElement | SVGElement).style;
    const controlled: Controlled = this.#set.get(id) ?? { element, kept: new Map<string, Kept>() };
    // What this writes does not change the transform of the page or where it turns around.
    const page = {
      translate: () => {
        if (!controlled.kept.has("translate")) {
          controlled.pageTranslate = getComputedStyle(element).translate;
        }
        return controlled.pageTranslate ?? "none";
      },
      style: () => getComputedStyle(element),
    };
    const styles = stylesOf(element, values, page);
    const changed = new Set<string>();
    for (const [property, kept] of controlled.kept) {
      if (styles.has(property)) continue;
      restore(style, property, kept);
      controlled.kept.delete(property);
      if (property === "translate") delete controlled.pageTranslate;
      changed.add(property);
    }
    for (const [property, value] of styles) {
      if (!controlled.kept.has(property)) {
        const priority = style.getPropertyPriority(property);
        controlled.kept.set(property, { value: style.getPropertyValue(property), priority });
      }
      style.setProperty(property, value, "important");
      changed.add(property);
    }
    if (controlled.kept.size > 0) this.#set.set(id, controlled);
    else this.#set.delete(id);
    if (styles.has("translate")) this.#warnIfInline(id, element, kind);
    stopTransitions(element, changed);
  }

  /** An inline element of HTML does not move at all, which people hear about, once. */
  #warnIfInline(id: string, element: Element, kind: SceneElement["kind"]): void {
    if (kind !== "html" || this.#warned.has(id)) return;
    if (getComputedStyle(element).display !== "inline") return;
    this.#warned.add(id);
    this.#report("element-inline", id);
  }

  /** The element gets back what it had before this took it over. */
  #release(id: string): void {
    const known = this.#set.get(id);
    if (!known) return;
    const style = (known.element as HTMLElement | SVGElement).style;
    for (const [property, kept] of known.kept) restore(style, property, kept);
    stopTransitions(known.element, new Set(known.kept.keys()));
    this.#set.delete(id);
  }
}

function restore(style: CSSStyleDeclaration, property: string, { value, priority }: Kept): void {
  if (value === "") style.removeProperty(property);
  else style.setProperty(property, value, priority);
}

/**
 * A change of style starts the transitions the page has for it, which would show the value of some
 * moment on the way and not that of the frame. They end right away, at the new value, and only those
 * of what this changed: the page keeps its other transitions.
 */
function stopTransitions(element: Element, properties: ReadonlySet<string>): void {
  if (properties.size === 0 || typeof CSSTransition === "undefined") return;
  for (const animation of element.getAnimations()) {
    if (animation instanceof CSSTransition && properties.has(animation.transitionProperty)) {
      animation.cancel();
    }
  }
}
