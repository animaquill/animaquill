import { componentSpecOf, type KeyEase } from "@animaquill/core";
import type { PropertySpec } from "@animaquill/schema";
import { Dice5 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Bubble } from "../app/Bubble.tsx";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { Tip } from "../app/Tip.tsx";
import { NumberField } from "../properties/NumberField.tsx";
import type { Pointer } from "../timeline/gestures.ts";
import type { KeyArea, KeySpot } from "./area.ts";
import {
  EASE_CHOICES,
  EASE_DIRECTIONS,
  STEP_JUMPS,
  TUNING_RANGES,
  easeOf,
  progressOf,
  type EaseTuning,
  type TunedEase,
} from "./easing.ts";
import type { KeyframeEditor, SelectedTuning } from "./editor.ts";
import type { TangentMode } from "./handles.ts";
import type { Shaking } from "./shaking.ts";
import styles from "./KeyPopups.module.css";

const TANGENTS: readonly TangentMode[] = ["auto", "aligned", "broken"];

/** What a stretch looks like, with room above and below for what overshoots. */
const CURVE_WIDTH = 36;
const CURVE_HEIGHT = 24;
const CURVE_MARGIN = 5;
/** Enough for an elastic to swing and a bounce to land a few times. */
const CURVE_POINTS = 72;

interface EaseCurveProps {
  readonly ease: KeyEase;
  /** How long the stretch is, which a spring goes by. */
  readonly span?: number | undefined;
}

/**
 * The progress of a stretch, from its key at the bottom left to the next at the top right, as the
 * project format works it out. What overshoots further than the room there is gets the curve
 * smaller, so that it all stays in sight.
 */
