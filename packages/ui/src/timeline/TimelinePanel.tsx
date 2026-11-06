import {
  Eye,
  EyeOff,
  FoldHorizontal,
  Lock,
  LockOpen,
  Magnet,
  MousePointer2,
  Plus,
  Replace,
  Scissors,
  SquareSplitHorizontal,
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
  type ComponentType,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { Tip } from "../app/Tip.tsx";
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
import { ZoomBar } from "./ZoomBar.tsx";

/** How close to the edge a drag has to be to scroll, and how fast it gets, in pixels per second. */
const SCROLL_ZONE = 32;
const SCROLL_SPEED = 900;
/** The list for screen readers follows the view a moment later, not with every frame of a drag. */
const CLIP_LIST_DELAY_MS = 80;
const CLIP_LIST_LIMIT = 200;
/** A wheel notch is about 100, and it should zoom by about a fifth. */
const WHEEL_ZOOM = 0.002;
/** Some mice report lines instead of pixels. */
const WHEEL_LINE = 16;

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

interface ToolButtonProps {
  readonly name: string;
  readonly usage: string;
  /** The action whose key to show. People can change it, so it is looked up. */
  readonly action?: TimelineAction;
  readonly icon: ComponentType<{ size?: number }>;
  /** Written next to the icon, where there is room. */
  readonly text?: string;
  readonly pressed?: boolean;
  readonly unavailable?: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

function ToolButton(props: ToolButtonProps) {
  const { name, usage, action, icon: Icon, text, pressed, unavailable, onClick } = props;
  const { keybindings } = useWorkbench();
  const combo = action && keybindings.keysFor(`timeline.${action}`)[0];
  return (
    <Tip
      name={name}
      usage={usage}
      shortcut={combo ? formatCombo(combo, keybindings.platform) : undefined}
    >
      <button
        type="button"
        className={styles.button}
        aria-label={name}
        aria-description={usage}
        // Not `disabled`: a disabled button gets no mouse events, and it still has to explain itself.
        {...(unavailable ? { "aria-disabled": true } : {})}
        {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
        onClick={(event) => {
          if (!unavailable) onClick(event);
        }}
      >
        <Icon size={15} />
        {text && <span className={styles.buttonLabel}>{text}</span>}
      </button>
    </Tip>
  );
}

function Toolbar({ editor }: { editor: TimelineEditor }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { tool, snapping, overwriting, model } = useSyncExternalStore(
    editor.subscribe,
    editor.getSnapshot,
  );
  const frame = useEditorView(editor, () => editor.frame);
  const zoom = useEditorView(editor, () => editor.zoomLevel);
  const canSplit = useEditorView(editor, () => editor.canSplit);

  return (
    <div className={styles.toolbarArea}>
      <div className={styles.toolbar} role="toolbar" aria-label={t("timeline.toolbar")}>
        <output className={styles.timecode} aria-label={t("timeline.playhead")} aria-live="off">
          {model && formatTimecode(frame, model.rate)}
        </output>
        <Tip name={t("project.frameRate")} usage={t("timeline.help.frameRate")}>
          <button
            type="button"
            className={styles.button}
            aria-label={t("project.frameRate")}
            onClick={() => void workbench.setFrameRate()}
          >
            {model && t("timeline.fps", { fps: Number(model.rate.fps.toFixed(3)) })}
          </button>
        </Tip>
        <div className={styles.divider} />
        <ToolButton
          name={t("timeline.action.toolSelect")}
          usage={t("timeline.help.toolSelect")}
          action="toolSelect"
          icon={MousePointer2}
          pressed={tool === "select"}
          onClick={() => editor.setTool("select")}
        />
        <ToolButton
          name={t("timeline.action.toolRazor")}
          usage={t("timeline.help.toolRazor")}
          action="toolRazor"
          icon={Scissors}
          pressed={tool === "razor"}
          onClick={() => editor.setTool("razor")}
        />
        <ToolButton
          name={t("timeline.splitButton")}
          usage={t("timeline.help.split")}
          action="split"
          icon={SquareSplitHorizontal}
          unavailable={!canSplit}
          onClick={() => editor.splitAtPlayhead()}
        />
        <div className={styles.divider} />
        <ToolButton
          name={t("timeline.snapping")}
          usage={t("timeline.help.snapping")}
          action="toggleSnapping"
          icon={Magnet}
          pressed={snapping}
          onClick={() => editor.toggleSnapping()}
        />
        <ToolButton
          name={t("timeline.overwriting")}
          usage={t("timeline.help.overwriting")}
          action="toggleOverwriting"
          icon={Replace}
          pressed={overwriting}
          onClick={() => editor.toggleOverwriting()}
        />
        <div className={styles.divider} />
        <ToolButton
          name={t("timeline.color")}
          usage={t("timeline.help.addColor")}
          icon={Plus}
          text={t("timeline.color")}
          onClick={() => editor.addColorClip()}
        />
        <div className={styles.spacer} />
        <ToolButton
          name={t("timeline.action.zoomOut")}
          usage={t("timeline.help.zoomOut")}
          action="zoomOut"
          icon={ZoomOut}
          onClick={() => editor.zoomOut()}
        />
        <Tip name={t("timeline.zoom")} usage={t("timeline.help.zoom")}>
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
        </Tip>
        <ToolButton
          name={t("timeline.action.zoomIn")}
          usage={t("timeline.help.zoomIn")}
          action="zoomIn"
          icon={ZoomIn}
          onClick={() => editor.zoomIn()}
        />
        <ToolButton
          name={t("timeline.action.zoomToFit")}
          usage={t("timeline.help.zoomToFit")}
          action="zoomToFit"
          icon={FoldHorizontal}
          onClick={() => editor.zoomToFit()}
        />
      </div>
    </div>
  );
}

function TrackName({ name, onDone }: { name: string; onDone: (next: string | undefined) => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => input.current?.select(), []);

  return (
    <input
      ref={input}
      className={styles.headerInput}
      aria-label={t("timeline.trackName")}
      defaultValue={name}
      spellCheck={false}
      autoFocus
      onBlur={(event) => onDone(event.target.value.trim() || undefined)}
      onKeyDown={(event) => {
        // During composition Enter belongs to the input method.
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          // Only this box should react, not the panel around it.
          event.stopPropagation();
          onDone(undefined);
        }
      }}
    />
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
  const { t } = useTranslation();
  const nameOf = useTrackName();
  const [renaming, setRenaming] = useState(false);
  const name = nameOf(row);
  const { track } = row;
  const sound = track.kind === "audio";
  const off = sound ? track.muted === true : track.hidden === true;
  const toggle = sound ? { muted: !off } : { hidden: !off };
  const offLabel = sound ? "timeline.mute" : "timeline.hide";
  const offUsage = sound ? "timeline.help.mute" : "timeline.help.hide";
  const OnIcon = sound ? Volume2 : Eye;
  const OffIcon = off ? (sound ? VolumeX : EyeOff) : OnIcon;

  const finishRenaming = (next: string | undefined) => {
    setRenaming(false);
    if (next !== undefined && next !== name) editor.updateTrack(row.id, { name: next });
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
              { id: "rename", label: t("timeline.renameTrack"), run: () => setRenaming(true) },
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
      {renaming ? (
        <TrackName name={name} onDone={finishRenaming} />
      ) : (
        <span
          className={styles.headerName}
          title={name}
          onDoubleClick={row.gone ? undefined : () => setRenaming(true)}
        >
          {name}
        </span>
      )}
      {!row.gone && (
        <>
          <Tip name={t("timeline.lock", { track: name })} usage={t("timeline.help.lock")}>
            <button
              type="button"
              className={styles.headerButton}
              aria-pressed={track.locked === true}
              aria-label={t("timeline.lock", { track: name })}
              onClick={() => editor.updateTrack(row.id, { locked: track.locked !== true })}
            >
              {track.locked ? <Lock size={14} /> : <LockOpen size={14} />}
            </button>
          </Tip>
          <Tip name={t(offLabel, { track: name })} usage={t(offUsage)}>
            <button
              type="button"
              className={styles.headerButton}
              aria-pressed={off}
              aria-label={t(offLabel, { track: name })}
              onClick={() => editor.updateTrack(row.id, toggle)}
            >
              <OffIcon size={14} />
            </button>
          </Tip>
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
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const follow = () => {
      if (list.current) list.current.style.transform = `translateY(${-editor.scrollY}px)`;
    };
    follow();
    return editor.subscribeView(follow);
  }, [editor]);

  const trackItems: readonly MenuItem[] = (["video", "audio", "caption"] as const).map((kind) => ({
    id: kind,
    label: t(`timeline.newTrack.${kind}`),
    run: () => editor.addTrack(kind),
  }));

  return (
    <div className={styles.headers}>
      <div className={styles.corner} style={{ height: RULER_HEIGHT }}>
        <ToolButton
          name={t("timeline.addTrack")}
          usage={t("timeline.help.addTrack")}
          icon={Plus}
          text={t("timeline.addTrack")}
          onClick={(event) => {
            const { left, bottom } = event.currentTarget.getBoundingClientRect();
            showMenu({
              x: left,
              y: bottom + 4,
              label: t("timeline.addTrack"),
              groups: [trackItems],
            });
          }}
        />
      </div>
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
    const stageElement = stage.current;
    // The wheel works over the track headers too.
    const bodyElement = stageElement?.closest(`.${styles.body as string}`);
    const canvasElement = canvas.current;
    const playheadElement = playhead.current;
    if (!bodyElement || !stageElement || !canvasElement || !playheadElement) return;

    const painter = new TimelinePainter(canvasElement, editor, (box) => labels.current(box));

    const show = () => {
      const { model: current } = editor;
      if (current) {
        const x = editor.xAt(editor.frame / current.rate.fps);
        const seen = x >= -1 && x <= editor.width;
        playheadElement.style.visibility = seen ? "visible" : "hidden";
        playheadElement.style.transform = `translateX(${Math.round(x)}px)`;
        playheadElement.classList.toggle(styles.snapped as string, editor.isSnappedToPlayhead);
        playheadElement.setAttribute("aria-valuenow", String(editor.frame));
        playheadElement.setAttribute("aria-valuetext", formatTimecode(editor.frame, current.rate));
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

    /** A mouse wheel and a trackpad both come through here. A pinch arrives with Ctrl held. */
    const onWheel = (event: Event) => {
      if (!(event instanceof WheelEvent)) return;
      event.preventDefault();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE : 1;
      // With Shift held, browsers on Windows report the wheel as going sideways.
      const amount = (event.deltaY || event.deltaX) * scale;
      const box = stageElement.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey || event.altKey) {
        const factor = Math.exp(-amount * WHEEL_ZOOM);
        if (event.shiftKey) editor.zoomRowsAround(event.clientY - box.top, factor);
        else editor.zoomAround(event.clientX - box.left, factor);
      } else if (event.shiftKey) {
        editor.setScroll(editor.scrollX, editor.scrollY + amount);
      } else {
        editor.setScroll(editor.scrollX + (event.deltaX + event.deltaY) * scale, editor.scrollY);
      }
    };

    const stopView = editor.subscribeView(show);
    const observer = new ResizeObserver(measure);
    observer.observe(stageElement);
    measure();
    bodyElement.addEventListener("wheel", onWheel, { passive: false });

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
      bodyElement.removeEventListener("wheel", onWheel);
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
    else if (editor.isDragging) {
      editor.drag(pointer);
      currentTarget.style.cursor = editor.preview?.copying ? "copy" : "";
    } else currentTarget.style.cursor = editor.hover(pointer);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 0) editor.release(pointerOf(event, event.currentTarget));
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const hit = editor.hitAt(pointerOf(event, event.currentTarget));
    const { clientX: x, clientY: y } = event;
    if (hit.kind === "clip" && !hit.row.track.locked) {
      if (!editor.getSnapshot().selection.has(hit.box.id)) editor.selectOnly(hit.box.id);
      const item = (id: TimelineAction, run: () => void, disabled = false) => ({
        id,
        label: t(`timeline.action.${id}`),
        run,
        disabled,
      });
      showMenu({
        x,
        y,
        label: t("timeline.clips"),
        groups: [
          [
            item("copy", () => editor.copySelection()),
            item("cut", () => editor.cutSelection()),
            item("paste", () => editor.paste(), !editor.hasClipboard),
          ],
          [
            item("split", () => editor.splitAtPlayhead(), !editor.canSplit),
            item("delete", () => editor.deleteSelection()),
          ],
        ],
      });
    } else if (hit.kind === "lane" && !hit.row.track.locked && !hit.row.gone) {
      const color =
        hit.row.track.kind === "video"
          ? [
              {
                id: "add",
                label: t("timeline.color"),
                run: () => editor.addColorClip({ row: hit.row, seconds: hit.seconds }),
              },
            ]
          : [];
      showMenu({
        x,
        y,
        label: t("timeline.clips"),
        groups: [
          [
            ...color,
            {
              id: "paste",
              label: t("timeline.action.paste"),
              run: () => editor.paste(),
              disabled: !editor.hasClipboard,
            },
          ],
        ],
      });
    }
  };

  const lanes = () => editor.height - RULER_HEIGHT;

  return (
    <div className={styles.surface}>
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
      <div className={styles.barRight} style={{ paddingTop: RULER_HEIGHT }}>
        <ZoomBar
          axis="y"
          label={t("timeline.scrollY")}
          handleLabel={t("timeline.handleY")}
          handleUsage={t("timeline.help.zoomHandleY")}
          subscribe={editor.subscribeView}
          read={() => ({
            content: editor.contentHeight - RULER_HEIGHT,
            view: lanes(),
            offset: editor.scrollY,
          })}
          scrollTo={(offset) => editor.setScroll(editor.scrollX, offset)}
          beginZoom={(edge) => {
            const start = editor.rowScale;
            const y = edge === "start" ? editor.height : RULER_HEIGHT;
            return (ratio) => editor.zoomRowsAround(y, start / ratio / editor.rowScale);
          }}
        />
      </div>
      <ZoomBar
        axis="x"
        label={t("timeline.scrollX")}
        handleLabel={t("timeline.handleX")}
        handleUsage={t("timeline.help.zoomHandleX")}
        subscribe={editor.subscribeView}
        read={() => ({
          content: editor.contentWidth,
          view: editor.width,
          offset: editor.scrollX,
        })}
        scrollTo={(offset) => editor.setScroll(offset, editor.scrollY)}
        beginZoom={(edge) => {
          const start = editor.pixelsPerSecond;
          const x = edge === "start" ? editor.width : 0;
          return (ratio) => editor.zoomAround(x, start / ratio / editor.pixelsPerSecond);
        }}
      />
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
      <Toolbar editor={editor} />
      <div className={styles.body}>
        <TrackHeaders editor={editor} model={model} showMenu={setPopup} />
        <Surface editor={editor} model={model} showMenu={setPopup} />
      </div>
      {popup && <PopupMenu {...popup} onClose={() => setPopup(undefined)} />}
    </div>
  );
}
