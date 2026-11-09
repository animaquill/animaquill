import { parseTime, toSeconds, type TransitionUse } from "@animaquill/schema";
import { Blend } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu, type MenuItem } from "../app/Menu.tsx";
import { useWorkbench } from "../app/context.ts";
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
import type { Edge } from "../timeline/model.ts";
import { TRANSITION_DRAG_TYPE, transitionDrag } from "../timeline/transition-drag.ts";
import { canTakeEdge } from "../timeline/transition-place.ts";
import { transitionName } from "../timeline/transition-names.ts";

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

interface AttachMenu {
  readonly x: number;
  readonly y: number;
  readonly resource: Resource<TransitionItem>;
}

/**
 * The transitions to find and use: dragged onto the timeline, or clicked with something selected
 * there. See docs/design/resource-panels.md, sections 2 and 3.
 */
export function TransitionsPanel() {
  const { timeline, resourceHabits: habits } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const resources = useMemo(() => builtInTransitions(t), [t]);
  const [menu, setMenu] = useState<AttachMenu>();
  const context = timeline.attachContext;
  const { model } = snapshot;

  const unavailable = ({ data }: Resource<TransitionItem>) => {
    const problem = timeline.attachProblem(data.use, data.pick);
    // With nothing selected a click has nothing to be about, but nothing is wrong with any of them.
    if (problem === undefined || problem === "nothing") return undefined;
    return { reason: t(`transitionPanel.why.${problem}`), draggable: true };
  };

  const attach = (resource: Resource<TransitionItem>, edges: readonly Edge[]) => {
    const { pick, use } = resource.data;
    if (timeline.attachTransition(pick, use, edges)) habits.used(resource.id);
  };

  const onActivate = (resource: Resource<TransitionItem>, anchor: DOMRect) => {
    const { use } = resource.data;
    // One clip takes it at either edge, or both: people say which.
    if (context.kind === "clips" && context.boxes.length === 1 && use !== "join") {
      setMenu({ x: anchor.left, y: anchor.bottom + 2, resource });
      return;
    }
    attach(resource, use === "join" ? [] : [use]);
  };

  const menuGroups = (resource: Resource<TransitionItem>): readonly (readonly MenuItem[])[] => {
    const box = context.kind === "clips" ? context.boxes[0] : undefined;
    const { pick } = resource.data;
    const can = (edge: Edge) =>
      model !== undefined &&
      box !== undefined &&
      pick.uses.includes(edge) &&
      canTakeEdge(model, box, edge);
    const item = (id: "enter" | "exit" | "both", edges: readonly Edge[]): MenuItem => ({
      id,
      label:
        id === "both"
          ? t("transitionPanel.attach.both")
          : t(`transitionPanel.attach.${id}`, {
              name: transitionName(t, pick.name, id, "picture"),
            }),
      disabled: !edges.every(can),
      run: () => attach(resource, edges),
    });
    return [[item("enter", ["enter"]), item("exit", ["exit"]), item("both", ["enter", "exit"])]];
  };

  return (
    <>
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
      />
      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={menu.resource.name}
          groups={menuGroups(menu.resource)}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}
