import type { AccountSpace, UndoUsage } from "@animaquill/host";
import { TOOL_CALL_LIMITS } from "@animaquill/agent";
import type { VideoCodecName } from "@animaquill/media";
import type { TFunction } from "i18next";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";
import { GitHubRow, useAccount } from "../cloud/CloudParts.tsx";

import { Button, Choice, GroupPage, Segmented, SettingRow, Toggle } from "./parts.tsx";
import { usageOfChats, clearLocalChats, type ChatsUsage } from "./storage.ts";
import cloudStyles from "../cloud/CloudSync.module.css";
import styles from "./Settings.module.css";

/** Where the code of the editor is, with its licence and its issues. */
export const REPOSITORY = "https://github.com/animaquill/animaquill";

// ---- 常规

export function GeneralGroup() {
  const { t } = useTranslation();
  return (
    <GroupPage title={t("settings.groups.general")}>
      <SettingRow id="general.language">
        <Choice
          label={t("settings.items.general.language.name")}
          value="zh-CN"
          options={[{ value: "zh-CN", label: "简体中文" }]}
          onChange={() => {}}
        />
      </SettingRow>
    </GroupPage>
  );
}

// ---- 编辑

export function EditingGroup() {
  const { trials } = useWorkbench();
  const { t } = useTranslation();
  const { enabled, count } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  return (
    <GroupPage title={t("settings.groups.editing")}>
      <SettingRow
        id="editing.trial"
        below={
          !enabled &&
          count > 0 && (
            <span className={styles.pending}>{t("settings.trialPending", { count })}</span>
          )
        }
      >
        <Toggle
          label={t("settings.items.editing.trial.name")}
          checked={enabled}
          onChange={(on) => trials.setEnabled(on)}
        />
      </SettingRow>
    </GroupPage>
  );
}

// ---- 预览和播放

export function PlaybackGroup() {
  const { proxyOffer } = useWorkbench();
  const { t } = useTranslation();
  const offer = useSyncExternalStore(proxyOffer.subscribe, proxyOffer.getSnapshot);
  return (
    <GroupPage title={t("settings.groups.playback")}>
      <SettingRow id="playback.proxyOffer">
        <Toggle
          label={t("settings.items.playback.proxyOffer.name")}
          checked={offer}
          onChange={(on) => proxyOffer.set(on)}
        />
      </SettingRow>
    </GroupPage>
  );
}

// ---- 导出

export function ExportGroup() {
  const { videos } = useWorkbench();
  const { t } = useTranslation();
  const [failed, setFailed] = useState<ReadonlyMap<VideoCodecName, number>>();
  const read = useCallback(() => {
    void videos.hardwareFailed().then(setFailed);
  }, [videos]);
  useEffect(read, [read]);

  const failures = failed ? [...failed.keys()] : [];
  return (
    <GroupPage title={t("settings.groups.export")}>
      <SettingRow
        id="export.hardware"
        // How it stands says it all: one line, and a way to try again only where it failed.
        help=""
        below={
          failed && (
            <span className={styles.status} data-testid="settings-hardware">
              {failures.length === 0
                ? t("settings.hardware.fine")
                : t("settings.hardware.failed", {
                    codecs: failures
                      .map((codec) => t(`export.video.codecName.${codec}`))
                      .join("、"),
                  })}
            </span>
          )
        }
      >
        {failures.length > 0 && (
          <Button onClick={() => void videos.retryHardware().then(read)}>
            {t("settings.hardware.retry")}
          </Button>
        )}
      </SettingRow>
    </GroupPage>
  );
}

// ---- AI 聊天

/**
 * A whole number in a range, taken as it loses the focus or on Enter; what is out of the range or
 * not a whole number is marked and not taken.
 */
function NumberField(props: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly disabled?: boolean;
  readonly onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string>();
  const text = draft ?? String(props.value);
  const parsed = Number(text);
  const valid = /^\s*\d+\s*$/.test(text) && parsed >= props.min && parsed <= props.max;
  const commit = () => {
    if (draft === undefined) return;
    if (valid) {
      props.onChange(parsed);
      setDraft(undefined);
    }
  };
  return (
    <span className={styles.number}>
      <input
        className={styles.input}
        inputMode="numeric"
        aria-label={props.label}
        aria-invalid={!valid}
        disabled={props.disabled}
        value={text}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {!valid && (
        <span className={styles.invalid} role="alert">
          {t("settings.numberRange", { min: props.min, max: props.max })}
        </span>
      )}
    </span>
  );
}

