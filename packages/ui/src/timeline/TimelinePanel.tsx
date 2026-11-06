import {
  ChevronDown,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Magnet,
  Maximize2,
  MousePointer2,
  Plus,
  Scissors,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { useWorkbench } from "../app/context.ts";
import type zhCN from "../i18n/zh-CN.json";
import { formatCombo } from "../workbench/keys.ts";
import type { TimelineAction } from "./actions.ts";
import { RULER_HEIGHT, type TimelineEditor, type VisibleClip } from "./editor.ts";
import { formatTimecode } from "./frames.ts";
import type { Pointer } from "./gestures.ts";
import type { ClipBox, Row, TimelineModel } from "./model.ts";
import { TimelinePainter } from "./paint.ts";
import styles from "./TimelinePanel.module.css";

/** How close to the edge a drag has to be to scroll, and how fast it gets, in pixels per second. */
const SCROLL_ZONE = 32;
const SCROLL_SPEED = 900;
/** The list for screen readers follows the view a moment later, not with every frame of a drag. */
const CLIP_LIST_DELAY_MS = 80;
const CLIP_LIST_LIMIT = 200;
/** A wheel notch is about 100, and it should zoom by about a fifth. */
const WHEEL_ZOOM = 0.002;

interface PopupState {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly groups: readonly (readonly MenuItem[])[];
}

type ShowMenu = (popup: PopupState) => void;

function useEditorView<T>(editor: TimelineEditor, read: () => T): T {
  return useSyncExternalStore(editor.subscribeView, read);
}

type ClipKind = keyof typeof zhCN.timeline.kind;

/** What a clip is called. A kind from a plugin has no word here, and shows as it is. */
function useClipLabel() {
  const { t } = useTranslation();
  return ({ clip }: ClipBox) => {
    const { kind } = clip.source;
    return clip.name ?? t(`timeline.kind.${kind as ClipKind}`, { defaultValue: kind });
  };
}

function useTrackName() {
  const { t } = useTranslation();
  return ({ track, number, gone }: Row) =>
    gone ? t("timeline.goneTrack") : (track.name ?? t(`timeline.track.${track.kind}`, { number }));
}

function pointerOf(event: MouseEvent | PointerEvent, stage: HTMLElement): Pointer {
  const box = stage.getBoundingClientRect();
  return {
    x: event.clientX - box.left,
    y: event.clientY - box.top,
    shift: event.shiftKey,
    alt: event.altKey,
    mod: event.ctrlKey || event.metaKey,
  };
}

function Toolbar({ editor, showMenu }: { editor: TimelineEditor; showMenu: ShowMenu }) {
  const { keybindings } = useWorkbench();
  const { t } = useTranslation();
  const { tool, snapping, model } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const frame = useEditorView(editor, () => editor.frame);
  const zoom = useEditorView(editor, () => editor.zoomLevel);

  /** The name of a button with its current shortcut, which people can change. */
  const titleOf = (id: TimelineAction) => {
    const name = t(`timeline.action.${id}`);
    const combo = keybindings.keysFor(`timeline.${id}`)[0];
    return combo ? `${name} (${formatCombo(combo, keybindings.platform)})` : name;
  };

  const trackItems: readonly MenuItem[] = (["video", "audio", "caption"] as const).map((kind) => ({
    id: kind,
    label: t(`timeline.newTrack.${kind}`),
    run: () => editor.addTrack(kind),
  }));

  return (
    <div className={styles.toolbarArea}>
      <div className={styles.toolbar} role="toolbar" aria-label={t("timeline.toolbar")}>
        <output className={styles.timecode} aria-label={t("timeline.playhead")} aria-live="off">
          {model && formatTimecode(frame, model.rate)}
        </output>
        <button
          type="button"
          className={styles.button}
          aria-pressed={tool === "select"}
          aria-label={t("timeline.action.toolSelect")}
          title={titleOf("toolSelect")}
          onClick={() => editor.setTool("select")}
        >
          <MousePointer2 size={15} />
        </button>
        <button
          type="button"
          className={styles.button}
          aria-pressed={tool === "razor"}
          aria-label={t("timeline.action.toolRazor")}
          title={titleOf("toolRazor")}
          onClick={() => editor.setTool("razor")}
        >
          <Scissors size={15} />
        </button>
        <div className={styles.divider} />
        <button
          type="button"
          className={styles.button}
          aria-pressed={snapping}
          aria-label={t("timeline.snapping")}
          title={titleOf("toggleSnapping")}
          onClick={() => editor.toggleSnapping()}
        >
          <Magnet size={15} />
        </button>
        <div className={styles.divider} />
        <button
          type="button"
          className={styles.button}
          aria-label={t("timeline.color")}
          title={t("timeline.action.addColor")}
          onClick={() => editor.addColorClip()}
        >
          <Plus size={15} />
          <span className={styles.buttonLabel}>{t("timeline.color")}</span>
        </button>
        <button
          type="button"
          className={styles.button}
          aria-label={t("timeline.addTrack")}
          title={t("timeline.addTrack")}
          aria-haspopup="menu"
          onClick={(event) => {
            const { left, bottom } = event.currentTarget.getBoundingClientRect();
            showMenu({
              x: left,
              y: bottom + 4,
              label: t("timeline.addTrack"),
              groups: [trackItems],
            });
          }}
        >
          <span className={styles.buttonLabel}>{t("timeline.addTrack")}</span>
          <ChevronDown size={13} />
        </button>
        <div className={styles.spacer} />
        <button
          type="button"
          className={styles.button}
          aria-label={t("timeline.action.zoomOut")}
          title={titleOf("zoomOut")}
          onClick={() => editor.zoomOut()}
        >
          <ZoomOut size={15} />
        </button>
        <input
          className={styles.zoom}
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={zoom}
          aria-label={t("timeline.zoom")}
          onChange={(event) => editor.setZoomLevel(Number(event.target.value))}
          // After the mouse lets go, the arrow keys should go back to moving the playhead.
          onPointerUp={(event) => event.currentTarget.blur()}
        />
        <button
          type="button"
          className={styles.button}
          aria-label={t("timeline.action.zoomIn")}
          title={titleOf("zoomIn")}
          onClick={() => editor.zoomIn()}
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          className={styles.button}
          aria-label={t("timeline.action.zoomToFit")}
          title={titleOf("zoomToFit")}
          onClick={() => editor.zoomToFit()}
        >
          <Maximize2 size={15} />
        </button>
      </div>
    </div>
  );
}

function TrackHeader({
  editor,
  row,
  showMenu,
}: {
  editor: TimelineEditor;
  row: Row;
  showMenu: ShowMenu;
}) {
  const { dialogs } = useWorkbench();
  const { t } = useTranslation();
  const nameOf = useTrackName();
  const name = nameOf(row);
  const { track } = row;
  const sound = track.kind === "audio";
  const off = sound ? track.muted === true : track.hidden === true;
  const toggle = sound ? { muted: !off } : { hidden: !off };
  const offLabel = sound ? "timeline.mute" : "timeline.hide";
  const OnIcon = sound ? Volume2 : Eye;
  const OffIcon = off ? (sound ? VolumeX : EyeOff) : OnIcon;

  const rename = async () => {
    const next = await dialogs.prompt({
      title: t("timeline.trackName"),
      value: name,
      confirm: t("project.rename"),
    });
    if (next) editor.updateTrack(row.id, { name: next });
  };

  return (
    <div
      className={styles.header}
      style={{ height: row.height }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (row.gone) return;
        showMenu({
          x: event.clientX,
          y: event.clientY,
          label: name,
          groups: [
            [
              { id: "rename", label: t("timeline.renameTrack"), run: () => void rename() },
              {
                id: "remove",
                label: t("timeline.removeTrack"),
                run: () => editor.removeTrack(row.id),
              },
            ],
          ],
        });
      }}
    >
      <span
        className={styles.headerName}
        title={name}
        onDoubleClick={row.gone ? undefined : () => void rename()}
      >
        {name}
      </span>
      {!row.gone && (
        <>
          <button
            type="button"
            className={styles.headerButton}
            aria-pressed={track.locked === true}
            aria-label={t("timeline.lock", { track: name })}
            title={t("timeline.lock", { track: name })}
            onClick={() => editor.updateTrack(row.id, { locked: track.locked !== true })}
          >
            {track.locked ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>
          <button
            type="button"
            className={styles.headerButton}
            aria-pressed={off}
            aria-label={t(offLabel, { track: name })}
            title={t(offLabel, { track: name })}
            onClick={() => editor.updateTrack(row.id, toggle)}
          >
            <OffIcon size={14} />
          </button>
        </>
      )}
    </div>
  );
}

function TrackHeaders({
  editor,
  model,
  showMenu,
}: {
  editor: TimelineEditor;
  model: TimelineModel;
  showMenu: ShowMenu;
}) {
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const follow = () => {
      if (list.current) list.current.style.transform = `translateY(${-editor.scrollY}px)`;
    };
    follow();
    return editor.subscribeView(follow);
  }, [editor]);

  return (
    <div className={styles.headers}>
      <div className={styles.corner} style={{ height: RULER_HEIGHT }} />
      <div className={styles.headerList}>
        <div ref={list}>
          {model.rows.map((row) => (
            <TrackHeader key={row.id} editor={editor} row={row} showMenu={showMenu} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** What is on the canvas, for those who cannot see it. */
function ClipList({ editor }: { editor: TimelineEditor }) {
  const { t } = useTranslation();
  const labelOf = useClipLabel();
  const trackNameOf = useTrackName();
  const [clips, setClips] = useState<readonly VisibleClip[]>([]);
  const { selection, model } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => setClips(editor.visibleClips(CLIP_LIST_LIMIT));
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(update, CLIP_LIST_DELAY_MS);
    };
    update();
    const stop = editor.subscribeView(later);
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [editor]);

  if (!model) return null;
  const timecode = (seconds: number) =>
    formatTimecode(Math.round(seconds * model.rate.fps), model.rate);

  return (
    <div
      className={styles.clipList}
      role="listbox"
      aria-multiselectable="true"
      aria-label={t("timeline.clips")}
    >
      {clips.map(({ box, row, left, top, width, height }) => (
        <div
          key={box.id}
          className={styles.clipItem}
          role="option"
          aria-selected={selection.has(box.id)}
          aria-label={t("timeline.clipLabel", {
            name: labelOf(box),
            track: trackNameOf(row),
            start: timecode(box.start),
            end: timecode(box.end),
          })}
          style={{ left, top, width, height }}
        />
      ))}
    </div>
  );
}

function Surface({
  editor,
  model,
  showMenu,
}: {
  editor: TimelineEditor;
  model: TimelineModel;
  showMenu: ShowMenu;
}) {
  const { t } = useTranslation();
  const labelOf = useClipLabel();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<Pointer | undefined>(undefined);
  const scrolling = useRef<number | undefined>(undefined);
  const labels = useRef(labelOf);

  useLayoutEffect(() => {
    labels.current = labelOf;
  });

  useLayoutEffect(() => {
    const scrollerElement = scroller.current;
    const contentElement = content.current;
    const stageElement = stage.current;
    const canvasElement = canvas.current;
    const playheadElement = playhead.current;
    if (!scrollerElement || !contentElement || !stageElement || !canvasElement) return;
    if (!playheadElement) return;

    const painter = new TimelinePainter(canvasElement, editor, (box) => labels.current(box));

    const show = () => {
      const { model: current } = editor;
      contentElement.style.width = `${editor.contentWidth}px`;
      contentElement.style.height = `${editor.contentHeight}px`;
      if (Math.abs(scrollerElement.scrollLeft - editor.scrollX) > 0.5) {
        scrollerElement.scrollLeft = editor.scrollX;
      }
      if (Math.abs(scrollerElement.scrollTop - editor.scrollY) > 0.5) {
        scrollerElement.scrollTop = editor.scrollY;
      }
      if (current) {
        const x = editor.xAt(editor.frame / current.rate.fps);
        const seen = x >= -1 && x <= editor.width;
        playheadElement.style.visibility = seen ? "visible" : "hidden";
        playheadElement.style.transform = `translateX(${Math.round(x)}px)`;
        playheadElement.setAttribute("aria-valuenow", String(editor.frame));
        playheadElement.setAttribute("aria-valuetext", formatTimecode(editor.frame, current.rate));
      }
      painter.invalidate();
    };

    const measure = () => {
      const width = scrollerElement.clientWidth;
      const height = scrollerElement.clientHeight;
      stageElement.style.width = `${width}px`;
      stageElement.style.height = `${height}px`;
      painter.resize(width, height, devicePixelRatio);
      editor.setViewport(width, height);
      show();
      // Resizing wipes the canvas, and this runs after the frame's chance to draw: waiting for the
      // next one would show an empty panel for a moment, over and over while dragging a divider.
      painter.paintNow();
    };

    const onScroll = () => editor.setScroll(scrollerElement.scrollLeft, scrollerElement.scrollTop);

    /** Trackpads and mice both come through here. A pinch arrives with Ctrl held. */
    const onWheel = (event: WheelEvent) => {
      const box = stageElement.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault();
        editor.zoomAround(event.clientX - box.left, Math.exp(-event.deltaY * WHEEL_ZOOM));
        return;
      }
      // With no rows to scroll through, the wheel has one useful direction left.
      const canScrollDown = editor.contentHeight > editor.height + 1;
      if (!canScrollDown && event.deltaX === 0 && !event.shiftKey) {
        event.preventDefault();
        editor.setScroll(editor.scrollX + event.deltaY, editor.scrollY);
      }
    };

    const stopView = editor.subscribeView(show);
    const observer = new ResizeObserver(measure);
    observer.observe(scrollerElement);
    measure();
    scrollerElement.addEventListener("scroll", onScroll, { passive: true });
    scrollerElement.addEventListener("wheel", onWheel, { passive: false });

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
      scrollerElement.removeEventListener("wheel", onWheel);
      scrollerElement.removeEventListener("scroll", onScroll);
      observer.disconnect();
      stopView();
      painter.dispose();
    };
  }, [editor]);

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
    editor.press(lastPointer.current);
    scrolling.current ??= requestAnimationFrame((now) => scrollWhileNearEdge(now));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const { currentTarget } = event;
    const pointer = pointerOf(event, currentTarget);
    lastPointer.current = pointer;
    // The button came up somewhere we could not see it, for example in another window.
    if (editor.isDragging && event.buttons === 0) editor.cancelDrag();
    else if (editor.isDragging) editor.drag(pointer);
    else currentTarget.style.cursor = editor.hover(pointer);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 0) editor.release(pointerOf(event, event.currentTarget));
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const hit = editor.hitAt(pointerOf(event, event.currentTarget));
    const { clientX: x, clientY: y } = event;
    if (hit.kind === "clip") {
      if (!editor.getSnapshot().selection.has(hit.box.id)) editor.selectOnly(hit.box.id);
      showMenu({
        x,
        y,
        label: t("timeline.clips"),
        groups: [
          [
            {
              id: "split",
              label: t("timeline.action.split"),
              run: () => editor.splitAtPlayhead(),
              disabled: !editor.canSplit,
            },
            {
              id: "delete",
              label: t("timeline.action.delete"),
              run: () => editor.deleteSelection(),
            },
          ],
        ],
      });
    } else if (
      hit.kind === "lane" &&
      !hit.row.track.locked &&
      !hit.row.gone &&
      hit.row.track.kind === "video"
    ) {
      showMenu({
        x,
        y,
        label: t("timeline.clips"),
        groups: [
          [
            {
              id: "add",
              label: t("timeline.color"),
              run: () => editor.addColorClip({ row: hit.row, seconds: hit.seconds }),
            },
          ],
        ],
      });
    }
  };

  return (
    <div ref={scroller} className={styles.scroller}>
      <div ref={content} className={styles.content}>
        <div
          ref={stage}
          className={styles.stage}
          tabIndex={0}
          role="group"
          aria-label={t("panel.timeline.title")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => editor.cancelDrag()}
          onLostPointerCapture={() => editor.cancelDrag()}
          onPointerLeave={() => editor.leave()}
          onContextMenu={onContextMenu}
        >
          <canvas ref={canvas} className={styles.canvas} />
          <ClipList editor={editor} />
          {model.boxes.size === 0 && <p className={styles.hint}>{t("timeline.emptyHint")}</p>}
          <div
            ref={playhead}
            className={styles.playhead}
            role="slider"
            aria-label={t("timeline.playhead")}
            aria-valuemin={0}
            aria-valuemax={Math.round(model.duration * model.rate.fps)}
            aria-orientation="horizontal"
            tabIndex={-1}
          />
        </div>
      </div>
    </div>
  );
}

export function TimelinePanel() {
  const { timeline: editor } = useWorkbench();
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const [popup, setPopup] = useState<PopupState>();

  if (!model) return <div className={styles.missing}>{t("timeline.missing")}</div>;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A menu opened from here is part of this panel for React, but it has its own Escape.
    if (event.key !== "Escape" || !event.currentTarget.contains(event.target as Node)) return;
    if (!editor.cancelDrag()) editor.clearSelection();
  };

  return (
    <div className={styles.panel} onKeyDown={onKeyDown}>
      <Toolbar editor={editor} showMenu={setPopup} />
      <div className={styles.body}>
        <TrackHeaders editor={editor} model={model} showMenu={setPopup} />
        <Surface editor={editor} model={model} showMenu={setPopup} />
      </div>
      {popup && <PopupMenu {...popup} onClose={() => setPopup(undefined)} />}
    </div>
  );
}
