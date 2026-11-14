import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useWorkbench } from "../app/context.ts";
import { agoText } from "../app/start-view.ts";
import type { AiCounts } from "../chat/ai-sync.ts";
import { useAiSyncText } from "../chat/AiSyncStatus.tsx";
import { BackToPages } from "../panels/SettingsPanel.tsx";
import type { CloudFeature } from "./cloud-sync.ts";
import { countsText, hasAny } from "./cloud-text.ts";
import { FeatureRow, GitHubRow, Switch, useAccount } from "./CloudParts.tsx";
import styles from "./CloudSync.module.css";

/**
 * The page "云同步" of the settings, where people are signed in (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 9.4): the switches of the welcome, each with how
 * it stands, which people change whenever they like; and the AI settings of this device of before
 * signing in, which they can put into the account, or take away.
 */
export function CloudSyncPage() {
  const workbench = useWorkbench();
  const { cloudSync, aiSync, organizer, chatSync, dialogs, notifications } = workbench;
  const { t } = useTranslation();
  const who = useAccount(workbench.account);
  const sync = useSyncExternalStore(cloudSync.subscribe, cloudSync.getSnapshot);
  const ai = useAiSyncText();
  const organizerSync = useSyncExternalStore(
    organizer.sync?.subscribe ?? noSubscribe,
    organizer.sync?.getSnapshot ?? idle,
  );
  const chats = useSyncExternalStore(
    chatSync?.subscribe ?? noSubscribe,
    chatSync?.getSnapshot ?? idle,
  );
  const now = useNow();
  const [counts, setCounts] = useState<AiCounts>();
  const [device, setDevice] = useState<AiCounts>();
  /** When this device's went into the account, as they are now. */
  const [merged, setMerged] = useState<number>();

  // What the AI settings have, in use and of this device, read again as they change.
  const recount = useCallback(() => {
    void aiSync.counts().then(setCounts, () => {});
    void aiSync.deviceCounts().then(setDevice, () => {});
    void aiSync.deviceMerged().then(setMerged, () => {});
  }, [aiSync]);
  useEffect(() => {
    recount();
    return workbench.ai.subscribe(recount);
  }, [recount, workbench.ai]);
  // The page opened: how the switches, the stars and groups and the conversations stand now.
  const { welcomed: answered } = useSyncExternalStore(cloudSync.subscribe, cloudSync.getSnapshot);
  useEffect(() => {
    void cloudSync.refresh();
    if (!answered) return;
    void organizer.syncNow();
    void chatSync?.retry();
  }, [cloudSync, answered, organizer, chatSync]);

  if (who.status !== "signedIn") return null;
  const { switches, welcomed, changing } = sync;
  const known = switches !== undefined;
  const on = (feature: CloudFeature) =>
    feature === "ai" ? ai.snapshot.status !== "off" : (switches?.[feature] ?? true);

  const toggle = async (feature: CloudFeature, next: boolean) => {
    if (!next && feature !== "newProjectsInCloud") {
      const words = {
        ai: [t("aiSync.offTitle"), t("aiSync.offMessage")],
        organizer: [t("cloudSync.organizerOffTitle"), t("cloudSync.organizerOffMessage")],
        chats: [t("cloudSync.chatsOffTitle"), t("cloudSync.chatsOffMessage")],
      }[feature];
      const sure = await dialogs.confirm({
        title: words[0]!,
        message: words[1]!,
        confirm: t("cloudSync.offConfirm"),
        danger: true,
      });
      if (!sure) return;
    }
    try {
      await cloudSync.set(feature, next);
    } catch (error) {
      console.warn("A cloud feature could not be turned on or off", error);
      notifications.push(t("cloudSync.changeFailed"));
    }
  };

  /** How what goes with the account stands, under its switch. */
  const line = (feature: "organizer" | "chats") => {
    if (!on(feature)) return lineOf(t, "off", undefined, now);
    if (!welcomed) return lineOf(t, "waiting", undefined, now);
    const { status, syncedAt } = feature === "organizer" ? organizerSync : chats;
    return lineOf(t, status, syncedAt, now);
  };

  const merge = async () => {
    if (!device) return;
    const words = countsText(t, device);
    const sure = await dialogs.confirm({
      title: t("cloudSync.device.mergeTitle"),
      message: `${t("cloudSync.device.mergeMessage", { counts: words })}${
        on("ai") ? t("cloudSync.device.mergeKeys") : t("cloudSync.device.mergeOff")
      }`,
      confirm: t("cloudSync.device.mergeConfirm"),
    });
    if (!sure) return;
    try {
      const names = await aiSync.mergeDevice();
      notifications.push(
        names.length > 0
          ? t("cloudSync.device.merged", { names: names.join("、") })
          : t("cloudSync.device.mergedNothing"),
      );
    } catch (error) {
      console.warn("The AI settings of this device could not go into the account", error);
      notifications.push(t("cloudSync.device.mergeFailed"));
    }
    recount();
  };

  const forget = async () => {
    if (!device) return;
    const sure = await dialogs.confirm({
      title: t("cloudSync.device.forgetTitle"),
      message: t("cloudSync.device.forgetMessage", { counts: countsText(t, device) }),
      confirm: t("cloudSync.device.forgetConfirm"),
      danger: true,
    });
    if (!sure) return;
    await aiSync.forgetDevice().catch((error: unknown) => {
      console.warn("The AI settings of this device could not be taken away", error);
    });
    recount();
  };

  const aiStatus = ai.snapshot.status;
  const canChange = known && sync.status !== "failed" && sync.status !== "offline";

  return (
    <div className={styles.page} data-testid="cloud-sync">
      <BackToPages />
      <h2>{t("cloudSync.title")}</h2>
      <p className={styles.intro}>{t("cloudSync.intro", { name: who.name })}</p>
      {(sync.status === "failed" || sync.status === "offline") && (
        <p className={styles.problem} data-testid="cloud-switches-problem">
          {t("cloudSync.switchesFailed")}{" "}
          <button type="button" className={styles.link} onClick={() => void cloudSync.refresh()}>
            {t("cloudSync.retry")}
          </button>
        </p>
      )}
      <div className={`${styles.rows} ${styles.plain}`}>
        <FeatureRow
          id="ai"
          name={t("cloudSync.ai.name")}
          help={t("cloudSync.ai.help")}
          control={
            <Switch
              checked={on("ai")}
              disabled={
                !canChange ||
                changing !== undefined ||
                !welcomed ||
                ai.snapshot.account === undefined
              }
              onChange={(next) => void toggle("ai", next)}
            />
          }
        >
          <span className={styles.status} data-testid="ai-sync-status" data-status={aiStatus}>
            {aiStatus === "off" || aiStatus === "waiting" || counts === undefined || !hasAny(counts)
              ? ai.text
              : t("cloudSync.aiStatus", { status: ai.text, counts: countsText(t, counts, true) })}
            {(aiStatus === "failed" || aiStatus === "offline") && (
              <button type="button" className={styles.link} onClick={() => aiSync.retry()}>
                {t("cloudSync.retry")}
              </button>
            )}
          </span>
        </FeatureRow>
        {(["organizer", "chats"] as const).map((feature) => {
          const { status, text } = line(feature);
          return (
            <FeatureRow
              key={feature}
              id={feature}
              name={t(`cloudSync.${feature}.name`)}
              help={t(`cloudSync.${feature}.help`)}
              control={
                <Switch
                  checked={on(feature)}
                  disabled={!canChange || changing !== undefined}
                  onChange={(next) => void toggle(feature, next)}
                />
              }
            >
              <span
                className={styles.status}
                data-testid={`${feature}-sync-status`}
                data-status={status}
              >
                {text}
                {(status === "failed" || status === "offline") && (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() =>
                      void (feature === "organizer" ? organizer.syncNow() : chatSync?.retry())
                    }
                  >
                    {t("cloudSync.retry")}
                  </button>
                )}
              </span>
            </FeatureRow>
          );
        })}
        <FeatureRow
          id="newProjectsInCloud"
          name={t("cloudSync.newProjectsInCloud.name")}
          help={t("cloudSync.newProjectsInCloud.help")}
          control={
            <Switch
              checked={on("newProjectsInCloud")}
              disabled={!canChange || changing !== undefined}
              onChange={(next) => void toggle("newProjectsInCloud", next)}
            />
          }
        />
        <GitHubRow />
      </div>
      {device && hasAny(device) && (
        <>
          <h3>{t("cloudSync.device.title")}</h3>
          <div className={`${styles.rows} ${styles.plain}`}>
            <FeatureRow
              id="device"
              name={t("cloudSync.device.name")}
              help={
                merged === undefined
                  ? t("cloudSync.device.help", { counts: countsText(t, device) })
                  : t("cloudSync.device.mergedHelp", {
                      counts: countsText(t, device),
                      ago: agoText(merged, Math.max(now, merged), t),
                    })
              }
              control={
                <div className={styles.actions}>
                  {merged === undefined && (
                    <button type="button" className={styles.button} onClick={() => void merge()}>
                      {t("cloudSync.device.merge")}
                    </button>
                  )}
                  <button type="button" className={styles.button} onClick={() => void forget()}>
                    {t(
                      merged === undefined
                        ? "cloudSync.device.forget"
                        : "cloudSync.device.forgetOnly",
                    )}
                  </button>
                </div>
              }
            />
          </div>
        </>
      )}
      <p className={styles.note}>{t("aiSync.signOutNote")}</p>
    </div>
  );
}

const noSubscribe = () => () => {};
const IDLE = { status: "idle", syncedAt: undefined } as const;
const idle = () => IDLE;

type LineStatus = "idle" | "syncing" | "synced" | "offline" | "failed" | "off" | "waiting";

function lineOf(
  t: TFunction,
  status: LineStatus,
  syncedAt: number | undefined,
  now: number,
): { status: LineStatus; text: string } {
  if (status === "synced" && syncedAt !== undefined)
    return {
      status,
      text: t("cloudSync.status.syncedAgo", { ago: agoText(syncedAt, Math.max(now, syncedAt), t) }),
    };
  return { status, text: t(`cloudSync.status.${status}`) };
}

/** Now, every half a minute, for "2 分钟前". */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
