import { orderedTracks } from "@animaquill/core";
import { forEachBetween, type Row, type TimelineModel } from "./model.ts";

/**
 * Where a new track comes next to a row, as people see it: above it or below it. Pictures and
 * captions further back in the project show higher up, sound further back shows lower down.
 */
export type Side = "above" | "below";

/** A track kind that people put clips on. */
export type TrackKind = "video" | "audio" | "caption";

/** Clips that touch differ by this much as floats, and that is no overlap. */
const TOUCHING = 1e-9;

/** Which half of a row a height in the rows is in: the upper one is above it. */
export function sideOf(row: Pick<Row, "top" | "height">, lane: number): Side {
  return lane - row.top < row.height / 2 ? "above" : "below";
}

/** Whether a height in the rows is in a row, not in the room under it. */
export const isInRow = (row: Pick<Row, "top" | "height">, lane: number): boolean =>
  lane >= row.top && lane < row.top + row.height;

/** Whether a clip that is not one of these is on a row at a moment. */
export function hasOtherAt(row: Row, seconds: number, ignored: ReadonlySet<string>): boolean {
  let found = false;
  forEachBetween(row, seconds, seconds + TOUCHING, (box) => {
    if (!ignored.has(box.id) && box.start <= seconds) found = true;
  });
  return found;
}

/** Whether a clip that is not one of these is somewhere from `start` to `end` on a row. */
export function hasOtherBetween(
  row: Row,
  start: number,
  end: number,
  ignored: ReadonlySet<string>,
): boolean {
  let found = false;
  forEachBetween(row, start + TOUCHING, end - TOUCHING, (box) => {
    if (!ignored.has(box.id)) found = true;
  });
  return found;
}

/**
 * The track a new one goes in front of in the project, as `track.add` takes it, to show next to a
 * row on a side; undefined for the end. Next to a track that is gone, it goes outermost: on top of
 * the pictures, below all sound.
 */
export function besideBefore(model: TimelineModel, row: Row, side: Side): string | undefined {
  const order = orderedTracks(model.state);
  const after = (index: number) => (index < 0 ? undefined : order[index + 1]?.id);
  const sound = row.track.kind === "audio";
  if (row.gone) {
    const last = order.findLastIndex(({ kind }) => kind === row.track.kind);
    return after(last);
  }
  const index = order.findIndex(({ id }) => id === row.id);
  // Further back in the project shows higher for pictures, and lower for sound.
  const later = sound ? side === "below" : side === "above";
  return later ? after(index) : row.id;
}

/** The number a new track of a kind gets where it goes in front of `before`, see `besideBefore`. */
export function newTrackNumber(
  model: TimelineModel,
  kind: TrackKind,
  before: string | undefined,
): number {
  const order = orderedTracks(model.state);
  const at = before === undefined ? order.length : order.findIndex(({ id }) => id === before);
  return (
    order.slice(0, at < 0 ? order.length : at).filter((track) => track.kind === kind).length + 1
  );
}
