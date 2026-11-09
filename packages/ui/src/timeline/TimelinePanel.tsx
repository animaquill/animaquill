import {
  Eye,
  EyeOff,
  FoldHorizontal,
  ListChecks,
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
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { JOIN_ALIGNS, mediaOfTrack } from "@animaquill/schema";
import { useTranslation } from "react-i18next";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { KeyList } from "../keyframes/KeyList.tsx";
import { useKeyPopups } from "../keyframes/KeyPopups.tsx";
import { LaneRows } from "../keyframes/LaneRows.tsx";
import { LanePainter, paintMarquee, paintSnapLine } from "../keyframes/paint.ts";
import { ASSET_DRAG_TYPE, SCENE_DRAG_TYPE, SOUND_DRAG_TYPE } from "../panels/AssetsPanel.tsx";
import type zhCN from "../i18n/zh-CN.json";
import type { TimelineAction } from "./actions.ts";
import { RULER_HEIGHT, type TimelineEditor, type VisibleClip } from "./editor.ts";
import { formatTimecode } from "./frames.ts";
import type { Pointer } from "./gestures.ts";
import type { ClipBox, Row, TimelineModel } from "./model.ts";
import { TimelinePainter } from "./paint.ts";
import { TRANSITION_DRAG_TYPE, transitionDrag } from "./transition-drag.ts";
import { transitionName } from "./transition-names.ts";
import { pointerOf, useStage } from "./stage.ts";
import { ToolButton } from "./ToolButton.tsx";
import styles from "./TimelinePanel.module.css";
import { ZoomBar } from "./ZoomBar.tsx";

/** The list for screen readers follows the view a moment later, not with every frame of a drag. */
const CLIP_LIST_DELAY_MS = 80;
const CLIP_LIST_LIMIT = 200;
/** How far a track header has to move before it counts as dragged. */
const TRACK_DRAG_REACH = 5;
const TRACK_LONG_PRESS_MS = 400;

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
  const { sounds } = useWorkbench();
  // What a sound is up to shows on its clip, and that comes from elsewhere than the timeline.
  useSyncExternalStore(sounds.subscribe, sounds.getVersion);
  return ({ clip }: ClipBox) => {
    const { kind } = clip.source;
    const name = clip.name ?? t(`timeline.kind.${kind as ClipKind}`, { defaultValue: kind });
    const sound = sounds.stateOf(clip);
    return !sound || sound.state === "ready"
      ? name
      : t("sound.clip", { name, state: t(`sound.state.${sound.state}`) });
  };
}

function useTrackName() {
  const { t } = useTranslation();
  return ({ track, number, gone }: Row) =>
    gone ? t("timeline.goneTrack") : (track.name ?? t(`timeline.track.${track.kind}`, { number }));
}

