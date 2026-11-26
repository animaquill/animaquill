import { UploadMark, useAssetMarks, usePlaceMenu } from "../storage/marks.tsx";
import { Boxes, FolderTree, Library, TriangleAlert } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { useResourceCatalog, type ExplorerItem } from "../resources/catalog.ts";
import {
  EFFECT_RESOURCE_TYPES,
  effectResourceTypes,
  effectTypesUsed,
} from "../resources/effects.ts";
import { EXPLORER_NODES, parentOf, type ExplorerNode } from "../resources/explorer.ts";
import { ResourceBrowser } from "../resources/ResourceBrowser.tsx";
import { PROJECT_TYPES, type ProjectItem } from "../resources/project-resources.ts";
import type { Resource } from "../resources/resources.ts";
import { FADE_TYPES, TRANSITION_TYPES } from "../resources/transitions.ts";
import { resourceTypeName } from "../resources/type-names.ts";
import { textOf } from "../properties/names.ts";
import { canDragProjectItem, startProjectItemDrag } from "./AssetsPanel.tsx";
import { endEffectDrag, startEffectDrag } from "./EffectsPanel.tsx";
import { ResourcePicture, useResourceActions } from "./ResourceDetails.tsx";
import { endTransitionDrag, startTransitionDrag } from "./TransitionsPanel.tsx";
import styles from "./ExplorerPanel.module.css";

export type { ExplorerItem } from "../resources/catalog.ts";

const TYPES: readonly string[] = [
  ...PROJECT_TYPES,
  ...TRANSITION_TYPES,
  ...FADE_TYPES,
  ...EFFECT_RESOURCE_TYPES,
  ...effectResourceTypes("sound"),
  "transition",
  "effect",
  "library",
];

/**
 * The explorer: every resource and where it is from, on the left the sources, on the right what one
 * of them has. A click opens a resource in the resources tab: the code of a scene or a sound, the
 * details of anything else, where it is looked after: renamed, tagged, replaced, taken away, and
 * found again when it is missing. The menu of a resource has the same. Each change goes through
 * the commands, so AI can do the same. Resources go onto the timeline by dragging, as from the tabs
 * that find them. See docs/design/resource-panels.md, section 1.
 */
