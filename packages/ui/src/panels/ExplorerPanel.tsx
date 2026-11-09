import {
  missingIn,
  usesOf,
  type MissingResource,
  type ResourceUse,
  type UsedResource,
} from "@animaquill/core";
import {
  describeMissing,
  describeMissingEffect,
  parseTime,
  toSeconds,
  type TransitionRef,
} from "@animaquill/schema";
import { Boxes, FileQuestion, FolderTree, Library, TriangleAlert } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { MenuItem } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import type { EffectItem } from "../resources/effects.ts";
import { EFFECT_RESOURCE_TYPES, builtInEffects } from "../resources/effects.ts";
import { EXPLORER_NODES, parentOf, type ExplorerNode } from "../resources/explorer.ts";
import { ProjectIcon, lengthOf } from "../resources/ProjectIcon.tsx";
import { ResourceBrowser, type ResourceIconProps } from "../resources/ResourceBrowser.tsx";
import {
  PROJECT_TYPES,
  parseTags,
  projectResources,
  type ProjectItem,
} from "../resources/project-resources.ts";
import type { Resource } from "../resources/resources.ts";
import {
  TRANSITION_TYPES,
  builtInTransitions,
  type TransitionItem,
} from "../resources/transitions.ts";
import { resourceTypeName } from "../resources/type-names.ts";
import { formatSize } from "../transfer/transfer.ts";
import { textOf } from "../properties/names.ts";
import { EffectIcon } from "./EffectsPanel.tsx";
import { TransitionIcon } from "./TransitionsPanel.tsx";
import styles from "./ExplorerPanel.module.css";

/** What the explorer knows of each resource it lists, wherever it is from. */
export type ExplorerItem =
  | { readonly kind: "project"; readonly item: ProjectItem }
  | { readonly kind: "transition"; readonly item: TransitionItem }
  | { readonly kind: "effect"; readonly item: EffectItem }
  /** Something that clips use, which is not there. */
  | { readonly kind: "missing"; readonly missing: MissingResource };

const TYPES: readonly string[] = [
  ...PROJECT_TYPES,
  ...TRANSITION_TYPES,
  ...EFFECT_RESOURCE_TYPES,
  "transition",
  "effect",
  "library",
];

const noSubscription = () => () => {};
const noProxies = () => undefined;

/** At most this many places where something is used are listed. */
const USES_SHOWN = 50;

const as = <T, D>(resource: Resource<T>, data: D): Resource<D> => ({ ...resource, data });

/** The picture of any resource, as the tab where it is found has it. */
function ExplorerIcon({ resource, playing }: ResourceIconProps<ExplorerItem>) {
  const { data } = resource;
  switch (data.kind) {
    case "project":
      return <ProjectIcon resource={as(resource, data.item)} playing={playing} />;
    case "transition":
      return <TransitionIcon resource={as(resource, data.item)} playing={playing} />;
    case "effect":
      return <EffectIcon resource={as(resource, data.item)} playing={playing} />;
    case "missing":
      return data.missing.kind === "library" ? (
        <Library size={24} aria-hidden />
      ) : (
        <FileQuestion size={24} aria-hidden />
      );
  }
}

/** What a reference to a transition says it is, as people read it. */
const refName = (ref: TransitionRef): string => {
  const base = ref.type ?? ref.transition ?? `${ref.library ?? ""}/${ref.resource ?? ""}`;
  return ref.variant === undefined ? base : `${base}.${ref.variant}`;
};

/** Something that is missing, as a resource of the list. */
function missingResource(t: TFunction, missing: MissingResource) {
  const source = { kind: "project" } as const;
  const data: ExplorerItem = { kind: "missing", missing };
  const base = { source, tags: [] as readonly string[], data };
  switch (missing.kind) {
    case "asset":
    case "scene":
    case "sound":
      return {
        ...base,
        id: `missing:${missing.kind}:${missing.id}`,
        type: missing.kind === "asset" ? "file" : missing.kind,
        name: (t as (key: string, options: object) => string)(
          `explorer.missingName.${missing.kind}`,
          { id: missing.id },
        ),
        keywords: [missing.id],
      };
    case "library":
      return {
        ...base,
        id: `missing:library:${missing.library}:${missing.item}`,
        type: "library",
        name: missing.item.slice(missing.item.lastIndexOf("/") + 1),
        keywords: [missing.library, missing.item],
      };
    case "effect":
      return { ...base, id: `missing:effect:${missing.type}`, type: "effect", name: missing.type };
    case "transition":
      return {
        ...base,
        id: `missing:transition:${missing.use}:${refName(missing.ref)}`,
        type: `transition.${missing.use}`,
        name: refName(missing.ref),
      };
  }
}

