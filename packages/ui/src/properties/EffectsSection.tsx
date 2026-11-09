import { EFFECTS_OBJECT_ID, effectObjectId, effectsOf, type ClipState } from "@animaquill/core";
import type { ObjectDescriptor } from "@animaquill/schema";
import { GripVertical, Trash2 } from "lucide-react";
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { effectName } from "../resources/effects.ts";
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

/**
 * The effects of a clip, in the order they work: each can be turned off, dragged to another place
 * (or moved with the arrow keys on its handle), and taken off. What each takes has the rows of any
 * property, with keys. See docs/design/resource-panels.md, section 4.
 */
export function EffectsSection({ clip, objects, readOnly, rows }: EffectsSectionProps) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const list = effectsOf(clip);
  const [dragged, setDragged] = useState<string>();
  const [target, setTarget] = useState<number>();
  if (list.length === 0) return null;
  const byId = new Map(objects.map((object) => [object.id, object]));
  const move = (id: string, to: number) => {
    const from = list.findIndex((effect) => effect.id === id);
    // Counted in the list without it.
    const index = to > from ? to - 1 : to;
    if (index !== from) timeline.moveEffect(clip.id, id, index);
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
      <ol className={styles.effectList}>
        {list.map(({ id, type, enabled }, index) => {
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
              data-dragged={dragged === id || undefined}
              data-drop={target === index ? "before" : target === index + 1 ? "after" : undefined}
              onDragOver={(event) => {
                if (!dragged || !event.dataTransfer.types.includes(ORDER_DRAG_TYPE)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setTarget(dropIndex(event, index));
              }}
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
