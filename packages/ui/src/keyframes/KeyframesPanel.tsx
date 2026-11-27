import type { ListRange } from "@animaquill/core";
import {
  ChevronDown,
  ChevronRight,
  Magnet,
  Spline,
  ZoomIn,
  ZoomOut,
  FoldHorizontal,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { RULER_HEIGHT } from "../timeline/editor.ts";
import { pointerOf, useStage } from "../timeline/stage.ts";
import timelineStyles from "../timeline/TimelinePanel.module.css";
import { ToolButton } from "../timeline/ToolButton.tsx";
import { FollowControl } from "../timeline/FollowControl.tsx";
import { WheelInterpreter, wheelInputOf } from "../timeline/wheel.ts";
import { ZoomBar } from "../timeline/ZoomBar.tsx";
import { KeyList } from "./KeyList.tsx";
import { InterpBubble, useKeyPopups } from "./KeyPopups.tsx";
import { LaneRows } from "./LaneRows.tsx";
import { RecordButton, RecordingFrame } from "./RecordButton.tsx";
import { KeyframesPainter } from "./paint.ts";
import styles from "./KeyframesPanel.module.css";
import rowStyles from "./LaneRows.module.css";
import type { KeyframesView } from "./view.ts";

const RANGES: readonly ListRange[] = ["here", "all", "keyed"];

function Toolbar({ view }: { view: KeyframesView }) {
  const { keyframes } = view;
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const { selection, listWidth, query } = useSyncExternalStore(
    keyframes.subscribe,
    keyframes.getSnapshot,
  );
  const { snapping } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const [anchor, setAnchor] = useState<DOMRect>();
  const hasKeys = selection.size > 0;
  const canEase = hasKeys && keyframes.canEase;
  const interpUsage = !hasKeys
    ? t("keyframes.interpNeedsKeys")
    : canEase
      ? t("keyframes.interpHelp")
      : t("keyframes.interpNeedsNumbers");

  return (
    <div className={timelineStyles.toolbarArea}>
      <div className={styles.toolbar} role="toolbar" aria-label={t("keyframes.toolbar")}>
        {/* Over the list it searches, as wide as it is: the tools start where the time does. */}
        <div className={styles.searchArea} style={{ width: listWidth }}>
          <RecordButton />
          <input
            className={styles.search}
            type="search"
            placeholder={t("keyframes.search")}
            aria-label={t("keyframes.search")}
            spellCheck={false}
            value={query}
            onChange={(event) => keyframes.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                keyframes.setQuery("");
              }
            }}
          />
        </div>
        <div className={`${timelineStyles.zone} ${styles.firstZone}`}>
          <ToolButton
            name={t("timeline.snapping")}
            usage={t("timeline.help.snapping")}
            action="toggleSnapping"
            icon={Magnet}
            pressed={snapping}
            isSwitch
            onClick={() => timeline.toggleSnapping()}
          />
        </div>
        <div className={timelineStyles.zone}>
          <ToolButton
            name={t("keyframes.interp")}
            usage={interpUsage}
            icon={Spline}
            text={t("keyframes.interp")}
            unavailable={!canEase}
            onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
          />
        </div>
        <div className={timelineStyles.spacer} />
        <div className={timelineStyles.zoneEnd} role="group" aria-label={t("timeline.zone.zoom")}>
          <FollowControl timeline={timeline} />
          <ToolButton
            name={t("timeline.action.zoomOut")}
            usage={t("timeline.help.zoomOut")}
            icon={ZoomOut}
            onClick={() => view.zoomOut()}
          />
          <ToolButton
            name={t("timeline.action.zoomIn")}
            usage={t("timeline.help.zoomIn")}
            icon={ZoomIn}
            onClick={() => view.zoomIn()}
          />
          <ToolButton
            name={t("timeline.action.zoomToFit")}
            usage={t("timeline.help.zoomToFit")}
            icon={FoldHorizontal}
            onClick={() => view.zoomToFit()}
          />
        </div>
      </div>
      {anchor && (
        <InterpBubble keyframes={keyframes} anchor={anchor} onClose={() => setAnchor(undefined)} />
      )}
    </div>
  );
}

