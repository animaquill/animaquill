import { useLayoutEffect, useRef, type PointerEvent } from "react";
import { Tip } from "../app/Tip.tsx";
import styles from "./ZoomBar.module.css";

/** Short enough for a long timeline, long enough to keep both handles and something between them. */
const MIN_THUMB = 30;

export interface BarState {
  /** The size of everything, of what shows of it, and where that starts. */
  readonly content: number;
  readonly view: number;
  readonly offset: number;
}

export type Edge = "start" | "end";

interface ZoomBarProps {
  readonly axis: "x" | "y";
  readonly label: string;
  readonly handleLabel: string;
  readonly handleUsage: string;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: () => BarState;
  readonly scrollTo: (offset: number) => void;
  /** Starts dragging a handle. The result takes how much longer the thumb is than at the start. */
  readonly beginZoom: (edge: Edge) => (ratio: number) => void;
}

type Drag =
  | { readonly kind: "thumb"; readonly from: number; readonly offset: number }
  | {
      readonly kind: "zoom";
      readonly from: number;
      readonly edge: Edge;
      readonly length: number;
      readonly zoom: (ratio: number) => void;
    };

/** A scrollbar with a handle on each end, as in Premiere: pulling one zooms. */
export function ZoomBar(props: ZoomBarProps) {
  const { axis, label, handleLabel, handleUsage, subscribe, read, scrollTo, beginZoom } = props;
  const bar = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | undefined>(undefined);

  const lengthOf = (element: HTMLElement) =>
    axis === "x" ? element.clientWidth : element.clientHeight;
  const place = (event: PointerEvent) => (axis === "x" ? event.clientX : event.clientY);

  /** The thumb in pixels. */
  const measure = () => {
    const { content, view, offset } = read();
    const length = bar.current ? lengthOf(bar.current) : 0;
    const size = Math.min(Math.max((view / content) * length, MIN_THUMB), length);
    const room = content - view;
    return { length, size, start: room > 0 ? (offset / room) * (length - size) : 0, room };
  };

  useLayoutEffect(() => {
    const show = () => {
      const element = thumb.current;
      if (!element) return;
      const { size, start } = measure();
      element.style[axis === "x" ? "width" : "height"] = `${size}px`;
      element.style.transform = axis === "x" ? `translateX(${start}px)` : `translateY(${start}px)`;
      const { content, view, offset } = read();
      const share = content > view ? Math.round((offset / (content - view)) * 100) : 0;
      bar.current?.setAttribute("aria-valuenow", String(share));
    };
    show();
    return subscribe(show);
  });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.target as HTMLElement;
    const edge = target.dataset["handle"] as Edge | undefined;
    const from = place(event);
    if (edge) {
      drag.current = { kind: "zoom", from, edge, length: measure().size, zoom: beginZoom(edge) };
      return;
    }
    if (target !== thumb.current) {
      // A click next to the thumb brings that place to the middle.
      const { length, size, room } = measure();
      const box = event.currentTarget.getBoundingClientRect();
      const inBar = from - (axis === "x" ? box.left : box.top);
      if (length > size) scrollTo(((inBar - size / 2) / (length - size)) * room);
    }
    drag.current = { kind: "thumb", from, offset: read().offset };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const moved = place(event) - current.from;
    if (current.kind === "zoom") {
      const grown = current.edge === "end" ? moved : -moved;
      current.zoom(Math.max(current.length + grown, 1) / current.length);
      return;
    }
    const { length, size, room } = measure();
    if (length > size) scrollTo(current.offset + (moved / (length - size)) * room);
  };

  const stop = () => {
    drag.current = undefined;
  };

  const handle = (edge: Edge) => (
    <Tip name={handleLabel} usage={handleUsage}>
      <div className={styles.handle} data-handle={edge} />
    </Tip>
  );

  return (
    <div
      ref={bar}
      className={axis === "x" ? styles.barX : styles.barY}
      data-bar={axis}
      role="scrollbar"
      aria-label={label}
      aria-orientation={axis === "x" ? "horizontal" : "vertical"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    >
      <div ref={thumb} className={styles.thumb}>
        {handle("start")}
        {handle("end")}
      </div>
    </div>
  );
}
