import { X } from "lucide-react";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import type { SwitchValues, WelcomeRequest } from "./cloud-sync.ts";
import { countsText, hasAny } from "./cloud-text.ts";
import { FeatureRow, GitHubRow, Switch } from "./CloudParts.tsx";
import styles from "./CloudSync.module.css";

/**
 * The welcome, the first time an account is signed in to in this browser (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 9.3): every cloud feature with its switch, as the
 * account has it or on by default. Whatever closes it ("开始使用", "以后再说", ✕, Esc) starts them as
 * the switches are then, see `CloudSync.answerWelcome`. It waits while another dialog is open, as
 * one of making or connecting a project.
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
  // The platform could not be reached: people get out, and it comes again once it can be.
  const dismiss = () => (welcome.failed ? cloudSync.postponeWelcome() : void answer());
  const set = (feature: keyof SwitchValues) => (on: boolean) =>
    cloudSync.editWelcome({ ...cloudSync.getSnapshot().welcome!.switches, [feature]: on });
  const { question } = welcome;
  const busy = welcome.answering === true;

  const device = countsText(t, question.device);
  const aiHelp = !values.ai
    ? `${t("welcome.ai.off")}${question.enabled && question.accountServices > 0 ? t("welcome.ai.offDeletes") : ""}`
    : `${
        hasAny(question.device)
          ? question.accountServices > 0
            ? t("welcome.ai.putMerge", { device, count: question.accountServices })
            : t("welcome.ai.put", { device })
          : question.accountServices > 0
            ? t("welcome.ai.take", { count: question.accountServices })
            : t("welcome.ai.nothing")
      }${question.deviceKeys > 0 ? t("welcome.ai.keys") : t("welcome.ai.laterKeys")}`;

  return (
    <dialog
      ref={dialog}
      className={styles.welcome}
      aria-label={t("welcome.title", { name: welcome.name })}
      data-testid="welcome"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) dismiss();
      }}
    >
      <div className={styles.welcomeBody}>
        <button
          type="button"
          className={styles.close}
          aria-label={t("welcome.close")}
          disabled={busy}
          onClick={dismiss}
        >
          <X size={16} aria-hidden />
        </button>
        <h2>{t("welcome.title", { name: welcome.name })}</h2>
        <p className={styles.intro}>{t("welcome.intro")}</p>
        <div className={styles.rows}>
          <FeatureRow
            id="ai"
            name={t("welcome.ai.name")}
            help={aiHelp}
            control={<Switch checked={values.ai} disabled={busy} onChange={set("ai")} />}
          />
          <FeatureRow
            id="organizer"
            name={t("welcome.organizer.name")}
            help={t("welcome.organizer.help")}
            control={
              <Switch checked={values.organizer} disabled={busy} onChange={set("organizer")} />
            }
          />
          <FeatureRow
            id="chats"
            name={t("welcome.chats.name")}
            help={t("welcome.chats.help")}
            control={<Switch checked={values.chats} disabled={busy} onChange={set("chats")} />}
          />
          <FeatureRow
            id="newProjectsInCloud"
            name={t("welcome.newProjectsInCloud.name")}
            help={t("welcome.newProjectsInCloud.help")}
            control={
              <Switch
                checked={values.newProjectsInCloud}
                disabled={busy}
                onChange={set("newProjectsInCloud")}
              />
            }
          />
          <GitHubRow before={answer} />
        </div>
        <div className={styles.footer}>
          {welcome.failed && !busy ? (
            <p className={styles.failed} role="alert" data-testid="welcome-failed">
              {t("welcome.failed")}
            </p>
          ) : (
            <p>{busy ? t("welcome.starting") : t("welcome.footer")}</p>
          )}
          <div className={styles.buttons}>
            <button type="button" disabled={busy} onClick={dismiss}>
              {t(welcome.failed ? "welcome.putOff" : "welcome.later")}
            </button>
            <button
              ref={start}
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => void answer()}
            >
              {t(welcome.failed ? "welcome.again" : "welcome.start")}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