/** What a resource is, for where it is used. */
function usedOf(data: ExplorerItem): UsedResource | undefined {
  switch (data.kind) {
    case "project":
      return { kind: data.item.kind, id: data.item.id };
    case "transition":
      return { kind: "transition", use: data.item.use, ref: data.item.pick.name };
    case "effect":
      return { kind: "effect", type: data.item.type };
    case "missing":
      return undefined;
  }
}

/**
 * The explorer: every resource and where it is from, on the left the sources, on the right what one
 * of them has with the details of the one chosen. This is where the resources of the project are
 * looked after: renamed, tagged, replaced, taken away, and found again when they are missing. Each
 * change goes through the commands, so AI can do the same. See docs/design/resource-panels.md,
 * section 1.
 */
export function ExplorerPanel() {
  const workbench = useWorkbench();
  const { explorer, missingFiles } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const project = useProject(store);
  const snapshot = useSyncExternalStore(explorer.subscribe, explorer.getSnapshot);
  const missing = useSyncExternalStore(missingFiles.subscribe, missingFiles.getSnapshot);
  const transitions = useMemo(
    () =>
      builtInTransitions(t).map((resource) =>
        as(resource, { kind: "transition", item: resource.data } as ExplorerItem),
      ),
    [t],
  );
  const effects = useMemo(
    () =>
      builtInEffects(t).map((resource) =>
        as(resource, { kind: "effect", item: resource.data } as ExplorerItem),
      ),
    [t],
  );
  const own = useMemo(
    () =>
      project
        ? projectResources(project, project.manifest.id).map((resource) =>
            as(resource, { kind: "project", item: resource.data } as ExplorerItem),
          )
        : [],
    [project],
  );
  const references = useMemo(() => (project ? missingIn(project) : []), [project]);
  const gone = useMemo(
    () => [
      ...own.filter(
        ({ data }) =>
          data.kind === "project" && data.item.kind === "asset" && missing.has(data.item.id),
      ),
      ...references.map((each) => missingResource(t, each) as Resource<ExplorerItem>),
    ],
    [own, missing, references, t],
  );

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
  const chosen = resources.find(({ id }) => id === snapshot.selected);
  const actions = useResourceActions();

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
                Icon={ExplorerIcon}
                selected={snapshot.selected}
                revealed={snapshot.revealed}
                onSelect={(resource) => explorer.select(resource.id)}
                onActivate={(resource) => explorer.select(resource.id)}
                menu={(resource) => actions(resource)}
                {...(node === "missing" && { empty: t("explorer.noMissing") })}
              />
            </div>
          )}
          <Details resource={chosen} actions={chosen ? actions(chosen) : []} />
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

