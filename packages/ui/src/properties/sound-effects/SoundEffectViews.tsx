import { REVERB_PRESETS, type ObjectDescriptor, type Value } from "@animaquill/schema";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from "react";
import { useWorkbench } from "../../app/context.ts";
import { useTranslation } from "react-i18next";
import type { PropertyRows } from "../rows.ts";
import styles from "../PropertiesPanel.module.css";
import {
  EQ_BANDS,
  bandOn,
  dragTo,
  hasQ,
  isPass,
  pointOf,
  qAfterWheel,
  qOf,
  responsePath,
  xOfFrequency,
  yOfGain,
  type EqBand,
} from "./eq-graph.ts";
import { curvePath, kneePoint, ratioAt, thresholdAt } from "./compressor-graph.ts";
import { useEffectValues } from "./values.ts";

/** The size the graphs are drawn at; they stretch to the width of the tab. */
const WIDTH = 300;
const HEIGHT = 120;
/** Room around what a graph draws, so that a point at its edge is all there to grab. */
const PAD = 8;
/** A pointer that moves less than this many pixels clicks rather than drags. */
const CLICK_SLOP = 3;
/** The wheel writes one step this long after it stops. */
const WHEEL_REST_MS = 400;

interface ViewProps {
  readonly rows: PropertyRows;
  readonly clip: string;
  readonly object: ObjectDescriptor;
  readonly readOnly: boolean;
}

/**
 * Where a pointer is in an SVG drawn `width` × `height` with `PAD` around what it draws, from 0 to 1
 * each way within that.
 */
function shareIn(
  svg: SVGSVGElement,
  event: { clientX: number; clientY: number },
  width: number,
  height: number,
) {
  const box = svg.getBoundingClientRect();
  const padX = (PAD / width) * box.width;
  const padY = (PAD / height) * box.height;
  const inner = { width: box.width - 2 * padX, height: box.height - 2 * padY };
  const x = inner.width > 0 ? (event.clientX - box.left - padX) / inner.width : 0;
  const y = inner.height > 0 ? (event.clientY - box.top - padY) / inner.height : 0;
  return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
}

/** The part of a graph inside its padding, where what it draws goes. */
const inside = (width: number, height: number) =>
  `translate(${PAD} ${PAD}) scale(${(width - 2 * PAD) / width} ${(height - 2 * PAD) / height})`;

/** Frequencies the graph marks, and the levels. */
const FREQUENCY_LINES = [100, 1000, 10_000];
const GAIN_LINES = [12, 0, -12];

/**
 * The frequency response of an equalizer, with a numbered point for each band: dragged across for
 * its frequency and up and down for its gain, the wheel for the Q of a peak, a double click for
 * 0 dB; a click on the point of a pass turns it on or off. A band that does nothing is hollow.
 */
