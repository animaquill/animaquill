import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { BackToPages } from "../panels/SettingsPanel.tsx";
import styles from "./AccountSyncPage.module.css";
import { useAiSyncText } from "./AiSyncStatus.tsx";

/**
 * The page "账号和同步" of the settings (docs/design/chat-and-models.md of AnimaQuill Cloud, 5.2):
 * who is signed in, whether the AI settings and keys go with the account, and how that stands. It
 * always says that what goes is kept on the platform, keys included.
 */
export function AccountSyncPage() {
  const workbench = useWorkbench();
  const { aiSync, account, dialogs, notifications } = workbench;
  const { t } = useTranslation();
  const { text, snapshot } = useAiSyncText();
  const who = useSyncExternalStore(
    account?.subscribe ?? noSubscribe,
    account?.getSnapshot ?? unknown,
  );
  const [busy, setBusy] = useState(false);
  const signedIn = who.status === "signedIn" ? who : undefined;
  const on = snapshot.status !== "off";

  const toggle = async () => {
    if (on) {
      const sure = await dialogs.confirm({
        title: t("aiSync.offTitle"),
        message: t("aiSync.offMessage"),
        confirm: t("aiSync.offConfirm"),
        danger: true,
      });
      if (!sure) return;
    }
    setBusy(true);
    try {
      await aiSync.setEnabled(!on);
    } catch (error) {
      console.warn("Syncing AI settings could not be turned on or off", error);
      notifications.push(t(on ? "aiSync.offFailed" : "aiSync.onFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page} data-testid="account-sync">
      <BackToPages />
      <h2 className={styles.group}>{t("settings.pages.account")}</h2>
      {signedIn ? (
        <p className={styles.who}>{t("aiSync.account", { name: signedIn.name })}</p>
      ) : (
        <p className={styles.who}>
          {t("aiSync.signedOut")}{" "}
          {who.status === "signedOut" && (
            <button type="button" className={styles.link} onClick={() => void workbench.signIn()}>
              {t("aiSync.signIn")}
            </button>
          )}
        </p>
      )}
      {signedIn && (
        <>
          <label className={styles.setting}>
            <input
              type="checkbox"
              checked={on}
              disabled={busy || snapshot.account === undefined}
              onChange={() => void toggle()}
            />
            <span>
              <strong>{t("aiSync.switch")}</strong>
              <span className={styles.help}>{t("aiSync.switchHelp")}</span>
            </span>
          </label>
          <p className={styles.status} data-testid="ai-sync-status" data-status={snapshot.status}>
            {t("aiSync.line", { status: text })}
            {(snapshot.status === "failed" || snapshot.status === "offline") && (
              <>
                {" "}
                <button type="button" className={styles.link} onClick={() => aiSync.retry()}>
                  {t("aiSync.retry")}
                </button>
              </>
            )}
          </p>
          <p className={styles.notice} data-testid="ai-sync-notice">
            {t("aiSync.notice")}
          </p>
          <p className={styles.help}>{t("aiSync.signOutNote")}</p>
        </>
      )}
    </div>
  );
}

const noSubscribe = () => () => {};
const unknown = () => ({ status: "unknown" }) as const;
