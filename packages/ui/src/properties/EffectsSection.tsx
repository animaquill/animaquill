import {
  EFFECTS_OBJECT_ID,
  effectObjectId,
  effectsOf,
  type ClipEffect,
  type ClipState,
} from "@animaquill/core";
import { parseTime, type ObjectDescriptor } from "@animaquill/schema";
import { GripVertical, Trash2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { effectName } from "../resources/effects.ts";
import { formatTimecode, frameContaining, frameTime, parseTimecode } from "../timeline/frames.ts";
import { RowButton } from "./controls.tsx";
import styles from "./PropertiesPanel.module.css";

/** What a drag of an effect within its list carries: its id. */
const ORDER_DRAG_TYPE = "application/x-animaquill-effect-order";

export interface EffectsSectionProps {
  readonly clip: ClipState;
  readonly objects: readonly ObjectDescriptor[];
  /** Nothing in the list can change: the track is locked, or people look at what was saved. */
  readonly readOnly: boolean;
  /** The rows of what each effect takes, by its object: those of any other property. */
  readonly rows: ReadonlyMap<string, ReactNode>;
}

/** Where a drop goes in the list without the effect that moves: before the one it is over, or after. */
function dropIndex(event: DragEvent<HTMLElement>, index: number): number {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? index : index + 1;
}

/** How long an effect that just went on a clip stands out in its list. */
const FRESH_MS = 1600;

/**
 * When an effect works, as two times from the start of its clip, by frames, the way the status bar
 * writes them. An empty field is the edge of the clip, as long as the clip is. A change is a step
 * once it is written.
 */
function RangeRow(props: {
  readonly clip: ClipState;
  readonly effect: ClipEffect;
  readonly readOnly: boolean;
}) {
  const { clip, effect, readOnly } = props;
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const [typed, setTyped] = useState<{ readonly start?: string; readonly end?: string }>({});
  const [invalid, setInvalid] = useState(false);
  const rate = timeline.model?.rate;
  if (!rate) return null;
  const length = frameContaining(parseTime(clip.duration), rate);
  const frameOf = (time: string | undefined, fallback: number) =>
    time === undefined ? fallback : Math.min(frameContaining(parseTime(time), rate), length);
  const shown = { start: frameOf(effect.start, 0), end: frameOf(effect.end, length) };
  const commit = (field: "start" | "end", text: string) => {
    setTyped((was) => ({ ...was, [field]: undefined }));
    const wanted =
      text.trim() === "" ? (field === "start" ? 0 : length) : parseTimecode(text, rate);
    const next = { ...shown, [field]: wanted };
    if (wanted === undefined || next.start < 0 || next.end > length || next.start >= next.end) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    // The edges of the clip are what an effect has without saying, which follow the clip.
    timeline.setEffectRange(
      clip.id,
      effect.id,
      next.start <= 0 ? undefined : frameTime(next.start, rate),
      next.end >= length ? undefined : frameTime(next.end, rate),
    );
  };
  const field = (name: "start" | "end") => {
    const label = t(`effect.${name}`);
    return (
      <input
        className={styles.text}
        aria-label={label}
        aria-invalid={invalid || undefined}
        title={label}
        spellCheck={false}
        readOnly={readOnly}
        value={typed[name] ?? formatTimecode(shown[name], rate)}
        onChange={(event) => {
          const { value } = event.currentTarget;
          setTyped((was) => ({ ...was, [name]: value }));
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            setTyped((was) => ({ ...was, [name]: undefined }));
            setInvalid(false);
          } else if (event.key !== "Enter") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Enter") commit(name, event.currentTarget.value);
          event.currentTarget.closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });
        }}
        onBlur={(event) => {
          if (typed[name] !== undefined) commit(name, event.currentTarget.value);
        }}
      />
    );
  };
  return (
    <>
      <div className={styles.row} role="group" aria-label={t("effect.range")} data-effect-range="">
        <span className={styles.name}>{t("effect.range")}</span>
        <div className={styles.rangeFields}>
          {field("start")}
          <span aria-hidden>–</span>
          {field("end")}
        </div>
      </div>
      {invalid && <p className={styles.transitionInvalid}>{t("effect.rangeInvalid")}</p>}
      {!invalid && shown.start >= shown.end && (
        <p className={styles.transitionHint}>{t("effect.nowhere")}</p>
      )}
    </>
  );
}

/**
 * Which effect of a clip just went on it, by a click or a drop, for as long as it stands out: the
 * list goes to it. Only what went on a moment ago counts, also when the list comes after it, as it
 * does when a drop selects the clip.
 */
