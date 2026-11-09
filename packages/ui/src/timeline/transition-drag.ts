import type { TransitionPick } from "./transition-place.ts";

/** What a drag of a transition from the transitions tab carries. */
export const TRANSITION_DRAG_TYPE = "application/x-animaquill-transition";

let dragged: TransitionPick | undefined;

/**
 * The transition being dragged from the tab in this window. Browsers keep what a drag carries to
 * themselves until the drop, but the timeline has to show where it would go before that, and
 * whether it can go there at all.
 */
export const transitionDrag = {
  start(pick: TransitionPick): void {
    dragged = pick;
  },
  end(): void {
    dragged = undefined;
  },
  current(): TransitionPick | undefined {
    return dragged;
  },
};
