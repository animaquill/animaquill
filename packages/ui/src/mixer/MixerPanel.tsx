import { CLIP_SOUND, type PropertySpec } from "@animaquill/schema";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { writeEdit } from "../properties/inspect.ts";
import { PropertyRows } from "../properties/rows.ts";
import { formatPan, formatVolume, parseVolume } from "../properties/sound-scale.ts";
import type { Row } from "../timeline/model.ts";
import { MASTER_LEFT, MASTER_RIGHT, type MixLevels } from "./levels.ts";
import styles from "./MixerPanel.module.css";
import { useTrackName } from "./names.ts";
import {
  faderAfterDrag,
  faderOfVolume,
  faderText,
  knobAngle,
  levelText,
  meterHeight,
  meterZone,
  panAfterDrag,
  stuckFader,
  stuckPan,
  volumeOfFader,
} from "./scale.ts";
import { trackClipId, withTrackClips } from "./track-clip.ts";

const [VOLUME, PAN] = CLIP_SOUND.properties as [PropertySpec, PropertySpec];
/**
 * The marks along faders and meters, in dB: full scale, where green and yellow end, and the
 * bottom. Faint and without numbers, so that they take no room.
 */
const TICKS = [0, -6, -18, Number.NEGATIVE_INFINITY] as const;
/** How far an arrow key moves a fader, in dB; with Shift a tenth of that. */
const KEY_DECIBELS = 1;
/** How far an arrow key turns a knob; with Shift a tenth of that. */
const KEY_PAN = 0.05;

/**
 * Draws the meters once a frame, at most, when what they show changed: the audio thread sends
 * levels 30 times a second, and the meters are drawn without React, straight into their elements.
 */
class MeterPainter {
  readonly #levels: MixLevels;
  readonly #draws = new Set<() => void>();
  #frame: number | undefined;
  #stop: (() => void) | undefined;

  constructor(levels: MixLevels) {
    this.#levels = levels;
  }

  add(draw: () => void): () => void {
    this.#draws.add(draw);
    draw();
    this.#stop ??= this.#levels.subscribe(this.#schedule);
    return () => {
      this.#draws.delete(draw);
      if (this.#draws.size > 0) return;
      this.#stop?.();
      this.#stop = undefined;
      if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
    };
  }

  #schedule = (): void => {
    this.#frame ??= requestAnimationFrame(() => {
      this.#frame = undefined;
      for (const draw of this.#draws) draw();
    });
  };
}

