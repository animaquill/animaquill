import type { EffectCategory } from "@animaquill/schema";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ResourceBrowser, type ResourceIconProps } from "../resources/ResourceBrowser.tsx";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "../resources/transition-preview.ts";
import { STILL_SWING, effectPreviews, swingAt } from "../resources/effect-preview.ts";
import { EFFECT_RESOURCE_TYPES, builtInEffects, type EffectItem } from "../resources/effects.ts";
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

  if (!drawn) return <Sparkles size={24} aria-hidden />;
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
 * there, which puts it last on each. See docs/design/resource-panels.md, sections 2 and 4.
 */
export function EffectsPanel() {
  const { timeline, resourceHabits: habits } = useWorkbench();
  const { t } = useTranslation();
  // What is selected says what a click does.
  useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const resources = useMemo(() => builtInEffects(t), [t]);

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
        if (timeline.attachEffect(resource.data.type)) habits.used(resource.id);
      }}
      onDragStart={(resource, event) => startEffectDrag(resource.data, event)}
      onDragEnd={(resource, dropped) => {
        endEffectDrag(timeline);
        if (dropped) habits.used(resource.id);
      }}
    />
  );
}
