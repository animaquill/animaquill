import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The colours of the two themes (theme/tokens.css): every colour the light theme needs has a value
 * there, and words are readable on what they are on, as WCAG asks: a contrast of 4.5:1, or 3:1 for
 * large words (docs/design/settings-and-properties.md of AnimaQuill Cloud, S-E).
 */

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} in tokens.css`);
  const body = css.slice(start, css.indexOf("\n}", start));
  const values = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--aq-[\w-]+):\s*([^;]+);/g))
    values.set(name as string, (value as string).trim());
  return values;
}

const dark = block(":root");
const light = new Map([...dark, ...block(':root[data-theme="light"]')]);
const THEMES = { dark, light } as const;

/**
 * What is the same in both themes on purpose: the size of words, and what goes on pictures and on
 * colours of their own, which are the same whatever the theme.
 */
const SAME_IN_BOTH =
  /^--aq-(font|on-picture|shade|picture-|cover-(text|shine|backdrop|\d)|level-|tool-|overlay-|timeline-(picture|sound|caption)$)/;

type Rgba = readonly [number, number, number, number];

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (!hex) throw new Error(`Not a colour this test reads: ${value}`);
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const [r, g, b, a = 255] = (full.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16));
  return [r as number, g as number, b as number, a / 255];
}

/** A colour that lets through some of what is under it, over that. */
function over(top: Rgba, under: Rgba): Rgba {
  const [r, g, b, a] = top;
  const mix = (index: 0 | 1 | 2) => (top[index] ?? 0) * a + (under[index] ?? 0) * (1 - a);
  return a === 1 ? [r, g, b, 1] : [mix(0), mix(1), mix(2), 1];
}

function luminance([r, g, b]: Rgba): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** A background: a token, or one over another, as the colour under the pointer over a panel. */
type Surface = string | readonly [top: string, under: string];

function colorOf(theme: Map<string, string>, surface: Surface): Rgba {
  const read = (name: string) => {
    const value = theme.get(`--aq-${name}`);
    if (!value) throw new Error(`No --aq-${name}`);
    return parse(value);
  };
  if (typeof surface === "string") return read(surface);
  const [top, under] = surface;
  return over(read(top), read(under));
}

/** Where words of the editor are: its surfaces, and those under the pointer. */
const SURFACES: readonly Surface[] = [
  "bg-chrome",
  "bg-panel",
  "bg-menu",
  "bg-input",
  "bg-raised",
  ["bg-hover", "bg-chrome"],
  ["bg-hover", "bg-panel"],
  ["bg-hover", "bg-menu"],
];

/** The colours words are in, on any of the surfaces. */
const TEXTS = [
  "text",
  "text-strong",
  "text-muted",
  "accent",
  "match",
  "warning",
  "warning-text",
  "trial",
  "danger",
  "danger-text",
  "success",
  "cloud",
  "local",
];

/** Words on a colour of their own. */
const PAIRS: readonly { text: string; on: Surface; large?: true }[] = [
  { text: "on-accent", on: "accent" },
  { text: "on-accent", on: "danger" },
  { text: "on-trial", on: "trial" },
  { text: "found-text", on: "star" },
  { text: "chip-text", on: ["accent-soft", "bg-input"] },
  { text: "chip-text", on: ["accent-soft", "bg-panel"] },
  { text: "text", on: ["accent-soft", "bg-panel"] },
  { text: "text", on: ["warning-soft", "bg-panel"] },
  { text: "timeline-label", on: "timeline-lane" },
  { text: "timeline-label", on: "timeline-background" },
  { text: "timeline-label", on: "timeline-ruler" },
];

/**
 * Where the dark theme is below, as it was before there were two themes: S-E leaves its look as it
 * was, to the pixel. The accent and the colour of danger as words, mostly small links and buttons,
 * and quiet words under the pointer, just below.
 */
const DARK_AS_IT_WAS = new Set([
  "text-muted on bg-hover over bg-panel",
  "text-muted on bg-hover over bg-menu",
  "accent on bg-chrome",
  "accent on bg-panel",
  "accent on bg-menu",
  "accent on bg-input",
  "accent on bg-raised",
  "accent on bg-hover over bg-chrome",
  "accent on bg-hover over bg-panel",
  "accent on bg-hover over bg-menu",
  "danger on bg-chrome",
  "danger on bg-panel",
  "danger on bg-menu",
  "danger on bg-input",
  "danger on bg-raised",
  "danger on bg-hover over bg-chrome",
  "danger on bg-hover over bg-panel",
  "danger on bg-hover over bg-menu",
]);

const nameOf = (surface: Surface) =>
  typeof surface === "string" ? surface : `${surface[0]} over ${surface[1]}`;

function belowIn(theme: Map<string, string>): string[] {
  const all = [
    ...TEXTS.flatMap((text) => SURFACES.map((on) => ({ text, on, large: false }))),
    ...PAIRS.map((pair) => ({ ...pair, large: pair.large === true })),
  ];
  const below: string[] = [];
  for (const { text, on, large } of all) {
    const background = colorOf(theme, on);
    const ratio = contrast(over(colorOf(theme, text), background), background);
    if (ratio < (large ? 3 : 4.5)) below.push(`${text} on ${nameOf(on)}: ${ratio.toFixed(2)}`);
  }
  return below;
}

describe("the themes", () => {
  it("give every colour of the editor a value of its own in the light theme", () => {
    const own = block(':root[data-theme="light"]');
    const missing = [...dark.keys()].filter((name) => !SAME_IN_BOTH.test(name) && !own.has(name));
    expect(missing).toEqual([]);
    // And nothing there that the dark theme does not have, which would be a typo.
    expect([...own.keys()].filter((name) => !dark.has(name))).toEqual([]);
  });

  it("keep words readable in the light theme", () => {
    expect(belowIn(THEMES.light)).toEqual([]);
  });

  it("keep words readable in the dark theme, where it was before", () => {
    const below = belowIn(THEMES.dark).filter(
      (line) => !DARK_AS_IT_WAS.has(line.slice(0, line.lastIndexOf(":"))),
    );
    expect(below).toEqual([]);
  });
});