export function ExplorerPanel() {
  const workbench = useWorkbench();
  const { explorer, timeline, resourceHabits: habits } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(explorer.subscribe, explorer.getSnapshot);
  const { transitions, fades, effects, soundEffects, own, gone } = useResourceCatalog();
  const { store } = useSession();
  const state = useProject(store);
  const used = useMemo(() => (state ? effectTypesUsed(state) : new Set<string>()), [state]);

  const listOf = (node: ExplorerNode): readonly Resource<ExplorerItem>[] => {
    const ofKind = (kind: ProjectItem["kind"]) =>
      own.filter(({ data }) => data.kind === "project" && data.item.kind === kind);
    switch (node) {
      case "built-in":
        return [...transitions, ...fades, ...effects, ...soundEffects];
      case "built-in.transitions":
        return transitions;
      case "built-in.fades":
        return fades;
      case "built-in.effects":
        return effects;
      case "built-in.soundEffects":
        return soundEffects;
      case "project":
        return own;
      case "project.media":
        return ofKind("asset");
      case "project.scenes":
        return ofKind("scene");
      case "project.sounds":
        return ofKind("sound");
      case "project.effects":
        return effects.filter(({ data }) => data.kind === "effect" && used.has(data.item.type));
      case "project.soundEffects":
        return soundEffects.filter(
          ({ data }) => data.kind === "effect" && used.has(data.item.type),
        );
      case "missing":
        return gone;
      case "project.transitions":
      case "libraries":
        return [];
    }
  };
  const { node } = snapshot;
  const resources = useMemo(
    () => listOf(node),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- listOf only reads what is listed here
    [node, own, transitions, fades, effects, soundEffects, used, gone],
  );
  const actions = useResourceActions();
  const placeMenu = usePlaceMenu();
  const marks = useAssetMarks();
  const markOf = ({ data }: Resource<ExplorerItem>) =>
    data.kind === "project" && data.item.kind === "asset" ? (
      <UploadMark mark={marks.get(data.item.id)} />
    ) : undefined;
  const assetsOf = (chosen: readonly Resource<ExplorerItem>[]) =>
    chosen.flatMap(({ data }) =>
      data.kind === "project" && data.item.kind === "asset" ? [data.item.id] : [],
    );
  const menu = (resource: Resource<ExplorerItem>, chosen: readonly Resource<ExplorerItem>[]) => {
    const place = placeMenu(assetsOf(chosen));
    // Of more than one: only what goes for all of them.
    if (chosen.length > 1) return place ? [[place]] : [];
    return [
      [
        {
          id: "details",
          label: t("explorer.actions.details"),
          run: () => workbench.openResourcePage(resource.id, resource.name),
        },
      ],
      ...(place ? [[place]] : []),
      ...actions(resource),
    ];
  };

  const noteOf = (at: ExplorerNode): string | undefined => {
    if (at === "missing")
      return resources.length === 0 ? t("explorer.noMissing") : t("explorer.notes.missing");
    if (at.startsWith("built-in")) return t("explorer.notes.built-in");
    if (at === "project.transitions" || at === "libraries") {
      return textOf(t, `explorer.notes.${at.replace(".", "_")}`, at);
    }
    return undefined;
  };
  const note = noteOf(node);
  const nodeName = (at: ExplorerNode) => textOf(t, `explorer.nodes.${at.replace(".", "_")}`, at);

  return (
    <div className={styles.explorer}>
      <div className={styles.layout}>
        <SourceTree
          node={node}
          missingCount={gone.length}
          onChoose={(at) => explorer.choose(at)}
          nameOf={nodeName}
        />
        <div className={styles.main}>
          {note && <p className={styles.note}>{note}</p>}
          {node !== "libraries" && node !== "project.transitions" && (
            <div className={styles.browser}>
              <ResourceBrowser<ExplorerItem>
                tab="explorer"
                label={t("explorer.list", { node: nodeName(node) })}
                searchLabel={t("explorer.search")}
                resources={resources}
                types={TYPES}
                defaultGrouping="type"
                typeName={(type) => resourceTypeName(t, type)}
                unavailable={() => undefined}
                Icon={ResourcePicture}
                selected={snapshot.selected}
                revealed={snapshot.revealed}
                pointed={snapshot.pointed}
                onSelect={(resource) => explorer.select(resource.id)}
                onActivate={(resource) => workbench.openResource(resource.id, resource.name)}
                menu={menu}
                multiple
                mark={markOf}
                {...(node === "missing" && { empty: t("explorer.noMissing") })}
                {...(node === "project.effects" && { empty: t("explorer.emptyUsed.effects") })}
                {...(node === "project.soundEffects" && {
                  empty: t("explorer.emptyUsed.soundEffects"),
                })}
                canDrag={({ data }) =>
                  data.kind === "transition" ||
                  data.kind === "effect" ||
                  (data.kind === "project" && canDragProjectItem(data.item))
                }
                onDragStart={({ data, id }, event) => {
                  if (data.kind === "project") startProjectItemDrag(data.item, event);
                  else if (data.kind === "transition") startTransitionDrag(data.item, id, event);
                  else if (data.kind === "effect") startEffectDrag(data.item, event);
                }}
                onDragEnd={({ data, id }, dropped) => {
                  if (data.kind === "transition") endTransitionDrag(timeline);
                  else if (data.kind === "effect") endEffectDrag(timeline);
                  if (dropped) habits.used(id);
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The tree of sources: built in, this project with its kinds and what is missing, libraries. */
function SourceTree({
  node,
  missingCount,
  onChoose,
  nameOf,
}: {
  readonly node: ExplorerNode;
  readonly missingCount: number;
  readonly onChoose: (node: ExplorerNode) => void;
  readonly nameOf: (node: ExplorerNode) => string;
}) {
  const { t } = useTranslation();
  const tree = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = EXPLORER_NODES.indexOf(node);
    const next =
      event.key === "ArrowDown"
        ? EXPLORER_NODES[Math.min(index + 1, EXPLORER_NODES.length - 1)]
        : event.key === "ArrowUp"
          ? EXPLORER_NODES[Math.max(index - 1, 0)]
          : event.key === "Home"
            ? EXPLORER_NODES[0]
            : event.key === "End"
              ? EXPLORER_NODES.at(-1)
              : event.key === "ArrowLeft"
                ? parentOf(node)
                : undefined;
    if (!next) return;
    event.preventDefault();
    onChoose(next);
    tree.current?.querySelector<HTMLElement>(`[data-node="${next}"]`)?.focus();
  };
  const icons: Partial<Record<ExplorerNode, ReactNode>> = {
    "built-in": <Boxes size={14} aria-hidden />,
    project: <FolderTree size={14} aria-hidden />,
    missing: <TriangleAlert size={14} aria-hidden />,
    libraries: <Library size={14} aria-hidden />,
  };
  // In one line, as where the tab is narrow, the one chosen is in sight.
  useEffect(() => {
    tree.current
      ?.querySelector(`[data-node="${node}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [node]);
  return (
    <div
      ref={tree}
      className={styles.tree}
      role="tree"
      aria-label={t("explorer.tree")}
      onKeyDown={onKeyDown}
      onWheel={(event) => {
        // In one line, the wheel goes along it, as a mouse has no other way to.
        const element = event.currentTarget;
        const sideways =
          element.scrollWidth > element.clientWidth + 1 &&
          element.scrollHeight <= element.clientHeight + 1;
        if (!sideways || event.deltaX !== 0) return;
        element.scrollLeft += event.deltaY;
      }}
    >
      {EXPLORER_NODES.map((at) => {
        const parent = parentOf(at);
        const level = parent ? 2 : at === "missing" ? 2 : 1;
        const name =
          at === "missing" && missingCount > 0
            ? t("explorer.missingCount", { count: missingCount })
            : nameOf(at);
        return (
          <div
            key={at}
            role="treeitem"
            aria-level={level}
            aria-selected={at === node}
            {...((at === "built-in" || at === "project") && { "aria-expanded": true })}
            tabIndex={at === node ? 0 : -1}
            data-node={at}
            data-missing={at === "missing" && missingCount > 0 ? "" : undefined}
            className={styles.node}
            style={{ paddingLeft: 6 + (level - 1) * 14 }}
            onClick={() => onChoose(at)}
          >
            {icons[at]}
            <span>{name}</span>
          </div>
        );
      })}
    </div>
  );
}
