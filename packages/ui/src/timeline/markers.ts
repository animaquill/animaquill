import { placedSections, type TimelineState } from "@animaquill/core";
import { parseTime, toSeconds, type Rational } from "@animaquill/schema";
import { frameAt, type FrameRate } from "./frames.ts";

type Marker = TimelineState["markers"][string];

/**
 * The colours a marker can take in the editor, as Premiere has them: what the project keeps, and
 * the name of the colour each shows in, which is lighter or darker with the theme. A marker without
 * a colour shows in the first. Colours written some other way show as they are.
 */
export const MARKER_COLORS = [
  { id: "green", value: "#4caf50" },
  { id: "red", value: "#e5484d" },
  { id: "purple", value: "#a371f7" },
  { id: "orange", value: "#f0883e" },
  { id: "yellow", value: "#e3b341" },
  { id: "white", value: "#e6e6e6" },
  { id: "blue", value: "#4f8ff7" },
  { id: "cyan", value: "#39c5cf" },
] as const;

export type MarkerColor = (typeof MARKER_COLORS)[number]["id"];

/** Which of the colours of the editor a marker has, or none when it has a colour of its own. */
export function markerColorOf(marker: Pick<Marker, "color">): MarkerColor | undefined {
  if (marker.color === undefined) return MARKER_COLORS[0].id;
  const color = marker.color.toLowerCase();
  return MARKER_COLORS.find(({ value }) => value === color)?.id;
}

/** A marker where it is on screen: seconds, and where a stretch of one ends. */
export interface MarkerBox {
  readonly id: string;
  readonly marker: Marker;
  readonly time: number;
  /** Where a marker with a duration ends; one without has none. */
  readonly end: number | undefined;
}

/** A section where it is, exactly and in seconds. */
export interface SectionBox {
  readonly id: string;
  readonly name: string | undefined;
  readonly startExact: Rational;
  readonly endExact: Rational;
  readonly start: number;
  readonly end: number;
}

const secondsOf = (time: string) => toSeconds(parseTime(time));

export function markerBoxesOf(state: TimelineState): readonly MarkerBox[] {
  return Object.values(state.markers)
    .map((marker) => {
      const time = secondsOf(marker.time);
      const end = marker.duration === undefined ? undefined : time + secondsOf(marker.duration);
      return { id: marker.id, marker, time, end };
    })
    .toSorted((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

export function sectionBoxesOf(state: TimelineState): readonly SectionBox[] {
  return placedSections(state).map(({ id, name, start, end }) => ({
    id,
    name,
    startExact: start,
    endExact: end,
    start: toSeconds(start),
    end: toSeconds(end),
  }));
}

/** Whether a timeline shows its sections: with more than one, or one that has a name. */
export const showsSections = (sections: readonly SectionBox[]): boolean =>
  sections.length > 1 || (sections[0]?.name ?? "") !== "";

/** The markers that start on a frame. */
export const markersOnFrame = (
  markers: readonly MarkerBox[],
  frame: number,
  rate: FrameRate,
): readonly MarkerBox[] => markers.filter(({ time }) => frameAt(time, rate) === frame);

/** The frame of the next marker after a frame, or of the one before it, if there is one. */
export function markerFrameFrom(
  markers: readonly MarkerBox[],
  frame: number,
  direction: 1 | -1,
  rate: FrameRate,
): number | undefined {
  const frames = markers
    .map(({ time }) => frameAt(time, rate))
    .filter((each) => (each - frame) * direction > 0);
  if (frames.length === 0) return undefined;
  return direction > 0 ? Math.min(...frames) : Math.max(...frames);
}
