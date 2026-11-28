import type { PlatformProjectUse } from "@animaquill/host";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { Tip } from "../app/Tip.tsx";
import { placedT } from "../i18n/i18n.ts";
import { NEARLY_FULL, formatPlatformBytes, partOf, releaseBlockText } from "./platform-space.ts";
import own from "./PlatformSpace.module.css";
import styles from "./StorageSpace.module.css";

const noSubscription = () => () => {};
const noAccount = () => undefined;

/**
 * "平台上的项目" of the storage page (docs/design/online-offline.md of AnimaQuill Cloud, 1.2 and
 * 3.6): what the person keeps on the platform against what they may ("3.2 GB / 5 GB", and the
 * number of projects), and each of their own projects, the largest first, to let go of ("释放")
 * or delete. One that cannot be let go of now has its button greyed, why on hovering it, and what
 * helps beside it; one let go of says it comes back from the repository as it is opened. Without a
 * limit, as on a server of one's own, only what is kept. `onChanged`: the list of projects of the
 * start page, to read again after a project changed here.
 */
export function PlatformProjects({ onChanged }: { readonly onChanged?: () => void }) {
  const workbench = useWorkbench();
  const { platformSpace, account } = workbench;
  const { t: baseT } = useTranslation();
  const who = useSyncExternalStore(
    account?.subscribe ?? noSubscription,
    account?.getSnapshot ?? noAccount,
  );
  const t = placedT(
    baseT,
    who?.status === "signedIn" && who.repositories === "local" ? "local" : undefined,
  );
  const { status, space } = useSyncExternalStore(
    platformSpace.subscribe,
    platformSpace.getSnapshot,
  );
  const [busy, setBusy] = useState<string>();
  const signedIn = who?.status === "signedIn";
  useEffect(() => {
    if (signedIn) void platformSpace.refresh();
  }, [platformSpace, signedIn]);
  if (status === "none" || !signedIn) return null;

  const run = (id: string, work: () => Promise<unknown>) => {
    if (busy !== undefined) return;
    setBusy(id);
    void work().finally(() => {
      setBusy(undefined);
      void platformSpace.refresh();
      onChanged?.();
    });
  };
  const open = (row: PlatformProjectUse) =>
    run(row.id, async () => workbench.cloud?.openCloudProject(row.id, { name: row.name }));
  const storagePart = space && partOf(space.used, space.limit);

  return (
    <section className={styles.part} aria-labelledby="storage-platform" data-storage="platform">
      <div className={styles.head}>
        <h2 id="storage-platform">{t("storage.platform.title")}</h2>
      </div>
      <p className={styles.muted}>{t("storage.platform.about")}</p>
      {!space ? (
        <p
          className={styles.muted}
          role="status"
          data-storage-state={status === "failed" ? "failed" : "loading"}
        >
          {t(status === "failed" ? "storage.platform.failedRead" : "storage.uploads.space.loading")}
        </p>
      ) : (
        <>
          <p className={own.amount} data-platform-used={space.used}>
            {space.limit === null ? (
              <strong>
                {t("storage.platform.usedOnly", { used: formatPlatformBytes(space.used) })}
              </strong>
            ) : (
              <strong>
                {t("storage.platform.used", {
                  used: formatPlatformBytes(space.used, { exact: true }),
                  limit: formatPlatformBytes(space.limit),
                })}
              </strong>
            )}
            <span>
              {space.count.limit === null
                ? t("storage.platform.countOnly", { used: space.count.used })
                : t("storage.platform.count", {
                    used: space.count.used,
                    limit: space.count.limit,
                  })}
            </span>
          </p>
          {storagePart !== undefined && (
            <div
              className={own.meter}
              role="meter"
              aria-label={t("storage.platform.meter")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.round(storagePart * 100))}
              data-near={storagePart >= NEARLY_FULL && storagePart < 1 ? "" : undefined}
              data-over={storagePart >= 1 ? "" : undefined}
            >
              <span style={{ width: `${Math.min(100, storagePart * 100)}%` }} />
            </div>
          )}
          {space.projects.length === 0 ? (
            <p className={styles.muted} data-storage-state="none">
              {t("storage.platform.none")}
            </p>
          ) : (
            <div className={styles.tableBox}>
              <table className={own.table}>
                <thead>
                  <tr>
                    <th className={own.name}>{t("storage.platform.name")}</th>
                    <th className={own.number}>{t("storage.platform.size")}</th>
                    <th className={own.cell} aria-label={t("storage.platform.actions")} />
                  </tr>
                </thead>
                <tbody>
                  {space.projects.map((row) => (
                    <Row
                      key={row.id}
                      row={row}
                      t={t}
                      busy={busy}
                      onOpen={() => open(row)}
                      onRelease={() => {
                        if (busy !== undefined) return;
                        // Busy once people said yes, not while they are asked.
                        void workbench
                          .releasePlatform(row.id, row.name, { onGo: () => setBusy(row.id) })
                          .finally(() => {
                            setBusy(undefined);
                            void platformSpace.refresh();
                            onChanged?.();
                          });
                      }}
                      onDelete={() =>
                        run(row.id, () => workbench.deleteFromCloud(row.id, row.name))
                      }
                      onSave={() => run(row.id, () => workbench.saveToFolder(row.id, row.name))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Row({
  row,
  t,
  busy,
  onOpen,
  onRelease,
  onDelete,
  onSave,
}: {
  readonly row: PlatformProjectUse;
  readonly t: ReturnType<typeof placedT>;
  readonly busy: string | undefined;
  readonly onOpen: () => void;
  readonly onRelease: () => void;
  readonly onDelete: () => void;
  readonly onSave: () => void;
}) {
  const live = row.state === "live";
  const why = row.why && releaseBlockText(row.why, t);
  const isBusy = busy !== undefined;
  const releaseButton = (
    <button
      type="button"
      aria-disabled={row.releasable !== true || isBusy ? "true" : undefined}
      {...(why && { "aria-description": why.text })}
      onClick={() => {
        if (row.releasable === true && !isBusy) onRelease();
      }}
    >
      {busy === row.id ? t("storage.platform.releasing") : t("storage.platform.release")}
    </button>
  );
  return (
    <tr data-platform-project={row.id} data-platform-state={row.state}>
      <td className={own.name}>
        <button type="button" className={own.nameButton} title={row.name} onClick={onOpen}>
          {row.name}
        </button>
        {row.state === "released" && (
          <span className={own.state}>{t("storage.platform.released")}</span>
        )}
        {row.state === "restoring" && (
          <span className={own.state}>{t("storage.platform.restoring")}</span>
        )}
      </td>
      <td className={own.number}>{formatPlatformBytes(row.bytes)}</td>
      <td className={own.cell}>
        {live &&
          (why ? (
            <Tip name={t("storage.platform.release")} usage={why.text}>
              {releaseButton}
            </Tip>
          ) : (
            releaseButton
          ))}
        {live && why?.fix === "open" && (
          <button type="button" className={own.fix} disabled={isBusy} onClick={onOpen}>
            {t("storage.platform.fix")}
          </button>
        )}
        {live && why?.fix === "saveToFolder" && (
          <button type="button" className={own.fix} disabled={isBusy} onClick={onSave}>
            {t("storage.platform.saveToFolder")}
          </button>
        )}
        <button type="button" className={own.danger} disabled={isBusy} onClick={onDelete}>
          {t("storage.platform.delete")}
        </button>
      </td>
    </tr>
  );
}
