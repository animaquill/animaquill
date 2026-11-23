import type { ProjectStore } from "@animaquill/core";
import type { CloudProjectSummary } from "@animaquill/host";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { CloudPanelBody } from "../app/CloudPanel.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { cloudOf, storedOf } from "../app/StatusBar.tsx";
import { cloudPanel, panelInputOf, type PanelActionId } from "../cloud/panel.ts";
import settings from "../settings/Settings.module.css";
import { formatSize } from "../transfer/transfer.ts";
import { Facts, Group, Heading, Row, Small, length, moment } from "./parts.tsx";
import { Choice, Segmented } from "../settings/parts.tsx";
import { lfsUsable, type PlaceUnusable } from "../storage/default-place.ts";
import { canChoose, placeRows, placeSummary } from "../storage/place-choice.ts";
import styles from "./Project.module.css";

const noSubscription = () => () => {};
const nothing = () => undefined;

/** Where the open project is, as the design of the properties tells the kinds apart (5.4). */
export type StoredAs =
  /** A folder of this computer: offline. */
  | "folder"
  /** A project of the platform, which this browser has a copy of: online. */
  | "cloudBrowser"
  /** Only in this browser, without the platform. */
  | "browser";

/** What the platform says of the open project, once, as the group opens. */
/**
 * What the platform says of the open project, asked each time the group opens: undefined while it
 * is being asked, `null` where it could not say.
 */
function useSummary(): CloudProjectSummary | null | undefined {
  const { cloud } = useWorkbench();
  const [summary, setSummary] = useState<CloudProjectSummary | null>();
  useEffect(() => {
    let live = true;
    void cloud?.summaryOfOpen().then((found) => live && setSummary(found ?? null));
    return () => {
      live = false;
    };
  }, [cloud]);
  return summary;
}

/** How many proxies the folder has and how large they are, read again after they went. */
function useProxies(): [
  { readonly count: number; readonly bytes: number } | undefined,
  () => void,
] {
  const { proxies } = useWorkbench();
  const [usage, setUsage] = useState<{ count: number; bytes: number }>();
  const read = useCallback(() => {
    void proxies?.usage().then(setUsage);
  }, [proxies]);
  useEffect(read, [read]);
  return [usage, read];
}