export function ChatGroup() {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const held = settings.held !== undefined;
  return (
    <GroupPage title={t("settings.groups.chat")}>
      <SettingRow id="chat.maxToolCalls">
        <NumberField
          label={t("settings.items.chat.maxToolCalls.name")}
          value={settings.maxToolCalls}
          min={TOOL_CALL_LIMITS.min}
          max={TOOL_CALL_LIMITS.max}
          disabled={held}
          onChange={(value) => ai.setMaxToolCalls(value)}
        />
        <span className={styles.unit}>{t("ai.times")}</span>
      </SettingRow>
      <SettingRow id="chat.askBeforeEdit">
        <Toggle
          label={t("settings.items.chat.askBeforeEdit.name")}
          checked={settings.askBeforeEdit === true}
          disabled={held}
          onChange={(on) => ai.setAskBeforeEdit(on)}
        />
      </SettingRow>
      <SettingRow id="chat.autoTitle">
        <Toggle
          label={t("settings.items.chat.autoTitle.name")}
          checked={settings.autoTitle}
          disabled={held}
          onChange={(on) => ai.setAutoTitle(on)}
        />
      </SettingRow>
      <SettingRow id="chat.expandThinking">
        <Toggle
          label={t("settings.items.chat.expandThinking.name")}
          checked={settings.expandThinking}
          disabled={held}
          onChange={(on) => ai.setExpandThinking(on)}
        />
      </SettingRow>
      <SettingRow id="chat.sendWith">
        <Segmented
          label={t("settings.items.chat.sendWith.name")}
          value={settings.sendWith ?? "enter"}
          options={[
            { value: "enter", label: t("settings.sendWith.enter") },
            { value: "modEnter", label: t("settings.sendWith.modEnter") },
          ]}
          disabled={held}
          onChange={(value) => ai.setSendWith(value)}
        />
      </SettingRow>
      <SettingRow id="chat.shotSize">
        <Segmented
          label={t("settings.items.chat.shotSize.name")}
          value={String(settings.shotSize ?? 1568)}
          options={[
            { value: "1024", label: t("settings.shotSize.1024") },
            { value: "1568", label: t("settings.shotSize.1568") },
            { value: "original", label: t("settings.shotSize.original") },
          ]}
          disabled={held}
          onChange={(value) =>
            ai.setShotSize(value === "original" ? "original" : value === "1024" ? 1024 : 1568)
          }
        />
      </SettingRow>
      <SettingRow id="chat.lookSize">
        <Segmented
          label={t("settings.items.chat.lookSize.name")}
          value={settings.lookSize ?? "medium"}
          options={[
            { value: "small", label: t("settings.lookSize.small") },
            { value: "medium", label: t("settings.lookSize.medium") },
            { value: "large", label: t("settings.lookSize.large") },
          ]}
          disabled={held}
          onChange={(value) => ai.setLookSize(value)}
        />
      </SettingRow>
      <SettingRow id="chat.lookWaits">
        <Toggle
          label={t("settings.items.chat.lookWaits.name")}
          checked={settings.lookWhilePlaying !== true}
          disabled={held}
          onChange={(on) => ai.setLookWaits(on)}
        />
      </SettingRow>
      <SettingRow id="chat.autoCompact">
        <Toggle
          label={t("settings.items.chat.autoCompact.name")}
          checked={settings.autoCompact !== false}
          disabled={held}
          onChange={(on) => ai.setAutoCompact(on)}
        />
      </SettingRow>
    </GroupPage>
  );
}

// ---- 账号

const formatBytes = (t: TFunction, bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return t("settings.bytes", { value: shown, unit: units[unit] });
};

export function AccountGroup() {
  const workbench = useWorkbench();
  const { account } = workbench;
  const { t } = useTranslation();
  const who = useAccount(account);
  if (who.status !== "signedIn") {
    return (
      <GroupPage title={t("settings.groups.account")}>
        <div className={styles.signIn} data-testid="settings-sign-in">
          <p>{t("settings.account.signedOut")}</p>
          {who.status === "signedOut" ? (
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={() => void workbench.signIn()}
            >
              {t("account.signIn")}
            </button>
          ) : (
            <span className={styles.note}>{t("start.account.unknown")}</span>
          )}
        </div>
      </GroupPage>
    );
  }
  return (
    <GroupPage title={t("settings.groups.account")}>
      <SettingRow
        id="account.who"
        name={
          <span className={styles.who}>
            {who.picture === undefined ? (
              <span className={styles.initial} aria-hidden="true">
                {[...who.name][0]?.toUpperCase() ?? "?"}
              </span>
            ) : (
              <img
                className={styles.picture}
                src={who.picture}
                alt=""
                referrerPolicy="no-referrer"
              />
            )}
            {who.name}
          </span>
        }
      >
        <Button onClick={() => void workbench.signOut()}>{t("account.signOut")}</Button>
      </SettingRow>
      <div
        className={`${cloudStyles.rows} ${cloudStyles.plain} ${styles.embedded}`}
        data-setting="account.github"
      >
        <GitHubRow />
      </div>
      <SpaceRow />
    </GroupPage>
  );
}

