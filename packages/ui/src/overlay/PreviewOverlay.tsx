import type { TFunction } from "i18next";
import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { Grip, Side } from "./editor.ts";
import type { OverlayPointer } from "./gestures.ts";
import { paintOverlay, readOverlayTheme, type OverlayTheme } from "./paint.ts";
import styles from "./PreviewOverlay.module.css";

/** How large the stand-in of a handle is in the list, for whoever reads the page instead of seeing it. */
const STAND_IN = 10;

function pointerOf(event: PointerEvent, element: HTMLElement): OverlayPointer {
  const box = element.getBoundingClientRect();
  return {
    x: event.clientX - box.left,
    y: event.clientY - box.top,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/** What a handle is called, for people who cannot see it, and for tests. */
function nameOf(t: TFunction, grip: Grip): string {
  switch (grip.role) {
    case "scale":
      return t(`overlay.grip.scale.${grip.detail as Side}`);
    case "key":
      return t("overlay.grip.key", { time: grip.detail });
    case "object":
      return t("overlay.grip.object", { object: grip.object ?? "", handle: grip.detail });
    case "rotate":
      return t("overlay.grip.rotate");
    case "anchor":
      return t("overlay.grip.anchor");
  }
}

/** What a handle does, while the pointer is on it. */
const usageOf = (t: TFunction, { role }: Grip): string => t(`overlay.usage.${role}`);

/**
 * The handles over the picture. The compositor frame below takes no pointer, so everything people do
 * on the picture lands here, on the editor's side of the sandbox.
 */
export function PreviewOverlay() {
  const { overlay, input } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(overlay.subscribe, overlay.getSnapshot);
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const painted = useRef<{ theme: OverlayTheme; ratio: number } | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  const paint = () => {
    frame.current = undefined;
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    painted.current ??= { theme: readOverlayTheme(element), ratio: devicePixelRatio };
    paintOverlay(context, painted.current.theme, overlay.getSnapshot(), painted.current.ratio);
  };

  useLayoutEffect(() => {
    const element = area.current;
    const drawing = canvas.current;
    if (!element || !drawing) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      const ratio = devicePixelRatio;
      drawing.width = Math.round(width * ratio);
      drawing.height = Math.round(height * ratio);
      drawing.style.width = `${width}px`;
      drawing.style.height = `${height}px`;
      painted.current = { theme: readOverlayTheme(drawing), ratio };
      overlay.setViewport(width, height);
      paint();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    // The ratio changes when the window moves to another screen, or with the browser's zoom.
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
      stopRatio();
      observer.disconnect();
      overlay.cancel();
      overlay.setViewport(0, 0);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
    // Painting reads what is there when it runs.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [overlay]);

  useLayoutEffect(() => {
    frame.current ??= requestAnimationFrame(paint);
  });

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { currentTarget } = event;
    currentTarget.focus({ preventScroll: true });
    currentTarget.setPointerCapture(event.pointerId);
    input.noticePointer(event.pointerType);
    overlay.setTouchInput(input.isTouch(event.pointerType));
    overlay.press(pointerOf(event, currentTarget));
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const { currentTarget } = event;
    const pointer = pointerOf(event, currentTarget);
    if (overlay.isDragging) {
      // The button came up somewhere this could not see it, for example in another window.
      if (event.buttons === 0) overlay.cancel();
      else overlay.drag(pointer);
      return;
    }
    currentTarget.style.cursor = overlay.hover(pointer);
    const { hovered, scene } = overlay.getSnapshot();
    const grip = scene.grips.find(({ id }) => id === hovered);
    currentTarget.title = grip ? `${nameOf(t, grip)}\n${usageOf(t, grip)}` : "";
  };

  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key !== "Escape" || !overlay.isDragging) return;
    event.preventDefault();
    event.stopPropagation();
    overlay.cancel();
  };

  const { scene } = snapshot;
  const target = scene.target;
  const targetBox = target && boundsOf(target.corners);
  return (
    <div ref={area} className={styles.overlay}>
      <canvas
        ref={canvas}
        className={styles.canvas}
        tabIndex={-1}
        aria-label={t("overlay.label")}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          if (event.button === 0) overlay.release(pointerOf(event, event.currentTarget));
        }}
        onPointerCancel={() => overlay.cancel()}
        onLostPointerCapture={() => overlay.cancel()}
        onPointerLeave={() => overlay.leave()}
        onKeyDown={onKeyDown}
      />
      {/* What is drawn, where it is drawn, for whoever reads the page. The pointer goes to the canvas. */}
      <ul className={styles.list} aria-label={t("overlay.list")}>
        {target && targetBox && (
          <li
            aria-label={t("overlay.box")}
            style={{
              left: targetBox.x,
              top: targetBox.y,
              width: targetBox.width,
              height: targetBox.height,
            }}
          />
        )}
        {scene.grips.map((grip) => (
          <li
            key={grip.id}
            aria-label={nameOf(t, grip)}
            style={{
              left: grip.at.x - STAND_IN / 2,
              top: grip.at.y - STAND_IN / 2,
              width: STAND_IN,
              height: STAND_IN,
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function boundsOf(corners: readonly { readonly x: number; readonly y: number }[]) {
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
