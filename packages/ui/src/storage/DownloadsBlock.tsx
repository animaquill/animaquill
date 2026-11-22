import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { formatSize } from "../transfer/transfer.ts";
import { downloadFix, downloadPhaseText } from "./download-text.ts";
import { downloadTotals, type DownloadItem } from "./downloads.ts";
import { etaText, percentOf } from "./upload-text.ts";
import styles from "./UploadsSection.module.css";

const startOfToday = () => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * The files of the open project that come out of the large file storage, in "素材" of the panel of
 * the platform (docs/design/asset-storage.md of AnimaQuill Cloud, 4.7.6): above the uploads, as the
 * uploads look, nearest the playhead first, with what people can do where one did not come.
 */
export function DownloadsBlock() {
  const workbench = useWorkbench();
  const { downloads } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
  if (!downloads.available) return null;
  const totals = downloadTotals(snapshot);
  const listed = snapshot.items.filter(({ phase }) => phase !== "done");
  const today = startOfToday();
  const doneToday = snapshot.items.filter(
    ({ phase, doneAt }) => phase === "done" && (doneAt ?? 0) >= today,
  ).length;
  if (listed.length === 0 && doneToday === 0 && snapshot.unused.count === 0) return null;
  const eta = etaText(
    t,
    totals.bytes - totals.received,
    totals.speed > 0 ? totals.speed : undefined,
  );

  const row = (item: DownloadItem) => {
    const fix = downloadFix(item);
    return (
      <li
        key={item.asset}
        className={styles.row}
        data-download-row={item.asset}
        data-phase={item.phase}
      >
        <span className={styles.name}>
          {item.name} <span className={styles.size}>{formatSize(item.size)}</span>
        </span>
        <span className={item.phase === "failed" ? styles.failed : styles.state}>
          {item.phase === "downloading" && (
            <span className={styles.mini} aria-hidden>
              <span style={{ width: `${percentOf(item)}%` }} />
            </span>
          )}
          {item.phase === "blocked" && snapshot.blocked
            ? t(`storage.downloads.blocked.${snapshot.blocked}`)
            : downloadPhaseText(t, item)}
        </span>
        {(fix !== undefined || item.phase === "failed") && (
          <span className={styles.buttons}>
            {fix !== undefined && (
              <button
                type="button"
                className={styles.link}
                onClick={() =>
                  void workbench.fixDownload(
                    item.phase === "access" ? "access" : (item.problem ?? "refused"),
                  )
                }
              >
                {t(`storage.downloads.fix.${fix}`)}
              </button>
            )}
            {item.phase === "failed" && (
              <button type="button" onClick={() => downloads.retry(item.asset)}>
                {t("storage.downloads.action.retry")}
              </button>
            )}
          </span>
        )}
      </li>
    );
  };

  return (
    <div data-downloads="">
      <div className={styles.head}>
        <p className={styles.headline} role="status">
          {snapshot.paused && listed.length > 0
            ? t("storage.downloads.panel.paused", { count: listed.length })
            : listed.length > 0
              ? eta === undefined
                ? t("storage.downloads.panel.downloading", {
                    count: listed.length,
                    total: formatSize(totals.bytes),
                    percent: totals.percent,
                  })
                : t("storage.downloads.panel.downloadingEta", {
                    count: listed.length,
                    total: formatSize(totals.bytes),
                    percent: totals.percent,
                    eta,
                  })
              : t("storage.downloads.panel.doneToday", { count: doneToday })}
        </p>
        {listed.length > 0 && (
          <button type="button" onClick={() => void downloads.setPaused(!snapshot.paused)}>
            {t(
              snapshot.paused
                ? "storage.downloads.action.resume"
                : "storage.downloads.action.pause",
            )}
          </button>
        )}
      </div>
      {listed.length > 0 && !snapshot.paused && (
        <div className={styles.bar} aria-hidden>
          <span style={{ width: `${totals.percent}%` }} />
        </div>
      )}
      {snapshot.blocked && snapshot.blocked !== "notCloud" && listed.length > 0 && (
        <p className={styles.blocked}>{t(`storage.downloads.blocked.${snapshot.blocked}`)}</p>
      )}
      {snapshot.sender === "elsewhere" && listed.length > 0 && (
        <p className={styles.note}>{t("storage.downloads.panel.elsewhere")}</p>
      )}
      {listed.length > 0 && <ul className={styles.rows}>{listed.map(row)}</ul>}
      {listed.length > 0 && doneToday > 0 && (
        <p className={styles.done}>
          <span>{t("storage.downloads.panel.doneToday", { count: doneToday })}</span>
        </p>
      )}
      {snapshot.unused.count > 0 && (
        <p className={styles.done}>
          <button type="button" className={styles.link} onClick={() => downloads.downloadUnused()}>
            {t("storage.downloads.action.unused", {
              count: snapshot.unused.count,
              size: formatSize(snapshot.unused.bytes),
            })}
          </button>
        </p>
      )}
    </div>
  );
}
