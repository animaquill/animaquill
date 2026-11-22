import {
  REVERB_PRESETS,
  type ObjectDescriptor,
  type PropertySpec,
  type Value,
} from "@animaquill/schema";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type RefObject,
} from "react";
import { useWorkbench } from "../../app/context.ts";
import { useTranslation } from "react-i18next";
import { groupOf } from "../names.ts";
import type { PropertyRows } from "../rows.ts";
import styles from "../PropertiesPanel.module.css";
import {
  EQ_BANDS,
  bandOn,
  dragTo,
  frequencyOf,
  gainOf,
  hasQ,
  isPass,
  qAfterWheel,
  qOf,
  responsePath,
  xOfFrequency,
  yOfGain,
  type EqBand,
} from "./eq-graph.ts";
import { curvePath, kneePoint, ratioAt, shareOfDb, thresholdAt } from "./compressor-graph.ts";
import { CompactField } from "./CompactField.tsx";
import { useEffectValues } from "./values.ts";

/** Room around what a graph draws, so that a point at its edge is all there to grab. */
const PAD = 10;
/** Room on the left and at the bottom of a graph for its numbers. */
const AXIS = 22;
/** A pointer that moves less than this many pixels clicks rather than drags. */
const CLICK_SLOP = 3;
/** The wheel writes one step this long after it stops. */
const WHEEL_REST_MS = 400;
/** The size a graph is drawn at before it knows how wide its place is. */
const FIRST_WIDTH = 300;

interface ViewProps {
  readonly rows: PropertyRows;
  readonly clip: string;
  readonly object: ObjectDescriptor;
  readonly readOnly: boolean;
}

