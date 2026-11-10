import type { MediaPick } from "./editor.ts";

let dragged: MediaPick | undefined;

/**
 * What of the project is being dragged from a tab in this window. Browsers keep what a drag carries
 * to themselves until the drop, but the timeline has to show where it would land before that.
 */
export const mediaDrag = {
  start(pick: MediaPick): void {
    dragged = pick;
    // The tab it came from may be gone by the end, so the end is caught wherever it happens.
    addEventListener("dragend", () => mediaDrag.end(), { once: true, capture: true });
  },
  end(): void {
    dragged = undefined;
  },
  current(): MediaPick | undefined {
    return dragged;
  },
};
