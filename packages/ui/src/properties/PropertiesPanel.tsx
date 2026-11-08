import { SCENE_OBJECT_TYPES } from "@animaquill/core";
import { ZERO, type ObjectDescriptor, type PropertySpec } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { ChevronLeft, ChevronRight, Diamond, RotateCcw, SlidersHorizontal } from "lucide-react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { frameTime } from "../timeline/frames.ts";
import type { FadeSide } from "../timeline/gestures.ts";
import { canFade, fadesOf, type ClipBox } from "../timeline/model.ts";
import { CONTROLS, PlainValue, RowButton } from "./controls.tsx";
import { inspectSelection, keyEdit, writeEdit, type Blocked, type Selected } from "./inspect.ts";
import { groupOf, nameOf, textOf } from "./names.ts";
import { NumberField } from "./NumberField.tsx";
import styles from "./PropertiesPanel.module.css";
import { placeOf, PropertyRows } from "./rows.ts";

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
  const Control = CONTROLS[spec.type] ?? PlainValue;
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
}

/**
 * The properties of one object. Only what is near the screen has rows: a skeleton has hundreds of
 * bones, and each row follows the playhead.
 */
const Section = memo(function Section({ rows, clip, object, name, eager }: SectionProps) {
  const element = useRef<HTMLElement>(null);
  // A field that somebody is in stays, also when they scroll away from it.
  const [focused, setFocused] = useState(false);
  const near = useNearScreen(element, eager) || focused;
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
  const estimate = (name === undefined ? 0 : HEADING_HEIGHT) + properties.length * ROW_HEIGHT;
  return (
    <section
      ref={element}
      className={styles.object}
      {...(name !== undefined && { "aria-label": name })}
      style={near ? undefined : { height: height ?? estimate }}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      {name !== undefined && <h3 className={styles.objectName}>{name}</h3>}
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

const FADE_SIDES: readonly FadeSide[] = ["in", "out"];
const NOTHING = () => {};

/**
 * How long a clip fades in and out, which the handles at the top corners of the clip on the timeline
 * also say. It is about the clip and not a property that changes over time, so a change is a step of
 * its own right away, like trimming the clip, and not something to try first. It goes by frames.
 */
function FadeRows({ box, readOnly }: { box: ClipBox; readOnly: boolean }) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const fades = fadesOf(box.clip);
  const length = box.end - box.start;
  const title = t("property.fade.title");
  const commit = (side: FadeSide, seconds: number) => {
    const rate = timeline.model?.rate;
    if (!rate) return;
    const frames = Math.max(Math.round(seconds * rate.fps), 0);
    timeline.setFade(box.id, side, frameTime(frames, rate));
  };
  return (
    <section className={styles.fades} aria-label={title}>
      <h3 className={styles.objectName}>{title}</h3>
      {FADE_SIDES.map((side) => {
        const label = t(`property.fade.${side}`);
        const other = side === "in" ? fades.out : fades.in;
        const spec: PropertySpec = {
          path: `fade.${side}`,
          type: "number",
          unit: "s",
          min: 0,
          max: Math.max(length - other, 0),
        };
        return (
          <div key={side} className={styles.row} role="group" aria-label={label}>
            <span className={styles.name}>{label}</span>
            <NumberField
              label={label}
              spec={spec}
              value={fades[side]}
              automatic={false}
              placeholder=""
              animated={false}
              tried={false}
              readOnly={readOnly}
              onPreview={NOTHING}
              onCommit={(seconds) => commit(side, seconds)}
              onCancel={NOTHING}
            />
            <div className={styles.rowButtons}>
              <RowButton
                name={t(`property.fade.remove.${side}`)}
                usage={t("property.help.fade")}
                unavailable={readOnly || fades[side] === 0}
                onClick={() => timeline.setFade(box.id, side, ZERO)}
              >
                <RotateCcw size={12} />
              </RowButton>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** What an object of a clip is called by itself, unless it is the clip itself. */
function ownName(t: TFunction, { type, name, id }: ObjectDescriptor): string | undefined {
  if (type === "clip.visual" || type === "clip.sound") return undefined;
  if (type === SCENE_OBJECT_TYPES.params) return t("keyframes.objects.params");
  if (type === SCENE_OBJECT_TYPES.elements) return t("keyframes.objects.elements");
  return name ?? id;
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
  const { timeline } = useWorkbench();
  const { box, objects } = selected;
  const { blocked, firstFrame } = usePlace(rows, box.id);
  const byId = new Map(objects.map((object) => [object.id, object]));
  const { kind } = box.clip.source;
  const kindName = textOf(t, `timeline.kind.${kind}`, kind);
  const shown = objects.filter((object) => object.properties.length > 0);
  const track = timeline.model?.rowOfClip.get(box.id)?.track;
  return (
    <>
      <header className={styles.header}>
        <span className={styles.title}>{box.clip.name ?? kindName}</span>
        {box.clip.name !== undefined && <span className={styles.kind}>{kindName}</span>}
      </header>
      {kind === "sound" && <SoundStatus clip={box.clip} />}
      {blocked && <BlockedHint blocked={blocked} firstFrame={firstFrame} />}
      {track && canFade(track) && <FadeRows box={box} readOnly={track.locked === true} />}
      <div className={styles.rows} data-readonly={blocked !== undefined || undefined}>
        {shown.map((object, index) => (
          // Another clip gets fields of its own, so nothing typed can end up on the wrong one.
          <Section
            key={`${box.id} ${object.id}`}
            rows={rows}
            clip={box.id}
            object={object}
            name={objectName(t, object, byId)}
            eager={index < EAGER_SECTIONS}
          />
        ))}
      </div>
    </>
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
  const { model, selection } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const { comparing } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  useSyncExternalStore(registrations.subscribe, registrations.getVersion);
  const rows = useMemo(
    () => new PropertyRows({ timeline, trials, state: () => store?.getState() }),
    [timeline, trials, store],
  );
  const { describe } = keyframes;
  const selected: Selected = model
    ? inspectSelection(model, selection, { look: trials.look, comparing, describe })
    : { kind: "nothing" };

  return (
    // Focusable, so that the keyboard has somewhere to go after a field, without a frame around it.
    <div className={styles.panel} tabIndex={-1} data-scroll>
      {selected.kind === "nothing" && <Message text={t("property.nothing")} />}
      {selected.kind === "no-properties" && <Message text={t("property.noProperties")} />}
      {selected.kind === "several" && (
        <Message text={t("property.several", { count: selected.count })} />
      )}
      {selected.kind === "clip" && <ClipProperties selected={selected} rows={rows} />}
    </div>
  );
}
