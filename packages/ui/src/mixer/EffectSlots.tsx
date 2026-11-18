import type { ClipEffect } from "@animaquill/core";
import { BUILT_IN_SOUND_EFFECTS } from "@animaquill/schema";
import { Plus } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import { useWorkbench } from "../app/context.ts";
import { effectName } from "../resources/effects.ts";
import { EFFECT_DRAG_TYPE, effectDrag } from "../timeline/effect-drag.ts";
import { mediaOfEffect } from "../timeline/effect-place.ts";
import styles from "./MixerPanel.module.css";

/** What a drag of an effect within a strip carries: its id. */
const SLOT_DRAG_TYPE = "application/x-animaquill-mixer-effect";

/** Where a drop goes: before the slot it is over, or after it. */
function dropIndex(event: DragEvent<HTMLElement>, index: number): number {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY < box.top + box.height / 2 ? index : index + 1;
}

interface EffectSlotsProps {
  /** The clip that stands for the track or the master, see `withTrackClips`. */
  readonly clip: string;
  /** What is selected for it: the track, or `MASTER_CLIP`. */
  readonly target: string;
  readonly name: string;
  readonly effects: readonly ClipEffect[];
  readonly readOnly: boolean;
  /** What comes after the effects and does not move: the safe limiter of the master. */
  readonly last?: ReactNode;
}

/**
 * The effects of a track or the master in its strip, one slot each, in the order they work: a click
 * selects the track and shows the effect in the properties tab, the dot turns it on and off, a drag
 * moves it, the context menu turns it off or deletes it. "+" adds one, and so does an effect of sound
 * dropped from its tab. See audio-mixing.md 1.3.
 */
export function EffectSlots({ clip, target, name, effects, readOnly, last }: EffectSlotsProps) {
  const { timeline, layout } = useWorkbench();
  const { t } = useTranslation();
  const [dragged, setDragged] = useState<string>();
  const [drop, setDrop] = useState<number>();
  const [menu, setMenu] = useState<
    { readonly x: number; readonly y: number; readonly effect?: ClipEffect } | undefined
  >();

  const show = (effect: ClipEffect) => {
    timeline.selectTrack(target);
    timeline.showEffect(clip, effect.id);
    layout.openPanel("properties");
  };
  const over = (event: DragEvent<HTMLElement>, index: number) => {
    const types = event.dataTransfer.types;
    if (readOnly) return;
    if (types.includes(SLOT_DRAG_TYPE) && dragged !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDrop(dropIndex(event, index));
      return;
    }
    const type = effectDrag.current();
    if (types.includes(EFFECT_DRAG_TYPE) && type !== undefined && mediaOfEffect(type) === "sound") {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDrop(index < effects.length ? dropIndex(event, index) : effects.length);
    }
  };
  const dropped = (event: DragEvent<HTMLElement>) => {
    const at = drop;
    setDrop(undefined);
    if (at === undefined || readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    const moving = event.dataTransfer.getData(SLOT_DRAG_TYPE);
    if (moving) {
      const from = effects.findIndex(({ id }) => id === moving);
      const index = at > from ? at - 1 : at;
      if (from >= 0 && index !== from) timeline.moveEffect(clip, moving, index);
      setDragged(undefined);
      return;
    }
    const type = effectDrag.current();
    effectDrag.end();
    if (type !== undefined) timeline.attachEffectTo(target, type, at);
  };

  return (
    <div
      className={styles.slots}
      role="list"
      aria-label={t("mixer.effects", { name })}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined);
      }}
      onDrop={dropped}
    >
      {effects.map((effect, index) => {
        const label = effectName(t, effect.type);
        const on = effect.enabled !== false;
        return (
          <div
            key={effect.id}
            role="listitem"
            className={styles.slot}
            data-effect={effect.id}
            data-off={on ? undefined : true}
            data-dragged={dragged === effect.id || undefined}
            data-drop={drop === index ? "before" : drop === index + 1 ? "after" : undefined}
            draggable={!readOnly}
            onDragStart={(event) => {
              event.dataTransfer.setData(SLOT_DRAG_TYPE, effect.id);
              event.dataTransfer.effectAllowed = "move";
              setDragged(effect.id);
            }}
            onDragEnd={() => {
              setDragged(undefined);
              setDrop(undefined);
            }}
            onDragEnter={(event) => over(event, index)}
            onDragOver={(event) => over(event, index)}
            onContextMenu={(event) => {
              event.preventDefault();
              if (!readOnly) setMenu({ x: event.clientX, y: event.clientY, effect });
            }}
          >
            <button
              type="button"
              className={styles.slotName}
              title={label}
              onClick={() => show(effect)}
            >
              {label}
            </button>
            <button
              type="button"
              className={styles.slotDot}
              aria-pressed={on}
              aria-label={t("mixer.effectOn", { name: label })}
              title={t("mixer.effectOn", { name: label })}
              disabled={readOnly}
              onClick={() => timeline.setEffectEnabled(clip, effect.id, !on)}
            />
          </div>
        );
      })}
      <button
        type="button"
        className={styles.slotAdd}
        aria-label={t("mixer.addEffect")}
        title={t("mixer.addEffect")}
        disabled={readOnly}
        data-drop={drop === effects.length ? "before" : undefined}
        onDragEnter={(event) => over(event, effects.length)}
        onDragOver={(event) => over(event, effects.length)}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom });
        }}
      >
        <Plus size={12} />
      </button>
      {last}
      {menu && (
        <PopupMenu
          label={menu.effect ? effectName(t, menu.effect.type) : t("mixer.addEffect")}
          x={menu.x}
          y={menu.y}
          groups={
            menu.effect
              ? [
                  [
                    {
                      id: "toggle",
                      label: t(menu.effect.enabled === false ? "mixer.turnOn" : "mixer.turnOff"),
                      run: () => {
                        const effect = menu.effect as ClipEffect;
                        timeline.setEffectEnabled(clip, effect.id, effect.enabled === false);
                      },
                    },
                    {
                      id: "remove",
                      label: t("mixer.removeEffect"),
                      run: () => timeline.removeEffect(clip, (menu.effect as ClipEffect).id),
                    },
                  ],
                ]
              : [
                  Object.keys(BUILT_IN_SOUND_EFFECTS).map((type) => ({
                    id: type,
                    label: effectName(t, type),
                    run: () => {
                      timeline.attachEffectTo(target, type);
                    },
                  })),
                ]
          }
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}