export function EaseCurve({ ease, span }: EaseCurveProps) {
  const room = CURVE_HEIGHT - CURVE_MARGIN * 2;
  const progress: number[] = [];
  if (ease.interp === "hold") progress.push(0, 0, 1);
  else if (ease.interp === "linear") progress.push(0, 1);
  else
    for (let step = 0; step <= CURVE_POINTS; step += 1) {
      progress.push(progressOf(ease, step / CURVE_POINTS, span));
    }
  const low = Math.min(-CURVE_MARGIN / room, ...progress);
  const high = Math.max(1 + CURVE_MARGIN / room, ...progress);
  const yOf = (value: number) => CURVE_HEIGHT - ((value - low) / (high - low)) * CURVE_HEIGHT;
  const xOf = (index: number) =>
    ease.interp === "hold"
      ? [0, CURVE_WIDTH, CURVE_WIDTH][index]
      : (index / (progress.length - 1)) * CURVE_WIDTH;
  const points = progress.map((value, index) => `${xOf(index)},${yOf(value)}`).join(" ");
  return (
    <svg className={styles.curve} width={CURVE_WIDTH} height={CURVE_HEIGHT} aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

interface InterpBubbleProps {
  readonly keyframes: KeyframeEditor;
  readonly anchor: DOMRect;
  readonly onClose: () => void;
}

/**
 * How the selected keys go on. It stays open, so that people can try them one after the other. A
 * preset that is tuned has a row of its own below the choices, with curves and numbers, no words.
 */
export function InterpBubble({ keyframes, anchor, onClose }: InterpBubbleProps) {
  const { t } = useTranslation();
  const current = useSyncExternalStore(keyframes.subscribeView, () => keyframes.selectedPreset);
  const selected = useSyncExternalStore(keyframes.subscribeView, () => keyframes.selectedTuning);
  // What a number is being dragged to, which the curves show before it is written.
  const [dragged, setDragged] = useState<Partial<EaseTuning>>();
  const tuning = selected && { ...selected.tuning, ...dragged };
  return (
    <Bubble
      anchor={anchor}
      title={t("keyframes.interp")}
      onClose={onClose}
      className={styles.bubble}
    >
      <div className={styles.presets} role="radiogroup" aria-label={t("keyframes.interp")}>
        {EASE_CHOICES.map((id) => {
          const mine = selected?.preset === id && tuning;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              className={styles.preset}
              aria-checked={current === id}
              {...(current === id ? { "data-autofocus": true } : {})}
              onClick={() => keyframes.choosePreset(id)}
            >
              <EaseCurve
                ease={mine ? easeOf(id, mine) : easeOf(id)}
                span={mine ? selected.span : undefined}
              />
              {t(`keyframes.ease.${id}`)}
            </button>
          );
        })}
      </div>
      {selected && tuning && (
        <TuningRow keyframes={keyframes} selected={selected} tuning={tuning} onDrag={setDragged} />
      )}
    </Bubble>
  );
}

type TunedNumber = keyof typeof TUNING_RANGES;

/** How each number reads and drags: seconds show as such, steps go one by one. */
const NUMBER_UNITS: Partial<Record<TunedNumber, string>> = { steps: "count", duration: "s" };

/** The numbers of each tuned preset, in the order of the row. */
const NUMBERS = {
  elastic: ["amplitude", "period"],
  bounce: [],
  steps: ["steps"],
  spring: ["wobble", "duration"],
} as const satisfies Record<TunedEase, readonly TunedNumber[]>;

interface TuningRowProps {
  readonly keyframes: KeyframeEditor;
  readonly selected: SelectedTuning;
  readonly tuning: EaseTuning;
  readonly onDrag: (change: Partial<EaseTuning> | undefined) => void;
}

function TuningRow({ keyframes, selected, tuning, onDrag }: TuningRowProps) {
  const { t } = useTranslation();
  const { preset, span } = selected;
  const choice = (label: string, name: string, change: Partial<EaseTuning>, on: boolean) => (
    <button
      key={name}
      type="button"
      role="radio"
      className={styles.choice}
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={() => {
        if (!on) keyframes.tunePreset(change, "commit");
      }}
    >
      <EaseCurve ease={easeOf(preset, { ...tuning, ...change })} span={span} />
    </button>
  );
  const choices =
    preset === "elastic" || preset === "bounce" ? (
      <div
        key="choices"
        className={styles.choices}
        role="radiogroup"
        aria-label={t("keyframes.tune.direction")}
      >
        {EASE_DIRECTIONS.map((direction) =>
          choice(
            t(`keyframes.tune.${direction}`),
            direction,
            { direction },
            tuning.direction === direction,
          ),
        )}
      </div>
    ) : preset === "steps" ? (
      <div
        key="choices"
        className={styles.choices}
        role="radiogroup"
        aria-label={t("keyframes.tune.jump")}
      >
        {STEP_JUMPS.map((jump) =>
          choice(t(`keyframes.tune.${jump}`), jump, { jump }, tuning.jump === jump),
        )}
      </div>
    ) : undefined;
  const numbers = NUMBERS[preset].map((name: TunedNumber) => {
    const label = t(`keyframes.tune.${name}`);
    const unit = NUMBER_UNITS[name];
    const spec: PropertySpec = {
      path: name,
      type: "number",
      ...TUNING_RANGES[name],
      ...(unit && { unit }),
    };
    return (
      <label key={name} className={styles.number}>
        <span>{label}</span>
        <NumberField
          label={label}
          placeholder=""
          spec={spec}
          value={tuning[name]}
          automatic={false}
          animated={false}
          tried={false}
          readOnly={false}
          onPreview={(value) => {
            onDrag({ [name]: value });
            keyframes.tunePreset({ [name]: value }, "preview");
          }}
          onCommit={(value) => {
            onDrag(undefined);
            keyframes.tunePreset({ [name]: value }, "commit");
          }}
          onCancel={() => {
            onDrag(undefined);
            keyframes.cancelEdits();
          }}
        />
      </label>
    );
  });
  // Steps say how many first: the jumps look like that many.
  return (
    <div className={styles.tuning} role="group" aria-label={t(`keyframes.ease.${preset}`)}>
      {preset === "steps" ? [...numbers, choices] : [choices, ...numbers]}
    </div>
  );
}

/** How often it shakes: from a slow drift to a buzz. */
const FREQUENCY_SPEC: PropertySpec = {
  path: "frequency",
  type: "number",
  unit: "hz",
  min: 0.01,
  softMin: 0.1,
  softMax: 10,
};

interface NoiseBubbleProps {
  readonly keyframes: KeyframeEditor;
  readonly clip: string;
  /** The property that shakes: how far it shakes is in its unit. */
  readonly spec: PropertySpec;
  readonly anchor: DOMRect;
  readonly onClose: () => void;
}

/**
 * How a property shakes: how far, how often, new dice for another way of shaking, and no more
 * shaking. Dragging a number only shows, letting go writes it. Gone with the shaking, as after undo.
 */
export function NoiseBubble({ keyframes, clip, spec, anchor, onClose }: NoiseBubbleProps) {
  const { t } = useTranslation();
  const { path } = spec;
  const signature = useSyncExternalStore(keyframes.subscribeView, () =>
    JSON.stringify(keyframes.shakingOf(clip, path) ?? null),
  );
  const shaking = JSON.parse(signature) as Shaking | null;
  const [dragged, setDragged] = useState<Partial<Shaking>>();
  const gone = shaking === null;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!shaking) return null;
  const shown = { ...shaking, ...dragged };
  const readOnly = !keyframes.canMove(clip);
  const amountSpec: PropertySpec = { ...componentSpecOf(spec), path: "amount", min: 0 };
  const field = (name: "amount" | "frequency", fieldSpec: PropertySpec) => {
    const label = t(`keyframes.noise.${name}`);
    return (
      <label className={styles.number}>
        <span>{label}</span>
        <NumberField
          label={label}
          placeholder=""
          spec={fieldSpec}
          value={shown[name]}
          automatic={false}
          animated={false}
          tried={false}
          readOnly={readOnly}
          onPreview={(value) => {
            setDragged({ [name]: value });
            keyframes.tuneShaking(clip, path, { [name]: value }, "preview");
          }}
          onCommit={(value) => {
            setDragged(undefined);
            keyframes.tuneShaking(clip, path, { [name]: value }, "commit");
          }}
          onCancel={() => {
            setDragged(undefined);
            keyframes.cancelEdits();
          }}
        />
      </label>
    );
  };
  const reroll = t("keyframes.noise.reroll");
  return (
    <Bubble
      anchor={anchor}
      title={t("keyframes.noise.title")}
      onClose={onClose}
      className={styles.bubble}
    >
      {/* The focus starts here, not in a number: one Escape closes it, as it does the menu. */}
      <div className={styles.noise} tabIndex={-1} data-autofocus>
        {field("amount", amountSpec)}
        {field("frequency", FREQUENCY_SPEC)}
        <Tip name={reroll} usage="">
          <button
            type="button"
            className={styles.dice}
            aria-label={reroll}
            disabled={readOnly}
            onClick={() => keyframes.rollShaking(clip, path)}
          >
            <Dice5 size={16} />
          </button>
        </Tip>
      </div>
      <div className={styles.noiseEnd}>
        <button
          type="button"
          className={styles.remove}
          disabled={readOnly}
          onClick={() => {
            keyframes.stopShaking(clip, path);
            onClose();
          }}
        >
          {t("keyframes.noise.remove")}
        </button>
      </div>
    </Bubble>
  );
}

