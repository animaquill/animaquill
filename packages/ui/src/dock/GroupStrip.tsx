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
 * dock.css, and down a side it has the edges that make it wider or narrower: the edge of the strip,
 * and, while the names of a strip of icons are out, the edge of the names. dock.css shows one of
 * the two at a time, so that the edge under the mouse is the one that people see.
 */
export function GroupStrip({ group }: IDockviewHeaderActionsProps) {
  const strips = useStrips();
  const { t } = useTranslation();
  const strip = strips.stripOf(group);
  const { peek, width, peekWidth } = strips.lookOf(group);
  // Tabs across the top always show their names.
  const pinned = strips.isPinned(group);
  const dragging = useRef<{ pinned: boolean } | "names" | undefined>(undefined);

  // The width belongs to the whole group, which is the one element of it with a public handle.
  useLayoutEffect(() => {
    const { style } = group.element;
    const put = (name: string, value: number | undefined) => {
      if (value === undefined) style.removeProperty(name);
      else style.setProperty(name, `${value}px`);
    };
    put("--aq-strip-width", width);
    put("--aq-strip-peek", peekWidth);
  }, [group, width, peekWidth]);

  const start = (what: "strip" | "names") => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Not a drag of the strip itself, see `DockArea`.
    event.preventDefault();
    event.stopPropagation();
    // The edge keeps the mouse, and with it the hover that keeps the names out.
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = what === "names" ? "names" : { pinned };
  };

  /**
   * The edge follows the mouse. The edge of the names makes them wider or narrower. The edge of
   * the strip makes it icons, or names as wide as the mouse is from the outer edge.
   */
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragging.current;
    if (!drag) return;
    const box = group.element.getBoundingClientRect();
    const wide = strip === "left" ? event.clientX - box.left : box.right - event.clientX;
    if (drag === "names") {
      strips.setPeekWidth(group, wide);
      return;
    }
    if (drag.pinned ? wide < UNPIN_BELOW : wide > PIN_BEYOND) drag.pinned = !drag.pinned;
    if (drag.pinned) strips.setWidth(group, true, wide);
    else strips.setWidth(group, false);
  };

  const end = () => {
    dragging.current = undefined;
  };

  const edge = (what: "strip" | "names") => ({
    className: styles.edge,
    role: "separator",
    "aria-orientation": "vertical" as const,
    "data-edge": what,
    onPointerDown: start(what),
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  });

  return (
    <div
      className={styles.marks}
      data-strip={strip}
      data-pinned={pinned}
      data-peek={peek && !strips.isResting(group)}
    >
      {strip !== "top" && (
        <div
          {...edge("strip")}
          aria-label={t("strip.edge")}
          aria-valuenow={pinned ? (width ?? DEFAULT_WIDTH) : ICONS_WIDTH}
        />
      )}
      {strip !== "top" && !pinned && peek && (
        <div
          {...edge("names")}
          aria-label={t("strip.peekEdge")}
          aria-valuenow={peekWidth ?? width ?? DEFAULT_WIDTH}
        />
      )}
    </div>
  );
}