function Corner({ view }: { view: KeyframesView }) {
  const { keyframes } = view;
  const { t } = useTranslation();
  const { range } = useSyncExternalStore(keyframes.subscribe, keyframes.getSnapshot);

  // Next to the ruler, above the list that they choose what goes in.
  return (
    <div className={styles.corner} style={{ height: RULER_HEIGHT }}>
      <div className={styles.ranges} role="radiogroup" aria-label={t("keyframes.rangeLabel")}>
        {RANGES.map((id) => (
          <Tip key={id} name={t(`keyframes.range.${id}`)} usage={t(`keyframes.rangeHelp.${id}`)}>
            <button
              type="button"
              role="radio"
              className={styles.range}
              aria-checked={range === id}
              onClick={() => keyframes.setRange(id)}
            >
              {t(`keyframes.range.${id}`)}
            </button>
          </Tip>
        ))}
      </div>
    </div>
  );
}

/** What the row of sound shows, as far as its header goes. */
function soundHeaderOf(view: KeyframesView): string {
  const { sound } = view;
  if (!sound) return "";
  return JSON.stringify([view.soundHeight, view.soundFolded, sound.track, sound.tracks]);
}

/**
 * The header of the row of sound: it folds, and its menu picks what it shows. It stays under the
 * ruler, as the row does, while the rows of keys scroll.
 */