interface PopupState {
  readonly x: number;
  readonly y: number;
  readonly groups: readonly (readonly MenuItem[])[];
}

export interface KeyPopups {
  /** Opens what belongs to a place. Says whether there is anything. */
  open(pointer: Pointer, stage: DOMRect): boolean;
  doubleClick(pointer: Pointer): boolean;
  readonly element: ReactNode;
}

/** The right mouse button and the double click, the same on all lanes. */
export function useKeyPopups(area: KeyArea): KeyPopups {
  const { keyframes } = area;
  const { t } = useTranslation();
  const [menu, setMenu] = useState<PopupState>();
  const [anchor, setAnchor] = useState<DOMRect>();

  const openOnKey = (spot: KeySpot, x: number, y: number) => {
    if (!keyframes.selection.includes(spot.keys)) area.selectSpot(spot);
    const canMove = keyframes.canMove(spot.box.id);
    // Switches, choices and words only hold, so there is nothing to ease or to steer.
    const canEase = canMove && keyframes.canEase;
    const part = spot.lane.component?.index;
    const tangent = canEase ? keyframes.selectedTangent(part) : undefined;
    setMenu({
      x,
      y,
      groups: [
        [
          {
            id: "interp",
            label: t("keyframes.interpMore"),
            disabled: !canEase,
            run: () => setAnchor(new DOMRect(x, y, 0, 0)),
          },
        ],
        TANGENTS.map((mode) => ({
          id: `tangent-${mode}`,
          label: t(`keyframes.tangent.${mode}`),
          disabled: !canEase,
          selected: tangent === mode,
          run: () => keyframes.setTangent(mode, part),
        })),
        [
          {
            id: "copy",
            label: t("keyframes.action.copy"),
            run: () => keyframes.copySelected(area.shownClips),
          },
          {
            id: "paste",
            label: t("keyframes.action.paste"),
            disabled: !keyframes.getSnapshot().hasClipboard,
            run: () => keyframes.paste(),
          },
          {
            id: "delete",
            label: t("keyframes.action.delete"),
            disabled: !canMove,
            run: () => keyframes.deleteSelected(area.shownClips),
          },
        ],
        [
          {
            id: "row",
            label: t("keyframes.selectRow"),
            run: () => area.selectLane(spot.lane, false),
          },
          {
            id: "column",
            label: t("keyframes.selectColumn"),
            run: () => area.selectColumn(spot, false),
          },
        ],
      ],
    });
  };

  return {
    open(pointer, stage) {
      const hit = area.hitAt(pointer);
      if (hit.kind !== "key") return false;
      openOnKey(hit, stage.left + pointer.x, stage.top + pointer.y);
      return true;
    },
    doubleClick(pointer) {
      const hit = area.hitAt(pointer);
      const adding = pointer.shift || pointer.mod;
      if (hit.kind === "key") area.selectColumn(hit, adding);
      else if (hit.kind === "lane") area.selectLane(hit.lane, adding);
      return hit.kind === "key" || hit.kind === "lane";
    },
    element: (
      <>
        {menu && (
          <PopupMenu
            label={t("keyframes.keys")}
            x={menu.x}
            y={menu.y}
            groups={menu.groups}
            onClose={() => setMenu(undefined)}
          />
        )}
        {anchor && (
          <InterpBubble
            keyframes={keyframes}
            anchor={anchor}
            onClose={() => setAnchor(undefined)}
          />
        )}
      </>
    ),
  };
}
