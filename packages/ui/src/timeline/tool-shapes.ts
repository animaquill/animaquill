/*
 * The shapes of the editing tools, as Premiere draws them: a bracket with an arrow for ripple, two
 * brackets back to back for roll, a double arrow between two bars for slip, and two bars between
 * two arrows for slide. The toolbar draws them as icons, and the pointer has them as cursors.
 */

/** The lines of each shape, as SVG path data in a box of 24 by 24. */
export const TOOL_SHAPES = {
  ripple: "M10 5H6v14h4M12 12h9M14.5 9.5 12 12l2.5 2.5M18.5 9.5 21 12l-2.5 2.5",
  roll: "M8 5h3v14H8M16 5h-3v14h3M7 12H2M4.5 9.5 2 12l2.5 2.5M17 12h5M19.5 9.5 22 12l-2.5 2.5",
  slip: "M4 5v14M20 5v14M7.5 12h9M10 9.5 7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5",
  slide: "M10 5v14M14 5v14M8 12H2M4.5 9.5 2 12l2.5 2.5M16 12h6M19.5 9.5 22 12l-2.5 2.5",
} as const;

export type ShapedTool = keyof typeof TOOL_SHAPES;

/**
 * A cursor of a shape: black lines on a white outline, which shows on any colour of clip, with
 * its hot spot in the middle; a plain cursor where a browser cannot show it.
 */
function cursorOf(path: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${path}" stroke="#ffffff" stroke-width="4"/>` +
    `<path d="${path}" stroke="#000000" stroke-width="1.6"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, ew-resize`;
}

export const TOOL_CURSORS: Readonly<Record<ShapedTool, string>> = {
  ripple: cursorOf(TOOL_SHAPES.ripple),
  roll: cursorOf(TOOL_SHAPES.roll),
  slip: cursorOf(TOOL_SHAPES.slip),
  slide: cursorOf(TOOL_SHAPES.slide),
};