export function StorageGroup({
  store,
  locked,
}: {
  readonly store: ProjectStore;
  /** The project cannot be changed now: a locked tag, or read only. */
  readonly locked: boolean;
}) {
  const workbench = useWorkbench();
  const { cloud, projectFolders, proxies, dialogs, notifications } = workbench;
  const { t } = useTranslation();
  const state = useProject(store);
  const { save } = useSession();
  const outer = useSyncExternalStore(
    cloud?.subscribe ?? noSubscription,
    cloud?.getSnapshot ?? nothing,
  );
  // What the panel says follows syncing and archiving as they go.
  const session = outer?.kind === "linked" ? outer.session : undefined;
  useSyncExternalStore(session?.subscribe ?? noSubscription, session?.getSnapshot ?? nothing);
  const repository = outer?.kind === "linked" ? outer.repository : undefined;
  useSyncExternalStore(repository?.subscribe ?? noSubscription, repository?.getSnapshot ?? nothing);
  const known = useSyncExternalStore(
    workbench.cloudKnown.subscribe,
    workbench.cloudKnown.getSnapshot,
  );
  const folders = useSyncExternalStore(
    projectFolders?.subscribe ?? noSubscription,
    projectFolders?.getSnapshot ?? nothing,
  );
  const summary = useSummary();
  const [usage, readUsage] = useProxies();
  const [now] = useState(() => Date.now());
  if (!state) return null;

  const folder = folders?.open?.record.folder.name;
  const linked = outer?.kind === "linked" ? outer : undefined;
  const storedAs: StoredAs = linked ? "cloudBrowser" : folder !== undefined ? "folder" : "browser";
  const panel =
    cloud && outer && known
      ? cloudPanel(
          panelInputOf(outer, {
            name: state.manifest.name,
            ...storedOf(workbench),
            ...cloudOf(workbench),
            now,
          }),
          t,
        )
      : undefined;
  const assets = summary?.size?.assets;
  /** What a fact of the platform says: still being asked, not said, or what it is. */
  const said = (value: string | undefined): string =>
    summary === undefined
      ? t("projectProps.storage.asking")
      : (value ?? t("projectProps.storage.notSaid"));
  /** What people press of the panel: what asks something or leaves goes on without the properties. */
  const run = (id: PanelActionId) => {
    if (id !== "archiveNow" && id !== "retry" && id !== "recheck") workbench.projectNav.close();
    workbench.runCloudAction(id);
  };
  /** Ways out, as the panel of the platform has them: the properties close first. */
  const exit = (id: "saveToFolder") => {
    workbench.projectNav.close();
    workbench.runCloudAction(id);
  };
  const removeProxies = async () => {
    const sure = await dialogs.confirm({
      title: t("projectProps.storage.removeProxiesTitle"),
      message: t("projectProps.storage.removeProxiesMessage"),
      confirm: t("projectProps.storage.removeProxies"),
    });
    if (!sure) return;
    const removed = await proxies?.removeAll();
    if (removed === undefined) notifications.push(t("projectProps.storage.proxiesElsewhere"));
    else notifications.push(t("projectProps.storage.proxiesRemoved", { count: removed }));
    readUsage();
  };

  return (
    <Group title={t("projectProps.groups.storage")}>
      <Row
        id="storedAs"
        name={t(`projectProps.storage.kind.${storedAs}`)}
        help={t(`projectProps.storage.kindHelp.${storedAs}`)}
      >
        {cloud && linked && (
          <Small
            onClick={() => {
              workbench.projectNav.close();
              workbench.cloudPanel.set(true);
            }}
          >
            {t("projectProps.storage.openPanel")}
          </Small>
        )}
      </Row>
      {linked && (
        <>
          <Heading>{t("projectProps.storage.platform")}</Heading>
          <Row
            id="platform"
            name={t("projectProps.storage.platformFacts")}
            wide
            below={
              <>
                <div className={styles.listRow}>
                  <Small disabled={!cloud?.isOnPlatform} onClick={() => exit("saveToFolder")}>
                    {t("saveToFolder.action")}
                  </Small>
                </div>
                <Facts
                  items={[
                    [
                      t("projectProps.storage.id"),
                      <code key="id" className={styles.code}>
                        {linked.link.project}
                      </code>,
                    ],
                    [
                      t("projectProps.storage.size"),
                      said(
                        summary?.size &&
                          t("projectProps.storage.sizeValue", {
                            documents: formatSize(summary.size.documents),
                            assets: assets ? formatSize(assets.bytes) : "—",
                            count: assets?.count ?? 0,
                          }),
                      ),
                    ],
                    [
                      t("projectProps.storage.duration"),
                      said(
                        summary?.durationMs === undefined
                          ? undefined
                          : length(t, summary.durationMs / 1000),
                      ),
                    ],
                    [
                      t("projectProps.general.created"),
                      said(
                        summary?.createdAt === undefined ? undefined : moment(summary.createdAt),
                      ),
                    ],
                    ...(summary?.repository
                      ? ([
                          [
                            t("projectProps.storage.repository"),
                            t(
                              summary.repository.private
                                ? "projectProps.storage.repositoryPrivate"
                                : "projectProps.storage.repositoryPublic",
                              { name: summary.repository.fullName },
                            ),
                          ],
                          [t("projectProps.storage.archivedAt"), moment(summary.archive?.at)],
                        ] as const)
                      : []),
                  ]}
                />
              </>
            }
          />
        </>
      )}
      {linked && workbench.repoMerges && repository?.status?.repository && (
        <PreferRow prefer={repository.status.prefer} />
      )}
      {/* Online a project is the platform's: this computer has a copy of it in the browser only. */}
      {!linked && <Heading>{t("projectProps.storage.local")}</Heading>}
      {linked ? null : folder !== undefined ? (
        <>
          <Row
            id="folder"
            name={t("projectProps.storage.folder", { name: folder })}
            help={t("projectProps.storage.folderHelp")}
          >
            <span className={settings.value}>{t(`projectProps.storage.save.${save}`)}</span>
          </Row>
          <Row
            id="proxies"
            name={t("projectProps.storage.proxies")}
            help={t("projectProps.storage.proxiesHelp")}
          >
            <span className={settings.value} data-testid="project-proxies">
              {usage === undefined
                ? "—"
                : t("projectProps.storage.proxiesValue", {
                    count: usage.count,
                    size: formatSize(usage.bytes),
                  })}
            </span>
            <Small
              danger
              disabled={!usage || usage.count === 0}
              onClick={() => void removeProxies()}
            >
              {t("projectProps.storage.removeProxies")}
            </Small>
          </Row>
        </>
      ) : (
        <Row
          id="folder"
          name={t("projectProps.storage.noFolder")}
          help={t("projectProps.storage.noFolderBrowser")}
        />
      )}
      <DefaultStorageRows repo={repository?.status?.repository?.fullName} locked={locked} />
      {panel && linked && (
        <>
          <Heading>{t("projectProps.storage.sync")}</Heading>
          <div className={styles.panel} data-testid="project-storage-panel">
            <CloudPanelBody panel={panel} run={run} />
          </div>
        </>
      )}
      {panel && !linked && (
        // Not syncing: only the ways out, as buttons, without the panel around them.
        <>
          <Heading>{t("projectProps.storage.sync")}</Heading>
          <Row
            id="sync"
            name={t("projectProps.storage.kind.browser")}
            help={t("projectProps.storage.kindHelp.browser")}
          >
            {[...panel.rows.flatMap((row) => row.actions), ...panel.actions]
              .filter((action, index, all) => all.findIndex(({ id }) => id === action.id) === index)
              .map((action) => (
                <Small
                  key={action.id}
                  disabled={!action.enabled}
                  danger={action.kind === "danger"}
                  onClick={() => run(action.id)}
                >
                  {action.label}
                </Small>
              ))}
          </Row>
        </>
      )}
    </Group>
  );
}

