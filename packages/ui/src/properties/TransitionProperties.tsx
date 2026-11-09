import {
  BUILT_IN_TRANSITIONS,
  JOIN_ALIGNS,
  formatTime,
  mediaOfTrack,
  parseTime,
  type JoinAlign,
  type SpeedCurve,
  type Transition,
  type TransitionRef,
} from "@animaquill/schema";
import {
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { isJoinChoice, type TransitionChoice } from "../timeline/editor.ts";
import {
  formatTimecode,
  frameContaining,
  frameTime,
  parseTimecode,
  type FrameRate,
} from "../timeline/frames.ts";
import { longestTransition } from "../timeline/gestures.ts";
import {
  edgeWorks,
  edgesOf,
  type ClipBox,
  type Edge,
  type JoinBox,
  type TimelineModel,
} from "../timeline/model.ts";
import { transitionName } from "../timeline/transition-names.ts";
import { textOf } from "./names.ts";
import styles from "./PropertiesPanel.module.css";
import {
  SPEED_PRESET_IDS,
  curveOfPreset,
  handlesOf,
  presetOf,
  withHandle,
  writtenCurve,
} from "./speed-curve.ts";

/** Moves the keyboard back to the tab, where undo means the project again. */
const leave = (element: HTMLElement) =>
  element.closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });

/** Why a transition does not do what it says, for people to know, or nothing when it does. */
function whyNot(model: TimelineModel, box: ClipBox, edge: Edge) {
  if (edgeWorks(model, box, edge)) return undefined;
  const kind = model.rowOfClip.get(box.id)?.track.kind;
  if (kind === "caption") return "caption" as const;
  if (model.joined.has(`${box.id} ${edge}`)) return "joined" as const;
  return kind === "audio" ? ("sound" as const) : ("unsupported" as const);
}

/** Whether a speed curve goes past 0 and 1 as it is for a transition, see `progressAt`. */
function overshoots(transition: TransitionRef, media: "picture" | "sound"): boolean {
  const { type } = transition;
  const own = BUILT_IN_TRANSITIONS[media];
  return type !== undefined && Object.hasOwn(own, type) && own[type]?.overshoot === true;
}

/**
 * Takes the transition away, as Delete on the timeline does. Another one takes its place from the
 * transitions tab, see docs/design/resource-panels.md, section 3: there is no button here for that.
 */
function DeleteButton({ disabled, onDelete }: { disabled: boolean; onDelete: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={styles.hintButton} disabled={disabled} onClick={onDelete}>
      {t("transition.delete")}
    </button>
  );
}

/**
 * How long a transition is, the way the status bar writes times, by frames. It goes as far as the
 * transition at the other edge of the clip lets it, and a change is a step right away.
 */