export function EqGraph({ rows, clip, object, readOnly }: ViewProps) {
  const { t } = useTranslation();
  const { values, blocked, preview, commit, cancel } = useEffectValues(rows, clip, object);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ band: EqBand; x: number; y: number; moved: boolean }>(undefined);
  const [held, setHeld] = useState<Readonly<Record<string, Value>>>();
  const wheel = useRef<{ timer: ReturnType<typeof setTimeout>; changes: Record<string, Value> }>(
    undefined,
  );
  useEffect(() => () => clearTimeout(wheel.current?.timer), []);

  const shown = held ? { ...values, ...held } : values;
  const still = readOnly || blocked;

  const down = (band: EqBand) => (event: PointerEvent<SVGElement>) => {
    if (still || event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = { band, x: event.clientX, y: event.clientY, moved: false };
  };
  const move = (event: PointerEvent<SVGElement>) => {
    const pressed = drag.current;
    if (!pressed || !svg.current) return;
    if (
      !pressed.moved &&
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < CLICK_SLOP
    )
      return;
    pressed.moved = true;
    const { x, y } = shareIn(svg.current, event, WIDTH, HEIGHT);
    const changes = dragTo(pressed.band, x, y);
    setHeld(changes);
    preview(changes);
  };
  const up = () => {
    const pressed = drag.current;
    drag.current = undefined;
    if (!pressed) return;
    if (pressed.moved) {
      if (held) commit(held);
      else cancel();
    } else if (isPass(pressed.band)) {
      commit({ [`${pressed.band.name}.on`]: !bandOn(values, pressed.band) });
    }
    setHeld(undefined);
  };
  const onWheel = (band: EqBand, event: WheelEvent): void => {
    if (still || !hasQ(band) || event.deltaY === 0) return;
    event.preventDefault();
    const was = wheel.current;
    const q = qAfterWheel(
      Number(was?.changes[`${band.name}.q`] ?? qOf(values, band)),
      event.deltaY < 0 ? 1 : -1,
    );
    const changes = { ...was?.changes, [`${band.name}.q`]: q };
    clearTimeout(was?.timer);
    preview(changes);
    setHeld(changes);
    wheel.current = {
      changes,
      timer: setTimeout(() => {
        wheel.current = undefined;
        commit(changes);
        setHeld(undefined);
      }, WHEEL_REST_MS),
    };
  };

  // Not through React, whose wheel listener cannot keep the tab from scrolling.
  const wheelOn = useRef(onWheel);
  useLayoutEffect(() => {
    wheelOn.current = onWheel;
  });
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const listen = (event: WheelEvent) => {
      const name = (event.target as Element | null)
        ?.closest("[data-band]")
        ?.getAttribute("data-band");
      const band = EQ_BANDS.find((one) => one.name === name);
      if (band) wheelOn.current(band, event);
    };
    element.addEventListener("wheel", listen, { passive: false });
    return () => element.removeEventListener("wheel", listen);
  }, [svg]);

  return (
    <svg
      ref={svg}
      className={styles.effectGraph}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="group"
      aria-label={t("effect.graph.eq")}
      data-eq-graph=""
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = undefined;
        setHeld(undefined);
        cancel();
      }}
    >
      <g transform={inside(WIDTH, HEIGHT)}>
        {FREQUENCY_LINES.map((frequency) => (
          <line
            key={frequency}
            className={styles.graphGrid}
            x1={xOfFrequency(frequency) * WIDTH}
            x2={xOfFrequency(frequency) * WIDTH}
            y1={0}
            y2={HEIGHT}
          />
        ))}
        {GAIN_LINES.map((gain) => (
          <line
            key={gain}
            className={gain === 0 ? styles.graphAxis : styles.graphGrid}
            x1={0}
            x2={WIDTH}
            y1={yOfGain(gain) * HEIGHT}
            y2={yOfGain(gain) * HEIGHT}
          />
        ))}
        <path className={styles.graphCurve} d={responsePath(shown, WIDTH, HEIGHT)} />
      </g>
      {EQ_BANDS.map((band) => {
        const { x, y } = pointOf(shown, band);
        const on = bandOn(shown, band);
        const px = PAD + x * (WIDTH - 2 * PAD);
        const py = PAD + y * (HEIGHT - 2 * PAD);
        return (
          <g
            key={band.name}
            className={styles.graphPoint}
            data-band={band.name}
            data-on={on || undefined}
            transform={`translate(${px.toFixed(1)} ${py.toFixed(1)})`}
            role="slider"
            aria-label={t("effect.graph.band", { name: band.number })}
            aria-valuetext={`${Math.round(Number(shown[`${band.name}.freq`] ?? 0))} Hz`}
            onPointerDown={down(band)}
            onDoubleClick={() => {
              if (!still && !isPass(band)) commit({ [`${band.name}.gain`]: 0 });
            }}
          >
            <circle r={7} />
            <text dy="0.35em">{band.number}</text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * What a compressor does to levels: the knee dragged across sets the threshold, the line after it
 * dragged sets the ratio.
 */
export function CompressorGraph({ rows, clip, object, readOnly }: ViewProps) {
  const { t } = useTranslation();
  const { values, blocked, preview, commit, cancel } = useEffectValues(rows, clip, object);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<"knee" | "ratio">(undefined);
  const [held, setHeld] = useState<Readonly<Record<string, Value>>>();
  const number = (name: string, fallback: number) => {
    const value = held?.[name] ?? values[name];
    return typeof value === "number" ? value : fallback;
  };
  const shape = {
    threshold: number("threshold", 0),
    ratio: number("ratio", 1),
    knee: number("knee", 6),
  };
  const still = readOnly || blocked;
  const knee = kneePoint(shape);
  const SIZE = HEIGHT;

  const down = (part: "knee" | "ratio") => (event: PointerEvent<SVGElement>) => {
    if (still || event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = part;
  };
  const move = (event: PointerEvent<SVGElement>) => {
    const part = drag.current;
    if (!part || !svg.current) return;
    const { x, y } = shareIn(svg.current, event, SIZE, SIZE);
    const changes =
      part === "knee" ? { threshold: thresholdAt(x) } : { ratio: ratioAt(shape, x, y) };
    setHeld(changes);
    preview(changes);
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = undefined;
    if (held) commit(held);
    else cancel();
    setHeld(undefined);
  };
  const curve = curvePath(shape, SIZE, SIZE);
  return (
    <div className={styles.effectGraphs}>
      <svg
        ref={svg}
        className={styles.effectGraphSquare}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="group"
        aria-label={t("effect.graph.compressor")}
        data-compressor-graph=""
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          drag.current = undefined;
          setHeld(undefined);
          cancel();
        }}
      >
        <g transform={inside(SIZE, SIZE)}>
          {[-12, -24, -36, -48].map((db) => {
            const at = (1 - (db + 60) / 60) * SIZE;
            return (
              <g key={db}>
                <line className={styles.graphGrid} x1={0} x2={SIZE} y1={at} y2={at} />
                <line className={styles.graphGrid} x1={SIZE - at} x2={SIZE - at} y1={0} y2={SIZE} />
              </g>
            );
          })}
          <line className={styles.graphAxis} x1={0} y1={SIZE} x2={SIZE} y2={0} />
          <path className={styles.graphCurve} d={curve} />
          <path
            className={styles.graphHit}
            d={curve}
            data-part="ratio"
            onPointerDown={down("ratio")}
          />
        </g>
        <circle
          className={styles.graphKnee}
          data-part="knee"
          cx={PAD + knee.x * (SIZE - 2 * PAD)}
          cy={PAD + knee.y * (SIZE - 2 * PAD)}
          r={6}
          onPointerDown={down("knee")}
        />
      </svg>
      <ReductionMeter clip={clip} effect={object.id.slice("effect.".length)} />
    </div>
  );
}

/** How far down a meter of gain reduction goes, in dB. */
const MOST_REDUCTION = 24;

/**
 * How much a compressor or a limiter takes off while playing: a bar that grows down from the top,
 * 0 to 24 dB.
 */
export function ReductionMeter({
  clip,
  effect,
  across = false,
}: {
  clip: string;
  effect: string;
  /** Lying down, growing from the left, as a limiter has it under its rows. */
  across?: boolean;
}) {
  const { levels } = useWorkbench();
  const { t } = useTranslation();
  const reduction = useSyncExternalStore(levels.subscribe, () => levels.reductionOf(clip, effect));
  const share = Math.min(Math.max(reduction / MOST_REDUCTION, 0), 1);
  return (
    <div
      className={across ? styles.reductionAcross : styles.reduction}
      role="meter"
      aria-label={t("effect.reduction")}
      aria-valuemin={0}
      aria-valuemax={MOST_REDUCTION}
      aria-valuenow={Number(reduction.toFixed(1))}
      data-reduction=""
    >
      <div
        className={styles.reductionBar}
        style={across ? { width: `${share * 100}%` } : { height: `${share * 100}%` }}
      />
    </div>
  );
}

/** A limiter: its meter of gain reduction above its rows. */
export function LimiterView({ clip, object }: ViewProps) {
  return <ReductionMeter clip={clip} effect={object.id.slice("effect.".length)} across />;
}

/** Rooms to start a reverb from: picking one writes all it sets, in one step. */
export function ReverbPresets({ rows, clip, object, readOnly }: ViewProps) {
  const { t } = useTranslation();
  const { values, blocked, commit } = useEffectValues(rows, clip, object);
  // The room that the values are, when they are one.
  const room =
    Object.entries(REVERB_PRESETS).find(([, preset]) =>
      Object.entries(preset).every(([name, value]) => values[name] === value),
    )?.[0] ?? "";
  return (
    <div className={styles.row} role="group" aria-label={t("effect.reverbPreset")}>
      <span className={styles.name}>{t("effect.reverbPreset")}</span>
      <select
        className={styles.choice}
        aria-label={t("effect.reverbPreset")}
        value={room}
        disabled={readOnly || blocked}
        onChange={(event) => {
          const preset = REVERB_PRESETS[event.target.value];
          if (preset) commit(preset);
        }}
      >
        <option value="" disabled>
          —
        </option>
        {Object.keys(REVERB_PRESETS).map((name) => (
          <option key={name} value={name}>
            {t(`effect.presets.${name}` as "effect.presets.room")}
          </option>
        ))}
      </select>
    </div>
  );
}
