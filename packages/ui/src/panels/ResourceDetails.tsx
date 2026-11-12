import {
  missingIn,
  orderedTracks,
  placedAsset,
  usesOf,
  type MissingResource,
  type ResourceUse,
} from "@animaquill/core";
import { describeMissing, describeMissingEffect, parseTime, toSeconds } from "@animaquill/schema";
import { FileQuestion, Library } from "lucide-react";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { MenuItem } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { as, usedOf, useResourceCatalog, type ExplorerItem } from "../resources/catalog.ts";
import { ProjectIcon, lengthOf } from "../resources/ProjectIcon.tsx";
import type { ResourceIconProps } from "../resources/ResourceBrowser.tsx";
import { parseTags, type ProjectItem } from "../resources/project-resources.ts";
import type { Resource } from "../resources/resources.ts";
import { resourceTypeName } from "../resources/type-names.ts";
import { downloadFrom } from "../storage/places.ts";
import { formatSize } from "../transfer/transfer.ts";
import { textOf } from "../properties/names.ts";
import { EffectIcon } from "./EffectsPanel.tsx";
import { TransitionIcon } from "./TransitionsPanel.tsx";
import styles from "./ResourceDetails.module.css";
import { commandFailedText } from "../i18n/failures.ts";

const noSubscription = () => () => {};
const noProxies = () => undefined;

/** At most this many places where something is used are listed. */
const USES_SHOWN = 50;

/** The picture of any resource, as the tab where it is found has it. */
export function ResourcePicture({ resource, playing }: ResourceIconProps<ExplorerItem>) {
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

/** What people can do with a resource: in its menu, and as buttons in its details. */
export function useResourceActions() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const missing = useSyncExternalStore(
    workbench.missingFiles.subscribe,
    workbench.missingFiles.getSnapshot,
  );
  const { dialogs, notifications, explorer, proxies, resourcePages } = workbench;
  const proxySnapshot = useSyncExternalStore(
    proxies?.subscribe ?? noSubscription,
    proxies?.getSnapshot ?? noProxies,
  );

  const run = (type: string, params: object): boolean => {
    const result = store?.execute({ type, params } as never);
    if (result && !result.ok) {
      notifications.push(commandFailedText(t, result.error));
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
    // Used somewhere, it says how much goes with it, and where, each place a click away.
    const confirmed = await dialogs.confirm(
      uses.length > 0
        ? {
            title: t("explorer.remove.inUseTitle", { name: resource.name, count: uses.length }),
            message: t("explorer.remove.inUse", { count: uses.length }),
            confirm: t("explorer.remove.confirmWithUses"),
            danger: true,
            details: [
              {
                title: t("explorer.remove.uses"),
                items: uses.map((use) => ({
                  label: placeOfUse(t, state, use),
                  show: () => workbench.goToUse(use),
                })),
              },
            ],
          }
        : {
            title: t("explorer.remove.title", { name: resource.name }),
            message: t("explorer.remove.message"),
            confirm: t("explorer.remove.confirm"),
            danger: true,
          },
    );
    if (!confirmed) return;
    const params = { [item.kind]: item.id, ...(uses.length > 0 && { withUses: true }) };
    if (!run(`${item.kind}.remove`, params)) return;
    explorer.select(undefined);
    resourcePages.close(resource.id);
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
        [
          {
            id: "code",
            label: t("explorer.actions.code"),
            run: () => workbench.openResource(resource.id, resource.name),
          },
        ],
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

/** Where a resource is used, with the timeline and the track: "主时间轴 · 视频 1 · 红，0:03". */
function placeOfUse(t: TFunction, state: Parameters<typeof usesOf>[0], use: ResourceUse): string {
  const timeline = state.timelines[use.timeline];
  const clip = use.clip === undefined ? undefined : timeline?.clips[use.clip];
  const track = clip && timeline?.tracks[clip.track];
  const parts = [timeline?.name ?? use.timeline];
  if (timeline && track) {
    const number = orderedTracks(timeline)
      .filter(({ kind }) => kind === track.kind)
      .findIndex(({ id }) => id === track.id);
    parts.push(track.name ?? t(`timeline.track.${track.kind}`, { number: number + 1 }));
  }
  parts.push(labelOfUse(t, state, use));
  return parts.join(" · ");
}

/** The details of a resource: what it is, where it is used, and what can be done with it. */
function ResourceDetails({
  resource,
  actions,
}: {
  readonly resource: Resource<ExplorerItem>;
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
      if (file?.elsewhere) {
        const url = state && placedAsset(state, item.id, workbench.here())?.url;
        const download = downloadFrom(t, file.elsewhere, url);
        problems.push(t("explorer.elsewhere", { path: file.path, download }));
      } else if (file) {
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
      <div className={styles.head}>
        <div
          className={styles.preview}
          onPointerEnter={() => setPointed(true)}
          onPointerLeave={() => setPointed(false)}
        >
          <ResourcePicture resource={resource} playing={pointed} />
        </div>
        <div className={styles.summary}>
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
        </div>
      </div>
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

/**
 * A page of the resources tab with the details of one resource, by its id. A resource that went
 * away, by an undo or from elsewhere, says so, and comes back with it.
 */
export function ResourcePage({ id, name }: { readonly id: string; readonly name: string }) {
  const { t } = useTranslation();
  const { byId } = useResourceCatalog();
  const actions = useResourceActions();
  const resource = byId.get(id);
  if (!resource) {
    return (
      <div className={styles.page}>
        <p className={styles.quiet} role="status">
          {t("resourcePage.gone", { name })}
        </p>
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <ResourceDetails resource={resource} actions={actions(resource)} />
    </div>
  );
}