function Toolbar({ editor }: { editor: TimelineEditor }) {
  const { t } = useTranslation();
  const { tool, snapping, overwriting, multiSelecting, headerWidth } = useSyncExternalStore(
    editor.subscribe,
    editor.getSnapshot,
  );
  const zoom = useEditorView(editor, () => editor.zoomLevel);
  const canSplit = useEditorView(editor, () => editor.canSplit);

  return (
    <div className={styles.toolbarArea}>
      <div className={styles.toolbar} role="toolbar" aria-label={t("timeline.toolbar")}>
        {/* The tools start where the timeline starts. */}
        <span className={styles.axes} style={{ width: headerWidth }}>
          {t("timeline.axes")}
        </span>
        <div className={styles.middle}>
          <div className={styles.zone} role="group" aria-label={t("timeline.zone.tools")}>
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
          </div>
          <div className={styles.zone} role="group" aria-label={t("timeline.zone.switches")}>
            <ToolButton
              name={t("timeline.snapping")}
              usage={t("timeline.help.snapping")}
              action="toggleSnapping"
              icon={Magnet}
              pressed={snapping}
              isSwitch
              onClick={() => editor.toggleSnapping()}
            />
            <ToolButton
              name={t("timeline.overwriting")}
              usage={t("timeline.help.overwriting")}
              action="toggleOverwriting"
              icon={Replace}
              pressed={overwriting}
              isSwitch
              onClick={() => editor.toggleOverwriting()}
            />
            <ToolButton
              name={t("timeline.multiSelecting")}
              usage={t("timeline.help.multiSelecting")}
              action="toggleMultiSelecting"
              icon={ListChecks}
              pressed={multiSelecting}
              isSwitch
              onClick={() => editor.toggleMultiSelecting()}
            />
          </div>
          <div className={styles.zone} role="group" aria-label={t("timeline.zone.actions")}>
            <ToolButton
              name={t("timeline.splitButton")}
              usage={t("timeline.help.split")}
              action="split"
              icon={SquareSplitHorizontal}
              unavailable={!canSplit}
              onClick={() => editor.splitAtPlayhead()}
            />
            <ToolButton
              name={t("timeline.color")}
              usage={t("timeline.help.addColor")}
              icon={Plus}
              text={t("timeline.color")}
              onClick={() => editor.addColorClip()}
            />
            <ToolButton
              name={t("timeline.action.addScene")}
              usage={t("timeline.help.addScene")}
              icon={Plus}
              text={t("timeline.scene")}
              onClick={() => editor.createScene()}
            />
          </div>
        </div>
        <div className={styles.zoneEnd} role="group" aria-label={t("timeline.zone.zoom")}>
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

interface Reorder {
  readonly from: number;
  lastY: number;
  readonly listTop: number;
  active: boolean;
  readonly touch: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function TrackHeader({
  editor,
  row,
  showMenu,
  onReorder,
}: {
  editor: TimelineEditor;
  row: Row;
  showMenu: ShowMenu;
  onReorder: (line: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const nameOf = useTrackName();
  const reorder = useRef<Reorder | undefined>(undefined);
  const { input } = useWorkbench();
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

  const laneOf = (event: PointerEvent<HTMLDivElement>) =>
    event.clientY - reorder.current!.listTop + editor.scrollY;

  /**
   * The mouse drags a track right away. A finger scrolls through the tracks, as it does everywhere
   * else, and picks one up with a long press.
   */
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.button !== 0 || row.gone || renaming || target.closest("button")) return;
    const element = event.currentTarget;
    const list = element.parentElement?.parentElement?.getBoundingClientRect();
    const touch = input.isTouch(event.pointerType);
    const state: Reorder = {
      from: event.clientY,
      lastY: event.clientY,
      listTop: list?.top ?? 0,
      active: false,
      touch,
      timer: undefined,
    };
    reorder.current = state;
    if (touch) {
      state.timer = setTimeout(() => {
        state.active = true;
        onReorder(editor.trackDrop(row.id, state.lastY - state.listTop + editor.scrollY).line);
      }, TRACK_LONG_PRESS_MS);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = reorder.current;
    if (!state) return;
    const moved = Math.abs(event.clientY - state.from);
    if (!state.active && state.touch) {
      if (moved >= TRACK_DRAG_REACH) clearTimeout(state.timer);
      if (moved >= TRACK_DRAG_REACH || state.timer === undefined) {
        editor.setScroll(editor.scrollX, editor.scrollY - (event.clientY - state.lastY));
      }
    } else if (!state.active && moved >= TRACK_DRAG_REACH) {
      // Only now: from here on all events go to the header, also the double click on its name.
      event.currentTarget.setPointerCapture(event.pointerId);
      state.active = true;
    }
    state.lastY = event.clientY;
    if (state.active) onReorder(editor.trackDrop(row.id, laneOf(event)).line);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = reorder.current;
    if (!state) return;
    clearTimeout(state.timer);
    if (state.active) editor.moveTrack(row.id, editor.trackDrop(row.id, laneOf(event)).index);
    reorder.current = undefined;
    onReorder(undefined);
  };

  const stopReordering = () => {
    clearTimeout(reorder.current?.timer);
    reorder.current = undefined;
    onReorder(undefined);
  };

  const finishRenaming = (next: string | undefined) => {
    setRenaming(false);
    if (next !== undefined && next !== name) editor.updateTrack(row.id, { name: next });
  };

  return (
    <div
      className={styles.header}
      style={{ height: row.height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={stopReordering}
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
                id: "up",
                label: t("timeline.moveTrackUp"),
                run: () => editor.shiftTrack(row.id, -1),
              },
              {
                id: "down",
                label: t("timeline.moveTrackDown"),
                run: () => editor.shiftTrack(row.id, 1),
              },
              {
                id: "remove",
                label: t("timeline.removeTrack"),
                disabled: track.locked === true,
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
  const { keyframes } = useWorkbench();
  const { headerWidth } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const list = useRef<HTMLDivElement>(null);
  const [dropLine, setDropLine] = useState<number>();
  const resizing = useRef<{ from: number; width: number } | undefined>(undefined);

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
    <div className={styles.headers} style={{ width: headerWidth }}>
      <div
        className={styles.headerDivider}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("timeline.resizeHeaders")}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          resizing.current = { from: event.clientX, width: headerWidth };
        }}
        onPointerMove={(event) => {
          const start = resizing.current;
          if (start) editor.setHeaderWidth(start.width + event.clientX - start.from);
        }}
        onPointerUp={() => {
          resizing.current = undefined;
          editor.saveHeaderWidth();
        }}
        onPointerCancel={() => {
          resizing.current = undefined;
        }}
      />
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
      <div
        className={styles.headerList}
        // Focus scrolls a list that only moves by its transform: the view goes there instead.
        onScroll={(event) => {
          const by = event.currentTarget.scrollTop;
          if (by === 0) return;
          event.currentTarget.scrollTop = 0;
          editor.setScroll(editor.scrollX, editor.scrollY + by);
        }}
      >
        <div ref={list}>
          {model.rows.map((row) => (
            <Fragment key={row.id}>
              <TrackHeader editor={editor} row={row} showMenu={showMenu} onReorder={setDropLine} />
              {row.below > 0 && <div style={{ height: row.below }} />}
            </Fragment>
          ))}
          <LaneRows area={keyframes.inTimeline} />
          {dropLine !== undefined && <div className={styles.dropLine} style={{ top: dropLine }} />}
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
  const workbench = useWorkbench();
  const { input, media, keyframes, sounds } = workbench;
  const labelOf = useClipLabel();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const labels = useRef(labelOf);
  const lanes = keyframes.inTimeline;
  const popups = useKeyPopups(lanes);

  useLayoutEffect(() => {
    labels.current = labelOf;
  });

  const events = useStage(
    editor,
    { stage, canvas, playhead },
    {
      paint: (element) => {
        const painter = new LanePainter(lanes, keyframes.labelOfValue);
        return new TimelinePainter(
          element,
          editor,
          (box) => labels.current(box),
          (clip) => media.peaksOf(clip),
          (clip) => media.stripOfClip(clip),
          (clip) => sounds.stateOf(clip)?.state === "failed",
          (transition, use, row) =>
            transitionName(t, transition, use, mediaOfTrack(row.track.kind)),
          (context, theme, sharp) => {
            painter.paint(context, theme, sharp);
            paintMarquee(context, lanes, theme);
            paintSnapLine(context, lanes, theme, sharp);
          },
        );
      },
      repaintOn: (listener) => {
        const stopMedia = media.subscribe(listener);
        const stopSounds = sounds.subscribe(listener);
        return () => {
          stopMedia();
          stopSounds();
        };
      },
      // The wheel works over the track headers too.
      wheelArea: (element) => element.closest(`.${styles.body as string}`),
      openMenu: (pointer) => {
        if (stage.current) openMenu(pointer, stage.current.getBoundingClientRect());
      },
    },
  );

  /** A transition from its tab, which shows where it would go, and goes only where it can. */
  const onTransitionDrag = (event: DragEvent<HTMLDivElement>) => {
    const pick = transitionDrag.current();
    const pointer = pointerOf(event, event.currentTarget);
    if (pick && editor.showTransitionDrop(pointer, pick)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    } else {
      event.dataTransfer.dropEffect = "none";
    }
  };

  const carriesMedia = (event: DragEvent) =>
    event.dataTransfer.types.includes(ASSET_DRAG_TYPE) ||
    event.dataTransfer.types.includes(SCENE_DRAG_TYPE) ||
    event.dataTransfer.types.includes(SOUND_DRAG_TYPE) ||
    event.dataTransfer.types.includes("Files");

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes(TRANSITION_DRAG_TYPE)) {
      onTransitionDrag(event);
      return;
    }
    if (!carriesMedia(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    editor.showDrop(pointerOf(event, event.currentTarget));
  };

  /** Files from the computer come in first. Several go one after the other. */
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const pick = transitionDrag.current();
    if (pick && event.dataTransfer.types.includes(TRANSITION_DRAG_TYPE)) {
      event.preventDefault();
      editor.dropTransition(pointerOf(event, event.currentTarget), pick);
      stage.current?.focus({ preventScroll: true });
      return;
    }
    if (!carriesMedia(event)) return;
    event.preventDefault();
    const pointer = pointerOf(event, event.currentTarget);
    const place = { lane: editor.laneAt(pointer.y), seconds: editor.timeAt(pointer.x) };
    editor.showDrop(undefined);
    const dragged = event.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (dragged) {
      editor.addAsset(dragged, place);
      return;
    }
    const scene = event.dataTransfer.getData(SCENE_DRAG_TYPE);
    if (scene) {
      editor.addScene(scene, place);
      return;
    }
    const sound = event.dataTransfer.getData(SOUND_DRAG_TYPE);
    if (sound) {
      editor.addSound(sound, place);
      return;
    }
    void workbench.importDropped(event.dataTransfer).then((ids) => {
      for (const id of ids) editor.addAsset(id, place);
    });
  };

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    // A finger gets its menu from a long press, which TouchController decides on.
    if (input.isTouch((event.nativeEvent as globalThis.PointerEvent).pointerType ?? "")) return;
    const box = event.currentTarget.getBoundingClientRect();
    openMenu(pointerOf(event, event.currentTarget), box);
  };

  const openMenu = (pointer: Pointer, box: DOMRect) => {
    if (popups.open(pointer, box)) return;
    const hit = editor.hitAt(pointer);
    const x = pointer.x + box.left;
    const y = pointer.y + box.top;
    if (hit.kind === "join") {
      const { join, row } = hit;
      editor.selectJoin(join.id);
      if (row.track.locked) return;
      const current = join.join.transition;
      const align = current.align ?? "center";
      // Where it is around the cut, and taking it away. Another one takes its place from the
      // transitions tab, see docs/design/resource-panels.md, section 3.
      showMenu({
        x,
        y,
        label: t("transition.uses.join"),
        groups: [
          JOIN_ALIGNS.map((place) => ({
            id: `align-${place}`,
            label: t(`transition.align.${place}`),
            selected: align === place,
            run: () => editor.updateJoin(join.id, { align: place }),
          })),
          [
            {
              id: "deleteJoin",
              label: t("transition.delete"),
              run: () => editor.removeJoin(join.id),
            },
          ],
        ],
      });
    } else if (hit.kind === "clip" && hit.transition && !hit.row.track.locked) {
      const { transition } = hit;
      editor.selectTransition(hit.box.id, transition);
      showMenu({
        x,
        y,
        label: t(`transition.uses.${transition}`),
        groups: [
          [
            {
              id: "deleteTransition",
              label: t("transition.delete"),
              run: () => editor.setTransition(hit.box.id, transition, null),
            },
          ],
        ],
      });
    } else if (hit.kind === "clip" && !hit.row.track.locked) {
      if (!editor.getSnapshot().selection.has(hit.box.id)) editor.selectOnly(hit.box.id);
      const item = (id: TimelineAction, run: () => void, disabled = false) => ({
        id,
        label: t(`timeline.action.${id}`),
        run,
        disabled,
      });
      const { extras } = editor;
      const properties =
        extras?.canOpen(hit.box) === true
          ? [
              {
                id: "properties",
                label: t(
                  extras.isOpen(hit.box) ? "timeline.closeProperties" : "timeline.openProperties",
                ),
                run: () => extras.toggle(hit.box),
              },
            ]
          : [];
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
          ...(properties.length > 0 ? [properties] : []),
          [
            item("split", () => editor.splitAtPlayhead(), !editor.canSplit),
            item("delete", () => editor.deleteSelection()),
          ],
          ...(sounds.stateOf(hit.box.clip)?.state === "failed"
            ? [[{ id: "retry", label: t("sound.retry"), run: () => sounds.retry(hit.box.clip) }]]
            : []),
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
              {
                id: "addScene",
                label: t("timeline.scene"),
                run: () => editor.createScene({ lane: hit.row.top + 1, seconds: hit.seconds }),
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

  const lanesHeight = () => editor.height - RULER_HEIGHT;

  return (
    <div className={styles.surface}>
      <div
        ref={stage}
        className={styles.stage}
        tabIndex={0}
        role="group"
        aria-label={t("panel.timeline.title")}
        {...events}
        onDoubleClick={(event) => popups.doubleClick(pointerOf(event, event.currentTarget))}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDragLeave={() => {
          editor.showDrop(undefined);
          editor.showTransitionDrop(undefined);
        }}
        onDrop={onDrop}
      >
        <canvas ref={canvas} className={styles.canvas} />
        <ClipList editor={editor} />
        <KeyList area={lanes} />
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
            view: lanesHeight(),
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
      {popups.element}
    </div>
  );
}

export function TimelinePanel() {
  const { timeline: editor, keyframes } = useWorkbench();
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const [popup, setPopup] = useState<PopupState>();

  if (!model) return <div className={styles.missing}>{t("timeline.missing")}</div>;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A menu opened from here is part of this panel for React, but it has its own Escape.
    if (event.key !== "Escape" || !event.currentTarget.contains(event.target as Node)) return;
    if (editor.cancelDrag() || editor.cancelCut()) return;
    if (keyframes.selection.size > 0) keyframes.clearSelection();
    else editor.clearSelection();
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