/** One meter, with its clip light on top, which a click puts out. */
function Meter({ id, label, painter }: { id: string; label: string; painter: MeterPainter }) {
  const { levels } = useWorkbench();
  const { t } = useTranslation();
  const cover = useRef<HTMLDivElement>(null);
  const light = useRef<HTMLButtonElement>(null);
  const meter = useRef<HTMLDivElement>(null);

  useLayoutEffect(
    () =>
      painter.add(() => {
        const shown = levels.shownOf(id);
        const height = meterHeight(shown);
        if (cover.current) cover.current.style.height = `${(1 - height) * 100}%`;
        if (meter.current) {
          meter.current.dataset.level = height > 0 ? shown.toFixed(1) : "";
          meter.current.dataset.zone = height > 0 ? meterZone(shown) : "";
        }
        if (light.current) {
          const on = levels.isClipped(id);
          light.current.toggleAttribute("data-on", on);
          light.current.disabled = !on;
        }
      }),
    [id, levels, painter],
  );

  return (
    <div className={styles.meterColumn}>
      <button
        ref={light}
        type="button"
        className={styles.clipLight}
        aria-label={t("mixer.clipLight", { name: label })}
        title={t("mixer.clipTip")}
        onClick={() => levels.resetClip(id)}
      />
      <div
        ref={meter}
        className={styles.meter}
        role="img"
        aria-label={t("mixer.meter", { name: label })}
      >
        <div ref={cover} className={styles.meterCover} />
        {TICKS.map((dbfs) => (
          <div
            key={dbfs}
            className={styles.tick}
            style={{ bottom: `${meterHeight(dbfs) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

interface FaderProps {
  readonly label: string;
  readonly decibels: number;
  readonly readOnly: boolean;
  readonly animated: boolean;
  readonly onMove: (decibels: number) => void;
  readonly onLetGo: (decibels: number) => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
}

/**
 * A fader, up and down, on the scale of the volume line: it moves with the pointer from wherever
 * it is grabbed, Shift a tenth as far, and sticks at 0 dB. Letting go writes one step; a double
 * click goes back to 0 dB.
 */
function Fader(props: FaderProps) {
  const { label, decibels, readOnly, animated, onMove, onLetGo, onCancel, onReset } = props;
  const travel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; raw: number }>(undefined);
  const [held, setHeld] = useState<number>();
  const height = held ?? faderOfVolume(decibels);
  const shownDecibels = held === undefined ? decibels : volumeOfFader(held);
  const travelOf = () => travel.current?.getBoundingClientRect().height ?? 0;

  const letGo = () => {
    drag.current = undefined;
    if (held === undefined) return;
    setHeld(undefined);
    onLetGo(volumeOfFader(held));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const by = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
    if (by === 0) return;
    event.preventDefault();
    const next = Math.round((shownDecibels + by * KEY_DECIBELS * (event.shiftKey ? 0.1 : 1)) * 10);
    const value = volumeOfFader(faderOfVolume(next / 10));
    setHeld(faderOfVolume(value));
    onMove(value);
  };

  return (
    <div
      ref={travel}
      className={styles.fader}
      role="slider"
      tabIndex={readOnly ? -1 : 0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(height * 100)}
      aria-valuetext={formatVolume(shownDecibels)}
      aria-readonly={readOnly || undefined}
      data-animated={animated || undefined}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (readOnly || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, raw: height };
      }}
      onPointerMove={(event) => {
        const pressed = drag.current;
        if (!pressed || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const raw = faderAfterDrag(
          pressed.raw,
          event.clientY - pressed.y,
          travelOf(),
          event.shiftKey,
        );
        drag.current = { y: event.clientY, raw };
        const shown = stuckFader(raw, travelOf(), event.shiftKey);
        setHeld(shown);
        onMove(volumeOfFader(shown));
      }}
      onPointerUp={letGo}
      onPointerCancel={() => {
        drag.current = undefined;
        setHeld(undefined);
        onCancel();
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") letGo();
      }}
      onBlur={letGo}
      onDoubleClick={() => {
        if (!readOnly) onReset();
      }}
    >
      <div className={styles.faderGroove} />
      {TICKS.map((mark) => (
        <div
          key={mark}
          className={mark === 0 ? styles.faderUnity : styles.faderTick}
          style={{ bottom: `${faderOfVolume(mark) * 100}%` }}
        />
      ))}
      <div className={styles.faderCap} style={{ bottom: `${height * 100}%` }} />
    </div>
  );
}

interface KnobProps {
  readonly label: string;
  readonly pan: number;
  readonly readOnly: boolean;
  readonly animated: boolean;
  readonly onMove: (pan: number) => void;
  readonly onLetGo: (pan: number) => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
}

/** The pan, a knob turned by dragging up (right) and down (left); a double click centres it. */
function Knob(props: KnobProps) {
  const { label, pan, readOnly, animated, onMove, onLetGo, onCancel, onReset } = props;
  const drag = useRef<{ y: number; raw: number }>(undefined);
  const [held, setHeld] = useState<number>();
  const shown = held ?? pan;

  const letGo = () => {
    drag.current = undefined;
    if (held === undefined) return;
    setHeld(undefined);
    onLetGo(held);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (readOnly) return;
    const by =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (by === 0) return;
    event.preventDefault();
    const next = stuckPan(
      Math.min(Math.max(shown + by * KEY_PAN * (event.shiftKey ? 0.1 : 1), -1), 1),
      true,
    );
    setHeld(next);
    onMove(next);
  };

  const text = formatPan(shown);
  return (
    <div className={styles.knobArea}>
      <div
        className={styles.knob}
        role="slider"
        tabIndex={readOnly ? -1 : 0}
        aria-label={label}
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        aria-valuetext={text}
        aria-readonly={readOnly || undefined}
        data-animated={animated || undefined}
        onPointerDown={(event) => {
          if (readOnly || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, raw: shown };
        }}
        onPointerMove={(event) => {
          const pressed = drag.current;
          if (!pressed || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const raw = panAfterDrag(pressed.raw, event.clientY - pressed.y, event.shiftKey);
          drag.current = { y: event.clientY, raw };
          const next = stuckPan(raw, event.shiftKey);
          setHeld(next);
          onMove(next);
        }}
        onPointerUp={letGo}
        onPointerCancel={() => {
          drag.current = undefined;
          setHeld(undefined);
          onCancel();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key.startsWith("Arrow")) letGo();
        }}
        onBlur={letGo}
        onDoubleClick={() => {
          if (!readOnly) onReset();
        }}
      >
        <svg viewBox="-12 -12 24 24" aria-hidden="true">
          <circle className={styles.knobBody} r="10" />
          <line
            className={styles.knobPointer}
            x1="0"
            y1="-3"
            x2="0"
            y2="-9"
            transform={`rotate(${knobAngle(shown)})`}
          />
        </svg>
      </div>
      <span className={styles.knobText} data-animated={animated || undefined} aria-hidden="true">
        {text}
      </span>
    </div>
  );
}

/** The volume as a number under the fader, to type one. */
function VolumeBox({
  label,
  decibels,
  readOnly,
  onCommit,
}: {
  label: string;
  decibels: number;
  readOnly: boolean;
  onCommit: (decibels: number) => void;
}) {
  const [typing, setTyping] = useState<string>();
  const done = (text: string) => {
    setTyping(undefined);
    const value = parseVolume(text);
    if (value !== undefined && value !== decibels) onCommit(value);
  };
  return (
    <input
      className={styles.volumeBox}
      aria-label={label}
      value={typing ?? faderText(decibels)}
      readOnly={readOnly}
      spellCheck={false}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setTyping(event.target.value)}
      onBlur={(event) => {
        if (typing !== undefined) done(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") done(event.currentTarget.value);
        if (event.key === "Escape") {
          event.stopPropagation();
          setTyping(undefined);
        }
      }}
    />
  );
}

/** The name on top of a strip: a click selects the track, a double click renames it. */
function StripName({ row, name, selected }: { row: Row; name: string; selected: boolean }) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const finish = (next: string | undefined) => {
    setRenaming(false);
    if (next !== undefined && next !== name) timeline.updateTrack(row.id, { name: next });
  };
  if (renaming) {
    return (
      <input
        ref={input}
        className={styles.nameInput}
        aria-label={t("timeline.trackName")}
        defaultValue={name}
        spellCheck={false}
        autoFocus
        onBlur={(event) => finish(event.target.value.trim() || undefined)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.stopPropagation();
            finish(undefined);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={styles.name}
      aria-pressed={selected}
      title={name}
      onClick={() => timeline.selectTrack(row.id)}
      onDoubleClick={() => setRenaming(true)}
    >
      {name}
    </button>
  );
}

/** A property of a track at the playhead, which a strip follows by itself as it changes. */
function useTrackProperty(rows: PropertyRows, clip: string, spec: PropertySpec) {
  useSyncExternalStore(rows.subscribe, () => rows.signatureOf(clip, spec));
  return rows.inspect(clip, spec);
}

interface StripProps {
  readonly row: Row;
  readonly rows: PropertyRows;
  readonly painter: MeterPainter;
  readonly selected: boolean;
}

/** The strip of a track of sound: pan, fader and meter, the volume as a number, M and S. */
function Strip({ row, rows, painter, selected }: StripProps) {
  const { properties, timeline } = useWorkbench();
  const { t } = useTranslation();
  const nameOf = useTrackName();
  const name = nameOf(row);
  const clip = trackClipId(row.id);
  const volume = useTrackProperty(rows, clip, VOLUME);
  const pan = useTrackProperty(rows, clip, PAN);
  /** The volume while the fader is in somebody's hands, for its number. */
  const [moving, setMoving] = useState<number>();
  const { track } = row;
  if (track.kind !== "audio" || !volume || !pan) return null;
  const readOnly = volume.blocked !== undefined;

  /** What goes where people work: at the playhead, a key there when there are keys. */
  const edit = (spec: PropertySpec, value: number) => {
    const now = rows.inspect(clip, spec);
    return now && now.blocked === undefined ? writeEdit(clip, now.row, now.time, value) : undefined;
  };
  const preview = (spec: PropertySpec) => (value: number) => {
    properties.noteProperty(clip, spec);
    const one = edit(spec, value);
    if (one) properties.preview([one]);
  };
  const commit = (spec: PropertySpec) => (value: number) => {
    const one = edit(spec, value);
    if (one) properties.commit([one]);
    else properties.cancel();
  };
  const decibels = typeof volume.row.value === "number" ? volume.row.value : 0;
  const panValue = typeof pan.row.value === "number" ? pan.row.value : 0;

  return (
    <div
      className={styles.strip}
      role="group"
      aria-label={name}
      data-selected={selected || undefined}
    >
      <StripName row={row} name={name} selected={selected} />
      <Knob
        label={t("mixer.pan", { name })}
        pan={panValue}
        readOnly={readOnly}
        animated={pan.row.animated}
        onMove={preview(PAN)}
        onLetGo={commit(PAN)}
        onCancel={() => properties.cancel()}
        onReset={() => commit(PAN)(0)}
      />
      <div className={styles.faderArea}>
        <Fader
          label={t("mixer.volume", { name })}
          decibels={decibels}
          readOnly={readOnly}
          animated={volume.row.animated}
          onMove={(value) => {
            setMoving(value);
            preview(VOLUME)(value);
          }}
          onLetGo={(value) => {
            setMoving(undefined);
            commit(VOLUME)(value);
          }}
          onCancel={() => {
            setMoving(undefined);
            properties.cancel();
          }}
          onReset={() => commit(VOLUME)(0)}
        />
        <Meter id={row.id} label={name} painter={painter} />
      </div>
      <VolumeBox
        label={t("mixer.volumeNumber", { name })}
        decibels={moving ?? decibels}
        readOnly={readOnly}
        onCommit={commit(VOLUME)}
      />
      <div className={styles.switches}>
        <button
          type="button"
          className={`${styles.switch} ${styles.mute}`}
          aria-pressed={track.muted === true}
          aria-label={t("timeline.mute", { track: name })}
          title={t("timeline.mute", { track: name })}
          onClick={() => timeline.updateTrack(row.id, { muted: track.muted !== true })}
        >
          M
        </button>
        <button
          type="button"
          className={`${styles.switch} ${styles.solo}`}
          aria-pressed={track.solo === true}
          aria-label={t("timeline.solo", { track: name })}
          title={t("timeline.solo", { track: name })}
          onClick={() => timeline.updateTrack(row.id, { solo: track.solo !== true })}
        >
          S
        </button>
      </div>
    </div>
  );
}

/** What the master meters say in numbers: the short-term loudness, and the largest true peak. */
function MasterReadout({ painter }: { painter: MeterPainter }) {
  const { levels } = useWorkbench();
  const { t } = useTranslation();
  const loudness = useRef<HTMLSpanElement>(null);
  const peak = useRef<HTMLSpanElement>(null);
  useLayoutEffect(
    () =>
      painter.add(() => {
        if (loudness.current) loudness.current.textContent = levelText(levels.shortTerm);
        if (peak.current) peak.current.textContent = levelText(levels.truePeak);
      }),
    [levels, painter],
  );
  return (
    <div className={styles.readout}>
      <div
        className={styles.reading}
        aria-label={t("mixer.loudness")}
        title={t("mixer.loudnessTip")}
        role="group"
      >
        <span ref={loudness} className={styles.readingValue} data-testid="mixer-loudness" />
        <span className={styles.readingUnit}>LUFS</span>
      </div>
      <button
        type="button"
        className={styles.reading}
        aria-label={t("mixer.truePeak")}
        title={t("mixer.truePeakTip")}
        onClick={() => levels.resetTruePeak()}
      >
        <span ref={peak} className={styles.readingValue} data-testid="mixer-true-peak" />
        <span className={styles.readingUnit}>dBTP</span>
      </button>
    </div>
  );
}

/** The master: both sides metered, its loudness and true peak. */
function MasterStrip({ painter }: { painter: MeterPainter }) {
  const { t } = useTranslation();
  const name = t("mixer.master");
  return (
    <div className={styles.master} role="group" aria-label={name}>
      <div className={styles.masterName}>{name}</div>
      <div className={styles.masterBody}>
        <div className={styles.masterMeters}>
          <Meter id={MASTER_LEFT} label={t("mixer.left", { name })} painter={painter} />
          <Meter id={MASTER_RIGHT} label={t("mixer.right", { name })} painter={painter} />
        </div>
        <MasterReadout painter={painter} />
      </div>
    </div>
  );
}

/**
 * The mixer: a strip for each track of sound, in the order of the timeline, then the master, which
 * stays on the right while the strips scroll. Faders and knobs are the volume and pan of the
 * tracks, written as the properties tab writes them.
 */
export function MixerPanel() {
  const { timeline, trials, levels } = useWorkbench();
  const { store } = useSession();
  useProject(store);
  const { model, track: selected } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const painter = useMemo(() => new MeterPainter(levels), [levels]);
  const rows = useMemo(() => {
    const shown = {
      get model() {
        const now = timeline.getSnapshot().model;
        return now && withTrackClips(now);
      },
      get frame() {
        return timeline.frame;
      },
      subscribe: timeline.subscribe,
      subscribeView: timeline.subscribeView,
    };
    return new PropertyRows({ timeline: shown, trials, state: () => store?.getState() });
  }, [timeline, trials, store]);
  const sound = model?.rows.filter((row) => row.track.kind === "audio" && !row.gone) ?? [];
  const strips = useRef<HTMLDivElement>(null);

  // The selected track comes into view.
  useEffect(() => {
    if (selected === undefined) return;
    const strip = strips.current?.querySelector<HTMLElement>("[data-selected]");
    strip?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    <div className={styles.panel}>
      <div ref={strips} className={styles.strips}>
        {sound.map((row) => (
          <Strip
            key={row.id}
            row={row}
            rows={rows}
            painter={painter}
            selected={row.id === selected}
          />
        ))}
      </div>
      <MasterStrip painter={painter} />
    </div>
  );
}
