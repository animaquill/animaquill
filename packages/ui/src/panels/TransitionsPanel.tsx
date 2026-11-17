import { parseTime, toSeconds, type TransitionMedia } from "@animaquill/schema";
import { Blend } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { useNotice } from "../resources/notice.ts";
import { ResourceBrowser, type ResourceIconProps } from "../resources/ResourceBrowser.tsx";
import type { Resource } from "../resources/resources.ts";
import { resourceTypeName } from "../resources/type-names.ts";
import {
  PREVIEW_HEIGHT,
  PREVIEW_WIDTH,
  STILL_PROGRESS,
  loopShare,
  progressOf,
  transitionPreviews,
} from "../resources/transition-preview.ts";
import {
  builtInTransitions,
  firstTypeOf,
  isChosen,
  typesOf,
  type TransitionItem,
} from "../resources/transitions.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import { TRANSITION_DRAG_TYPE, transitionDrag } from "../timeline/transition-drag.ts";
import { firstLength, greysOut } from "../timeline/transition-place.ts";
import { FadeIcon } from "./FadeIcon.tsx";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The picture of a transition: still, mostly through, and on the move under the pointer. Each is
 * drawn by the shared canvases of `transitionPreviews`, and a still one only once.
 */
export function TransitionIcon({ resource, playing }: ResourceIconProps<TransitionItem>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { pick, use, media } = resource.data;
  const [drawn, setDrawn] = useState(true);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const at = (share: number) =>
      transitionPreviews.draw(element, pick.name, use, progressOf(share, pick.curve), media);
    if (!playing || reducedMotion()) {
      setDrawn(at(STILL_PROGRESS));
      return;
    }
    const seconds = toSeconds(parseTime(firstLength(pick)));
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
  }, [pick, use, media, playing]);

  if (!drawn) return media === "sound" ? <FadeIcon size={24} /> : <Blend size={24} aria-hidden />;
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

/** What each of the two tabs is called and has, the transitions of pictures and of sound. */
const TABS = {
  picture: { tab: "transitions", texts: "transitionPanel" },
  sound: { tab: "fades", texts: "fadePanel" },
} as const;

/**
 * The transitions to find and use: dragged onto the timeline, or clicked with something selected
 * there. One that comes in goes at the start of each clip selected, one that goes out at its end,
 * and one that goes between two clips between each two selected that follow each other. Those of
 * pictures are in the transitions tab, and those of sound in the fades tab, which are the same
 * otherwise. See docs/design/resource-panels.md, sections 2, 3 and 7.
 */
function TransitionBrowser({ media }: { media: TransitionMedia }) {
  const { timeline, resourceHabits: habits } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const resources = useMemo(() => builtInTransitions(t, media), [t, media]);
  const [notice, say] = useNotice();
  const context = timeline.attachContext;
  const { tab, texts } = TABS[media];
  /** What the tab says: in its own words where it has them, else as the transitions tab does. */
  const text = (key: string) =>
    (t as unknown as (keys: readonly string[]) => string)([
      `${texts}.${key}`,
      `transitionPanel.${key}`,
    ]);

  const unavailable = ({ data }: Resource<TransitionItem>) => {
    const problem = timeline.attachProblem(data.use, data.pick);
    // With nothing selected a click has nothing to be about, but nothing is wrong with any of them,
    // and one between two clips can always be dragged there. Each tab has only those of its own
    // media, so one is not greyed out for clips of the other: a click says why it did nothing.
    if (!greysOut(problem) || problem === "pictureOnly" || problem === "soundOnly") {
      return undefined;
    }
    return { reason: text(`why.${problem}`), draggable: true };
  };

  /** A click says what it did, on the transition and under the list, or why it did nothing. */
  const onActivate = (resource: Resource<TransitionItem>) => {
    const { pick, use } = resource.data;
    const problem = timeline.attachProblem(use, pick);
    if (problem) {
      say(resource.id, text(`why.${problem}`), undefined, true);
      return;
    }
    if (isChosen(context, resource.data)) {
      say(resource.id, text("already"));
      return;
    }
    const done = timeline.attachTransition(pick, use);
    if (!done) {
      say(resource.id, text("failed"), undefined, true);
      return;
    }
    habits.used(resource.id);
    const what = done.replaced
      ? t("transitionPanel.replaced")
      : done.joins > 0
        ? t("transitionPanel.addedJoins", { count: done.joins })
        : t(use === "exit" ? "transitionPanel.addedEnd" : "transitionPanel.addedStart", {
            count: done.edges,
          });
    say(resource.id, `${resource.name}${what}`, `✓ ${what}`);
  };

  return (
    <ResourceBrowser<TransitionItem>
      tab={tab}
      label={t(`panel.${tab}.title`)}
      searchLabel={text("search")}
      resources={resources}
      types={typesOf(media)}
      firstType={firstTypeOf(context, media)}
      defaultGrouping="type"
      typeName={(type) => resourceTypeName(t, type)}
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

/** The transitions of pictures. */
export function TransitionsPanel() {
  return <TransitionBrowser media="picture" />;
}

/** The transitions of sound, which people know as fades: 淡入, 淡出 and 交叉淡化. */
export function FadesPanel() {
  return <TransitionBrowser media="sound" />;
}