/**
 * Which side a merge of changes on GitHub keeps first where both changed the same place (the
 * design of the start page, 10, screen G3 right): per project, kept by the platform, as merges run
 * there with no editor open. Only people change it: it is no command, and no AI tool has it.
 */
function PreferRow({ prefer }: { readonly prefer: "editor" | "github" | undefined }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<"editor" | "github">();
  const [busy, setBusy] = useState(false);
  const value = chosen ?? prefer ?? "editor";
  const change = async (next: "editor" | "github") => {
    setChosen(next);
    setBusy(true);
    const done = (await workbench.repoMerges?.setPrefer(next)) === true;
    setBusy(false);
    setChosen(undefined);
    if (!done) workbench.notifications.push(t("repoMerge.prefer.failed"));
  };
  return (
    <Row id="prefer" name={t("repoMerge.prefer.name")}>
      <Segmented
        label={t("repoMerge.prefer.name")}
        value={value}
        disabled={busy || prefer === undefined}
        options={[
          { value: "editor", label: t("repoMerge.prefer.editor") },
          { value: "github", label: t("repoMerge.prefer.github") },
        ]}
        onChange={(next) => void change(next)}
      />
    </Row>
  );
}

/**
 * Where new assets of the project go, "默认存储空间" (docs/design/online-offline.md of AnimaQuill
 * Cloud, 1.7): the repository's large file storage, or only this computer, as a step of the
 * project. Under it, where the assets it has are, and a way to put those there too: changing the
 * default moves nothing. What cannot be chosen here is grey, with why.
 */
function DefaultStorageRows({
  repo,
  locked,
}: {
  readonly repo: string | undefined;
  readonly locked: boolean;
}) {
  const workbench = useWorkbench();
  const { uploads, missingFiles } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const snapshot = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  const missing = useSyncExternalStore(missingFiles.subscribe, missingFiles.getSnapshot);
  const online = workbench.mode === "online";
  const rows = useMemo(
    () =>
      state && online && uploads.available
        ? placeRows(state, snapshot.items, new Set(missing.keys()), workbench.here())
        : [],
    [state, online, uploads, snapshot.items, missing, workbench],
  );
  const place = state ? workbench.defaultPlace() : undefined;
  if (!state || !place) return null;
  const why = (unusable: PlaceUnusable | undefined) =>
    unusable === undefined
      ? undefined
      : unusable === "offline"
        ? t("storage.uploads.properties.signIn")
        : unusable === "unsupported"
          ? t("storage.uploads.properties.unsupported")
          : t("storage.uploads.properties.noRepository");
  const lfsUnusable = why(lfsUsable(workbench.mode, snapshot.blocked, uploads.available));
  const chosen = place.chosen === "lfs" ? "lfs" : "local";
  // Online a file that is only here is only in this browser; offline it is in the folder.
  const local = t(
    online ? "storage.uploads.properties.localBrowser" : "storage.uploads.properties.local",
  );
  const help =
    place.effective !== place.chosen
      ? t("storage.uploads.properties.fellBack", { why: why(place.unusable), where: local })
      : chosen === "lfs"
        ? t("storage.uploads.properties.lfsHelp")
        : online
          ? t("storage.uploads.properties.localOnline")
          : t("storage.uploads.properties.localOffline");
  const summary = placeSummary(rows);
  const movable = rows.filter(canChoose).map(({ asset }) => asset);
  // Only what there is: nothing for none.
  const parts = [
    ...(summary.there > 0
      ? [
          t("storage.uploads.properties.existingLfs", {
            count: summary.there,
            size: formatSize(summary.thereBytes),
          }),
        ]
      : []),
    ...(summary.here > 0
      ? [t("storage.uploads.properties.existingHere", { count: summary.here })]
      : []),
  ];
  return (
    <Row
      id="defaultStorage"
      name={t("storage.uploads.properties.default")}
      help={help}
      below={
        online &&
        uploads.available &&
        parts.length > 0 && (
          <div className={styles.listRow}>
            <span data-testid="project-assets">
              {t("storage.uploads.properties.existing", { parts: parts.join("，") })}
            </span>
            {place.effective === "lfs" && movable.length > 0 && (
              <Small onClick={() => void workbench.choosePlaces(movable)}>
                {t("storage.uploads.properties.moveExisting")}
              </Small>
            )}
          </div>
        )
      }
    >
      <Choice
        label={t("storage.uploads.properties.default")}
        value={chosen}
        disabled={locked}
        options={[
          {
            value: "lfs",
            label:
              repo === undefined
                ? t("storage.uploads.properties.lfs")
                : t("storage.uploads.properties.lfsAt", {
                    repo,
                    interpolation: { escapeValue: false },
                  }),
            ...(lfsUnusable !== undefined && chosen !== "lfs" && { unavailable: lfsUnusable }),
          },
          { value: "local", label: local },
        ]}
        onChange={(kind) => {
          workbench.setDefaultStorage(kind);
        }}
      />
    </Row>
  );
}