function useFresh(clip: string): string | undefined {
  const { timeline } = useWorkbench();
  const added = useSyncExternalStore(timeline.subscribeAdded, () => timeline.lastAdded);
  // Which of them no longer stands out: one from before the list came is over already.
  const [over, setOver] = useState(() =>
    added && Date.now() - added.time > FRESH_MS ? added.at : undefined,
  );
  useEffect(() => {
    if (!added) return;
    const left = Math.max(FRESH_MS - (Date.now() - added.time), 0);
    const timer = setTimeout(() => setOver(added.at), left);
    return () => clearTimeout(timer);
  }, [added]);
  return added && over !== added.at ? added.effects.get(clip) : undefined;
}

/**
 * The effects of a clip, in the order they work: each can be turned off, dragged to another place
 * (or moved with the arrow keys on its handle), and taken off, and works for a time of the clip.
 * What each takes has the rows of any property, with keys. One that just went on the clip comes into
 * view and stands out for a moment. See docs/design/resource-panels.md, sections 4 and 7.
 */
export function EffectsSection({ clip, objects, readOnly, rows }: EffectsSectionProps) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const list = effectsOf(clip);
  const [dragged, setDragged] = useState<string>();
  const [target, setTarget] = useState<number>();
  const fresh = useFresh(clip.id);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (fresh === undefined) return;
    const item = listRef.current?.querySelector(`[data-effect="${CSS.escape(fresh)}"]`);
    item?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [fresh]);
  if (list.length === 0) return null;
  const byId = new Map(objects.map((object) => [object.id, object]));
  const move = (id: string, to: number) => {
    const from = list.findIndex((effect) => effect.id === id);
    // Counted in the list without it.
    const index = to > from ? to - 1 : to;
    if (index !== from) timeline.moveEffect(clip.id, id, index);
  };
  // On entering too: the browser goes by the last of the two, and the pointer goes from one part of
  // an effect to another.
  const overEffect = (event: DragEvent<HTMLElement>, index: number) => {
    if (!dragged || !event.dataTransfer.types.includes(ORDER_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setTarget(dropIndex(event, index));
  };
  const onKey = (event: KeyboardEvent, id: string, index: number) => {
    if (readOnly) return;
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      timeline.moveEffect(clip.id, id, index - 1);
    } else if (event.key === "ArrowDown" && index < list.length - 1) {
      event.preventDefault();
      timeline.moveEffect(clip.id, id, index + 1);
    }
  };

  return (
    <section
      className={styles.effects}
      aria-label={t("effect.section")}
      data-object={EFFECTS_OBJECT_ID}
    >
      <h3 className={styles.objectName}>{t("effect.section")}</h3>
      <ol ref={listRef} className={styles.effectList}>
        {list.map((effect, index) => {
          const { id, type, enabled } = effect;
          const name = effectName(t, type);
          const object = byId.get(effectObjectId(id));
          const on = enabled !== false;
          const known = object !== undefined && object.properties.length > 0;
          return (
            <li
              key={id}
              className={styles.effect}
              aria-label={name}
              data-effect={id}
              data-off={on ? undefined : true}
              data-fresh={fresh === id || undefined}
              data-dragged={dragged === id || undefined}
              data-drop={target === index ? "before" : target === index + 1 ? "after" : undefined}
              onDragEnter={(event) => overEffect(event, index)}
              onDragOver={(event) => overEffect(event, index)}
              onDragLeave={() => setTarget(undefined)}
              onDrop={(event) => {
                const moving = event.dataTransfer.getData(ORDER_DRAG_TYPE);
                if (!moving) return;
                event.preventDefault();
                move(moving, dropIndex(event, index));
                setTarget(undefined);
                setDragged(undefined);
              }}
            >
              <div className={styles.effectHeader}>
                <button
                  type="button"
                  className={styles.effectGrip}
                  aria-label={t("effect.reorder", { name })}
                  title={t("effect.reorder", { name })}
                  draggable={!readOnly}
                  aria-disabled={readOnly || undefined}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(ORDER_DRAG_TYPE, id);
                    event.dataTransfer.effectAllowed = "move";
                    setDragged(id);
                  }}
                  onDragEnd={() => {
                    setDragged(undefined);
                    setTarget(undefined);
                  }}
                  onKeyDown={(event) => onKey(event, id, index)}
                >
                  <GripVertical size={13} />
                </button>
                <input
                  type="checkbox"
                  className={styles.effectToggle}
                  checked={on}
                  disabled={readOnly}
                  aria-label={t("effect.on", { name })}
                  onChange={(event) => timeline.setEffectEnabled(clip.id, id, event.target.checked)}
                />
                <span className={styles.effectName}>{name}</span>
                {!on && <span className={styles.effectOff}>{t("effect.off")}</span>}
                <RowButton
                  name={t("effect.remove", { name })}
                  usage={t("effect.remove", { name })}
                  unavailable={readOnly}
                  onClick={() => timeline.removeEffect(clip.id, id)}
                >
                  <Trash2 size={12} />
                </RowButton>
              </div>
              <RangeRow clip={clip} effect={effect} readOnly={readOnly} />
              {known ? (
                rows.get(object.id)
              ) : (
                <p className={styles.effectMissing}>{t("effect.missing")}</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
