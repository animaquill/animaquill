import { X } from "lucide-react";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { SwitchValues, WelcomeRequest } from "./cloud-sync.ts";
import { WhereIcon } from "../settings/WhereIcon.tsx";
import { FeatureRow, GitHubRow, Switch } from "./CloudParts.tsx";
import styles from "./CloudSync.module.css";

/**
 * The welcome, the first time an account is signed in to in this browser (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 9.3): every cloud feature with its switch, of this
 * device, on by default. Whatever closes it ("开始使用", "以后再说", ✕, Esc) starts them as the
 * switches are then, see `CloudSync.answerWelcome`. It waits while another dialog is open, as one
 * of making or connecting a project.
 */
export function WelcomeHost() {
  const { cloudSync, dialogs } = useWorkbench();
  const { welcome } = useSyncExternalStore(cloudSync.subscribe, cloudSync.getSnapshot);
  const other = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot);
  if (!welcome || other) return null;
  return <WelcomeDialog key={welcome.account} welcome={welcome} />;
}

function WelcomeDialog({ welcome }: { readonly welcome: WelcomeRequest }) {
  const { cloudSync } = useWorkbench();
  const { t } = useTranslation();
  // Kept with the welcome, not here: another dialog can take its place for a while.
  const values = welcome.switches;
  const dialog = useRef<HTMLDialogElement>(null);
  const start = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    start.current?.focus();
    return () => element?.close();
  }, []);

  const answer = () => cloudSync.answerWelcome(values);
  const set = (feature: keyof SwitchValues) => (on: boolean) =>
    cloudSync.editWelcome({ ...cloudSync.getSnapshot().welcome!.switches, [feature]: on });
  const device = <WhereIcon where="device" />;

  return (
    <dialog
      ref={dialog}
      className={styles.welcome}
      aria-label={t("welcome.title", { name: welcome.name })}
      data-testid="welcome"
      onCancel={(event) => {
        event.preventDefault();
        void answer();
      }}
    >
      <div className={styles.welcomeBody}>
        <button
          type="button"
          className={styles.close}
          aria-label={t("welcome.close")}
          onClick={() => void answer()}
        >
          <X size={16} aria-hidden />
        </button>
        <h2>{t("welcome.title", { name: welcome.name })}</h2>
        <div className={styles.rows}>
          <FeatureRow
            id="ai"
            name={t("welcome.ai.name")}
            where={device}
            {...(values.ai && { help: t("welcome.ai.keys") })}
            control={<Switch checked={values.ai} onChange={set("ai")} />}
          />
          <FeatureRow
            id="organizer"
            name={t("welcome.organizer.name")}
            where={device}
            control={<Switch checked={values.organizer} onChange={set("organizer")} />}
          />
          <FeatureRow
            id="chats"
            name={t("welcome.chats.name")}
            where={device}
            control={<Switch checked={values.chats} onChange={set("chats")} />}
          />
          <FeatureRow
            id="newProjectsInCloud"
            name={t("welcome.newProjectsInCloud.name")}
            where={device}
            control={
              <Switch checked={values.newProjectsInCloud} onChange={set("newProjectsInCloud")} />
            }
          />
          <GitHubRow before={answer} />
        </div>
        <div className={styles.footer}>
          <p>{t("welcome.footer")}</p>
          <div className={styles.buttons}>
            <button type="button" onClick={() => void answer()}>
              {t("welcome.later")}
            </button>
            <button
              ref={start}
              type="button"
              className={styles.primary}
              onClick={() => void answer()}
            >
              {t("welcome.start")}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