function DurationField(props: {
  readonly label: string;
  readonly frames: number;
  readonly longest: number;
  readonly rate: FrameRate;
  readonly readOnly: boolean;
  readonly onCommit: (frames: number) => void;
}) {
  const { label, frames, longest, rate, readOnly, onCommit } = props;
  const { t } = useTranslation();
  const [typed, setTyped] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const commit = (text: string) => {
    const wanted = parseTimecode(text, rate);
    setTyped(undefined);
    if (wanted === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (wanted !== frames) onCommit(Math.min(Math.max(wanted, 0), longest));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      setTyped(undefined);
      setInvalid(false);
    } else if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") commit(event.currentTarget.value);
    leave(event.currentTarget);
  };
  const onBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (typed !== undefined) commit(event.currentTarget.value);
  };
  return (
    <>
      <div className={styles.row} role="group" aria-label={label}>
        <span className={styles.name}>{label}</span>
        <input
          className={styles.text}
          aria-label={label}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          readOnly={readOnly}
          value={typed ?? formatTimecode(frames, rate)}
          onChange={(event) => setTyped(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
      </div>
      <p className={invalid ? styles.transitionInvalid : styles.transitionHint}>
        {invalid
          ? t("transition.durationInvalid")
          : t("transition.durationHint", { longest: formatTimecode(longest, rate) })}
      </p>
    </>
  );
}

/** The drawing area of the speed curve, in units of its view box. */
const CURVE_SIZE = 100;
const CURVE_MARGIN = 8;

const xOf = (share: number) => CURVE_MARGIN + share * CURVE_SIZE;
const yOf = (share: number) => CURVE_MARGIN + (1 - share) * CURVE_SIZE;

/**
 * The speed curve with its two handles, which look and drag like the handles of keys. Dragging
 * only changes what shows here: letting go writes it, as one step.
 */
function CurveEditor(props: {
  readonly curve: SpeedCurve | undefined;
  readonly overshoot: boolean;
  readonly readOnly: boolean;
  readonly onCommit: (curve: SpeedCurve | undefined) => void;
}) {
  const { curve, overshoot, readOnly, onCommit } = props;
  const { t } = useTranslation();
  type Drag = { readonly handle: 0 | 1; readonly curve: SpeedCurve };
  const [dragged, setDragged] = useState<Drag>();
  // Letting go and losing the pointer both end a drag, which must write once.
  const drag = useRef<Drag | undefined>(undefined);
  const follow = (next: Drag | undefined) => {
    drag.current = next;
    setDragged(next);
  };
  const [x1, y1, x2, y2] = dragged?.curve ?? handlesOf(curve);

  const placeOf = (event: PointerEvent<SVGElement>) => {
    const svg = (event.currentTarget as SVGElement).ownerSVGElement ?? event.currentTarget;
    const box = svg.getBoundingClientRect();
    const scale = box.width / (CURVE_SIZE + CURVE_MARGIN * 2);
    const x = (event.clientX - box.left) / scale - CURVE_MARGIN;
    const y = (event.clientY - box.top) / scale - CURVE_MARGIN;
    return { x: x / CURVE_SIZE, y: 1 - y / CURVE_SIZE };
  };
  const onPointerDown = (handle: 0 | 1) => (event: PointerEvent<SVGCircleElement>) => {
    if (readOnly || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    follow({ handle, curve: handlesOf(curve) });
  };
  const onPointerMove = (event: PointerEvent<SVGCircleElement>) => {
    const current = drag.current;
    if (!current) return;
    const { x, y } = placeOf(event);
    follow({ ...current, curve: withHandle(current.curve, current.handle, x, y, overshoot) });
  };
  const onPointerUp = () => {
    const current = drag.current;
    if (!current) return;
    follow(undefined);
    const next = writtenCurve(current.curve);
    if (JSON.stringify(next) !== JSON.stringify(curve)) onCommit(next);
  };
  const onKeyDown = (handle: 0 | 1) => (event: KeyboardEvent<SVGCircleElement>) => {
    const steps: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-0.05, 0],
      ArrowRight: [0.05, 0],
      ArrowUp: [0, 0.05],
      ArrowDown: [0, -0.05],
    };
    const step = steps[event.key];
    if (readOnly || !step) return;
    event.preventDefault();
    event.stopPropagation();
    const [hx, hy] = handle === 0 ? [x1, y1] : [x2, y2];
    onCommit(writtenCurve(withHandle(curve, handle, hx + step[0], hy + step[1], overshoot)));
  };

  const path = `M ${xOf(0)} ${yOf(0)} C ${xOf(x1)} ${yOf(y1)}, ${xOf(x2)} ${yOf(y2)}, ${xOf(1)} ${yOf(1)}`;
  const handle = (index: 0 | 1, x: number, y: number, fromX: number, fromY: number) => (
    <g key={index}>
      <line
        className={styles.curveHandleLine}
        x1={xOf(fromX)}
        y1={yOf(fromY)}
        x2={xOf(x)}
        y2={yOf(y)}
      />
      <circle
        className={styles.curveHandle}
        cx={xOf(x)}
        cy={yOf(y)}
        r={4}
        role="slider"
        tabIndex={readOnly ? -1 : 0}
        aria-label={t(index === 0 ? "transition.handles.first" : "transition.handles.second")}
        aria-valuetext={`${x}, ${y}`}
        aria-disabled={readOnly || undefined}
        data-dragging={dragged?.handle === index || undefined}
        onPointerDown={onPointerDown(index)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => follow(undefined)}
        onLostPointerCapture={onPointerUp}
        onKeyDown={onKeyDown(index)}
      />
    </g>
  );
  const size = CURVE_SIZE + CURVE_MARGIN * 2;
  return (
    <svg
      className={styles.curve}
      viewBox={`0 0 ${size} ${size}`}
      role="group"
      aria-label={t("transition.curve")}
      data-readonly={readOnly || undefined}
    >
      <rect
        className={styles.curveFrame}
        x={CURVE_MARGIN}
        y={CURVE_MARGIN}
        width={CURVE_SIZE}
        height={CURVE_SIZE}
      />
      <path className={styles.curveLine} d={path} />
      {handle(0, x1, y1, 0, 0)}
      {handle(1, x2, y2, 1, 1)}
    </svg>
  );
}