/** What people can do with a resource: in its menu, and as buttons in its details. */
function useResourceActions() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const missing = useSyncExternalStore(
    workbench.missingFiles.subscribe,
    workbench.missingFiles.getSnapshot,
  );
  const { dialogs, notifications, explorer, proxies } = workbench;
  const proxySnapshot = useSyncExternalStore(
    proxies?.subscribe ?? noSubscription,
    proxies?.getSnapshot ?? noProxies,
  );

  const run = (type: string, params: object): boolean => {
    const result = store?.execute({ type, params } as never);
    if (result && !result.ok) {
      notifications.push(t("notice.commandFailed", { message: result.error.message }));
    }
    return result?.ok ?? false;
  };

  const rename = async (item: ProjectItem, name: string) => {
    const next = await dialogs.prompt({
      title: t("explorer.rename.title", { name }),
      value: name,
      confirm: t("explorer.rename.confirm"),
    });
    const trimmed = next?.trim();
    if (!trimmed || trimmed === name) return;
    if (item.kind === "asset") run("asset.update", { asset: item.id, changes: { name: trimmed } });
    else run(`${item.kind}.update`, { [item.kind]: item.id, changes: { name: trimmed } });
  };

  const editTags = async (item: ProjectItem, name: string, tags: readonly string[]) => {
    const next = await dialogs.prompt({
      title: t("explorer.tags.title", { name }),
      value: tags.join("、"),
      hint: t("explorer.tags.hint"),
      allowEmpty: true,
      confirm: t("explorer.tags.confirm"),
    });
    if (next === undefined) return;
    const parsed = parseTags(next);
    if (parsed.join("\n") === tags.join("\n")) return;
    if (item.kind === "asset") run("asset.update", { asset: item.id, changes: { tags: parsed } });
    else if (parsed.length === 0) {
      run(`${item.kind}.update`, { [item.kind]: item.id, changes: {}, clear: ["tags"] });
    } else run(`${item.kind}.update`, { [item.kind]: item.id, changes: { tags: parsed } });
  };

  const remove = async (resource: Resource<ExplorerItem>, item: ProjectItem) => {
    const state = store?.getState();
    if (!state) return;
    const uses = usesOf(state, { kind: item.kind, id: item.id });
    const confirmed = await dialogs.confirm({
      title: t("explorer.remove.title", { name: resource.name }),
      message:
        uses.length > 0
          ? t("explorer.remove.inUse", { count: uses.length })
          : t("explorer.remove.message"),
      confirm: t("explorer.remove.confirm"),
      danger: true,
      ...(uses.length > 0 && {
        details: [
          { title: t("explorer.remove.uses"), items: uses.map((use) => labelOfUse(t, state, use)) },
        ],
      }),
    });
    if (!confirmed) return;
    const params = { [item.kind]: item.id, ...(uses.length > 0 && { withUses: true }) };
    if (run(`${item.kind}.remove`, params)) explorer.select(undefined);
  };

  const swap = async (
    name: string,
    kind: ProjectItem["kind"],
    from: string,
    assetKind?: string,
  ) => {
    const state = store?.getState();
    if (!state) return;
    const uses =
      missingOf(state).find((each) => "id" in each && each.kind === kind && each.id === from)
        ?.uses ?? usesOf(state, { kind, id: from });
    const candidates =
      kind === "asset"
        ? Object.entries(state.assets ?? {}).flatMap(([id, asset]) =>
            id !== from &&
            (assetKind === undefined
              ? ["video", "image", "audio"].includes(asset.kind)
              : asset.kind === assetKind)
              ? [{ id, label: asset.name ?? asset.path }]
              : [],
          )
        : Object.entries(kind === "scene" ? state.scenes : state.sounds).flatMap(
            ([id, manifest]) => (id === from ? [] : [{ id, label: manifest.name }]),
          );
    const [first] = candidates;
    if (!first) {
      await dialogs.confirm({
        title: t("explorer.swap.title", { name }),
        message: t("explorer.swap.none"),
        confirm: t("dialog.close"),
        noticeOnly: true,
      });
      return;
    }
    const answer = await dialogs.form({
      title: t("explorer.swap.title", { name }),
      fields: [{ id: "to", label: t("explorer.swap.field"), options: candidates, value: first.id }],
      notes: [t("explorer.swap.note", { count: uses.length })],
      confirm: t("explorer.swap.confirm"),
    });
    const to = answer?.["to"];
    if (to !== undefined) run("source.replace", { kind, from, to });
  };

  const afterFile = (done: Promise<boolean>) =>
    void done.then((changed) => changed && workbench.projectFolders?.checkAssetsSoon());

  return (resource: Resource<ExplorerItem>): readonly (readonly MenuItem[])[] => {
    const { data } = resource;
    if (data.kind === "transition" || data.kind === "effect") {
      return [
        [
          {
            id: "copy",
            label: `${t("explorer.actions.copy")}（${t("explorer.actions.copyLater")}）`,
            disabled: true,
            run: () => {},
          },
        ],
      ];
    }
    if (data.kind === "missing") {
      const { missing: gone } = data;
      if (gone.kind === "asset" || gone.kind === "scene" || gone.kind === "sound") {
        return [
          [
            {
              id: "swap",
              label: t("explorer.actions.swap"),
              run: () => void swap(resource.name, gone.kind, gone.id),
            },
          ],
        ];
      }
      return [];
    }
    const { item } = data;
    const manage: MenuItem[] = [
      {
        id: "rename",
        label: t("explorer.actions.rename"),
        run: () => void rename(item, resource.name),
      },
      {
        id: "tags",
        label: t("explorer.actions.tags"),
        run: () => void editTags(item, resource.name, resource.tags),
      },
    ];
    if (item.kind !== "asset") {
      return [
        manage,
        [
          {
            id: "remove",
            label: t("explorer.actions.remove"),
            run: () => void remove(resource, item),
          },
        ],
      ];
    }
    const file = missing.get(item.id);
    const found = file?.found;
    const fileItems: MenuItem[] = file
      ? [
          ...(found === undefined
            ? []
            : [
                {
                  id: "usePlace",
                  label: t("explorer.actions.usePlace", { path: found }),
                  run: () => afterFile(workbench.moveAssetTo(item.id, found)),
                },
              ]),
          {
            id: "refind",
            label: t("explorer.actions.refind"),
            run: () => afterFile(workbench.replaceAssetFile(item.id)),
          },
          {
            id: "swap",
            label: t("explorer.actions.swap"),
            run: () => void swap(resource.name, "asset", item.id, item.asset.kind),
          },
        ]
      : [
          {
            id: "replace",
            label: t("explorer.actions.replace"),
            run: () => afterFile(workbench.replaceAssetFile(item.id)),
          },
        ];
    const { hash } = item.asset;
    const proxy = hash === undefined ? undefined : proxySnapshot?.states.get(hash);
    const proxyItems: MenuItem[] =
      proxies && hash !== undefined && proxy && !file
        ? proxy.kind === "none" || proxy.kind === "stopped" || proxy.kind === "failed"
          ? proxySnapshot?.elsewhere
            ? []
            : [{ id: "proxy", label: t("proxy.make"), run: () => proxies.make(hash) }]
          : proxy.kind === "ready" || proxy.kind === "checking"
            ? []
            : [{ id: "proxy", label: t("proxy.stop"), run: () => proxies.stop(hash) }]
        : [];
    return [
      manage,
      fileItems,
      ...(proxyItems.length > 0 ? [proxyItems] : []),
      [
        {
          id: "remove",
          label: t("explorer.actions.remove"),
          run: () => void remove(resource, item),
        },
      ],
    ];
  };
}

