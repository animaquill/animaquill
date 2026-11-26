import { SCENE_OBJECT_TYPES, effectsOf, objectsOf } from "@animaquill/core";
import {
  CLIP_SOUND,
  MASTER_SOUND,
  type ObjectDescriptor,
  type PropertySpec,
} from "@animaquill/schema";
import type { TFunction } from "i18next";
import { ChevronLeft, ChevronRight, Diamond, RotateCcw, SlidersHorizontal } from "lucide-react";
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import type { ClipBox } from "../timeline/model.ts";
import { CONTROLS, PlainValue, RowButton } from "./controls.tsx";
import { PanControl, VolumeControl } from "./SoundControls.tsx";
import { RecordButton } from "../keyframes/RecordButton.tsx";
import { inspectSelection, keyEdit, writeEdit, type Blocked, type Selected } from "./inspect.ts";
import { groupOf, nameOf, textOf } from "./names.ts";
import styles from "./PropertiesPanel.module.css";
import { placeOf, PropertyRows } from "./rows.ts";
import { EffectsSection } from "./EffectsSection.tsx";
import { SectionHeading, SectionsScope, useFolded } from "./SectionHeading.tsx";
import { effectSectionId, isEffectObject, sectionsOf, type PropertySection } from "./sections.ts";
import { TransitionProperties } from "./TransitionProperties.tsx";
import { MASTER_CLIP, trackClipId, withTrackClip } from "../mixer/track-clip.ts";
import { useTrackName } from "../mixer/names.ts";

type ClipSelected = Extract<Selected, { kind: "clip" }>;

/** How tall a row is, for what is not on screen yet. A row that says more is taller. */
const ROW_HEIGHT = 25;
const HEADING_HEIGHT = 28;
/** How far from the screen a section starts to show what it has, so that scrolling finds it there. */
const NEAR_SCREEN = "600px 0px";
/** The first sections show right away: most clips have no more, and the rest is below them. */
const EAGER_SECTIONS = 4;

/**
 * Whether something is on the screen or close to it. A tab that does not show is nowhere near it,
 * so what is in it stops following the playhead.
 */
function useNearScreen(ref: RefObject<HTMLElement | null>, eager: boolean): boolean {
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const root = element.closest<HTMLElement>("[data-scroll]");
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting === true),
      { root, rootMargin: NEAR_SCREEN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}

/**
 * What a row shows of its property at the playhead, which it follows by itself, as far as what it
 * shows changes: playing goes through here with every frame, and most rows stay the same.
 */
function useInspected(rows: PropertyRows, clip: string, spec: PropertySpec) {
  useSyncExternalStore(rows.subscribe, () => rows.signatureOf(clip, spec));
  return rows.inspect(clip, spec);
}

interface RowProps {
  readonly rows: PropertyRows;
  readonly clip: string;
  readonly spec: PropertySpec;
  /** The first of a group says what the group is. */
  readonly startsGroup: boolean;
}