/** The presets of the speed of a transition, and its curve with its two handles. */
function SpeedRows(props: {
  readonly curve: SpeedCurve | undefined;
  readonly overshoot: boolean;
  readonly readOnly: boolean;
  readonly onCommit: (curve: SpeedCurve | undefined) => void;
}) {
  const { curve, overshoot, readOnly, onCommit } = props;
  const { t } = useTranslation();
  const preset = presetOf(curve);
  return (
    <>
      <div className={styles.row} role="group" aria-label={t("transition.speed")}>
        <span className={styles.name}>{t("transition.speed")}</span>
        <div className={styles.presets}>
          {SPEED_PRESET_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={styles.preset}
              aria-pressed={preset === id}
              disabled={readOnly}
              onClick={() => {
                if (preset !== id) onCommit(curveOfPreset(id));
              }}
            >
              {t(`transition.presets.${id}`)}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.curveRow}>
        <CurveEditor curve={curve} overshoot={overshoot} readOnly={readOnly} onCommit={onCommit} />
        <p className={styles.transitionHint}>{t("transition.curveHint")}</p>
      </div>
    </>
  );
}

/** The curve as a transition writes it: four plain numbers, or none for an even speed. */
const writtenAs = (curve: SpeedCurve | undefined): [number, number, number, number] | undefined =>
  curve ? [curve[0], curve[1], curve[2], curve[3]] : undefined;

/**
 * What a selected transition is: how long it takes and how it gets along, which is all people set,
 * and what it is, which can be another one that comes with the editor. It has no keys, and a change
 * is a step right away, as with trimming: nothing to try first.
 */
export function TransitionProperties({ choice }: { choice: TransitionChoice }) {
  return isJoinChoice(choice) ? (
    <JoinProperties join={choice.join} />
  ) : (
    <EdgeProperties clip={choice.clip} edge={choice.edge} />
  );
}

function EdgeProperties({ clip, edge }: { readonly clip: string; readonly edge: Edge }) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const box = model?.boxes.get(clip);
  const row = model?.rowOfClip.get(clip);
  const transition = box?.clip[edge];
  if (!model || !box || !row || !transition) return null;
  const { rate } = model;
  const media = mediaOfTrack(row.track.kind);
  const name = transitionName(t, transition, edge, media);
  const clipName =
    box.clip.name ?? textOf(t, `timeline.kind.${box.clip.source.kind}`, box.clip.source.kind);
  const readOnly = row.track.locked === true;
  const why = whyNot(model, box, edge);
  const frames = Math.round(edgesOf(box.clip)[edge] * rate.fps);
  const longest = frameContaining(longestTransition(box.clip, edge, model), rate);
  const change = (next: Transition) => timeline.setTransition(box.id, edge, next);
  const withCurve = (curve: SpeedCurve | undefined): Transition => {
    const { curve: _curve, ...rest } = transition;
    const written = writtenAs(curve);
    return written ? { ...rest, curve: written } : rest;
  };
  return (
    <section className={styles.transition} aria-label={name}>
      <header className={styles.header}>
        <span className={styles.title}>{name}</span>
        <span className={styles.kind}>
          {t("transition.of", { clip: clipName, use: t(`transition.uses.${edge}`) })}
        </span>
      </header>
      {readOnly && (
        <div className={styles.hint} role="status">
          <span>{t("transition.locked")}</span>
        </div>
      )}
      {why && (
        <div className={styles.hint} role="status">
          <span>{t(`transition.why.${why}`)}</span>
        </div>
      )}
      <div className={styles.hint}>
        <span>{t("transition.replaceHint")}</span>
        <DeleteButton
          disabled={readOnly}
          onDelete={() => timeline.setTransition(box.id, edge, null)}
        />
      </div>
      <div className={styles.rows}>
        <DurationField
          label={t("transition.duration")}
          frames={frames}
          longest={longest}
          rate={rate}
          readOnly={readOnly}
          onCommit={(wanted) => timeline.setTransitionLength(box.id, edge, frameTime(wanted, rate))}
        />
        <SpeedRows
          curve={transition.curve}
          overshoot={overshoots(transition, media)}
          readOnly={readOnly}
          onCommit={(curve) => change(withCurve(curve))}
        />
      </div>
    </section>
  );
}