/** How wide an element is on the screen, as it changes: graphs are drawn in its pixels. */
function useWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(FIRST_WIDTH);
  useLayoutEffect(() => {
    const shown = element.current;
    // The observer says it the first time too, before the next frame is drawn.
    if (!shown || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(shown.clientWidth || FIRST_WIDTH));
    observer.observe(shown);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** The part of a graph that its curve takes: inside the room for numbers and grabbing. */
interface Plot {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const plotOf = (width: number, height: number): Plot => ({
  left: AXIS,
  top: PAD,
  width: Math.max(width - AXIS - PAD, 1),
  height: Math.max(height - PAD - AXIS + 6, 1),
});

/** Where a pointer is in a plot, from 0 to 1 each way. */
function shareIn(svg: SVGSVGElement, event: { clientX: number; clientY: number }, plot: Plot) {
  const box = svg.getBoundingClientRect();
  const x = (event.clientX - box.left - plot.left) / plot.width;
  const y = (event.clientY - box.top - plot.top) / plot.height;
  return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
}

/** Frequencies the graph marks, and the levels. */
const FREQUENCY_LINES: readonly (readonly [number, string])[] = [
  [100, "100"],
  [1000, "1k"],
  [10_000, "10k"],
];
const GAIN_LINES: readonly (readonly [number, string])[] = [
  [12, "+12"],
  [0, "0"],
  [-12, "−12"],
];

const signed = (value: number, digits: number) => value.toFixed(digits).replace("-", "−");
const hertz = (value: number) =>
  value >= 1000
    ? `${signed(value / 1000, value >= 10_000 ? 1 : 2)} kHz`
    : `${Math.round(value)} Hz`;

/** What a band is called on its point: its number, and HP and LP for the passes. */
const markOf = (band: EqBand) =>
  band.name === "hp" ? "HP" : band.name === "lp" ? "LP" : String(band.number - 1);

/**
 * The frequency response of an equalizer, with a point for each band: dragged across for its
 * frequency and up and down for its gain, the wheel for the Q of a peak, a double click for 0 dB.
 * The passes sit at the bottom: dragged across, a click turns them on or off. A band that does
 * nothing is hollow. While a point is in a hand, it says what it is set to.
 */
export function EqGraph({ rows, clip, object, readOnly }: ViewProps) {
  const { t } = useTranslation();
  const { values, blocked, preview, commit, cancel } = useEffectValues(rows, clip, object);
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(frame);
  const height = 140;
  const plot = plotOf(width, height);
  const drag = useRef<{ band: EqBand; x: number; y: number; moved: boolean }>(undefined);
  const [held, setHeld] = useState<Readonly<Record<string, Value>>>();
  const [active, setActive] = useState<EqBand>();
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
    setActive(band);
  };
  const move = (event: PointerEvent<SVGElement>) => {
    const pressed = drag.current;
    if (!pressed || !svg.current) return;
    if (
      !pressed.moved &&
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < CLICK_SLOP
    ) {
      return;
    }
    pressed.moved = true;
    const { x, y } = shareIn(svg.current, event, plot);
    const changes = dragTo(pressed.band, x, y);
    setHeld(changes);
    preview(changes);
  };
  const up = () => {
    const pressed = drag.current;
    drag.current = undefined;
    setActive(undefined);
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
    setActive(band);
    wheel.current = {
      changes,
      timer: setTimeout(() => {
        wheel.current = undefined;
        commit(changes);
        setHeld(undefined);
        setActive(undefined);
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

  const xAt = (share: number) => plot.left + share * plot.width;
  const yAt = (share: number) => plot.top + share * plot.height;
  const pointAt = (band: EqBand) =>
    isPass(band)
      ? { x: xAt(xOfFrequency(frequencyOf(shown, band))), y: plot.top + plot.height }
      : { x: xAt(xOfFrequency(frequencyOf(shown, band))), y: yAt(yOfGain(gainOf(shown, band))) };
  const said = active && [
    hertz(frequencyOf(shown, active)),
    ...(isPass(active) ? [] : [`${signed(gainOf(shown, active), 1)} dB`]),
    ...(hasQ(active) ? [`Q ${qOf(shown, active).toFixed(2)}`] : []),
  ];
  const at = active && pointAt(active);

  return (
    <div ref={frame} className={styles.graphFrame}>
      <svg
        ref={svg}
        className={styles.effectGraph}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={t("effect.graph.eq")}
        data-eq-graph=""
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          drag.current = undefined;
          setHeld(undefined);
          setActive(undefined);
          cancel();
        }}
      >
        {FREQUENCY_LINES.map(([frequency, label]) => {
          const x = xAt(xOfFrequency(frequency));
          return (
            <g key={frequency}>
              <line
                className={styles.graphGrid}
                x1={x}
                x2={x}
                y1={plot.top}
                y2={plot.top + plot.height}
              />
              <text className={styles.graphLabel} x={x} y={height - 3} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
        {GAIN_LINES.map(([gain, label]) => {
          const y = yAt(yOfGain(gain));
          return (
            <g key={gain}>
              <line
                className={gain === 0 ? styles.graphAxis : styles.graphGrid}
                x1={plot.left}
                x2={plot.left + plot.width}
                y1={y}
                y2={y}
              />
              <text
                className={styles.graphLabel}
                x={plot.left - 4}
                y={y}
                dy="0.35em"
                textAnchor="end"
              >
                {label}
              </text>
            </g>
          );
        })}
        <path
          className={styles.graphCurve}
          transform={`translate(${plot.left} ${plot.top})`}
          d={responsePath(shown, plot.width, plot.height)}
        />
        {EQ_BANDS.map((band) => {
          const { x, y } = pointAt(band);
          const on = bandOn(shown, band);
          return (
            <g
              key={band.name}
              className={styles.graphPoint}
              data-band={band.name}
              data-on={on || undefined}
              data-pass={isPass(band) || undefined}
              transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
              role="slider"
              aria-label={`${groupOf(t, band.name)} ${t("effect.graph.point")}`}
              aria-valuetext={hertz(frequencyOf(shown, band))}
              onPointerDown={down(band)}
              onDoubleClick={() => {
                if (!still && !isPass(band)) commit({ [`${band.name}.gain`]: 0 });
              }}
            >
              {isPass(band) ? (
                <rect x={-9} y={-7} width={18} height={14} rx={3} />
              ) : (
                <circle r={7} />
              )}
              <text dy="0.35em">{markOf(band)}</text>
            </g>
          );
        })}
        {said && at && (
          <text
            className={styles.graphReading}
            x={Math.min(Math.max(at.x, plot.left + 50), plot.left + plot.width - 50)}
            y={at.y > plot.top + 24 ? at.y - 14 : at.y + 22}
            textAnchor="middle"
            data-reading=""
          >
            {said.join(" / ")}
          </text>
        )}
      </svg>
      <EqBands rows={rows} clip={clip} object={object} readOnly={readOnly} />
    </div>
  );
}

/**
 * The numbers of an equalizer under its graph, a band to a row: frequency, gain and Q of each,
 * with their keys; the passes are on or off, and how steep.
 */
function EqBands({ rows, clip, object, readOnly }: ViewProps) {
  const { t } = useTranslation();
  const specOf = (name: string): PropertySpec | undefined =>
    object.properties.find(({ path }) => path === `${object.id}.${name}`);
  const parts = (band: EqBand) =>
    isPass(band) ? ["freq", "on", "slope"] : hasQ(band) ? ["freq", "gain", "q"] : ["freq", "gain"];
  return (
    <div className={styles.eqBands} role="group" aria-label={t("effect.graph.bands")}>
      {EQ_BANDS.map((band) => {
        const group = groupOf(t, band.name);
        return (
          <div key={band.name} className={styles.eqBand} data-band={band.name}>
            <span className={styles.eqBandName}>{group}</span>
            {parts(band).map((part) => {
              const spec = specOf(`${band.name}.${part}`);
              if (!spec) return <span key={part} />;
              const name = t(`property.name.effect.${part}` as "property.name.effect.freq");
              return (
                <CompactField
                  key={part}
                  rows={rows}
                  clip={clip}
                  spec={spec}
                  label={`${group} ${name}`}
                  readOnly={readOnly}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What a compressor does to levels, as wide as there is room: the knee dragged across sets the
 * threshold, the handle on the line after it sets the ratio; while one is in a hand, the graph says
 * both.
 */
export function CompressorGraph({ rows, clip, object, readOnly }: ViewProps) {
  const { t } = useTranslation();
  const { values, blocked, preview, commit, cancel } = useEffectValues(rows, clip, object);
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const width = useWidth(frame);
  // Square, as wide as there is room next to its meter, at most 220.
  const size = Math.min(Math.max(width - 20, 120), 220);
  const plot = plotOf(size, size);
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
  const xAt = (share: number) => plot.left + share * plot.width;
  const yAt = (share: number) => plot.top + share * plot.height;
  // The handle of the ratio: on the line, a little more than halfway from the knee to 0 dB in.
  const handleIn = shape.threshold + (0 - shape.threshold) * 0.6;
  const handleOut = Math.min(
    shape.threshold + (handleIn - shape.threshold) / Math.max(shape.ratio, 1),
    0,
  );
  const handle = { x: shareOfDb(handleIn), y: 1 - shareOfDb(handleOut) };

  const down = (part: "knee" | "ratio") => (event: PointerEvent<SVGElement>) => {
    if (still || event.button !== 0) return;
    event.stopPropagation();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = part;
    setHeld({});
  };
  const move = (event: PointerEvent<SVGElement>) => {
    const part = drag.current;
    if (!part || !svg.current) return;
    const { x, y } = shareIn(svg.current, event, plot);
    const changes =
      part === "knee" ? { threshold: thresholdAt(x) } : { ratio: ratioAt(shape, x, y) };
    setHeld(changes);
    preview(changes);
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = undefined;
    if (held && Object.keys(held).length > 0) commit(held);
    else cancel();
    setHeld(undefined);
  };
  const curve = curvePath(shape, plot.width, plot.height);
  const ticks = [-12, -24, -36, -48];
  return (
    <div ref={frame} className={styles.graphFrame}>
      <div className={styles.effectGraphs}>
        <svg
          ref={svg}
          className={styles.effectGraphSquare}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
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
          {ticks.map((db) => {
            const share = shareOfDb(db);
            return (
              <g key={db}>
                <line
                  className={styles.graphGrid}
                  x1={plot.left}
                  x2={plot.left + plot.width}
                  y1={yAt(1 - share)}
                  y2={yAt(1 - share)}
                />
                <line
                  className={styles.graphGrid}
                  x1={xAt(share)}
                  x2={xAt(share)}
                  y1={plot.top}
                  y2={plot.top + plot.height}
                />
                <text
                  className={styles.graphLabel}
                  x={plot.left - 4}
                  y={yAt(1 - share)}
                  dy="0.35em"
                  textAnchor="end"
                >
                  {signed(db, 0)}
                </text>
                <text className={styles.graphLabel} x={xAt(share)} y={size - 3} textAnchor="middle">
                  {signed(db, 0)}
                </text>
              </g>
            );
          })}
          <line className={styles.graphAxis} x1={xAt(0)} y1={yAt(1)} x2={xAt(1)} y2={yAt(0)} />
          <g transform={`translate(${plot.left} ${plot.top})`}>
            <path className={styles.graphCurve} d={curve} />
          </g>
          <circle
            className={styles.graphHandle}
            data-part="ratio"
            cx={xAt(handle.x)}
            cy={yAt(handle.y)}
            r={5}
            onPointerDown={down("ratio")}
          />
          <circle
            className={styles.graphKnee}
            data-part="knee"
            cx={xAt(knee.x)}
            cy={yAt(knee.y)}
            r={6}
            onPointerDown={down("knee")}
          />
          {held !== undefined && (
            <text
              className={styles.graphReading}
              x={plot.left + 6}
              y={plot.top + 12}
              data-reading=""
            >
              {`${signed(shape.threshold, 1)} dB / ${shape.ratio.toFixed(1)}:1`}
            </text>
          )}
        </svg>
        <ReductionMeter clip={clip} effect={object.id.slice("effect.".length)} />
      </div>
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

/** A limiter: its meter of gain reduction above its rows, and how much it takes off. */
export function LimiterView({ clip, object }: ViewProps) {
  const { levels } = useWorkbench();
  const { t } = useTranslation();
  const effect = object.id.slice("effect.".length);
  const reduction = useSyncExternalStore(levels.subscribe, () => levels.reductionOf(clip, effect));
  return (
    <div className={styles.reductionRow}>
      <ReductionMeter clip={clip} effect={effect} across />
      <span className={styles.reductionText} data-reduction-text="">
        {t("effect.reductionText", { value: signed(-reduction, 1) })}
      </span>
    </div>
  );
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