const Row = memo(function Row({ rows, clip, spec, startsGroup }: RowProps) {
  const { properties, trials } = useWorkbench();
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();
  const inspected = useInspected(rows, clip, spec);
  if (!inspected) return null;
  const { row, blocked } = inspected;
  const { path, tried } = row;
  const name = nameOf(t, spec);
  const { group } = spec;
  const label = group === undefined ? name : `${groupOf(t, group)} ${name}`;
  const readOnly = blocked !== undefined;
  // The volume and the pan of sound have controls of their own; the rest go by the type of value.
  const Control =
    spec.path === "audio.volume"
      ? VolumeControl
      : spec.path === "audio.pan"
        ? PanControl
        : (CONTROLS[spec.type] ?? PlainValue);
  /** What the playhead says when something happens, which is where the edit goes. */
  const now = () => rows.inspect(clip, spec) ?? inspected;

  return (
    <>
      <div
        className={styles.row}
        role="group"
        aria-label={label}
        data-tried={tried || undefined}
        data-readonly={readOnly || undefined}
        onFocusCapture={() => properties.noteProperty(clip, spec)}
        onPointerDownCapture={() => properties.noteProperty(clip, spec)}
        onContextMenu={(event) => {
          if (!tried) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {group === undefined ? (
          <span className={styles.name}>{name}</span>
        ) : (
          <>
            <span className={styles.group}>{startsGroup ? groupOf(t, group) : ""}</span>
            <span className={styles.part}>{name}</span>
          </>
        )}
        <Control
          row={row}
          label={label}
          readOnly={readOnly}
          onPreview={(value) => {
            const { row: current, time } = now();
            properties.preview([writeEdit(clip, current, time, value)]);
          }}
          // The playhead can leave the clip while a value is still in somebody's hands.
          onCommit={(value) => {
            const { row: current, time, blocked: stopped } = now();
            if (stopped) properties.cancel();
            else properties.commit([writeEdit(clip, current, time, value)]);
          }}
          onCancel={() => properties.cancel()}
        />
        <RowButtons
          rows={rows}
          clip={clip}
          spec={spec}
          animated={row.animated}
          onKey={row.keyTime !== undefined}
          previousKey={row.previousKey}
          nextKey={row.nextKey}
          canKey={!readOnly && keyEdit(clip, row, inspected.time) !== undefined}
          canReset={!readOnly && row.stored !== undefined}
        />
      </div>
      {row.changedElsewhere && <p className={styles.elsewhere}>{t("trial.changedElsewhere")}</p>}
      {menu && (
        <PopupMenu
          label={label}
          x={menu.x}
          y={menu.y}
          groups={[
            [
              {
                id: "discard",
                label: t("trial.discardProperty"),
                run: () => trials.discardProperty(clip, path),
              },
            ],
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
});

interface RowButtonsProps {
  readonly rows: PropertyRows;
  readonly clip: string;
  readonly spec: PropertySpec;
  readonly animated: boolean;
  readonly onKey: boolean;
  readonly previousKey: number | undefined;
  readonly nextKey: number | undefined;
  readonly canKey: boolean;
  readonly canReset: boolean;
}

/**
 * The buttons of a row, which stay the same while its value changes: playing changes values with
 * every frame, and keys only now and then.
 */
const RowButtons = memo(function RowButtons(props: RowButtonsProps) {
  const { rows, clip, spec, animated, onKey, previousKey, nextKey, canKey, canReset } = props;
  const { properties, timeline } = useWorkbench();
  const { t } = useTranslation();
  return (
    <div className={styles.rowButtons}>
      {spec.animatable !== false && (
        <>
          <RowButton
            name={t("property.previousKey")}
            usage={t("property.help.previousKey")}
            unavailable={previousKey === undefined}
            onClick={() => timeline.seek(previousKey as number)}
          >
            <ChevronLeft size={13} />
          </RowButton>
          <RowButton
            name={onKey ? t("property.removeKey") : t("property.addKey")}
            usage={animated ? t("property.help.key") : t("property.help.firstKey")}
            unavailable={!canKey}
            pressed={onKey}
            onClick={() => {
              const now = rows.inspect(clip, spec);
              const key = now && keyEdit(clip, now.row, now.time);
              if (key) properties.commit([key]);
            }}
          >
            <Diamond
              size={12}
              className={animated ? styles.keyed : undefined}
              {...(onKey ? { fill: "currentColor" } : {})}
            />
          </RowButton>
          <RowButton
            name={t("property.nextKey")}
            usage={t("property.help.nextKey")}
            unavailable={nextKey === undefined}
            onClick={() => timeline.seek(nextKey as number)}
          >
            <ChevronRight size={13} />
          </RowButton>
        </>
      )}
      <RowButton
        name={t("property.reset")}
        usage={t("property.help.reset")}
        unavailable={!canReset}
        onClick={() => properties.commit([{ owner: { clip }, path: spec.path, op: "clear" }])}
      >
        <RotateCcw size={12} />
      </RowButton>
    </div>
  );
});

interface SectionProps {
  readonly rows: PropertyRows;
  readonly clip: string;
  readonly object: ObjectDescriptor;
  readonly name: string | undefined;
  readonly eager: boolean;
  /** A group that folds up, by its id, see sections.ts. Without one it always shows. */
  readonly fold?: string | undefined;
}

/**
 * The properties of one object, or of one group of them. Only what is near the screen has rows: a
 * skeleton has hundreds of bones, and each row follows the playhead. A group that is folded up has
 * only its title, which says whether there are keys in it.
 */
const Section = memo(function Section({ rows, clip, object, name, eager, fold }: SectionProps) {
  const element = useRef<HTMLElement>(null);
  const heading = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  // A field that somebody is in stays, also when they scroll away from it.
  const [focused, setFocused] = useState(false);
  const folded = useFolded(fold);
  const near = (useNearScreen(element, eager) || focused) && !folded;
  const { properties } = object;
  // What it took when it showed, which is what it takes when it does not, so that nothing jumps.
  const [height, setHeight] = useState<number>();
  useEffect(() => {
    const shown = element.current;
    if (!near || !shown || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(shown.offsetHeight));
    observer.observe(shown);
    return () => observer.disconnect();
  }, [near]);
  // Folded up while somebody was in one of its fields: the keyboard stays here, on its title.
  useEffect(() => {
    if (folded && focused && !element.current?.contains(document.activeElement)) {
      heading.current?.focus({ preventScroll: true });
    }
  }, [folded, focused]);
  const estimate = (name === undefined ? 0 : HEADING_HEIGHT) + properties.length * ROW_HEIGHT;
  return (
    <section
      ref={element}
      className={styles.object}
      {...(name !== undefined && { "aria-label": name })}
      data-section={fold}
      data-folded={folded || undefined}
      style={near || folded ? undefined : { height: height ?? estimate }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {name !== undefined &&
        (fold === undefined ? (
          <h3 className={styles.objectName}>{name}</h3>
        ) : (
          <SectionHeading
            ref={heading}
            id={fold}
            title={name}
            folded={folded}
            controls={contentId}
            keyed={folded ? () => rows.keyed(clip, properties) : undefined}
            subscribe={rows.subscribe}
          />
        ))}
      <div id={contentId} hidden={folded}>
        {near &&
          properties.map((spec, index) => (
            <Row
              key={spec.path}
              rows={rows}
              clip={clip}
              spec={spec}
              startsGroup={properties[index - 1]?.group !== spec.group}
            />
          ))}
      </div>
    </section>
  );
});

/** Whether the clip can change at the playhead, which only changes at the edges of the clip. */
function usePlace(rows: PropertyRows, clip: string) {
  return placeOf(useSyncExternalStore(rows.subscribe, () => rows.placeOf(clip)));
}

/** Says why the controls do not react, and how to change that when something can be done. */
function BlockedHint({ blocked, firstFrame }: { blocked: Blocked; firstFrame: number }) {
  const { timeline, trials } = useWorkbench();
  const { t } = useTranslation();
  return (
    <div className={styles.hint} role="status">
      <span>{t(`property.blocked.${blocked}`)}</span>
      {blocked === "outside" && (
        <button
          type="button"
          className={styles.hintButton}
          onClick={() => timeline.seek(firstFrame)}
        >
          {t("property.goToClip")}
        </button>
      )}
      {blocked === "comparing" && (
        <button type="button" className={styles.hintButton} onClick={() => trials.toggleCompare()}>
          {t("trial.backToTrial")}
        </button>
      )}
    </div>
  );
}

/** A sound that code makes says how that is going, and one that failed can try again. */
function SoundStatus({ clip }: { clip: ClipBox["clip"] }) {
  const { sounds } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(sounds.subscribe, sounds.getVersion);
  const sound = sounds.stateOf(clip);
  if (!sound || sound.state === "ready") return null;
  return (
    <div className={styles.hint} role="status">
      <span>{t(`sound.state.${sound.state}`)}</span>
      {sound.state === "failed" && (
        <button type="button" className={styles.hintButton} onClick={() => sounds.retry(clip)}>
          {t("sound.retry")}
        </button>
      )}
    </div>
  );
}

/** What an object of a clip is called by itself, unless it is the clip itself. */
function ownName(t: TFunction, { type, name, id }: ObjectDescriptor): string | undefined {
  if (type === "clip.visual") return undefined;
  if (type === "clip.sound") return t("keyframes.objects.sound");
  if (type === SCENE_OBJECT_TYPES.params) return t("keyframes.objects.params");
  if (type === SCENE_OBJECT_TYPES.elements) return t("keyframes.objects.elements");
  return name ?? id;
}

/** What a group of the properties tab is called, see sections.ts. */
function sectionName(
  t: TFunction,
  section: PropertySection,
  byId: ReadonlyMap<string, ObjectDescriptor>,
): string {
  if (section.kind !== "object") return t(`property.section.${section.kind}`);
  return objectName(t, section.object, byId) ?? t("property.section.other");
}

/** Objects can be inside each other, which a flat list says with the names of what they are in. */
const MAX_NAMED_PARENTS = 4;

function objectName(
  t: TFunction,
  object: ObjectDescriptor,
  byId: ReadonlyMap<string, ObjectDescriptor>,
): string | undefined {
  const own = ownName(t, object);
  if (own === undefined) return undefined;
  const names = [own];
  const seen = new Set([object.id]);
  let parent = object.parent === undefined ? undefined : byId.get(object.parent);
  while (parent && !seen.has(parent.id) && names.length <= MAX_NAMED_PARENTS) {
    seen.add(parent.id);
    names.unshift(ownName(t, parent) ?? parent.id);
    parent = parent.parent === undefined ? undefined : byId.get(parent.parent);
  }
  return names.join(" › ");
}

function ClipProperties({ selected, rows }: { selected: ClipSelected; rows: PropertyRows }) {
  const { t } = useTranslation();
  const { box, objects } = selected;
  const { blocked, firstFrame } = usePlace(rows, box.id);
  const byId = new Map(objects.map((object) => [object.id, object]));
  const { kind } = box.clip.source;
  const kindName = textOf(t, `timeline.kind.${kind}`, kind);
  const sections = useMemo(() => sectionsOf(objects), [objects]);
  const sound = selected.sound;
  const soundSections = useMemo(
    () => sectionsOf(sound?.objects.filter((object) => object.type === "clip.sound") ?? []),
    [sound],
  );
  const effectRows = effectRowsOf(rows, box.id, objects);
  const ids = useMemo(
    () => [
      ...sections.map(({ id }) => id),
      ...effectsOf(box.clip).map(({ type }) => effectSectionId(type)),
      ...soundSections.map(({ id }) => id),
    ],
    [sections, soundSections, box.clip],
  );
  return (
    <SectionsScope kind={kind} ids={ids}>
      <header className={styles.header}>
        <span className={styles.title}>{box.clip.name ?? kindName}</span>
        {box.clip.name !== undefined && <span className={styles.kind}>{kindName}</span>}
        <span className={styles.headerEnd}>
          <RecordButton />
        </span>
      </header>
      {kind === "sound" && <SoundStatus clip={box.clip} />}
      {blocked && <BlockedHint blocked={blocked} firstFrame={firstFrame} />}
      <div className={styles.rows} data-readonly={blocked !== undefined || undefined}>
        {sections.map((section, index) => (
          // Another clip gets fields of its own, so nothing typed can end up on the wrong one.
          <Section
            key={`${box.id} ${section.id}`}
            rows={rows}
            clip={box.id}
            object={section.object}
            name={sectionName(t, section, byId)}
            fold={section.id}
            eager={index < EAGER_SECTIONS}
          />
        ))}
        <EffectsSection
          clip={box.clip}
          objects={objects}
          readOnly={blocked === "locked" || blocked === "comparing"}
          rows={effectRows}
          propertyRows={rows}
        />
        {sound &&
          soundSections.map((section) => (
            // The sound linked to the picture: its own clip, with its own playhead and keys.
            <Section
              key={`${sound.box.id} ${section.id}`}
              rows={rows}
              clip={sound.box.id}
              object={section.object}
              name={t("keyframes.objects.sound")}
              fold={section.id}
              eager
            />
          ))}
      </div>
    </SectionsScope>
  );
}

/** The rows of what each effect of a clip takes, by its object, for the list of its effects. */
function effectRowsOf(rows: PropertyRows, clip: string, objects: readonly ObjectDescriptor[]) {
  return new Map(
    objects
      .filter((object) => isEffectObject(object) && object.properties.length > 0)
      .map((object) => [
        object.id,
        <Section
          key={`${clip} ${object.id}`}
          rows={rows}
          clip={clip}
          object={object}
          name={undefined}
          eager
        />,
      ]),
  );
}

/**
 * A selected track of sound, or the master: its volume (and the pan of a track, the safe limiter of
 * the master), as the mixer has them, keyed on the timeline's time, and its effects. They write to
 * the track or the master, see `withTrackClip`.
 */
function StandInProperties({ track, rows }: { track: string; rows: PropertyRows }) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const trackName = useTrackName();
  const { model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const master = track === MASTER_CLIP;
  const clip = master ? MASTER_CLIP : trackClipId(track);
  const { blocked, firstFrame } = usePlace(rows, clip);
  const shown = model && withTrackClip(model, track);
  const box = shown?.boxes.get(clip);
  const row = master ? undefined : model?.rows.find((one) => one.id === track);
  if (!box || (!master && !row)) return null;
  const objects = objectsOf(box.clip);
  const own = master ? MASTER_SOUND : CLIP_SOUND;
  const ids = [
    master ? "master" : "sound",
    ...effectsOf(box.clip).map(({ type }) => effectSectionId(type)),
  ];
  return (
    <SectionsScope kind={master ? "master" : "track"} ids={ids}>
      <header className={styles.header}>
        <span className={styles.title}>{row ? trackName(row) : t("mixer.master")}</span>
        <span className={styles.headerEnd}>
          <RecordButton />
        </span>
      </header>
      {blocked && <BlockedHint blocked={blocked} firstFrame={firstFrame} />}
      <div className={styles.rows} data-readonly={blocked !== undefined || undefined}>
        <Section
          key={clip}
          rows={rows}
          clip={clip}
          object={own}
          name={t(master ? "property.section.master" : "property.section.sound")}
          fold={master ? "master" : "sound"}
          eager
        />
        <EffectsSection
          clip={box.clip}
          objects={objects}
          readOnly={blocked === "locked" || blocked === "comparing"}
          rows={effectRowsOf(rows, clip, objects)}
          propertyRows={rows}
        />
      </div>
    </SectionsScope>
  );
}

function Message({ text }: { text: string }) {
  return (
    <div className={styles.message}>
      <SlidersHorizontal size={32} />
      <p>{text}</p>
    </div>
  );
}

export function PropertiesPanel() {
  const { timeline, trials, keyframes, registrations } = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  // What changes which properties there are. Where the playhead is, rows look at for themselves.
  useProject(store);
  const { model, selection, transition, track } = useSyncExternalStore(
    timeline.subscribe,
    timeline.getSnapshot,
  );
  const { comparing } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  useSyncExternalStore(registrations.subscribe, registrations.getVersion);
  const rows = useMemo(() => {
    // With the clip of a selected track among the clips, see `withTrackClip`.
    const shown = {
      get model() {
        const { model: now, track: selected } = timeline.getSnapshot();
        return now && withTrackClip(now, selected);
      },
      get frame() {
        return timeline.frame;
      },
      subscribe: timeline.subscribe,
      subscribeView: timeline.subscribeView,
    };
    return new PropertyRows({ timeline: shown, trials, state: () => store?.getState() });
  }, [timeline, trials, store]);
  const { describe } = keyframes;
  const selected: Selected = model
    ? inspectSelection(model, selection, { look: trials.look, comparing, describe })
    : { kind: "nothing" };
  // A transition is what people look at instead of clips, and has nothing of theirs.
  if (transition) {
    return (
      <div className={styles.panel} tabIndex={-1} data-scroll>
        <TransitionProperties choice={transition} />
      </div>
    );
  }

  return (
    // Focusable, so that the keyboard has somewhere to go after a field, without a frame around it.
    <div className={styles.panel} tabIndex={-1} data-scroll>
      {selected.kind === "nothing" && track !== undefined && (
        <StandInProperties track={track} rows={rows} />
      )}
      {selected.kind === "nothing" && track === undefined && (
        <Message text={t("property.nothing")} />
      )}
      {selected.kind === "no-properties" && <Message text={t("property.noProperties")} />}
      {selected.kind === "several" && (
        <Message text={t("property.several", { count: selected.count })} />
      )}
      {selected.kind === "clip" && <ClipProperties selected={selected} rows={rows} />}
    </div>
  );
}
