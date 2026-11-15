import type { ProjectStore } from "@animaquill/core";
import type { CloudProjectSummary } from "@animaquill/host";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { CloudPanelBody } from "../app/CloudPanel.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { cloudOf, storedOf } from "../app/StatusBar.tsx";
import { cloudPanel, panelInputOf, type PanelActionId } from "../cloud/panel.ts";
import settings from "../settings/Settings.module.css";
import { formatSize } from "../transfer/transfer.ts";
import { Facts, Group, Heading, Row, Small, length, moment } from "./parts.tsx";
import styles from "./Project.module.css";

const noSubscription = () => () => {};
const nothing = () => undefined;

/** Where the open project is, as the design of the properties tells the kinds apart (5.4). */
export type StoredAs =
  /** A folder of this computer, without the platform. */
  | "folder"
  /** A folder of this computer, which syncs with the platform. */
  | "cloudFolder"
  /** A project of the platform, only in this browser: no folder. */
  | "cloudBrowser"
  /** Only in this browser, without the platform, as projects were made before. */
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

export function StorageGroup({ store }: { readonly store: ProjectStore }) {
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
  const storedAs: StoredAs = linked
    ? linked.local === "folder"
      ? "cloudFolder"
      : "cloudBrowser"
    : folder !== undefined
      ? "folder"
      : "browser";
  const panel =
    cloud && outer && known
      ? cloudPanel(
          panelInputOf(outer, {
            name: state.manifest.name,
            ...(folder !== undefined && { folder }),
            canMoveToFolder: projectFolders !== undefined,
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
  const exit = (id: "saveAsLocal" | "disconnect") => {
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
                  {projectFolders && (
                    <Small disabled={!cloud?.isOnPlatform} onClick={() => exit("saveAsLocal")}>
                      {t("cloud.saveAsLocalAction")}
                    </Small>
                  )}
                  {linked.local === "folder" && (
                    <Small onClick={() => exit("disconnect")}>{t("cloud.disconnectAction")}</Small>
                  )}
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
      <Heading>{t("projectProps.storage.local")}</Heading>
      {folder !== undefined ? (
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
          help={t(
            linked ? "projectProps.storage.noFolderCloud" : "projectProps.storage.noFolderBrowser",
          )}
        />
      )}
      {panel && linked && (
        <>
          <Heading>{t("projectProps.storage.sync")}</Heading>
          <div className={styles.panel} data-testid="project-storage-panel">
            <CloudPanelBody panel={panel} run={run} />
          </div>
        </>
      )}
      {panel && !linked && (
        // Not syncing: only the ways to it, as buttons, without the panel around them.
        <>
          <Heading>{t("projectProps.storage.sync")}</Heading>
          <Row
            id="sync"
            name={t("projectProps.storage.noSync")}
            help={t("projectProps.storage.noSyncHelp")}
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
