import { placedAsset } from "@animaquill/core";
import { CircleAlert, Cloud, Download, ExternalLink, Upload } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { httpsLink } from "../app/links.ts";
import type { CloudProjectsSnapshot } from "../cloud/projects.ts";
import { downloadFix, downloadPhaseText, downloadProblemText } from "./download-text.ts";
import { downloadFrom } from "./places.ts";
import { percentOf, phaseText, progressText } from "./upload-text.ts";
import type { UploadItem } from "./uploads.ts";
import styles from "./AssetPlace.module.css";
import { OnlineOnly } from "../app/OnlineOnly.tsx";

const noSubscription = () => () => {};
const NONE: CloudProjectsSnapshot = { kind: "none" };
const none = () => NONE;
const nothing = () => undefined;

/** A row of buttons. */
function Buttons({ children }: { children: ReactNode }) {
  return <div className={styles.buttons}>{children}</div>;
}

/**
 * "存放位置" of an asset (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3, screen U1 right):
 * where its file is, how it goes on its way into the large file storage, and what people can do
 * about it right there. Each of the states of the table of 4.3 has its words.
 */
export function AssetPlace({ asset }: { asset: string }) {
  const workbench = useWorkbench();
  const { uploads, downloads, cloud, missingFiles } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const snapshot = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot);
  const coming = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
  const missing = useSyncExternalStore(missingFiles.subscribe, missingFiles.getSnapshot);
  const linked = useSyncExternalStore(
    cloud?.subscribe ?? noSubscription,
    cloud?.getSnapshot ?? none,
  );
  const repository = linked.kind === "linked" ? linked.repository : undefined;
  const status = useSyncExternalStore(
    repository?.subscribe ?? noSubscription,
    repository?.getSnapshot ?? nothing,
  )?.status;
  // Without a platform there is nowhere else for files to go: offline that needs signing in.
  if (!state || (!cloud && workbench.mode !== "offline")) return null;
  const placed = placedAsset(state, asset, workbench.here());
  if (!placed || placed.hash === undefined) return null;
  const item = snapshot.items.find((each) => each.asset === asset);
  const going = item && item.hash === placed.hash && item.phase !== "done" ? item : undefined;
  const file = missing.get(asset);
  const isCloud = linked.kind === "linked";
  const download =
    file?.elsewhere === "lfs" ? coming.items.find((each) => each.asset === asset) : undefined;
  const elsewhereWindow = snapshot.sender === "elsewhere";

  const frame = (tone: "plain" | "going" | "failed" | "there", body: ReactNode) => (
    <section
      className={`${styles.place} ${styles[tone]}`}
      aria-label={t("storage.uploads.row.title")}
      data-asset-place={
        going?.phase ??
        (download
          ? `download-${download.phase}`
          : placed.storage === "lfs" && !file
            ? "lfs"
            : file
              ? "away"
              : "here")
      }
    >
      <h4 className={styles.title}>{t("storage.uploads.row.title")}</h4>
      {body}
    </section>
  );
  const control = (shown: UploadItem) => (
    <Buttons>
      {shown.phase === "paused" ? (
        <button type="button" onClick={() => void uploads.resume(asset)}>
          {t("storage.uploads.action.resume")}
        </button>
      ) : shown.phase === "failed" ? null : ["queued", "checking", "pushing", "blocked"].includes(
          shown.phase,
        ) ? null : (
        <button type="button" onClick={() => void uploads.pause(asset)}>
          {t("storage.uploads.action.pause")}
        </button>
      )}
      {shown.phase !== "checking" && shown.phase !== "pushing" && (
        <button type="button" onClick={() => void uploads.cancel(asset)}>
          {t("storage.uploads.action.cancel")}
        </button>
      )}
    </Buttons>
  );
  const other = elsewhereWindow && (
    <p className={styles.note}>{t("storage.uploads.row.otherWindow")}</p>
  );

  if (going) {
    if (going.phase === "failed") {
      const problem = going.problem ?? "refused";
      const fix =
        problem === "githubQuota"
          ? "quota"
          : problem === "notAcknowledged"
            ? "acknowledge"
            : problem === "changed" || problem === "missing"
              ? "problems"
              : problem === "access"
                ? "allow"
                : problem === "signedOut"
                  ? "signIn"
                  : undefined;
      return frame(
        "failed",
        <>
          <p className={styles.problem} role="alert">
            <CircleAlert size={13} aria-hidden />
            {t(`storage.uploads.problem.${problem}`)}
          </p>
          <Buttons>
            <button type="button" onClick={() => void uploads.retry(asset)}>
              {t("storage.uploads.action.retry")}
            </button>
            {fix && (
              <button
                type="button"
                className={styles.link}
                onClick={() => void workbench.fixUpload(problem)}
              >
                {t(`storage.uploads.fix.${fix}`)}
                {fix === "quota" && " ↗"}
              </button>
            )}
            <button type="button" onClick={() => void uploads.cancel(asset)}>
              {t("storage.uploads.action.cancel")}
            </button>
          </Buttons>
        </>,
      );
    }
    const headline = going.replaced
      ? t("storage.uploads.row.replaced")
      : t("storage.uploads.row.uploading");
    const line =
      going.phase === "queued"
        ? going.ahead
          ? t("storage.uploads.row.queued", { count: going.ahead })
          : t("storage.uploads.row.queuedNext")
        : going.phase === "checking"
          ? t("storage.uploads.row.checking")
          : going.phase === "pushing"
            ? t("storage.uploads.row.pushing")
            : going.phase === "paused"
              ? t("storage.uploads.row.paused", { percent: percentOf(going) })
              : going.phase === "blocked"
                ? t(`storage.uploads.blocked.${snapshot.blocked ?? "notCloud"}`)
                : going.phase === "offline" || going.phase === "busy"
                  ? `${phaseText(t, going)} · ${percentOf(going)}%`
                  : progressText(t, going);
    const bar = going.phase === "checking" || going.phase === "pushing" ? 100 : percentOf(going);
    return frame(
      "going",
      <>
        <p className={styles.headline}>
          <Upload size={13} aria-hidden />
          {headline}
        </p>
        <div
          className={styles.bar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={bar}
          aria-label={headline}
        >
          <span style={{ width: `${bar}%` }} />
        </div>
        <p className={styles.note} role="status">
          {line}
        </p>
        {other}
        {going.phase === "blocked" && snapshot.blocked === "repository" && (
          <Buttons>
            <button
              type="button"
              className={styles.link}
              onClick={() => workbench.cloudPanel.set(true)}
            >
              {t("storage.uploads.fix.repository")}
            </button>
          </Buttons>
        )}
        {control(going)}
      </>,
    );
  }

  // Not on this computer, and on its way here out of the large file storage, or to be asked for.
  if (file?.elsewhere === "lfs" && downloads.available && isCloud) {
    if (download && download.phase === "failed") {
      const fix = downloadFix(download);
      return frame(
        "failed",
        <>
          <p className={styles.problem} role="alert">
            <CircleAlert size={13} aria-hidden />
            {t("storage.downloads.row.failed", { reason: downloadProblemText(t, download) })}
          </p>
          {download.problem === "missing" && (
            <p className={styles.note}>{t("storage.downloads.problem.missingHelp")}</p>
          )}
          <Buttons>
            <button type="button" onClick={() => downloads.retry(asset)}>
              {t("storage.downloads.action.retry")}
            </button>
            {fix && (
              <button
                type="button"
                className={styles.link}
                onClick={() => void workbench.fixDownload(download.problem ?? "refused")}
              >
                {t(`storage.downloads.fix.${fix}`)}
                {fix === "quota" && " ↗"}
              </button>
            )}
          </Buttons>
        </>,
      );
    }
    if (download && download.phase !== "done") {
      const line =
        download.phase === "queued"
          ? download.ahead
            ? t("storage.downloads.row.queued", { count: download.ahead })
            : t("storage.downloads.row.queuedNext")
          : download.phase === "checking"
            ? t("storage.downloads.row.checking")
            : download.phase === "writing"
              ? t("storage.downloads.row.writing")
              : download.phase === "paused"
                ? t("storage.downloads.row.paused", { percent: percentOf(download) })
                : download.phase === "blocked"
                  ? t(`storage.downloads.blocked.${coming.blocked ?? "notCloud"}`)
                  : download.phase === "downloading"
                    ? progressText(t, download)
                    : downloadPhaseText(t, download);
      const bar =
        download.phase === "checking" || download.phase === "writing" || download.phase === "access"
          ? 100
          : percentOf(download);
      return frame(
        "going",
        <>
          <p className={styles.headline}>
            <Download size={13} aria-hidden />
            {t("storage.downloads.row.downloading")}
          </p>
          <div
            className={styles.bar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={bar}
            aria-label={t("storage.downloads.row.downloading")}
          >
            <span style={{ width: `${bar}%` }} />
          </div>
          <p className={styles.note} role="status">
            {line}
          </p>
          {coming.sender === "elsewhere" && (
            <p className={styles.note}>{t("storage.downloads.row.otherWindow")}</p>
          )}
          {download.phase === "access" && (
            <Buttons>
              <button
                type="button"
                className={styles.primary}
                onClick={() => void workbench.fixDownload("access")}
              >
                {t("storage.downloads.fix.allow")}
              </button>
            </Buttons>
          )}
        </>,
      );
    }
    if (!download)
      return frame(
        "plain",
        <>
          <p className={styles.headline}>{downloadFrom(t, "lfs", placed.url)}</p>
          <p className={styles.note}>{t("storage.downloads.row.notUsed")}</p>
          <Buttons>
            <button
              type="button"
              className={styles.primary}
              onClick={() => downloads.download(asset)}
            >
              {t("storage.downloads.row.download")}
            </button>
          </Buttons>
        </>,
      );
  }

  if (placed.storage === "lfs") {
    const repo = status?.repository;
    const url = httpsLink(repo?.url);
    return frame(
      "there",
      <>
        <p className={styles.headline}>
          <Cloud size={13} aria-hidden />
          {repo
            ? t("storage.uploads.row.done", { repo: repo.fullName })
            : t("storage.uploads.row.doneNoRepo")}
        </p>
        <p className={styles.note}>{t("storage.uploads.row.doneNote")}</p>
        {url && (
          <a className={styles.link} href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={11} aria-hidden />
            {t("storage.uploads.row.seeOnGitHub")}
          </a>
        )}
      </>,
    );
  }

  if (file) {
    // Not on this computer: where it can come from, or where it is.
    if (file.elsewhere)
      return frame(
        "plain",
        <p className={styles.headline}>{downloadFrom(t, file.elsewhere, placed.url)}</p>,
      );
    if (!isCloud) return null;
    return frame(
      "plain",
      <>
        <p className={styles.headline}>{t("storage.uploads.row.elsewhere")}</p>
        <p className={styles.note}>{t("storage.uploads.row.elsewhereNote")}</p>
      </>,
    );
  }

  if (placed.storage !== "local") return null;
  const blocked = snapshot.blocked;
  const canPut = isCloud && uploads.available && blocked === undefined;
  const why = !isCloud
    ? t("storage.uploads.row.needsCloud")
    : blocked && t(`storage.uploads.blocked.${blocked}`);
  return frame(
    "plain",
    <>
      <p className={styles.headline}>{t("storage.uploads.row.here")}</p>
      <p className={styles.note}>{t("storage.uploads.row.hereNote")}</p>
      <Buttons>
        {workbench.mode === "offline" ? (
          <OnlineOnly className={styles.primary} what={t("storage.uploads.row.put")}>
            {t("storage.uploads.row.put")}
          </OnlineOnly>
        ) : (
          <button
            type="button"
            className={styles.primary}
            disabled={!canPut}
            title={canPut ? undefined : (why ?? undefined)}
            onClick={() => void workbench.putInLfs([asset])}
          >
            {t("storage.uploads.row.put")}
          </button>
        )}
        {isCloud ? (
          <button
            type="button"
            disabled={!canPut}
            onClick={() => void workbench.choosePlaces([asset])}
          >
            {t("storage.uploads.row.change")}
          </button>
        ) : undefined}
      </Buttons>
      {!canPut && why && workbench.mode === "online" && <p className={styles.note}>{why}</p>}
    </>,
  );
}
