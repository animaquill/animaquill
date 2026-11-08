import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { RULER_HEIGHT } from "./editor.ts";
import { formatTimecode, type FrameRate } from "./frames.ts";
import type { Pointer } from "./gestures.ts";
import type { StagePainter } from "./stage-painter.ts";
import { TouchController, type TouchTarget } from "./touch.ts";
import styles from "./TimelinePanel.module.css";
import { WheelInterpreter } from "./wheel.ts";

/** How close to the edge a drag has to be to scroll, and how fast it gets, in pixels per second. */
const SCROLL_ZONE = 32;
const SCROLL_SPEED = 900;

/** Anything that shows time from left to right under a ruler, and that the mouse works on. */
export interface StageEditor extends TouchTarget {
  readonly model: { readonly rate: FrameRate } | undefined;
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  readonly isDragging: boolean;
  readonly isSnappedToPlayhead: boolean;
  /** The cursor while dragging, or nothing for the usual one. */
  readonly dragCursor: string;
  subscribeView(listener: () => void): () => void;
  setViewport(width: number, height: number): void;
  xAt(seconds: number): number;
  hover(pointer: Pointer): string;
  /** What to tell about what is under the pointer, as a key of the interface texts. */
  titleAt?(pointer: Pointer): string | undefined;
  leave(): void;
  scrollDuringDrag(pointer: Pointer, dx: number, dy: number): void;
  setTouchInput(on: boolean): void;
}

export function pointerOf(event: MouseEvent | PointerEvent, stage: HTMLElement): Pointer {
  const box = stage.getBoundingClientRect();
  return {
    x: event.clientX - box.left,
    y: event.clientY - box.top,
    shift: event.shiftKey,
    alt: event.altKey,
    mod: event.ctrlKey || event.metaKey,
  };
}

export interface StageParts {
  readonly stage: RefObject<HTMLDivElement | null>;
  readonly canvas: RefObject<HTMLCanvasElement | null>;
  readonly playhead: RefObject<HTMLDivElement | null>;
}

export interface StageOptions {
  /** Makes what draws on the canvas, once it is in the page. */
  readonly paint: (canvas: HTMLCanvasElement) => StagePainter;
  /** What else changes the picture, apart from the view. */
  readonly repaintOn?: (listener: () => void) => () => void;
  /** Where the wheel works, which can be more than the stage. */
  readonly wheelArea: (stage: HTMLElement) => Element | null;
  /** The menu of a place: a finger gets there with a long press. */
  readonly openMenu: (pointer: Pointer) => void;
}

/** The events of a stage, for its element. */
export interface StageEvents {
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onPointerLeave: () => void;
}

/**
 * What every timeline-like view does with its canvas, the mouse, fingers and the wheel. The view
 * itself decides what these mean: this only gets the events to it.
 */