/** How much of the cloud space the account has used, of what it was given, read-only. */
function SpaceRow() {
  const { account } = useWorkbench();
  const { t } = useTranslation();
  const [space, setSpace] = useState<AccountSpace | "failed">();
  const read = useCallback(() => {
    account?.space?.().then(setSpace, (error: unknown) => {
      console.warn("The cloud space of the account could not be read", error);
      setSpace("failed");
    });
  }, [account]);
  useEffect(read, [read]);
  if (!account?.space) return null;
  // Where there is none, nothing to say: only what there is.
  if (space !== undefined && space !== "failed" && (space.mode === "off" || space.limit === 0))
    return null;
  const text =
    space === undefined
      ? t("settings.space.reading")
      : space === "failed"
        ? t("settings.space.failed")
        : space.mode === "off"
          ? t("settings.space.off")
          : space.limit === 0
            ? t("settings.space.none")
            : t(space.mode === "readonly" ? "settings.space.readonly" : "settings.space.used", {
                used: formatBytes(t, space.used),
                limit: formatBytes(t, space.limit),
              });
  return (
    <SettingRow
      id="account.space"
      below={
        <span className={styles.status} data-testid="settings-space">
          {text}
          {space === "failed" && (
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                setSpace(undefined);
                read();
              }}
            >
              {t("cloudSync.retry")}
            </button>
          )}
        </span>
      }
    />
  );
}

// ---- 存储和数据

export function StorageGroup() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  return (
    <GroupPage title={t("settings.groups.storage")}>
      {workbench.persistence && <PersistRow />}
      <KeysRow />
      {workbench.chatStore?.usage && <ChatsRow />}
      <UndoRow />
      <UsageRow />
    </GroupPage>
  );
}

/**
 * Whether the browser keeps what is stored here until people clear it: the editor asks for it on
 * its own once something was saved (`Workbench`); only where the browser said no does anything
 * show here, to ask again.
 */
function PersistRow() {
  const { persistence, notifications } = useWorkbench();
  const { t } = useTranslation();
  const [kept, setKept] = useState<boolean>();
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!persistence) return;
    let gone = false;
    void (async () => {
      const now = (await persistence.persisted()) || !persistence.wasAsked();
      if (!gone) setKept(now);
    })();
    return () => {
      gone = true;
    };
  }, [persistence]);
  if (!persistence || kept !== false) return null;
  const ask = async () => {
    setAsking(true);
    const now = await (persistence.askAgain ?? persistence.persist)();
    setKept(now);
    setAsking(false);
    if (!now) notifications.push(t("settings.persist.refused"));
  };
  return (
    <SettingRow id="storage.persist" name={t("settings.persist.notKept")}>
      <Button disabled={asking} onClick={() => void ask()}>
        {t("settings.persist.ask")}
      </Button>
    </SettingRow>
  );
}

function KeysRow() {
  const { ai, dialogs } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const removeAll = async () => {
    const sure = await dialogs.confirm({
      title: t("ai.removeAllKeys"),
      message: t("ai.removeAllKeysConfirm"),
      confirm: t("ai.removeAllKeys"),
      danger: true,
    });
    if (sure) await ai.removeAllKeys();
  };
  // None kept: nothing to say, nothing to take away.
  if (snapshot.keyed.size === 0) return null;
  return (
    <SettingRow
      id="storage.keys"
      name={
        <span data-testid="ai-keys-where" data-where={snapshot.keysWhere}>
          {t("settings.keys.line", { count: snapshot.keyed.size })}
        </span>
      }
      below={
        snapshot.keysWhere === undefined && (
          <span className={styles.status}>{t("ai.keysNowhere")}</span>
        )
      }
    >
      <Button danger disabled={snapshot.keyed.size === 0} onClick={() => void removeAll()}>
        {t("settings.keys.removeAll")}
      </Button>
    </SettingRow>
  );
}

