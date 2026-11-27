import { formatTime, parseTime, toSeconds } from "@animaquill/schema";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { Bubble } from "../app/Bubble.tsx";
import type { MenuItem } from "../app/Menu.tsx";
import { MARKER_HALF, MARKER_TOP, RULER_HEIGHT, type TimelineEditor } from "./editor.ts";
import { formatTimecode, frameAt, frameTime, parseTimecode } from "./frames.ts";
import { MARKER_COLORS, markerColorOf, showsSections, type MarkerBox } from "./markers.ts";
import { pointerOf } from "./stage.ts";
import styles from "./TimelinePanel.module.css";

function useView<T>(editor: TimelineEditor, read: () => T): T {
  return useSyncExternalStore(editor.subscribeView, read);
}

export interface MenuPlace {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly groups: readonly (readonly MenuItem[])[];
}

/**
 * The markers, which the canvas draws on the ruler, for screen readers and for finding them: each
 * where it is, with its name, time and colour, and which one is selected. Nothing of it shows.
 */
export function MarkerList({ editor }: { editor: TimelineEditor }) {
  const { t } = useTranslation();
  const { model, marker: selected } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  // Text, so that it stays the same while nothing moves.
  const places = useView(editor, () =>
    (editor.model?.markers ?? [])
      .map(({ time, end }) => `${editor.xAt(time)},${end === undefined ? "" : editor.xAt(end)}`)
      .join(" "),
  );
  if (!model || model.markers.length === 0) return null;
  const xs = places.split(" ").map((place) => place.split(","));
  return (
    <div className={styles.markerList} role="list" aria-label={t("timeline.marker.list")}>
      {model.markers.map((box, index) => {
        const [at = "0", end = ""] = xs[index] ?? [];
        const left = Number(at);
        const width = end === "" ? 1 : Math.max(Number(end) - left, 1);
        const frame = frameAt(box.time, model.rate);
        const time = formatTimecode(frame, model.rate);
        const { name } = box.marker;
        return (
          <div
            key={box.id}
            role="listitem"
            className={styles.markerItem}
            style={{ transform: `translateX(${left}px)`, width, height: RULER_HEIGHT }}
            aria-label={
              name
                ? t("timeline.marker.named", { name, time })
                : t("timeline.marker.unnamed", { time })
            }
            aria-current={box.id === selected || undefined}
            data-marker={box.id}
            data-frame={frame}
            data-color={markerColorOf(box.marker) ?? box.marker.color}
            data-end={box.end === undefined ? undefined : frameAt(box.end, model.rate)}
          />
        );
      })}
    </div>
  );
}

/** Where a marker is on screen, for its bubble to point at. */
function anchorOf(editor: TimelineEditor, stage: HTMLElement, box: MarkerBox): DOMRect {
  const { left, top } = stage.getBoundingClientRect();
  const x = left + editor.xAt(box.time);
  return new DOMRect(x - MARKER_HALF, top + MARKER_TOP, MARKER_HALF * 2, RULER_HEIGHT - MARKER_TOP);
}

type Field = "name" | "duration" | "note";

/**
 * What a marker says, open to change: its name, colour, duration and note. Each change is a step of
 * its own, made when people leave a field, or press Enter in one line; Escape leaves without it.
 */
