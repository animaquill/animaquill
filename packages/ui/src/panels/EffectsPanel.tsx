import type { EffectCategory, EffectMedia } from "@animaquill/schema";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ResourceBrowser, type ResourceIconProps } from "../resources/ResourceBrowser.tsx";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "../resources/transition-preview.ts";
import { STILL_SWING, effectPreviews, swingAt } from "../resources/effect-preview.ts";
import { builtInEffects, effectResourceTypes, type EffectItem } from "../resources/effects.ts";
import { useNotice } from "../resources/notice.ts";
import { FxIcon } from "./FxIcon.tsx";
import type { Resource } from "../resources/resources.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { MASTER_CLIP } from "../mixer/track-clip.ts";
import { useTrackName } from "../mixer/names.ts";
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
 * A small picture of what an effect of sound does: the curve of an equalizer, the knee of a
 * compressor, the flat top of a limiter, the echoes of a reverb.
 */
export function SoundEffectIcon({ resource }: ResourceIconProps<EffectItem>) {
  const paths: Readonly<Record<string, string>> = {
    eq: "M2 14 C8 14 9 14 12 6 C15 14 16 14 22 14 M2 18h20",
    compressor: "M3 21 L11 13 C13 11 15 10.5 21 8 M3 3v18h18",
    limiter: "M2 16 L6 8 L9 15 L12 6 L14 6 L16 14 L19 7 L22 16 M2 6h20",
    reverb: "M3 20V5 M7 20v-11 M10 20v-8 M13 20v-6 M16 20v-4 M19 20v-2",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width={PREVIEW_WIDTH}
      height={PREVIEW_HEIGHT}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      data-sound-effect={resource.data.type}
    >
      <path d={paths[resource.data.type] ?? "M4 12h16"} />
    </svg>
  );
}

/**
 * The effects to find and use, of pictures or of sound: dragged onto a clip of the timeline, or
 * clicked with clips selected there, which puts it last on each, once more with each click. Those
 * of sound also go on a track of sound: dropped on its header or its strip in the mixer, or clicked
 * with the track (or the master) selected. A click says what it did: the clips light up, their list
 * of effects goes to the new one, and the effect here says on how many clips it went. See
 * docs/design/resource-panels.md, sections 2, 4 and 7, and audio-mixing.md 1.6.
 */
function EffectsBrowser({ media }: { readonly media: EffectMedia }) {
  const { timeline, resourceHabits: habits } = useWorkbench();
  const { t } = useTranslation();
  const trackName = useTrackName();
  // What is selected says what a click does.
  const { model, track } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const resources = useMemo(() => builtInEffects(t, media), [t, media]);
  const [notice, say] = useNotice();
  const why = (problem: string) =>
    t(
      media === "sound" && problem === "nothing"
        ? "effectPanel.why.soundNothing"
        : (`effectPanel.why.${problem}` as "effectPanel.why.failed"),
    );

  const unavailable = ({ data }: Resource<EffectItem>) => {
    const problem = timeline.effectProblem(data.type);
    // With nothing selected a click has nothing to be about, but nothing is wrong with any of them.
    if (problem === undefined || problem === "nothing") return undefined;
    return { reason: why(problem), draggable: problem !== "unknown" };
  };
  const targetName = () => {
    if (track === MASTER_CLIP) return t("mixer.master");
    const row = model?.rows.find((one) => one.id === track);
    return row ? trackName(row) : "";
  };

  return (
    <ResourceBrowser<EffectItem>
      tab={media === "sound" ? "soundEffects" : "effects"}
      label={t(media === "sound" ? "panel.soundEffects.title" : "panel.effects.title")}
      searchLabel={t(media === "sound" ? "effectPanel.soundSearch" : "effectPanel.search")}
      resources={resources}
      types={effectResourceTypes(media)}
      defaultGrouping="type"
      typeName={(type) => t(`effectPanel.types.${type.slice("effect.".length) as EffectCategory}`)}
      unavailable={unavailable}
      Icon={media === "sound" ? SoundEffectIcon : EffectIcon}
      onActivate={(resource) => {
        const onTrack = timeline.effectContext.selected === 0 && track !== undefined;
        // Each click is one more, also where it is already: people can stack the same effect.
        const count = timeline.attachEffect(resource.data.type);
        if (count === 0) {
          const problem = timeline.effectProblem(resource.data.type) ?? "failed";
          say(resource.id, why(problem), undefined, true);
          return;
        }
        habits.used(resource.id);
        if (onTrack) {
          const added = t("effectPanel.addedTrack", { name: targetName() });
          say(resource.id, `${resource.name}${added}`, `✓ ${added}`);
          return;
        }
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

/** The effects of pictures. */
export function EffectsPanel() {
  return <EffectsBrowser media="picture" />;
}

/** The effects of sound: equalizer, dynamics, space. */
export function SoundEffectsPanel() {
  return <EffectsBrowser media="sound" />;
}
