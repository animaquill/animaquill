import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { formatSize } from "../transfer/transfer.ts";
import { placeRows, placeSummary } from "./place-choice.ts";
import { etaText, isGoing, needsPeople, percentOf, phaseText } from "./upload-text.ts";
import type { UploadItem, UploadsSnapshot } from "./uploads.ts";
import styles from "./UploadsSection.module.css";

/** How the files on their way go, all of them together. */
export function uploadTotals(snapshot: UploadsSnapshot) {
  const going = snapshot.items.filter(isGoing);
  const size = going.reduce((all, item) => all + item.size, 0);
  const received = going.reduce((all, item) => all + Math.min(item.received, item.size), 0);
  const speed = going.reduce((all, item) => all + (item.speed ?? 0), 0);
  return {
    going,
    size,
    received,
    percent: size === 0 ? 0 : Math.floor((received / size) * 100),
    speed: speed > 0 ? speed : undefined,
    needsPeople: snapshot.items.some(needsPeople),
  };
}

const startOfToday = () => {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * "素材" of the panel of the platform (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3, screen
 * U3): how the files of the open project go into the large file storage, one row each with what
 * people can do about it, those that got there folded into one line, and what the project has where.
 */
export function UploadsSection({ focused }: { focused: boolean }) {
  const workbench = useWorkbench();
  const { uploads, missingFiles } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const snapshot = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  const missing = useSyncExternalStore(missingFiles.subscribe, missingFiles.getSnapshot);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) section.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const summary = useMemo(
    () =>
      placeSummary(
        state ? placeRows(state, snapshot.items, new Set(missing.keys()), workbench.here()) : [],
      ),
    [state, snapshot.items, missing, workbench],
  );
  if (!uploads.available) return null;
  const totals = uploadTotals(snapshot);
  const listed = snapshot.items.filter((item) => item.phase !== "done");
  const done = snapshot.items.filter((item) => item.phase === "done");
  const today = startOfToday();
  const doneToday = done.filter((item) => (item.doneAt ?? 0) >= today).length;
  const waiting = snapshot.items.some((item) => isGoing(item) && item.phase !== "blocked");
  const paused = snapshot.items.some((item) => item.phase === "paused");
  const eta = etaText(t, totals.size - totals.received, totals.speed);

  const row = (item: UploadItem) => {
    const sending = item.phase === "sending";
    return (
      <li
        key={item.asset}
        className={styles.row}
        data-upload-row={item.asset}
        data-phase={item.phase}
      >
        <span className={styles.name}>
          {item.name} <span className={styles.size}>{formatSize(item.size)}</span>
          {item.replaced && (
            <span className={styles.size}> · {t("storage.uploads.row.replaced")}</span>
          )}
        </span>
        <span className={item.phase === "failed" ? styles.failed : styles.state}>
          {sending && (
            <span className={styles.mini} aria-hidden>
              <span style={{ width: `${percentOf(item)}%` }} />
            </span>
          )}
          {item.phase === "blocked" && snapshot.blocked
            ? t(`storage.uploads.blocked.${snapshot.blocked}`)
            : phaseText(t, item)}
        </span>
        <span className={styles.buttons}>
          {item.phase === "failed" && (
            <>
              {(item.problem === "githubQuota" ||
                item.problem === "changed" ||
                item.problem === "missing" ||
                item.problem === "access" ||
                item.problem === "signedOut") && (
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void workbench.fixUpload(item.problem ?? "refused")}
                >
                  {t(
                    `storage.uploads.fix.${
                      item.problem === "githubQuota"
                        ? "quota"
                        : item.problem === "access"
                          ? "allow"
                          : item.problem === "signedOut"
                            ? "signIn"
                            : "problems"
                    }`,
                  )}
                </button>
              )}
              <button type="button" onClick={() => void uploads.retry(item.asset)}>
                {t("storage.uploads.action.retry")}
              </button>
            </>
          )}
          {item.phase === "paused" && (
            <button type="button" onClick={() => void uploads.resume(item.asset)}>
              {t("storage.uploads.action.resume")}
            </button>
          )}
          {["sending", "reading", "offline", "busy"].includes(item.phase) && (
            <button type="button" onClick={() => void uploads.pause(item.asset)}>
              {t("storage.uploads.action.pause")}
            </button>
          )}
          {item.phase !== "checking" && item.phase !== "pushing" && (
            <button type="button" onClick={() => void uploads.cancel(item.asset)}>
              {t("storage.uploads.action.cancel")}
            </button>
          )}
        </span>
      </li>
    );
  };

  return (
    <section
      ref={section}
      className={styles.section}
      data-uploads-section=""
      data-focused={focused || undefined}
      aria-label={t("storage.uploads.panel.title")}
      tabIndex={-1}
    >
      <div className={styles.head}>
        <h3>{t("storage.uploads.panel.title")}</h3>
        {waiting ? (
          <button type="button" onClick={() => void uploads.pauseAll()}>
            {t("storage.uploads.action.pauseAll")}
          </button>
        ) : (
          paused && (
            <button type="button" onClick={() => void uploads.resumeAll()}>
              {t("storage.uploads.action.resumeAll")}
            </button>
          )
        )}
      </div>
      <p className={styles.headline} role="status">
        {totals.going.length > 0
          ? eta === undefined
            ? t("storage.uploads.panel.uploading", {
                count: totals.going.length,
                total: formatSize(totals.size),
                percent: totals.percent,
              })
            : t("storage.uploads.panel.uploadingEta", {
                count: totals.going.length,
                total: formatSize(totals.size),
                percent: totals.percent,
                eta,
              })
          : t("storage.uploads.panel.nothing")}
      </p>
      {totals.going.length > 0 && (
        <div className={styles.bar} aria-hidden>
          <span style={{ width: `${totals.percent}%` }} />
        </div>
      )}
      {snapshot.blocked && snapshot.blocked !== "notCloud" && listed.length > 0 && (
        <p className={styles.blocked}>{t(`storage.uploads.blocked.${snapshot.blocked}`)}</p>
      )}
      {snapshot.items.some((item) => item.full) && (
        <p className={styles.blocked}>
          {t("storage.uploads.phase.busyFull")}{" "}
          <button
            type="button"
            className={styles.link}
            onClick={() => void workbench.giveUpUploads()}
          >
            {t("storage.uploads.action.giveUpAll")}
          </button>
        </p>
      )}
      {snapshot.sender === "elsewhere" && listed.length > 0 && (
        <p className={styles.note}>{t("storage.uploads.panel.elsewhere")}</p>
      )}
      {listed.length > 0 && <ul className={styles.rows}>{listed.map(row)}</ul>}
      {done.length > 0 && (
        <p className={styles.done}>
          <span>
            {doneToday === done.length
              ? t("storage.uploads.panel.doneToday", { count: done.length })
              : t("storage.uploads.panel.doneEarlier", { count: done.length })}
          </span>
          <button type="button" className={styles.link} onClick={() => void uploads.clearDone()}>
            {t("storage.uploads.action.clear")}
          </button>
        </p>
      )}
      <p className={styles.summary}>
        <span>
          {t("storage.uploads.panel.summary", {
            count: summary.there,
            size: formatSize(summary.thereBytes),
            here: summary.here,
          })}
        </span>{" "}
        <button
          type="button"
          className={styles.link}
          disabled={snapshot.blocked !== undefined}
          onClick={() => {
            workbench.cloudPanel.set(false);
            void workbench.choosePlaces();
          }}
        >
          {t("storage.uploads.action.choose")}
        </button>
      </p>
    </section>
  );
}
