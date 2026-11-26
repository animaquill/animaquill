import { ExternalLink } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { httpsLink } from "../app/links.ts";
import { formatSize } from "../transfer/transfer.ts";
import type { LocalLfsUse } from "@animaquill/host";
import { GITHUB_BILLING } from "./links.ts";
import styles from "./StorageSpace.module.css";

const noSubscription = () => () => {};
const noAccount = () => undefined;

/**
 * The large file storage of the server's own repositories, in numbers: what all of it comes to, how
 * much more it takes (by the limit the server is set up for or the room of its disk, which it says)
 * and the largest file.
 */
function LocalUse({ use, failed }: { use: LocalLfsUse | undefined; failed: boolean }) {
  const { t } = useTranslation();
  if (!use)
    return (
      <p className={styles.muted} role="status" data-storage-state={failed ? "failed" : "loading"}>
        {t(failed ? "storage.uploads.space.failed" : "storage.uploads.space.loading")}
      </p>
    );
  return (
    <div data-storage-state="local">
      <p className={styles.total}>
        <strong>{formatSize(use.usedBytes)}</strong>{" "}
        <span className={styles.muted}>
          {t("storage.uploads.space.localUsed", { used: formatSize(use.usedBytes) })}
        </span>
      </p>
      {use.leftBytes !== undefined && (
        <p className={styles.muted} data-storage-left={use.leftBy}>
          {use.leftBy === "max"
            ? t("storage.uploads.space.localLeftMax", {
                left: formatSize(use.leftBytes),
                max: formatSize(use.maxBytes ?? 0),
              })
            : t("storage.uploads.space.localLeftDisk", { left: formatSize(use.leftBytes) })}
        </p>
      )}
      <p className={styles.muted}>
        {t("storage.uploads.space.localFile", { most: formatSize(use.fileBytes) })}
      </p>
    </div>
  );
}

/**
 * "存储空间" of the start page (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3, screen U4,
 * and section 9): where the large files of people's projects are, and how much. For now the
 * large file storage of GitHub, by repository, as the platform knows it; the room and the traffic
 * only GitHub says, which a link goes to. The cloud space comes later.
 */
export function StorageSpace() {
  const workbench = useWorkbench();
  const { lfsAccount, account } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(lfsAccount.subscribe, lfsAccount.getSnapshot);
  const who = useSyncExternalStore(
    account?.subscribe ?? noSubscription,
    account?.getSnapshot ?? noAccount,
  );
  const signedIn = who?.status === "signedIn";
  // A server whose projects are all in its own repositories: their large files are on its disk,
  // which this page does not list by project yet; nothing of GitHub's quota is about them.
  const local = signedIn && who.repositories === "local";
  useEffect(() => {
    if (signedIn) void lfsAccount.refresh();
  }, [lfsAccount, signedIn]);
  const repositories = snapshot.account?.repositories ?? [];
  const total = repositories.reduce((all, each) => all + each.bytes, 0);

  return (
    <div className={styles.page} data-storage-space="">
      <p className={styles.about}>{t("storage.uploads.space.about")}</p>
      <section className={styles.part} aria-labelledby="storage-lfs" data-storage="lfs">
        <div className={styles.head}>
          <h2 id="storage-lfs">{t("storage.uploads.space.lfsTitle")}</h2>
          {!local && (
            <a
              href={GITHUB_BILLING}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.link}
            >
              {t("storage.uploads.space.seeQuota")} <ExternalLink size={12} aria-hidden />
            </a>
          )}
        </div>
        <p className={styles.muted}>{t("storage.uploads.space.lfsAbout")}</p>
        {local ? (
          <LocalUse use={snapshot.account?.local} failed={snapshot.status === "failed"} />
        ) : !signedIn ? (
          <p className={styles.muted} data-storage-state="signedOut">
            {t("storage.uploads.space.signIn")}{" "}
            <button type="button" className={styles.button} onClick={() => void workbench.signIn()}>
              {t("start.signIn")}
            </button>
          </p>
        ) : snapshot.status === "failed" && !snapshot.account ? (
          <p className={styles.muted} role="status" data-storage-state="failed">
            {t("storage.uploads.space.failed")}
          </p>
        ) : !snapshot.account ? (
          <p className={styles.muted} role="status" data-storage-state="loading">
            {t("storage.uploads.space.loading")}
          </p>
        ) : repositories.length === 0 ? (
          <p className={styles.muted} data-storage-state="none">
            {t("storage.uploads.space.none")}
          </p>
        ) : (
          <>
            <p className={styles.total}>
              <strong>{formatSize(total)}</strong>{" "}
              <span className={styles.muted}>
                {t("storage.uploads.space.total", { count: repositories.length })}
              </span>
            </p>
            <div className={styles.tableBox}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t("storage.uploads.space.repo")}</th>
                    <th>{t("storage.uploads.space.project")}</th>
                    <th>{t("storage.uploads.space.files")}</th>
                    <th>{t("storage.uploads.space.size")}</th>
                  </tr>
                </thead>
                <tbody>
                  {repositories.map((each) => {
                    const url = httpsLink(each.url);
                    return (
                      <tr key={each.repo} data-storage-repo={each.fullName}>
                        <td>
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.code}
                            >
                              {each.fullName}
                            </a>
                          ) : (
                            <span className={styles.code}>{each.fullName}</span>
                          )}
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.linkButton}
                            onClick={() =>
                              void workbench.cloud?.openCloudProject(each.project.id, {
                                name: each.project.name,
                              })
                            }
                          >
                            {each.project.name}
                          </button>
                        </td>
                        <td>{each.files}</td>
                        <td>{formatSize(each.bytes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className={styles.muted}>{t("storage.uploads.space.noDelete")}</p>
      </section>
      <section className={`${styles.part} ${styles.later}`} aria-labelledby="storage-platform">
        <div className={styles.head}>
          <h2 id="storage-platform">
            {t("storage.uploads.space.platformTitle")}{" "}
            <span className={styles.tag}>{t("storage.uploads.comingSoon")}</span>
          </h2>
        </div>
        <p className={styles.muted}>{t("storage.uploads.space.platformAbout")}</p>
      </section>
    </div>
  );
}
