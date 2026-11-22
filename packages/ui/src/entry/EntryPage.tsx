import type { SignInOutcome } from "@animaquill/host";
import type { TFunction } from "i18next";
import { Feather, LogIn, MonitorOff } from "lucide-react";
import { useState } from "react";
import styles from "./EntryPage.module.css";

/** Why the entry page has something to say: how a sign-in ended, or a backend out of reach. */
export type EntryProblem = Exclude<SignInOutcome, "signedIn"> | "unreachable";

/** Whether this browser can keep projects in folders on this computer. */
const canFolders = () =>
  typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

/**
 * The page of a site with a backend for whoever is not signed in (docs/design/online-offline.md of
 * AnimaQuill Cloud, 1.1): what this is, and the two ways in, signing in for the online mode, or
 * the offline mode, which needs nobody. Nothing else: the editor is behind either.
 */
export function EntryPage({
  t,
  problem,
  offlineRefused,
  signIn,
  offline,
  retry,
}: {
  readonly t: TFunction;
  readonly problem: EntryProblem | undefined;
  /** Safari: the offline mode is grey, and says why, see `startApp`. */
  readonly offlineRefused: boolean;
  readonly signIn: () => void;
  readonly offline: () => void;
  readonly retry: () => void;
}) {
  const [asked, setAsked] = useState(false);
  return (
    <main className={styles["page"]} data-testid="entry">
      <div className={styles["box"]}>
        <Feather className={styles["mark"]} size={40} aria-hidden />
        <h1 className={styles["name"]}>AnimaQuill</h1>
        <p className={styles["tagline"]}>{t("app.tagline")}</p>
        {problem && (
          <p className={styles["problem"]} role="alert">
            {problem === "unreachable" ? t("entry.unreachable") : t(`account.outcome.${problem}`)}
            {problem === "unreachable" && (
              <button type="button" className={styles["inline"]} onClick={retry}>
                {t("entry.retry")}
              </button>
            )}
          </p>
        )}
        <div className={styles["ways"]}>
          <button
            type="button"
            className={styles["primary"]}
            onClick={signIn}
            // The first thing people do here.
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          >
            <LogIn size={18} aria-hidden />
            {t("entry.signIn")}
          </button>
          <button
            type="button"
            className={styles["secondary"]}
            {...(offlineRefused
              ? {
                  "aria-disabled": "true",
                  "data-refused": "",
                  title: t("entry.safari"),
                  onClick: () => setAsked(true),
                }
              : { onClick: offline })}
          >
            <MonitorOff size={18} aria-hidden />
            {t("entry.offline")}
          </button>
          {offlineRefused ? (
            asked && (
              <p className={styles["note"]} role="status">
                {t("entry.safari")}
                <button type="button" className={styles["inline"]} onClick={signIn}>
                  {t("entry.safariSignIn")}
                </button>
              </p>
            )
          ) : (
            <p className={styles["note"]}>
              {canFolders() ? t("entry.offlineAbout") : t("entry.offlineAboutBrowser")}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