/** The clip on a side of a join, as people call it. */
const clipNameOf = (t: ReturnType<typeof useTranslation>["t"], { clip }: ClipBox) =>
  clip.name ?? textOf(t, `timeline.kind.${clip.source.kind}`, clip.source.kind);

/**
 * A selected join: what it is, how long it takes, how it gets along, and where it is around its
 * cut. It goes as long as the clips on both sides leave room for.
 */
function JoinProperties({ join: id }: { readonly join: string }) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const join: JoinBox | undefined = model?.joins.get(id);
  const row = join && model?.rowOfClip.get(join.from.id);
  if (!model || !join || !row) return null;
  const { rate } = model;
  const { transition } = join.join;
  const media = mediaOfTrack(row.track.kind);
  const name = transitionName(t, transition, "join", media);
  const readOnly = row.track.locked === true;
  const align: JoinAlign = transition.align ?? "center";
  const frames = frameContaining(parseTime(transition.duration), rate);
  const longest = frameContaining(timeline.longestJoin(join), rate);
  const update = (changes: Readonly<Record<string, unknown>>) => timeline.updateJoin(id, changes);
  const sides = { from: clipNameOf(t, join.from), to: clipNameOf(t, join.to) };
  return (
    <section className={styles.transition} aria-label={name}>
      <header className={styles.header}>
        <span className={styles.title}>{name}</span>
        <span className={styles.kind}>{t("transition.between", sides)}</span>
      </header>
      {readOnly && (
        <div className={styles.hint} role="status">
          <span>{t("transition.locked")}</span>
        </div>
      )}
      {join.trouble && (
        <div className={styles.hint} role="status">
          <span>{t(`transition.why.join.${join.trouble}`)}</span>
        </div>
      )}
      {join.still.length > 0 && (
        <div className={styles.hint} role="status">
          <span>{t("transition.still")}</span>
        </div>
      )}
      <div className={styles.hint}>
        <span>{t("transition.replaceHint")}</span>
        <DeleteButton disabled={readOnly} onDelete={() => timeline.removeJoin(id)} />
      </div>
      <div className={styles.rows}>
        <DurationField
          label={t("transition.duration")}
          frames={frames}
          longest={longest}
          rate={rate}
          readOnly={readOnly}
          onCommit={(wanted) => {
            if (wanted <= 0) timeline.removeJoin(id);
            else update({ duration: formatTime(frameTime(wanted, rate)) });
          }}
        />
        <div className={styles.row} role="group" aria-label={t("transition.position")}>
          <span className={styles.name}>{t("transition.position")}</span>
          <div className={styles.presets}>
            {JOIN_ALIGNS.map((place) => (
              <button
                key={place}
                type="button"
                className={styles.preset}
                aria-pressed={align === place}
                disabled={readOnly}
                onClick={() => {
                  if (align !== place) update({ align: place });
                }}
              >
                {t(`transition.align.${place}`)}
              </button>
            ))}
          </div>
        </div>
        <SpeedRows
          curve={transition.curve}
          overshoot={overshoots(transition, media)}
          readOnly={readOnly}
          onCommit={(curve) => update({ curve: writtenAs(curve) ?? null })}
        />
      </div>
    </section>
  );
}
