import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { NumberControl, type ControlProps } from "./controls.tsx";
import styles from "./PropertiesPanel.module.css";
import {
  formatPan,
  formatVolume,
  heightOfVolume,
  roundedVolume,
  UNITY_HEIGHT,
  volumeOfHeight,
} from "./sound-scale.ts";

/** How far an arrow key moves a slider, as a share of it; Shift goes ten times as far. */
const KEY_STEP = 0.01;
/** How close to its mark a drag sticks to it, in pixels. */
const MARK_REACH = 4;
/** How far a press goes before it is a drag rather than a click, in pixels. */
const CLICK_REACH = 2;
/**
 * How long a click waits before it writes: a second click within this is a double click, which
 * goes back to the mark instead, as one step to undo.
 */
const DOUBLE_CLICK_MS = 350;

interface SliderProps {
  readonly label: string;
  /** Where it is, from 0 at the left to 1 at the right. */
  readonly at: number;
  readonly text: string;
  readonly readOnly: boolean;
  readonly animated: boolean;
  readonly tried: boolean;
  /** Where the mark is, as a share: the middle of the pan, 0 dB of the volume. A drag sticks to it. */
  readonly mark: number;
  /** Where people drag it to, as a share, which a control turns into a value. */
  readonly onMove: (at: number) => void;
  readonly onLetGo: (at: number) => void;
  readonly onCancel: () => void;
  /** A double click: back to where it starts. */
  readonly onReset: () => void;
}

/**
 * A small slider along a row: dragging it shows the value as it goes, letting go writes it as one
 * step. Arrow keys move it a little, and a key that comes up writes it.
 */
function Slider(props: SliderProps) {
  const { label, at, text, readOnly, animated, tried, mark, onMove, onLetGo, onCancel } = props;
  const track = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<number>();
  /** A click that writes once it is not the first of a double click. */
  const waiting = useRef<{ timer: ReturnType<typeof setTimeout>; share: number }>(undefined);
  const press = useRef<{ x: number; moved: boolean }>(undefined);
  const shown = held ?? at;
  const letGoRef = useRef(onLetGo);
  useEffect(() => {
    letGoRef.current = onLetGo;
  });

  // A click that is still waiting is written when the control goes.
  useEffect(
    () => () => {
      const pending = waiting.current;
      if (!pending) return;
      clearTimeout(pending.timer);
      letGoRef.current(pending.share);
    },
    [],
  );

  const shareAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return shown;
    const share = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
    return Math.abs(share - mark) * box.width <= MARK_REACH ? mark : share;
  };

  /** Writes a click that waited, now: something else is about to happen. */
  const flush = () => {
    const pending = waiting.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting.current = undefined;
    onLetGo(pending.share);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (readOnly || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { x: event.clientX, moved: false };
    const share = shareAt(event.clientX);
    setHeld(share);
    onMove(share);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const step = (event.shiftKey ? 10 : 1) * KEY_STEP;
    const by =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? step
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -step
          : 0;
    if (by === 0) return;
    event.preventDefault();
    flush();
    const share = Math.min(Math.max(shown + by, 0), 1);
    setHeld(share);
    onMove(share);
  };

  const letGo = () => {
    if (held === undefined) return;
    setHeld(undefined);
    const clicked = press.current !== undefined && !press.current.moved;
    press.current = undefined;
    if (!clicked) {
      flush();
      onLetGo(held);
      return;
    }
    // A click shows where it goes at once, and writes it once it is no double click.
    if (waiting.current) clearTimeout(waiting.current.timer);
    const share = held;
    waiting.current = {
      share,
      timer: setTimeout(() => {
        waiting.current = undefined;
        letGoRef.current(share);
      }, DOUBLE_CLICK_MS),
    };
  };

  return (
    <div
      ref={track}
      className={styles.slider}
      role="slider"
      tabIndex={readOnly ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      aria-valuetext={text}
      aria-readonly={readOnly || undefined}
      data-animated={animated || undefined}
      data-tried={tried || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (held === undefined || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const pressed = press.current;
        if (pressed && Math.abs(event.clientX - pressed.x) > CLICK_REACH) pressed.moved = true;
        const share = shareAt(event.clientX);
        setHeld(share);
        onMove(share);
      }}
      onPointerUp={letGo}
      onPointerCancel={() => {
        setHeld(undefined);
        press.current = undefined;
        onCancel();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key.startsWith("Arrow")) letGo();
      }}
      onBlur={() => {
        letGo();
        flush();
      }}
      onDoubleClick={() => {
        if (readOnly) return;
        // The clicks of it wrote nothing yet: going back is the one step.
        if (waiting.current) clearTimeout(waiting.current.timer);
        waiting.current = undefined;
        props.onReset();
      }}
    >
      <div className={styles.sliderTrack} />
      <div className={styles.sliderMark} style={{ left: `${mark * 100}%` }} />
      <div className={styles.sliderKnob} style={{ left: `${shown * 100}%` }} />
    </div>
  );
}

const volumeOf = (row: ControlProps["row"]) => (typeof row.value === "number" ? row.value : 0);

/** The volume: a slider from −∞ to +24 dB, with 0 dB a third from the right, and its number. */
export function VolumeControl(props: ControlProps) {
  const { row, label, readOnly, onPreview, onCommit, onCancel } = props;
  const volume = volumeOf(row);
  const valueOf = (at: number) => roundedVolume(volumeOfHeight(at));
  return (
    <div className={styles.soundControl}>
      <Slider
        label={label}
        at={heightOfVolume(volume)}
        text={formatVolume(volume)}
        readOnly={readOnly}
        animated={row.animated}
        tried={row.tried}
        onMove={(at) => onPreview(valueOf(at))}
        onLetGo={(at) => onCommit(valueOf(at))}
        onCancel={onCancel}
        onReset={() => onCommit(0)}
        mark={UNITY_HEIGHT}
      />
      <div className={styles.soundNumber}>
        <NumberControl {...props} />
      </div>
    </div>
  );
}

/** Where a sound sits: a slider from left to right with its middle marked, and "L 50", "C", "R 30". */
export function PanControl(props: ControlProps) {
  const { row, label, readOnly, onPreview, onCommit, onCancel } = props;
  const pan = typeof row.value === "number" ? row.value : 0;
  const valueOf = (at: number) => Math.round((at * 2 - 1) * 100) / 100;
  const text = formatPan(pan);
  return (
    <div className={styles.soundControl}>
      <Slider
        label={label}
        at={(Math.min(Math.max(pan, -1), 1) + 1) / 2}
        text={text}
        readOnly={readOnly}
        animated={row.animated}
        tried={row.tried}
        mark={0.5}
        onMove={(at) => onPreview(valueOf(at))}
        onLetGo={(at) => onCommit(valueOf(at))}
        onCancel={onCancel}
        onReset={() => onCommit(0)}
      />
      <span
        className={styles.panText}
        data-animated={row.animated || undefined}
        data-tried={row.tried || undefined}
        aria-hidden="true"
      >
        {text}
      </span>
    </div>
  );
}