function SoundHeader({ view }: { view: KeyframesView }) {
  const { keyframes } = view;
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  useSyncExternalStore(keyframes.subscribeView, () => soundHeaderOf(view));
  const { sound } = view;
  if (!sound) return null;
  const folded = view.soundFolded;
  const picked = sound.tracks.find(({ track }) => track.id === sound.track);
  const nameOf = ({ track, number }: (typeof sound.tracks)[number]) =>
    track.name ?? t("timeline.track.audio", { number });
  const name = picked
    ? t("keyframes.sound.track", { name: nameOf(picked) })
    : t("keyframes.sound.title");
  const toggle = () => view.foldSound(!folded);
  return (
    <div
      className={`${rowStyles.lane} ${styles.sound}`}
      data-kind="track"
      data-testid="keyframes-sound"
      style={{ height: view.soundHeight }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className={rowStyles.line} style={{ height: view.soundHeight - 1 }}>
        <button
          type="button"
          className={rowStyles.chevron}
          aria-label={t(folded ? "keyframes.open" : "keyframes.close", { name })}
          aria-expanded={!folded}
          onClick={toggle}
        >
          {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
        <span className={rowStyles.title}>
          <button type="button" className={rowStyles.name} title={name} onClick={toggle}>
            {name}
          </button>
        </span>
      </div>
      {menu && (
        <PopupMenu
          label={t("keyframes.sound.title")}
          x={menu.x}
          y={menu.y}
          groups={[
            [
              {
                id: "all",
                label: t("keyframes.sound.all"),
                selected: sound.track === undefined,
                run: () => view.pickSoundTrack(undefined),
              },
            ],
            sound.tracks.map((row) => ({
              id: `track-${row.track.id}`,
              label: nameOf(row),
              selected: sound.track === row.track.id,
              run: () => view.pickSoundTrack(row.track.id),
            })),
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

function List({ view }: { view: KeyframesView }) {
  const { keyframes } = view;
  const { input } = useWorkbench();
  const { t } = useTranslation();
  const { listWidth } = useSyncExternalStore(keyframes.subscribe, keyframes.getSnapshot);
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const resizing = useRef<{ from: number; width: number } | undefined>(undefined);
  const finger = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    const follow = () => {
      if (rows.current) rows.current.style.transform = `translateY(${-view.scrollY}px)`;
    };
    follow();
    return keyframes.subscribeView(follow);
  }, [keyframes, view]);

  // The rows are the headers of the keys, and the wheel does what it does over the headers of the
  // tracks: see `WheelInterpreter`. Not passive: Ctrl would zoom the page.
  useLayoutEffect(() => {
    const element = list.current;
    const wheel = new WheelInterpreter();
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const action = wheel.read(wheelInputOf(event), input.wheelDevice, "headers");
      if (wheel.device) input.notice(wheel.device);
      if (action.kind === "scroll") {
        view.setScroll(view.scrollX + action.dx, view.scrollY + action.dy, wheel.movementStart);
      } else {
        const box = element?.getBoundingClientRect();
        view.zoomRowsAround(event.clientY - (box?.top ?? 0) + view.lanesTop, action.factor);
      }
    };
    element?.addEventListener("wheel", onWheel, { passive: false });
    return () => element?.removeEventListener("wheel", onWheel);
  }, [view, input]);

  return (
    <div className={timelineStyles.headers} style={{ width: listWidth }}>
      <div
        className={timelineStyles.headerDivider}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("keyframes.resizeList")}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          resizing.current = { from: event.clientX, width: listWidth };
        }}
        onPointerMove={(event) => {
          const start = resizing.current;
          if (start) keyframes.setListWidth(start.width + event.clientX - start.from);
        }}
        onPointerUp={() => {
          resizing.current = undefined;
          keyframes.saveListWidth();
        }}
        onPointerCancel={() => {
          resizing.current = undefined;
        }}
      />
      <Corner view={view} />
      <SoundHeader view={view} />
      <div
        ref={list}
        className={timelineStyles.headerList}
        role="tree"
        aria-label={t("keyframes.list")}
        onPointerDown={(event) => {
          if (input.isTouch(event.pointerType)) finger.current = event.clientY;
        }}
        onPointerMove={(event) => {
          if (finger.current === undefined) return;
          view.setScroll(view.scrollX, view.scrollY + finger.current - event.clientY);
          finger.current = event.clientY;
        }}
        onPointerUp={() => {
          finger.current = undefined;
        }}
        onPointerCancel={() => {
          finger.current = undefined;
        }}
        // Focus scrolls a list that only moves by its transform: the view goes there instead.
        onScroll={(event) => {
          const by = event.currentTarget.scrollTop;
          if (by === 0) return;
          event.currentTarget.scrollTop = 0;
          view.setScroll(view.scrollX, view.scrollY + by);
        }}
      >
        <div ref={rows} className={styles.rows}>
          <LaneRows area={view} canPin />
        </div>
      </div>
    </div>
  );
}

function EmptyHint({ view }: { view: KeyframesView }) {
  const { keyframes } = view;
  const { t } = useTranslation();
  const lanes = useSyncExternalStore(view.subscribeLanes, view.getLanes);
  const { range, query } = useSyncExternalStore(keyframes.subscribe, keyframes.getSnapshot);
  if (lanes.length > 0) return null;
  const text = query === "" ? t(`keyframes.empty.${range}`) : t("keyframes.empty.search");
  return <p className={timelineStyles.hint}>{text}</p>;
}

function Surface({ view }: { view: KeyframesView }) {
  const { keyframes } = view;
  const { media } = useWorkbench();
  const { t } = useTranslation();
  // The waveforms of the timeline, which the row of sound adds up.
  useLayoutEffect(() => {
    view.setPeaksSource((clip) => {
      const box = view.model?.boxes.get(clip);
      return box && media.peaksOf(box.clip);
    });
    return media.subscribe(() => view.soundsArrived());
  }, [view, media]);
  const lanesTop = useSyncExternalStore(keyframes.subscribeView, () => view.lanesTop);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const popups = useKeyPopups(view);

  const events = useStage(
    view,
    { stage, canvas, playhead },
    {
      paint: (element) => new KeyframesPainter(element, view, keyframes.labelOfValue),
      wheelArea: (element) => element,
      openMenu: (pointer) => {
        if (stage.current) popups.open(pointer, stage.current.getBoundingClientRect());
      },
    },
  );

  // Closed, nothing shows this any more, and it should not go on following the playhead.
  useLayoutEffect(() => () => view.setViewport(0, 0), [view]);

  const lanes = () => view.height - view.lanesTop;
  const { model } = view;

  return (
    <div className={timelineStyles.surface}>
      <div
        ref={stage}
        className={timelineStyles.stage}
        tabIndex={0}
        role="group"
        aria-label={t("panel.keyframes.title")}
        {...events}
        onDoubleClick={(event) => popups.doubleClick(pointerOf(event, event.currentTarget))}
        onContextMenu={(event) => {
          event.preventDefault();
          popups.open(
            pointerOf(event, event.currentTarget),
            event.currentTarget.getBoundingClientRect(),
          );
        }}
      >
        <canvas ref={canvas} className={timelineStyles.canvas} />
        <KeyList area={view} />
        <EmptyHint view={view} />
        <div
          ref={playhead}
          className={timelineStyles.playhead}
          role="slider"
          aria-label={t("timeline.playhead")}
          aria-valuemin={0}
          aria-valuemax={Math.round((model?.duration ?? 0) * (model?.rate.fps ?? 30))}
          aria-orientation="horizontal"
          tabIndex={-1}
        />
      </div>
      <div className={timelineStyles.barRight} style={{ paddingTop: lanesTop }}>
        <ZoomBar
          axis="y"
          label={t("timeline.scrollY")}
          handleLabel={t("keyframes.handleY")}
          handleUsage={t("keyframes.zoomHandleY")}
          subscribe={keyframes.subscribeView}
          read={() => ({
            content: view.contentHeight - view.lanesTop,
            view: lanes(),
            offset: view.scrollY,
          })}
          scrollTo={(offset) => view.setScroll(view.scrollX, offset)}
          beginZoom={(edge) => {
            const start = view.rowScale;
            const y = edge === "start" ? view.height : view.lanesTop;
            return (ratio) => view.zoomRowsAround(y, start / ratio / view.rowScale);
          }}
        />
      </div>
      <ZoomBar
        axis="x"
        label={t("timeline.scrollX")}
        handleLabel={t("timeline.handleX")}
        handleUsage={t("timeline.help.zoomHandleX")}
        subscribe={keyframes.subscribeView}
        read={() => {
          // Holding the playhead in the middle, it goes from before 0 to past the end.
          const { min, max } = view.scrollRange;
          return { content: max - min + view.width, view: view.width, offset: view.scrollX - min };
        }}
        scrollTo={(offset) => view.setScroll(offset + view.scrollRange.min, view.scrollY)}
        beginZoom={(edge) => {
          const start = view.pixelsPerSecond;
          const x = edge === "start" ? view.width : 0;
          return (ratio) => view.zoomAround(x, start / ratio / view.pixelsPerSecond);
        }}
      />
      {popups.element}
    </div>
  );
}

/** The more advanced timeline: what can be animated on the left, keys and curves on the right. */
export function KeyframesPanel() {
  const { keyframes, timeline } = useWorkbench();
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const view = keyframes.panel;

  if (!model) return <div className={timelineStyles.missing}>{t("timeline.missing")}</div>;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A menu opened from here is part of this panel for React, but it has its own Escape.
    if (event.key !== "Escape" || !event.currentTarget.contains(event.target as Node)) return;
    if (!view.cancelDrag()) keyframes.clearSelection();
  };

  return (
    <div className={`${timelineStyles.panel} ${styles.panel}`} onKeyDown={onKeyDown}>
      <Toolbar view={view} />
      <div className={timelineStyles.body}>
        <List view={view} />
        <Surface view={view} />
      </div>
      <RecordingFrame />
    </div>
  );
}
