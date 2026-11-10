import { ExternalLink } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  archiveStateText,
  keptText,
  knownPause,
  lastArchiveText,
  pauseDetail,
  pauseText,
  repositoryText,
} from "../cloud/repository-text.ts";
import type { RepositoryWatch } from "../cloud/repository-watch.ts";
import { useWorkbench } from "./context.ts";
import styles from "./RepositoryStatus.module.css";

/** How often the times shown move on while the bubble is open. */
const TICK_MS = 15_000;
/** An answer older than this is asked again as the bubble opens: people look for what is new. */
const FRESH_MS = 3000;

/** What a button in the bubble does. */
type Fix = "archiveNow" | "continue" | "switch" | "install";

/** What helps with a pause, as buttons, the first the most likely. */
const FIXES: Readonly<Record<string, readonly Fix[]>> = {
  diverged: ["continue", "switch"],
  gone: ["archiveNow", "switch"],
  uninstalled: ["install"],
  suspended: ["archiveNow"],
  archived: ["archiveNow", "switch"],
  protected: ["archiveNow", "switch"],
  transferred: ["switch"],
  manifest: ["archiveNow"],
  invalid: ["archiveNow"],
};

/**
 * The GitHub part of the bubble of the cloud status, docs/design/phase5-step14.md 3.1.10: which
 * repository, the last archive, what waits or runs, why archiving paused and what helps, files the
 * last archive could not write, and "archive now". `close` closes the bubble, before a dialog.
 */
export function RepositoryStatus({
  watch,
  notSent,
  close,
}: {
  readonly watch: RepositoryWatch;
  /** Changes of this window the platform does not have yet, which an archive leaves out. */
  readonly notSent: boolean;
  readonly close: () => void;
}) {
  const workbench = useWorkbench();
  const { cloud } = workbench;
  const { t } = useTranslation();
  const { status, trouble, checkedAt, archiveAt } = useSyncExternalStore(
    watch.subscribe,
    watch.getSnapshot,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // Only as it opens.
  const [openedWith] = useState(checkedAt);
  useEffect(() => {
    if (openedWith === undefined || Date.now() - openedWith > FRESH_MS) void watch.refresh();
  }, [openedWith, watch]);

  const run = (fix: Fix) => {
    close();
    if (fix === "archiveNow") void cloud?.archiveNow();
    else if (fix === "continue") void cloud?.continueWithEditor();
    else if (fix === "switch") void cloud?.saveToGitHub();
    else void workbench.installApp();
  };
  const fixLabel: Record<Fix, string> = {
    archiveNow: t("repository.status.archiveNow"),
    continue: t("repository.continue"),
    switch: t("repository.switch"),
    install: t("repository.install"),
  };

  let body;
  if (!status) {
    body = (
      <p className={styles.line}>
        {trouble === "signedOut"
          ? t("repository.status.signedOut")
          : trouble
            ? t("repository.status.unknown")
            : t("repository.status.checking")}
      </p>
    );
  } else if (status.state === "none") {
    body = (
      <>
        <p className={styles.line} data-archive-line="state">
          {t("repository.status.none")}
        </p>
        <div className={styles.buttons}>
          <button type="button" className={styles.primary} onClick={() => run("switch")}>
            {t("repository.action")}
          </button>
        </div>
      </>
    );
  } else {
    const { repository } = status;
    const paused = status.state === "paused";
    const pause = paused ? pauseText(status, t) : undefined;
    const detail = paused ? pauseDetail(status, t) : undefined;
    const kept = keptText(status, t);
    const fixes: readonly Fix[] = paused
      ? (FIXES[knownPause(status.reason) ?? ""] ?? ["archiveNow", "switch"])
      : ["archiveNow"];
    const waiting = archiveAt !== undefined;
    body = (
      <>
        {repository && (
          <p className={styles.line}>
            {repositoryText(repository, t)}
            {repository.url && (
              <a
                className={styles.link}
                href={repository.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={11} />
                {t("repository.status.open")}
              </a>
            )}
          </p>
        )}
        <p className={styles.line} data-archive-line="last">
          {lastArchiveText(status, now, t)}
        </p>
        <p className={paused ? styles.paused : styles.line} data-archive-line="state" role="status">
          {archiveAt !== undefined
            ? t("repository.status.archiveAt", {
                count: Math.max(1, Math.ceil((archiveAt - now) / 1000)),
              })
            : archiveStateText(status, now, t)}
        </p>
        {pause && <p className={styles.note}>{pause.fix}</p>}
        {detail && <p className={styles.note}>{detail}</p>}
        {kept && (
          <p className={styles.note} data-archive-line="kept">
            {kept}
          </p>
        )}
        {notSent && status.state === "ready" && (
          <p className={styles.note}>{t("repository.status.notSent")}</p>
        )}
        {trouble && trouble !== "signedOut" && (
          <p className={styles.note}>{t("repository.status.stale")}</p>
        )}
        <div className={styles.buttons}>
          {fixes.map((fix, index) => (
            <button
              key={fix}
              type="button"
              className={index === 0 ? styles.primary : undefined}
              disabled={fix === "archiveNow" && !paused && (status.archiving || waiting)}
              onClick={() => run(fix)}
            >
              {fixLabel[fix]}
            </button>
          ))}
        </div>
      </>
    );
  }

  return (
    <section className={styles.section} aria-label={t("repository.status.heading")}>
      <h4 className={styles.heading}>{t("repository.status.heading")}</h4>
      {body}
    </section>
  );
}