export function MarkerBubble({
  editor,
  stage,
}: {
  editor: TimelineEditor;
  stage: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const { editingMarker, model } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const box = model?.markers.find(({ id }) => id === editingMarker);
  const [anchor, setAnchor] = useState<{ readonly id: string; readonly rect: DOMRect }>();

  // Where it opened, by the marker it is about: it stays there while that one is open.
  useEffect(
    () =>
      editor.subscribe(() => {
        const id = editor.getSnapshot().editingMarker;
        const opened = editor.model?.markers.find((each) => each.id === id);
        setAnchor((now) => {
          if (!opened || !stage.current) return undefined;
          if (now?.id === opened.id) return now;
          return { id: opened.id, rect: anchorOf(editor, stage.current, opened) };
        });
      }),
    [editor, stage],
  );

  if (!box || !model || anchor?.id !== box.id) return null;
  return (
    <Bubble
      anchor={anchor.rect}
      title={t("timeline.marker.at", {
        time: formatTimecode(frameAt(box.time, model.rate), model.rate),
      })}
      className={styles.markerBubble}
      onClose={() => editor.editMarker(undefined)}
    >
      <MarkerFields key={box.id} editor={editor} box={box} />
    </Bubble>
  );
}

function MarkerFields({ editor, box }: { editor: TimelineEditor; box: MarkerBox }) {
  const { t } = useTranslation();
  const model = editor.model;
  const rate = model?.rate;
  const { marker } = box;
  const durationText = (duration: string | undefined) =>
    duration === undefined || !rate
      ? ""
      : formatTimecode(frameAt(toSeconds(parseTime(duration)), rate), rate);
  const [values, setValues] = useState({
    name: marker.name ?? "",
    duration: durationText(marker.duration),
    note: marker.note ?? "",
  });
  /** What is typed and not saved yet, which closing the bubble saves too, apart from with Escape. */
  const pending = useRef(new Map<Field, string>());
  const cancelled = useRef(false);

  const commit = (field: Field, value: string) => {
    if (field === "duration") {
      if (!rate) return;
      if (value.trim() === "") {
        editor.updateMarker(box.id, {}, ["duration"]);
        return;
      }
      const frames = parseTimecode(value, rate);
      if (frames === undefined || frames <= 0) {
        setValues((now) => ({ ...now, duration: durationText(marker.duration) }));
        return;
      }
      editor.updateMarker(box.id, { duration: formatTime(frameTime(frames, rate)) });
      setValues((now) => ({ ...now, duration: formatTimecode(frames, rate) }));
      return;
    }
    const text = field === "name" ? value.trim() : value;
    if (text === "") editor.updateMarker(box.id, {}, [field]);
    else editor.updateMarker(box.id, { [field]: text });
  };
  const save = (field: Field) => {
    const value = pending.current.get(field);
    if (value === undefined) return;
    pending.current.delete(field);
    commit(field, value);
  };
  const latest = useRef(commit);
  useLayoutEffect(() => {
    latest.current = commit;
  });

  // Closing the bubble by a click elsewhere comes before the field hears that it lost the focus.
  useEffect(() => {
    const queued = pending.current;
    const off = cancelled;
    const saving = latest;
    return () => {
      if (off.current) return;
      for (const [field, value] of queued) saving.current(field, value);
    };
  }, [pending, cancelled, latest]);

  const change = (field: Field, value: string) => {
    pending.current.set(field, value);
    setValues((now) => ({ ...now, [field]: value }));
  };
  const onKeyDown = (field: Field) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      cancelled.current = true;
      pending.current.clear();
    }
    if (event.key === "Enter" && field !== "note") {
      event.preventDefault();
      save(field);
    }
  };
  const current = markerColorOf(marker);

  return (
    <div className={styles.markerFields}>
      <label className={styles.markerLabel}>
        {t("timeline.marker.name")}
        <input
          className={styles.markerInput}
          value={values.name}
          spellCheck={false}
          onChange={(event) => change("name", event.target.value)}
          onBlur={() => save("name")}
          onKeyDown={onKeyDown("name")}
        />
      </label>
      <div className={styles.markerLabel} role="group" aria-label={t("timeline.marker.color")}>
        {t("timeline.marker.color")}
        <div className={styles.swatches} role="radiogroup" aria-label={t("timeline.marker.color")}>
          {MARKER_COLORS.map(({ id, value }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={current === id}
              aria-label={t(`timeline.marker.colors.${id}`)}
              title={t(`timeline.marker.colors.${id}`)}
              className={styles.swatch}
              style={{ background: `var(--aq-timeline-marker-${id})` }}
              onClick={() => {
                if (current !== id) editor.updateMarker(box.id, { color: value });
              }}
            />
          ))}
        </div>
      </div>
      <label className={styles.markerLabel}>
        {t("timeline.marker.duration")}
        <input
          className={styles.markerInput}
          value={values.duration}
          inputMode="numeric"
          spellCheck={false}
          onChange={(event) => change("duration", event.target.value)}
          onBlur={() => save("duration")}
          onKeyDown={onKeyDown("duration")}
        />
      </label>
      <label className={styles.markerLabel}>
        {t("timeline.marker.note")}
        <textarea
          className={styles.markerNote}
          rows={3}
          value={values.note}
          onChange={(event) => change("note", event.target.value)}
          onBlur={() => save("note")}
          onKeyDown={onKeyDown("note")}
        />
      </label>
    </div>
  );
}

/** The menu of a marker on the ruler. */
export function markerMenu(
  editor: TimelineEditor,
  box: MarkerBox,
  x: number,
  y: number,
  t: (key: string) => string,
): MenuPlace {
  return {
    x,
    y,
    label: t("timeline.marker.title"),
    groups: [
      [
        {
          id: "editMarker",
          label: t("timeline.marker.edit"),
          run: () => editor.editMarker(box.id),
        },
        {
          id: "removeMarker",
          label: t("timeline.marker.remove"),
          run: () => editor.removeMarker(box.id),
        },
      ],
    ],
  };
}

/** Whether the band of sections shows, which the headers make room for too. */
export function useShowsSections(editor: TimelineEditor): boolean {
  const { model } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  return model !== undefined && showsSections(model.sections);
}

function SectionName({
  name,
  onDone,
}: {
  name: string;
  onDone: (next: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.select(), []);
  return (
    <input
      ref={input}
      className={styles.sectionInput}
      aria-label={t("timeline.section.name")}
      defaultValue={name}
      spellCheck={false}
      autoFocus
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => onDone(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.stopPropagation();
          onDone(undefined);
        }
      }}
    />
  );
}

