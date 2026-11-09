import { Boxes, FolderTree, Library, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { useResourceCatalog, type ExplorerItem } from "../resources/catalog.ts";
import { EFFECT_RESOURCE_TYPES } from "../resources/effects.ts";
import { EXPLORER_NODES, parentOf, type ExplorerNode } from "../resources/explorer.ts";
import { ResourceBrowser } from "../resources/ResourceBrowser.tsx";
import { PROJECT_TYPES, type ProjectItem } from "../resources/project-resources.ts";
import type { Resource } from "../resources/resources.ts";
import { TRANSITION_TYPES } from "../resources/transitions.ts";
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
  ...EFFECT_RESOURCE_TYPES,
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
  const { transitions, effects, own, gone } = useResourceCatalog();

  const listOf = (node: ExplorerNode): readonly Resource<ExplorerItem>[] => {
    const ofKind = (kind: ProjectItem["kind"]) =>
      own.filter(({ data }) => data.kind === "project" && data.item.kind === kind);
    switch (node) {
      case "built-in":
        return [...transitions, ...effects];
      case "built-in.transitions":
        return transitions;
      case "built-in.effects":
        return effects;
      case "project":
        return own;
      case "project.media":
        return ofKind("asset");
      case "project.scenes":
        return ofKind("scene");
      case "project.sounds":
        return ofKind("sound");
      case "missing":
        return gone;
      case "project.transitions":
      case "project.effects":
      case "libraries":
        return [];
    }
  };
  const { node } = snapshot;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- listOf only reads what is listed here
  const resources = useMemo(() => listOf(node), [node, own, transitions, effects, gone]);
  const actions = useResourceActions();
  const menu = (resource: Resource<ExplorerItem>) => [
    [
      {
        id: "details",
        label: t("explorer.actions.details"),
        run: () => workbench.openResourcePage(resource.id, resource.name),
      },
    ],
    ...actions(resource),
  ];

  const noteOf = (at: ExplorerNode): string | undefined => {
    if (at === "missing")
      return resources.length === 0 ? t("explorer.noMissing") : t("explorer.notes.missing");
    if (at.startsWith("built-in")) return t("explorer.notes.built-in");
    if (at === "project.transitions" || at === "project.effects" || at === "libraries") {
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
          {node !== "libraries" && node !== "project.transitions" && node !== "project.effects" && (
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
                onSelect={(resource) => explorer.select(resource.id)}
                onActivate={(resource) => workbench.openResource(resource.id, resource.name)}
                menu={menu}
                {...(node === "missing" && { empty: t("explorer.noMissing") })}
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
  return (
    <div
      ref={tree}
      className={styles.tree}
      role="tree"
      aria-label={t("explorer.tree")}
      onKeyDown={onKeyDown}
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
