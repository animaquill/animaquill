import type { IDockviewHeaderActionsProps } from "dockview-react";
import { useLayoutEffect, useRef, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import styles from "./GroupStrip.module.css";
import { useStrips } from "./strips-context.ts";
import { DEFAULT_WIDTH, ICONS_WIDTH, MIN_WIDTH } from "./strips.ts";

/** Dragged out this far, a strip of icons gets its names. */
const PIN_BEYOND = MIN_WIDTH;
/** Dragged in this far, a strip with names goes back to icons. */
const UNPIN_BELOW = ICONS_WIDTH + 16;

/**
 * At the end of the tabs of each group. It shows nothing, but says how the strip looks, see
 * dock.css, and down a side it has the edge that makes the strip wider or narrower.
 */
export function GroupStrip({ group }: IDockviewHeaderActionsProps) {
  const strips = useStrips();
  const { t } = useTranslation();
  const strip = strips.stripOf(group);
  const { peek, width } = strips.lookOf(group);
  // Tabs across the top always show their names.
  const pinned = strips.isPinned(group);
  const dragging = useRef<{ pinned: boolean } | undefined>(undefined);

  // The width belongs to the whole group, which is the one element of it with a public handle.
  useLayoutEffect(() => {
    const { style } = group.element;
    if (width === undefined) style.removeProperty("--aq-strip-width");
    else style.setProperty("--aq-strip-width", `${width}px`);
  }, [group, width]);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Not a drag of the strip itself, see `DockArea`.
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { pinned };
  };

  /** The strip follows the mouse: icons, or names as wide as the mouse is from the outer edge. */
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (!drag) return;
    const box = group.element.getBoundingClientRect();
    const wide = strip === "left" ? event.clientX - box.left : box.right - event.clientX;
    if (drag.pinned ? wide < UNPIN_BELOW : wide > PIN_BEYOND) drag.pinned = !drag.pinned;
    if (drag.pinned) strips.setWidth(group, true, wide);
    else strips.setWidth(group, false);
  };

  const end = () => {
    dragging.current = undefined;
  };

  return (
    <div
      className={styles.marks}
      data-strip={strip}
      data-pinned={pinned}
      data-peek={peek && !strips.isResting(group)}
    >
      {strip !== "top" && (
        <div
          className={styles.edge}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("strip.edge")}
          aria-valuenow={pinned ? (width ?? DEFAULT_WIDTH) : ICONS_WIDTH}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
        />
      )}
    </div>
  );
}