/**
 * The sections of the timeline, over the ruler, when there is more than one or the one there has a
 * name: a block each, lighter and darker by turns, with its name. A boundary between two can be
 * dragged, a block renamed with a double click, and the right mouse button splits at the playhead,
 * merges a section into the one before it or removes it, which is the same.
 */
export function SectionBand({
  editor,
  showMenu,
}: {
  editor: TimelineEditor;
  showMenu: (place: MenuPlace) => void;
}) {
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  const band = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string>();
  // Where each section shows, also while a boundary or the end is dragged, as text.
  const places = useView(editor, () => {
    const sections = editor.model?.sections ?? [];
    const { boundary, end } = editor.preview ?? {};
    const moved = (index: number, seconds: number) => {
      if (boundary && sections[index]?.id === boundary.section) return boundary.seconds;
      return index === sections.length - 1 && end !== undefined ? end : seconds;
    };
    const ends = sections.map((section, index) => moved(index, section.end));
    return ends
      .map(
        (to, index) => `${editor.xAt(index === 0 ? 0 : (ends[index - 1] ?? 0))},${editor.xAt(to)}`,
      )
      .join(" ");
  });
  if (!model || !showsSections(model.sections)) return null;
  const { sections, rate } = model;
  const xs = places.split(" ").map((place) => place.split(",").map(Number));
  const timecode = (seconds: number) => formatTimecode(frameAt(seconds, rate), rate);

  const onBoundaryDown = (section: string) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !band.current) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    editor.pressBoundary(section, pointerOf(event, band.current));
  };
  const onBoundaryMove = (event: PointerEvent<HTMLDivElement>) => {
    if (band.current && event.currentTarget.hasPointerCapture(event.pointerId)) {
      editor.drag(pointerOf(event, band.current));
    }
  };
  const onBoundaryUp = (event: PointerEvent<HTMLDivElement>) => {
    if (band.current) editor.release(pointerOf(event, band.current));
  };

  const menuOf = (index: number, x: number, y: number): MenuPlace => {
    const section = sections[index];
    const id = section?.id ?? "";
    const label = section?.name || t("timeline.section.band");
    return {
      x,
      y,
      label,
      groups: [
        [
          { id: "renameSection", label: t("timeline.section.rename"), run: () => setRenaming(id) },
          {
            id: "splitSection",
            label: t("timeline.section.split"),
            disabled: !editor.canSplitSection,
            run: () => editor.splitSectionAtPlayhead(),
          },
        ],
        [
          {
            id: "mergeSection",
            label: t(index === 0 ? "timeline.section.mergeNext" : "timeline.section.merge"),
            disabled: sections.length < 2,
            run: () => editor.removeSection(id),
          },
        ],
      ],
    };
  };

  return (
    <div
      ref={band}
      className={styles.sectionBand}
      role="group"
      aria-label={t("timeline.section.band")}
    >
      {sections.map((section, index) => {
        const [left = 0, right = 0] = xs[index] ?? [];
        const name = section.name ?? "";
        const words = { start: timecode(section.start), end: timecode(section.end) };
        return (
          <div
            key={section.id}
            className={index % 2 === 0 ? styles.section : `${styles.section} ${styles.sectionAlt}`}
            style={{ left, width: Math.max(right - left, 0) }}
            role="button"
            tabIndex={-1}
            aria-label={
              name
                ? t("timeline.section.named", { name, ...words })
                : t("timeline.section.unnamed", { number: index + 1, ...words })
            }
            data-section={section.id}
            onPointerDown={(event) => {
              if (event.button !== 0 || !band.current || renaming === section.id) return;
              const { x } = pointerOf(event, band.current);
              editor.goTo(frameAt(Math.max(editor.timeAt(x), 0), rate));
            }}
            onDoubleClick={() => setRenaming(section.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              showMenu(menuOf(index, event.clientX, event.clientY));
            }}
          >
            {renaming === section.id ? (
              <SectionName
                name={name}
                onDone={(next) => {
                  setRenaming(undefined);
                  if (next !== undefined) editor.renameSection(section.id, next);
                }}
              />
            ) : (
              <span className={styles.sectionName}>{name}</span>
            )}
          </div>
        );
      })}
      {sections.slice(0, -1).map((section, index) => {
        const right = xs[index]?.[1] ?? 0;
        return (
          <div
            key={`${section.id}-end`}
            className={styles.boundary}
            style={{ transform: `translateX(${right}px)` }}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("timeline.section.boundary", { number: index + 1, next: index + 2 })}
            aria-valuenow={frameAt(section.end, rate)}
            aria-valuetext={timecode(section.end)}
            data-boundary={section.id}
            onPointerDown={onBoundaryDown(section.id)}
            onPointerMove={onBoundaryMove}
            onPointerUp={onBoundaryUp}
            onPointerCancel={() => editor.cancelDrag()}
            onLostPointerCapture={() => editor.cancelDrag()}
          />
        );
      })}
    </div>
  );
}