function ChatsRow() {
  const workbench = useWorkbench();
  const { dialogs, notifications } = workbench;
  const { t } = useTranslation();
  const [usage, setUsage] = useState<ChatsUsage | "failed">();
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => {
    usageOfChats(workbench).then(setUsage, (error: unknown) => {
      console.warn("How much the conversations take could not be read", error);
      setUsage("failed");
    });
  }, [workbench]);
  useEffect(read, [read]);

  const clear = async () => {
    if (usage === undefined || usage === "failed") return;
    const sure = await dialogs.confirm({
      title: t("settings.chats.clearTitle"),
      message: t("settings.chats.clearMessage", {
        count: usage.local.count,
        projects: usage.local.projects,
      }),
      confirm: t("settings.chats.clear"),
      danger: true,
    });
    if (!sure) return;
    setBusy(true);
    try {
      const { cleared, kept } = await clearLocalChats(workbench);
      notifications.push(
        kept > 0
          ? t("settings.chats.clearedButRunning", { count: cleared })
          : t("settings.chats.cleared", { count: cleared }),
      );
    } catch (error) {
      console.warn("The conversations could not be cleared", error);
      notifications.push(t("settings.chats.clearFailed"));
    } finally {
      setBusy(false);
      read();
    }
  };

  // None here, or not read yet: nothing to say.
  if (
    usage === undefined ||
    (usage !== "failed" && usage.all.count === 0 && usage.images.count === 0)
  )
    return null;
  return (
    <SettingRow
      id="storage.chats"
      name={
        <span data-testid="settings-chats">
          {usage === "failed"
            ? t("settings.chats.failed")
            : t("settings.chats.line", {
                size: formatBytes(t, usage.all.bytes + usage.images.bytes),
              })}
        </span>
      }
    >
      <Button
        danger
        disabled={busy || usage === "failed" || usage.local.count === 0}
        onClick={() => void clear()}
      >
        {t("settings.chats.clear")}
      </Button>
    </SettingRow>
  );
}

/** The undo logs of AI tasks and batches that last across reloads, see `UndoKeeper`. */
function UndoRow() {
  const workbench = useWorkbench();
  const { dialogs, notifications } = workbench;
  const { t } = useTranslation();
  const [usage, setUsage] = useState<UndoUsage | "failed">();
  const [busy, setBusy] = useState(false);
  const read = useCallback(() => {
    workbench.undo.usage().then(setUsage, (error: unknown) => {
      console.warn("How much the undo logs take could not be read", error);
      setUsage("failed");
    });
  }, [workbench]);
  useEffect(read, [read]);

  const clear = async () => {
    const sure = await dialogs.confirm({
      title: t("settings.undo.clearTitle"),
      message: t("settings.undo.clearMessage"),
      confirm: t("settings.undo.clear"),
      danger: true,
    });
    if (!sure) return;
    setBusy(true);
    try {
      await workbench.undo.clear();
      notifications.push(t("settings.undo.cleared"));
    } catch (error) {
      console.warn("The undo logs could not be cleared", error);
      notifications.push(t("settings.undo.clearFailed"));
    } finally {
      setBusy(false);
      read();
    }
  };

  // None kept, or not read yet: nothing to say.
  if (usage === undefined || (usage !== "failed" && usage.projects === 0)) return null;
  return (
    <SettingRow
      id="storage.undo"
      name={
        <span data-testid="settings-undo">
          {usage === "failed"
            ? t("settings.undo.failed")
            : t("settings.undo.line", {
                projects: usage.projects,
                size: formatBytes(t, usage.bytes),
              })}
        </span>
      }
    >
      <Button danger disabled={busy || usage === "failed"} onClick={() => void clear()}>
        {t("settings.undo.clear")}
      </Button>
    </SettingRow>
  );
}

function UsageRow() {
  const { palette, resourceHabits, notifications } = useWorkbench();
  const { t } = useTranslation();
  return (
    <SettingRow id="storage.usage">
      <Button
        onClick={() => {
          palette.clearRecent();
          resourceHabits.clearRecent();
          notifications.push(t("settings.usage.cleared"));
        }}
      >
        {t("settings.usage.clear")}
      </Button>
    </SettingRow>
  );
}

// ---- 关于

function Link({ href, children }: { readonly href: string; readonly children: string }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noreferrer noopener">
      {children} <ExternalLink size={11} aria-hidden />
    </a>
  );
}

export function AboutGroup() {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  return (
    <GroupPage title={t("settings.groups.about")}>
      <SettingRow id="about.version">
        <span className={styles.value} data-testid="settings-version">
          {workbench.version}
        </span>
        <Link href={`${REPOSITORY}/releases`}>{t("settings.about.changelog")}</Link>
      </SettingRow>
      <SettingRow id="about.license">
        <Link href={`${REPOSITORY}/blob/main/LICENSE`}>AGPL-3.0</Link>
        <Link href={`${REPOSITORY}/blob/main/LICENSES/pi-web.txt`}>pi-web (MIT)</Link>
      </SettingRow>
      <SettingRow id="about.feedback">
        <Link href={`${REPOSITORY}/issues`}>{t("settings.about.issues")}</Link>
      </SettingRow>
      <SettingRow
        id="about.performance"
        below={
          !store && <span className={styles.note}>{t("settings.about.performanceClosed")}</span>
        }
      >
        <Button
          disabled={!store}
          onClick={() => {
            workbench.settingsNav.close();
            workbench.layout.openPanel("performance");
          }}
        >
          {t("settings.about.performanceOpen")}
        </Button>
      </SettingRow>
    </GroupPage>
  );
}
