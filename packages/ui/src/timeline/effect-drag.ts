/** What a drag of an effect from the effects tab carries. */
export const EFFECT_DRAG_TYPE = "application/x-animaquill-effect";

let dragged: string | undefined;

/**
 * The effect being dragged from the tab in this window, by type. Browsers keep what a drag carries
 * to themselves until the drop, but the timeline has to light up the clip it would go on before.
 */
export const effectDrag = {
  start(type: string): void {
    dragged = type;
  },
  end(): void {
    dragged = undefined;
  },
  current(): string | undefined {
    return dragged;
  },
};
