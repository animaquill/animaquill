import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useWorkbench } from "../app/context.ts";
import { agoText } from "../app/start-view.ts";
import type { ChatImageUsage } from "@animaquill/host";
import type { AiCounts } from "../chat/ai-sync.ts";
import { bytesText } from "../chat/shots.ts";
import { useAiSyncText } from "../chat/AiSyncStatus.tsx";
import { WhereIcon } from "../settings/WhereIcon.tsx";
import { DEFAULT_SWITCHES, type CloudFeature } from "./cloud-sync.ts";
import { countsText, hasAny } from "./cloud-text.ts";
import { FeatureRow, Switch, useAccount } from "./CloudParts.tsx";
import styles from "./CloudSync.module.css";

/**
 * The page "云同步" of the settings, where people are signed in (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 9.4): the switches of the welcome, each of this
 * device, with how it stands, which people change whenever they like. Turning one off takes nothing
 * away anywhere, so it asks nothing.
 */
export function CloudSyncPage() {
  const workbench = useWorkbench();
  const { cloudSync, aiSync, organizer, chatSync, notifications } = workbench;
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
  const [changing, setChanging] = useState<CloudFeature>();

  // What the AI settings have, read again as they change.
  const recount = useCallback(() => {
    void aiSync.counts().then(setCounts, () => {});
  }, [aiSync]);
  useEffect(() => {
    recount();
    return workbench.ai.subscribe(recount);
  }, [recount, workbench.ai]);
  // The page opened: how the stars and groups and the conversations stand now.
  const { welcomed } = sync;
  useEffect(() => {
    if (!welcomed) return;
    void organizer.syncNow();
    void chatSync?.retry();
  }, [welcomed, organizer, chatSync]);

  if (who.status !== "signedIn") return null;
  const switches = sync.switches ?? DEFAULT_SWITCHES;
  const on = (feature: CloudFeature) =>
    feature === "ai" ? ai.snapshot.status !== "off" : switches[feature];

  const toggle = async (feature: CloudFeature, next: boolean) => {
    setChanging(feature);
    try {
      await cloudSync.set(feature, next);
    } catch (error) {
      console.warn("A cloud feature could not be turned on or off", error);
      notifications.push(t("cloudSync.changeFailed"));
    } finally {
      setChanging(undefined);
    }
  };

  /** How what goes with the account stands, under its switch. */
  const line = (feature: "organizer" | "chats") => {
    if (!on(feature)) return lineOf(t, "off", undefined, now);
    if (!welcomed) return lineOf(t, "waiting", undefined, now);
    const { status, syncedAt } = feature === "organizer" ? organizerSync : chats;
    return lineOf(t, status, syncedAt, now);
  };

  const aiStatus = ai.snapshot.status;
  const canChange = welcomed && changing === undefined;
  const device = <WhereIcon where="device" />;

  return (
    <div className={styles.page} data-testid="cloud-sync">
      <h2>{t("cloudSync.title")}</h2>
      <div className={`${styles.rows} ${styles.plain}`}>
        <FeatureRow
          id="ai"
          name={t("cloudSync.ai.name")}
          where={device}
          help={t("cloudSync.ai.help")}
          control={
            <Switch
              checked={on("ai")}
              disabled={!canChange || ai.snapshot.account === undefined}
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
              where={device}
              control={
                <Switch
                  checked={on(feature)}
                  disabled={!canChange}
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
              {feature === "chats" && on("chats") && welcomed && <ChatImagesUsage />}
            </FeatureRow>
          );
        })}
        <FeatureRow
          id="newProjectsInCloud"
          name={t("cloudSync.newProjectsInCloud.name")}
          where={device}
          control={
            <Switch
              checked={on("newProjectsInCloud")}
              disabled={!canChange}
              onChange={(next) => void toggle("newProjectsInCloud", next)}
            />
          }
        />
        {/* Linking GitHub is the account's: here only where it is. */}
        <FeatureRow
          id="github"
          name={t("cloudSync.github.name")}
          control={
            <button
              type="button"
              className={styles.button}
              onClick={() =>
                workbench.settingsNav.go({ group: "account", depth: 1, item: "account.github" })
              }
            >
              {t("cloudSync.githubGo")}
            </button>
          }
        />
      </div>
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

/** A size of the room of pictures: 500 MB, 12.5 MB, 9 KB. */
const roomText = (bytes: number) => bytesText(bytes).replace(/\.0 MB$/, " MB");

/**
 * Under “云端项目的 AI 对话”: how much of their room the pictures of the conversations take on the
 * platform, and, to manage it, which conversations have them, each of which can go.
 */
function ChatImagesUsage() {
  const { chatSync, dialogs, notifications, chat } = useWorkbench();
  const { t } = useTranslation();
  const [usage, setUsage] = useState<ChatImageUsage | "failed">();
  const [open, setOpen] = useState(false);
  const read = useCallback(() => {
    if (!chatSync) return;
    void chatSync.imageUsage().then(
      (found) => setUsage(found),
      () => setUsage("failed"),
    );
  }, [chatSync]);
  useEffect(read, [read]);
  if (!chatSync || usage === undefined) return null;
  if (usage === "failed")
    return (
      <span className={styles.status} data-testid="chat-images-usage" data-status="failed">
        {t("cloudSync.chatImages.failed")}{" "}
        <button type="button" className={styles.link} onClick={read}>
          {t("cloudSync.retry")}
        </button>
      </span>
    );
  const remove = async (each: ChatImageUsage["chats"][number]) => {
    const title = each.title || t("cloudSync.chatImages.untitled");
    const sure = await dialogs.confirm({
      title: t("cloudSync.chatImages.deleteTitle", { title }),
      message: t("cloudSync.chatImages.deleteMessage"),
      confirm: t("cloudSync.chatImages.deleteConfirm"),
      danger: true,
    });
    if (!sure) return;
    try {
      await chatSync.removeOnAccount(each.project, each.chat);
      void chat.reloadList();
    } catch (error) {
      console.warn("A conversation could not be taken away", error);
      notifications.push(t("cloudSync.chatImages.deleteFailed"));
    }
    read();
  };
  return (
    <>
      <span className={styles.status} data-testid="chat-images-usage">
        {t("cloudSync.chatImages.usage", {
          used: roomText(usage.used),
          limit: roomText(usage.limit),
        })}
        <button
          type="button"
          className={styles.link}
          data-testid="chat-images-manage"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t(open ? "cloudSync.chatImages.hide" : "cloudSync.chatImages.manage")}
        </button>
      </span>
      {open && (
        <div className={styles.imageList} data-testid="chat-images-list">
          {usage.chats.length === 0 && (
            <p className={styles.help}>{t("cloudSync.chatImages.none")}</p>
          )}
          {usage.chats.map((each) => (
            <div
              key={`${each.project}/${each.chat}`}
              className={styles.imageRow}
              data-testid="chat-images-row"
            >
              <span>
                <span className={styles.name}>
                  {each.title || t("cloudSync.chatImages.untitled")}
                </span>
                <span className={styles.help}>
                  {t("cloudSync.chatImages.row", {
                    project: each.projectName,
                    count: each.images,
                    size: bytesText(each.bytes),
                  })}
                </span>
              </span>
              <button type="button" className={styles.button} onClick={() => void remove(each)}>
                {t("cloudSync.chatImages.delete")}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
