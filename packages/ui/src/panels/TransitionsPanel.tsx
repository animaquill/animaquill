import { parseTime, toSeconds, type TransitionUse } from "@animaquill/schema";
import { Blend } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { useNotice } from "../resources/notice.ts";
import { ResourceBrowser, type ResourceIconProps } from "../resources/ResourceBrowser.tsx";
import type { Resource } from "../resources/resources.ts";
import {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  STILL_PROGRESS,
  loopShare,
  progressOf,
  transitionPreviews,
} from "../resources/transition-preview.ts";
import {
  TRANSITION_TYPES,
  builtInTransitions,
  firstTypeOf,
  isChosen,
  type TransitionItem,
} from "../resources/transitions.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { TRANSITION_DRAG_TYPE, transitionDrag } from "../timeline/transition-drag.ts";
import { greysOut } from "../timeline/transition-place.ts";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The picture of a transition: still, mostly through, and on the move under the pointer. Each is
 * drawn by the shared canvases of `transitionPreviews`, and a still one only once.
 */
export function TransitionIcon({ resource, playing }: ResourceIconProps<TransitionItem>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { pick, use } = resource.data;
  const [drawn, setDrawn] = useState(true);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const at = (share: number) =>
      transitionPreviews.draw(element, pick.name, use, progressOf(share, pick.curve));
    if (!playing || reducedMotion()) {
      setDrawn(at(STILL_PROGRESS));
      return;
    }
    const seconds = toSeconds(parseTime(pick.duration));
    const began = performance.now();
    // One frame asked for at a time, by the same loop, until it stops.
    const loop = { frame: 0 };
    const step = (now: number) => {
      at(loopShare(now - began, seconds));
      loop.frame = requestAnimationFrame(step);
    };
    loop.frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(loop.frame);
      at(STILL_PROGRESS);
    };
  }, [pick, use, playing]);

  if (!drawn) return <Blend size={24} aria-hidden />;
  return <canvas ref={canvas} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} aria-hidden />;
}

/** What a drag of a transition carries, from any tab that lists them. */
export function startTransitionDrag(
  item: TransitionItem,
  id: string,
  event: DragEvent<HTMLElement>,
): void {
  event.dataTransfer.setData(TRANSITION_DRAG_TYPE, id);
  event.dataTransfer.effectAllowed = "copy";
  transitionDrag.start(item.pick);
}

export function endTransitionDrag(timeline: TimelineEditor): void {
  transitionDrag.end();
  timeline.showTransitionDrop(undefined);
}

/**
 * The transitions to find and use: dragged onto the timeline, or clicked with something selected
 * there. One that comes in goes at the start of each clip selected, one that goes out at its end,
 * and one that goes between two clips between each two selected that follow each other. See
 * docs/design/resource-panels.md, sections 2, 3 and 7.
 */
export function TransitionsPanel() {
  const { timeline, resourceHabits: habits } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const resources = useMemo(() => builtInTransitions(t), [t]);
  const [notice, say] = useNotice();
  const context = timeline.attachContext;

  const unavailable = ({ data }: Resource<TransitionItem>) => {
    const problem = timeline.attachProblem(data.use, data.pick);
    // With nothing selected a click has nothing to be about, but nothing is wrong with any of them,
    // and one between two clips can always be dragged there.
    if (!greysOut(problem)) return undefined;
    return { reason: t(`transitionPanel.why.${problem}`), draggable: true };
  };

  const onActivate = (resource: Resource<TransitionItem>) => {
    const { pick, use } = resource.data;
    const problem = timeline.attachProblem(use, pick);
    if (problem === "joinHow" || problem === "nothing") {
      say(resource.id, t(`transitionPanel.why.${problem}`));
      return;
    }
    if (timeline.attachTransition(pick, use)) habits.used(resource.id);
  };

  return (
    <ResourceBrowser<TransitionItem>
      tab="transitions"
      label={t("panel.transitions.title")}
      searchLabel={t("transitionPanel.search")}
      resources={resources}
      types={TRANSITION_TYPES}
      firstType={firstTypeOf(context)}
      defaultGrouping="type"
      typeName={(type) =>
        t(`transitionPanel.types.${type.slice("transition.".length) as TransitionUse}`)
      }
      unavailable={unavailable}
      isCurrent={(resource) => isChosen(context, resource.data)}
      Icon={TransitionIcon}
      onActivate={onActivate}
      onDragStart={(resource, event) => startTransitionDrag(resource.data, resource.id, event)}
      onDragEnd={(resource, dropped) => {
        endTransitionDrag(timeline);
        if (dropped) habits.used(resource.id);
      }}
      notice={notice}
    />
  );
}