/** What is missing in a state, kept for as long as the state is the same. */
const missingByState = new WeakMap<object, readonly MissingResource[]>();
function missingOf(state: Parameters<typeof missingIn>[0]): readonly MissingResource[] {
  let known = missingByState.get(state);
  if (!known) {
    known = missingIn(state);
    missingByState.set(state, known);
  }
  return known;
}

/** Where a resource is used, in words: which clip, which part of it, when, and in which version. */
function labelOfUse(t: TFunction, state: Parameters<typeof usesOf>[0], use: ResourceUse): string {
  const timeline = state.timelines[use.timeline];
  const clip = use.clip === undefined ? undefined : timeline?.clips[use.clip];
  if (!clip) return t("explorer.uses.gone");
  const kind = clip.source.kind;
  const name = clip.name ?? textOf(t, `timeline.kind.${kind}`, kind);
  let seconds = 0;
  try {
    seconds = toSeconds(parseTime(clip.start));
  } catch {
    // The time shows as 0:00.
  }
  const whole = Math.floor(seconds);
  const time = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  const place =
    use.join !== undefined
      ? t("explorer.uses.join", { name, time })
      : use.edge !== undefined
        ? t(`explorer.uses.${use.edge}`, { name, time })
        : use.effect !== undefined
          ? t("explorer.uses.effect", { name, time })
          : t("explorer.uses.clip", { name, time });
  return use.version === undefined
    ? place
    : t("explorer.uses.version", { place, version: use.version });
}

