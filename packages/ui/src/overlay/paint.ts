import type { Point } from "@animaquill/core";
import type { Grip, Mark, OverlaySnapshot } from "./editor.ts";

/** Canvas cannot read CSS variables, so the colours come over once. */
export interface OverlayTheme {
  /** Boxes and handles. */
  readonly line: string;
  readonly fill: string;
  /** Around every line, so that it shows on a bright picture as well as on a dark one. */
  readonly halo: string;
  /** The path that keys make. */
  readonly path: string;
  /** What is selected without handles: other clips, locked ones, where code objects are. */
  readonly muted: string;
}

export function readOverlayTheme(element: Element): OverlayTheme {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(`--aq-overlay-${name}`).trim();
  return {
    line: color("line"),
    fill: color("fill"),
    halo: color("halo"),
    path: color("path"),
    muted: color("muted"),
  };
}

/** Handles are as large on any picture, in pixels of the page. */
const CORNER = 8;
const SIDE = 7;
const DOT = 5;
const KEY = 7;
const ANCHOR = 6;
const ANCHOR_ARM = 10;
const FRAME_DOT = 1.5;
/** Dots closer than this would only make a thicker line. */
const MIN_FRAME_GAP = 4;

type Context = CanvasRenderingContext2D;

function trace(context: Context, points: readonly Point[], closed: boolean): void {
  context.beginPath();
  points.forEach(({ x, y }, index) => {
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  if (closed) context.closePath();
}

/** A line with a darker one under it. */
function stroke(context: Context, theme: OverlayTheme, color: string, dashed = false): void {
  context.setLineDash([]);
  context.lineWidth = 3;
  context.strokeStyle = theme.halo;
  context.stroke();
  context.setLineDash(dashed ? [4, 3] : []);
  context.lineWidth = 1;
  context.strokeStyle = color;
  context.stroke();
  context.setLineDash([]);
}

function paintMark(context: Context, theme: OverlayTheme, mark: Mark): void {
  switch (mark.kind) {
    case "outline":
      trace(context, mark.corners, true);
      if (mark.style === "target") stroke(context, theme, theme.line);
      else stroke(context, theme, mark.style === "locked" ? theme.muted : theme.line, true);
      return;
    case "stem":
      trace(context, [mark.from, mark.to], false);
      stroke(context, theme, theme.line);
      return;
    case "path": {
      trace(context, mark.points, false);
      stroke(context, theme, theme.path);
      let last: Point | undefined;
      context.fillStyle = theme.path;
      for (const point of mark.frames) {
        if (last && Math.hypot(point.x - last.x, point.y - last.y) < MIN_FRAME_GAP) continue;
        last = point;
        context.beginPath();
        context.arc(point.x, point.y, FRAME_DOT, 0, Math.PI * 2);
        context.fill();
      }
      return;
    }
    case "bounds":
      trace(context, mark.corners, true);
      stroke(context, theme, theme.muted, true);
      return;
    case "line":
      trace(context, mark.points, mark.closed);
      stroke(context, theme, theme.line);
      return;
    case "ring":
      context.beginPath();
      context.arc(mark.at.x, mark.at.y, Math.max(mark.radius, 1), 0, Math.PI * 2);
      stroke(context, theme, theme.line, true);
  }
}

/** A square turned with its box. */
function square(context: Context, { x, y }: Point, size: number, angle: number): void {
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.beginPath();
  context.rect(-size / 2, -size / 2, size, size);
  context.restore();
}

function filled(context: Context, theme: OverlayTheme, fill: string, edge: string): void {
  context.lineWidth = 3;
  context.strokeStyle = theme.halo;
  context.stroke();
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = 1;
  context.strokeStyle = edge;
  context.stroke();
}

function paintGrip(context: Context, theme: OverlayTheme, grip: Grip, lit: boolean): void {
  const { at, angle } = grip;
  const fill = lit ? theme.line : theme.fill;
  switch (grip.look) {
    case "corner":
    case "side":
      square(context, at, grip.look === "corner" ? CORNER : SIDE, angle);
      filled(context, theme, fill, theme.line);
      return;
    case "rotate":
    case "point":
      context.beginPath();
      context.arc(at.x, at.y, DOT, 0, Math.PI * 2);
      filled(context, theme, fill, theme.line);
      return;
    case "knob":
      context.beginPath();
      context.arc(at.x, at.y, DOT, 0, Math.PI * 2);
      filled(context, theme, lit ? theme.fill : theme.line, theme.fill);
      return;
    case "scale":
      square(context, at, CORNER, Math.PI / 4);
      filled(context, theme, fill, theme.line);
      return;
    case "key":
      square(context, at, KEY, 0);
      filled(context, theme, lit ? theme.path : theme.halo, theme.path);
      return;
    case "anchor": {
      const color = lit ? theme.line : theme.fill;
      context.beginPath();
      context.arc(at.x, at.y, ANCHOR, 0, Math.PI * 2);
      context.moveTo(at.x - ANCHOR_ARM, at.y);
      context.lineTo(at.x + ANCHOR_ARM, at.y);
      context.moveTo(at.x, at.y - ANCHOR_ARM);
      context.lineTo(at.x, at.y + ANCHOR_ARM);
      stroke(context, theme, color);
    }
  }
}

/** Draws the overlay. The canvas has as many pixels as the screen shows, and sizes are in pixels of the page. */
export function paintOverlay(
  context: Context,
  theme: OverlayTheme,
  { scene, hovered, dragging }: OverlaySnapshot,
  ratio: number,
): void {
  const { canvas } = context;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.lineJoin = "round";
  for (const mark of scene.marks) paintMark(context, theme, mark);
  for (const grip of scene.grips) {
    paintGrip(context, theme, grip, grip.id === (dragging ?? hovered));
  }
}
