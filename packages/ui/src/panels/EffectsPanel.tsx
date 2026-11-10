import type { EffectCategory } from "@animaquill/schema";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ResourceBrowser, type ResourceIconProps } from "../resources/ResourceBrowser.tsx";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "../resources/transition-preview.ts";
import { STILL_SWING, effectPreviews, swingAt } from "../resources/effect-preview.ts";
import { EFFECT_RESOURCE_TYPES, builtInEffects, type EffectItem } from "../resources/effects.ts";
import { useNotice } from "../resources/notice.ts";
import { FxIcon } from "./FxIcon.tsx";
import type { Resource } from "../resources/resources.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { EFFECT_DRAG_TYPE, effectDrag } from "../timeline/effect-drag.ts";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The picture of an effect on a sample: still at some strength, and going back and forth under the
 * pointer. Each is drawn by the shared canvases of `effectPreviews`, and a still one only once.
 */
export function EffectIcon({ resource, playing }: ResourceIconProps<EffectItem>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { type } = resource.data;
  const [drawn, setDrawn] = useState(true);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const at = (swing: number) => effectPreviews.draw(element, type, swing);
    if (!playing || reducedMotion()) {
      setDrawn(at(STILL_SWING));
      return;
    }
    const began = performance.now();
    const loop = { frame: 0 };
    const step = (now: number) => {
      at(swingAt(now - began));
      loop.frame = requestAnimationFrame(step);
    };
    loop.frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(loop.frame);
      at(STILL_SWING);
    };
  }, [type, playing]);

  if (!drawn) return <FxIcon size={24} />;
  return <canvas ref={canvas} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} aria-hidden />;
}

/** What a drag of an effect carries, from any tab that lists them. */
export function startEffectDrag(item: EffectItem, event: DragEvent<HTMLElement>): void {
  event.dataTransfer.setData(EFFECT_DRAG_TYPE, item.type);
  event.dataTransfer.effectAllowed = "copy";
  effectDrag.start(item.type);
}

export function endEffectDrag(timeline: TimelineEditor): void {
  effectDrag.end();
  timeline.showEffectDrop(undefined);
}

/**
 * The effects to find and use: dragged onto a clip of the timeline, or clicked with clips selected
 * there, which puts it last on each, once more with each click. A click says what it did: the clips
 * light up, their list of effects goes to the new one, and the effect here says on how many clips it
 * went. See docs/design/resource-panels.md, sections 2, 4 and 7.
 */
export function EffectsPanel() {
  const { timeline, resourceHabits: habits } = useWorkbench();
  const { t } = useTranslation();
  // What is selected says what a click does.
  useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const resources = useMemo(() => builtInEffects(t), [t]);
  const [notice, say] = useNotice();

  const unavailable = ({ data }: Resource<EffectItem>) => {
    const problem = timeline.effectProblem(data.type);
    // With nothing selected a click has nothing to be about, but nothing is wrong with any of them.
    if (problem === undefined || problem === "nothing") return undefined;
    return { reason: t(`effectPanel.why.${problem}`), draggable: problem !== "unknown" };
  };

  return (
    <ResourceBrowser<EffectItem>
      tab="effects"
      label={t("panel.effects.title")}
      searchLabel={t("effectPanel.search")}
      resources={resources}
      types={EFFECT_RESOURCE_TYPES}
      defaultGrouping="type"
      typeName={(type) => t(`effectPanel.types.${type.slice("effect.".length) as EffectCategory}`)}
      unavailable={unavailable}
      Icon={EffectIcon}
      onActivate={(resource) => {
        // Each click is one more, also where it is already: people can stack the same effect.
        const count = timeline.attachEffect(resource.data.type);
        if (count === 0) {
          const problem = timeline.effectProblem(resource.data.type) ?? "failed";
          say(resource.id, t(`effectPanel.why.${problem}`), undefined, true);
          return;
        }
        habits.used(resource.id);
        const added = t("effectPanel.added", { count });
        say(resource.id, t("effectPanel.addedLong", { name: resource.name, count }), `✓ ${added}`);
      }}
      notice={notice}
      onDragStart={(resource, event) => startEffectDrag(resource.data, event)}
      onDragEnd={(resource, dropped) => {
        endEffectDrag(timeline);
        if (dropped) habits.used(resource.id);
      }}
    />
  );
}