/** The details of the chosen resource: what it is, where it is used, and what can be done with it. */
function Details({
  resource,
  actions,
}: {
  readonly resource: Resource<ExplorerItem> | undefined;
  readonly actions: readonly (readonly MenuItem[])[];
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const missing = useSyncExternalStore(
    workbench.missingFiles.subscribe,
    workbench.missingFiles.getSnapshot,
  );
  const [pointed, setPointed] = useState(false);
  // Looking through every clip takes a while in a large project: once for each state of it.
  const uses = useMemo((): readonly ResourceUse[] => {
    if (!state || !resource) return [];
    if (resource.data.kind === "missing") return resource.data.missing.uses;
    const used = usedOf(resource.data);
    return used ? usesOf(state, used) : [];
  }, [state, resource]);
  if (!resource) {
    return (
      <section className={styles.details} aria-label={t("explorer.details")}>
        <p className={styles.quiet}>{t("explorer.nothingChosen")}</p>
      </section>
    );
  }
  const { data } = resource;
  const fields: [string, ReactNode][] = [
    [t("explorer.fields.type"), resourceTypeName(t, resource.type)],
  ];
  const problems: string[] = [];
  if (data.kind === "project") {
    const { item } = data;
    if (item.kind === "asset") {
      const { asset } = item;
      const length = lengthOf(asset);
      if (length) fields.push([t("explorer.fields.length"), length]);
      if (asset.info?.width && asset.info.height) {
        fields.push([t("explorer.fields.picture"), `${asset.info.width}×${asset.info.height}`]);
      }
      if (asset.size !== undefined)
        fields.push([t("explorer.fields.size"), formatSize(asset.size)]);
      if (asset.license) fields.push([t("explorer.fields.license"), asset.license]);
      if (asset.credit) fields.push([t("explorer.fields.credit"), asset.credit]);
      fields.push([
        t("explorer.fields.from"),
        t("explorer.from.asset", { path: asset.path, interpolation: { escapeValue: false } }),
      ]);
      const file = missing.get(item.id);
      if (file) {
        problems.push(
          t("explorer.missing.file", { path: file.path, interpolation: { escapeValue: false } }),
        );
        if (file.hidden !== undefined)
          problems.push(t("explorer.missing.hidden", { name: file.hidden }));
        if (file.found !== undefined) {
          problems.push(
            t("explorer.missing.moved", {
              found: file.found,
              interpolation: { escapeValue: false },
            }),
          );
        }
      }
    } else {
      fields.push([t("explorer.fields.from"), t(`explorer.from.${item.kind}`, { id: item.id })]);
    }
  } else if (data.kind === "missing") {
    const { missing: gone } = data;
    fields.push([t("explorer.fields.from"), t("explorer.from.missing")]);
    problems.push(
      gone.kind === "effect"
        ? describeMissingEffect(gone.why)
        : gone.kind === "transition"
          ? describeMissing(gone.why)
          : gone.kind === "library"
            ? t("explorer.missing.library", {
                library: gone.library,
                item: gone.item,
                interpolation: { escapeValue: false },
              })
            : t(`explorer.missing.${gone.kind}`, { id: gone.id }),
    );
  } else {
    fields.push([t("explorer.fields.from"), t("explorer.from.built-in")]);
  }
  const shownTimeline = workbench.timeline.model?.id;
  const timelineName = (id: string) => state?.timelines[id]?.name ?? id;
  return (
    <section className={styles.details} aria-label={t("explorer.details")}>
      <div
        className={styles.preview}
        onPointerEnter={() => setPointed(true)}
        onPointerLeave={() => setPointed(false)}
      >
        <ExplorerIcon resource={resource} playing={pointed} />
      </div>
      <h3 className={styles.title}>{resource.name}</h3>
      {problems.map((problem) => (
        <p key={problem} className={styles.problem} role="note">
          {problem}
        </p>
      ))}
      <dl className={styles.fields}>
        {fields.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>{t("explorer.fields.tags")}</dt>
          <dd>
            {resource.tags.length === 0 ? (
              <span className={styles.quiet}>{t("explorer.noTags")}</span>
            ) : (
              <ul className={styles.tags} aria-label={t("explorer.fields.tags")}>
                {resource.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      {actions.some((group) => group.length > 0) && (
        <div className={styles.actions} role="group" aria-label={t("explorer.actions.label")}>
          {actions.flat().map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={action.run}
              data-danger={action.id === "remove" ? "" : undefined}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <h4 className={styles.subtitle}>
        {t("explorer.uses.title")}
        {uses.length > 0 && (
          <span className={styles.quiet}> {t("explorer.uses.count", { count: uses.length })}</span>
        )}
      </h4>
      {uses.length === 0 ? (
        <p className={styles.quiet}>{t("explorer.uses.none")}</p>
      ) : (
        <ul className={styles.uses} aria-label={t("explorer.uses.title")}>
          {uses.slice(0, USES_SHOWN).map((use, index) => {
            const elsewhere = use.timeline !== shownTimeline;
            const label = state ? labelOfUse(t, state, use) : "";
            return (
              <li
                key={`${use.timeline}/${use.clip ?? ""}/${use.join ?? ""}/${use.edge ?? ""}/${use.effect ?? ""}/${use.version ?? ""}/${index}`}
              >
                <button
                  type="button"
                  disabled={elsewhere}
                  title={
                    elsewhere
                      ? t("explorer.uses.elsewhere", { timeline: timelineName(use.timeline) })
                      : undefined
                  }
                  onClick={() => workbench.goToUse(use)}
                >
                  {label}
                </button>
              </li>
            );
          })}
          {uses.length > USES_SHOWN && (
            <li className={styles.quiet}>
              {t("explorer.uses.more", { count: uses.length - USES_SHOWN })}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