export function useStage(
  editor: StageEditor,
  { stage, canvas, playhead }: StageParts,
  options: StageOptions,
): StageEvents {
  const { t } = useTranslation();
  const { input } = useWorkbench();
  const lastPointer = useRef<Pointer | undefined>(undefined);
  const scrolling = useRef<number | undefined>(undefined);
  const touch = useRef<TouchController | undefined>(undefined);
  const latest = useRef(options);

  useLayoutEffect(() => {
    latest.current = options;
  });

  useLayoutEffect(() => {
    touch.current = new TouchController(editor, {
      later(run, milliseconds) {
        const timer = setTimeout(run, milliseconds);
        return () => clearTimeout(timer);
      },
      nextFrame(run) {
        const frame = requestAnimationFrame(run);
        return () => cancelAnimationFrame(frame);
      },
      now: () => performance.now(),
      openMenu: (pointer) => latest.current.openMenu(pointer),
      held: () => navigator.vibrate?.(10),
    });
  }, [editor]);

  useLayoutEffect(() => {
    const stageElement = stage.current;
    const canvasElement = canvas.current;
    const playheadElement = playhead.current;
    const wheelElement = stageElement && latest.current.wheelArea(stageElement);
    if (!wheelElement || !stageElement || !canvasElement || !playheadElement) return;

    const painter = latest.current.paint(canvasElement);
    const stopRepaints = latest.current.repaintOn?.(() => painter.invalidate());

    const show = () => {
      const { model } = editor;
      if (model) {
        const x = editor.xAt(editor.frame / model.rate.fps);
        const seen = x >= -1 && x <= editor.width;
        playheadElement.style.visibility = seen ? "visible" : "hidden";
        playheadElement.style.transform = `translateX(${Math.round(x)}px)`;
        playheadElement.classList.toggle(styles.snapped as string, editor.isSnappedToPlayhead);
        playheadElement.setAttribute("aria-valuenow", String(editor.frame));
        playheadElement.setAttribute("aria-valuetext", formatTimecode(editor.frame, model.rate));
      }
      painter.invalidate();
    };

    const measure = () => {
      const width = stageElement.clientWidth;
      const height = stageElement.clientHeight;
      painter.resize(width, height, devicePixelRatio);
      editor.setViewport(width, height);
      show();
      // Resizing wipes the canvas, and this runs after the frame's chance to draw: waiting for the
      // next one would show an empty panel for a moment, over and over while dragging a divider.
      painter.paintNow();
    };

    const wheel = new WheelInterpreter();
    const onWheel = (event: Event) => {
      if (!(event instanceof WheelEvent)) return;
      event.preventDefault();
      const { wheelDeltaX, wheelDeltaY } = event as WheelEvent & {
        wheelDeltaX: number;
        wheelDeltaY: number;
      };
      const action = wheel.read(
        {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          lines: event.deltaMode === WheelEvent.DOM_DELTA_LINE,
          wheelDelta: wheelDeltaY || wheelDeltaX,
          ctrl: event.ctrlKey || event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
          time: event.timeStamp,
        },
        input.wheelDevice,
      );
      if (wheel.device) input.notice(wheel.device);
      const box = stageElement.getBoundingClientRect();
      if (action.kind === "zoom") editor.zoomAround(event.clientX - box.left, action.factor);
      else if (action.kind === "zoomRows") {
        editor.zoomRowsAround(event.clientY - box.top, action.factor);
      } else editor.setScroll(editor.scrollX + action.dx, editor.scrollY + action.dy);
    };

    const stopView = editor.subscribeView(show);
    const observer = new ResizeObserver(measure);
    observer.observe(stageElement);
    measure();
    wheelElement.addEventListener("wheel", onWheel, { passive: false });

    // The ratio changes when the window moves to another screen, or with the browser's zoom. The
    // query is about one value, so every change needs a new one.
    let stopRatio = () => {};
    const watchRatio = () => {
      stopRatio();
      const query = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      const onChange = () => {
        measure();
        watchRatio();
      };
      query.addEventListener("change", onChange);
      stopRatio = () => query.removeEventListener("change", onChange);
    };
    watchRatio();

    return () => {
      // The mouse button can come up after this panel is gone, and nobody here would hear of it.
      editor.cancelDrag();
      stopRatio();
      wheelElement.removeEventListener("wheel", onWheel);
      observer.disconnect();
      stopView();
      stopRepaints?.();
      painter.dispose();
    };
  }, [canvas, editor, input, playhead, stage]);

  /** Dragging near an edge keeps going, also when the mouse does not move. */
  const scrollWhileNearEdge = (now: number, before = now) => {
    scrolling.current = undefined;
    const pointer = lastPointer.current;
    if (!pointer || !editor.isDragging) return;
    const seconds = (now - before) / 1000;
    const speed = (distance: number) =>
      Math.max(0, Math.min(1, distance / SCROLL_ZONE)) * SCROLL_SPEED * seconds;
    const dx = speed(pointer.x - (editor.width - SCROLL_ZONE)) - speed(SCROLL_ZONE - pointer.x);
    const dy =
      speed(pointer.y - (editor.height - SCROLL_ZONE)) -
      speed(SCROLL_ZONE + RULER_HEIGHT - pointer.y);
    if (dx !== 0 || dy !== 0) editor.scrollDuringDrag(pointer, dx, dy);
    scrolling.current = requestAnimationFrame((next) => scrollWhileNearEdge(next, now));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const { currentTarget } = event;
    currentTarget.focus({ preventScroll: true });
    currentTarget.setPointerCapture(event.pointerId);
    lastPointer.current = pointerOf(event, currentTarget);
    input.noticePointer(event.pointerType);
    const isTouch = input.isTouch(event.pointerType);
    editor.setTouchInput(isTouch);
    if (isTouch) touch.current?.down(event.pointerId, lastPointer.current.x, lastPointer.current.y);
    else editor.press(lastPointer.current);
    scrolling.current ??= requestAnimationFrame((now) => scrollWhileNearEdge(now));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const { currentTarget } = event;
    const pointer = pointerOf(event, currentTarget);
    const about = editor.titleAt?.(pointer);
    currentTarget.title =
      pointer.y < RULER_HEIGHT ? t("timeline.timeFormat") : about ? t(about as never) : "";
    lastPointer.current = pointer;
    if (input.isTouch(event.pointerType)) {
      touch.current?.move(event.pointerId, pointer.x, pointer.y);
      scrolling.current ??= requestAnimationFrame((now) => scrollWhileNearEdge(now));
      return;
    }
    // The button came up somewhere we could not see it, for example in another window.
    if (editor.isDragging && event.buttons === 0) editor.cancelDrag();
    else if (editor.isDragging) {
      editor.drag(pointer);
      currentTarget.style.cursor = editor.dragCursor;
    } else currentTarget.style.cursor = editor.hover(pointer);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (input.isTouch(event.pointerType)) touch.current?.up(event.pointerId);
    else if (event.button === 0) editor.release(pointerOf(event, event.currentTarget));
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (input.isTouch(event.pointerType)) touch.current?.cancel(event.pointerId);
    else editor.cancelDrag();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture: (event) => {
      if (!input.isTouch(event.pointerType)) editor.cancelDrag();
    },
    onPointerLeave: () => editor.leave(),
  };
}
