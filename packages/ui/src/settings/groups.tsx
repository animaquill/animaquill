import type { AccountSpace } from "@animaquill/host";
import { TOOL_CALL_LIMITS } from "@animaquill/agent";
import type { VideoCodecName } from "@animaquill/media";
import type { TFunction } from "i18next";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLayout, useSession, useWorkbench } from "../app/context.ts";
import { GitHubRow, useAccount } from "../cloud/CloudParts.tsx";
import type { Quality } from "../export/codecs.ts";
import { DEFAULT_LIST_WIDTH } from "../keyframes/editor.ts";
import { QUALITY_CHOICES, type QualityChoice } from "../preview/quality.ts";
import { DEFAULT_HEADER_WIDTH } from "../timeline/editor.ts";
import type { InputChoice } from "../workbench/input-mode.ts";
import type { SettingsGroup } from "../workbench/settings-nav.ts";
import type { SettingId } from "./registry.ts";

import {
  Button,
  Choice,
  GroupPage,
  RowsHeading,
  Segmented,
  SettingRow,
  Toggle,
  useGroups,
  type Option,
} from "./parts.tsx";
import { usageOfChats, clearLocalChats, type ChatsUsage } from "./storage.ts";
import cloudStyles from "../cloud/CloudSync.module.css";
import styles from "./Settings.module.css";

/** Where the code of the editor is, with its licence and its issues. */
export const REPOSITORY = "https://github.com/animaquill/animaquill";

// ---- 常规

const INPUT_CHOICES: readonly InputChoice[] = ["auto", "mouse", "trackpad", "touch"];

export function GeneralGroup() {
  const { input } = useWorkbench();
  const { t } = useTranslation();
  const { choice } = useSyncExternalStore(input.subscribe, input.getSnapshot);
  const later = (value: string, label: string): Option<string> => ({ value, label, later: true });
  return (
    <GroupPage title={t("settings.groups.general")}>
      <SettingRow
        id="general.language"
        below={<span className={styles.note}>{t("settings.moreLanguages")}</span>}
      >
        <Choice
          label={t("settings.items.general.language.name")}
          value="zh-CN"
          options={[{ value: "zh-CN", label: "简体中文" }]}
          onChange={() => {}}
        />
      </SettingRow>
      <SettingRow id="general.theme">
        <Segmented
          label={t("settings.items.general.theme.name")}
          value="dark"
          options={[
            { value: "dark", label: t("settings.theme.dark") },
            later("light", t("settings.theme.light")),
            later("system", t("settings.theme.system")),
          ]}
          onChange={() => {}}
        />
      </SettingRow>
      <SettingRow id="general.fontSize">
        <Segmented
          label={t("settings.items.general.fontSize.name")}
          value="standard"
          options={[
            later("small", t("settings.fontSize.small")),
            { value: "standard", label: t("settings.fontSize.standard") },
            later("large", t("settings.fontSize.large")),
          ]}
          onChange={() => {}}
        />
      </SettingRow>
      <SettingRow id="general.input">
        <Choice
          label={t("settings.items.general.input.name")}
          value={choice}
          options={INPUT_CHOICES.map((value) => ({ value, label: t(`input.${value}`) }))}
          onChange={(value) => input.choose(value)}
        />
      </SettingRow>
      <LayoutRow />
      <SeeAlso />
    </GroupPage>
  );
}

/** Where what people may look for here is instead, a link each, to go there and see it. */
function SeeAlso() {
  const { settingsNav } = useWorkbench();
  const { t } = useTranslation();
  const groups = useGroups();
  const link = (group: SettingsGroup, item: SettingId, words: string) => (
    <button
      type="button"
      className={styles.link}
      onClick={() => settingsNav.go({ group, depth: 1, item })}
    >
      {words}
    </button>
  );
  return (
    <>
      <RowsHeading>{t("settings.seeAlso")}</RowsHeading>
      {groups.includes("cloud") && (
        <p className={styles.note} data-testid="settings-see-cloud">
          {t("settings.seeAlsoLinks.cloud")}{" "}
          {link("cloud", "cloud.newProjectsInCloud", t("settings.seeAlsoLinks.cloudGroup"))}
          {t("settings.seeAlsoLinks.tail")}
        </p>
      )}
      <p className={styles.note} data-testid="settings-see-editing">
        {t("settings.seeAlsoLinks.editing")}{" "}
        {link("editing", "editing.snapping", t("settings.seeAlsoLinks.editingGroup"))}
        {t("settings.seeAlsoLinks.tail")}
      </p>
    </>
  );
}

/**
 * The layouts: which one this window shows, and managing them: renaming and deleting people's own,
 * and putting the one shown back as it was, with the sizes dragged in the timeline and keyframes.
 */
function LayoutRow() {
  const workbench = useWorkbench();
  const { layout, dialogs, timeline, keyframes } = workbench;
  const { t } = useTranslation();
  const { layout: current, layouts } = useLayout();
  const [managing, setManaging] = useState(false);
  const own = layouts.filter((choice) => choice.custom);

  const rename = async (id: string, name: string) => {
    const next = await dialogs.prompt({
      title: t("layout.renameTitle"),
      value: name,
      confirm: t("layout.renameConfirm"),
    });
    if (next !== undefined) layout.rename(id, next);
  };
  const remove = async (id: string, name: string) => {
    const first = layouts[0]?.title(t) ?? "";
    const sure = await dialogs.confirm({
      title: t("layout.deleteTitle", { name }),
      message: t("layout.deleteMessage", { first }),
      confirm: t("layout.deleteConfirm"),
      danger: true,
    });
    if (sure) layout.remove(id);
  };
  const reset = async () => {
    const name = layouts.find((choice) => choice.id === current)?.title(t) ?? "";
    const sure = await dialogs.confirm({
      title: t("settings.layout.resetTitle", { name }),
      message: t("settings.layout.resetMessage"),
      confirm: t("settings.layout.reset"),
    });
    if (!sure) return;
    layout.resetLayout();
    timeline.setHeaderWidth(DEFAULT_HEADER_WIDTH);
    timeline.saveHeaderWidth();
    keyframes.setListWidth(DEFAULT_LIST_WIDTH);
    keyframes.saveListWidth();
  };

  return (
    <SettingRow
      id="general.layout"
      below={
        managing && (
          <div className={styles.manage} data-testid="settings-layouts">
            {own.length === 0 && (
              <span className={styles.note}>{t("settings.layout.noneOwn")}</span>
            )}
            {own.map((choice) => {
              const name = choice.title(t);
              return (
                <div key={choice.id} className={styles.manageRow} data-layout={choice.id}>
                  <span className={styles.manageName}>{name}</span>
                  <Button onClick={() => void rename(choice.id, name)}>
                    {t("settings.layout.rename")}
                  </Button>
                  <Button danger onClick={() => void remove(choice.id, name)}>
                    {t("settings.layout.delete")}
                  </Button>
                </div>
              );
            })}
            <div className={styles.manageRow}>
              <span className={styles.manageName}>{t("settings.layout.resetHelp")}</span>
              <Button onClick={() => void reset()}>{t("settings.layout.reset")}</Button>
            </div>
          </div>
        )
      }
    >
      <Choice
        label={t("settings.items.general.layout.name")}
        value={current}
        options={layouts.map((choice) => ({ value: choice.id, label: choice.title(t) }))}
        onChange={(id) => layout.switchLayout(id)}
      />
      <Button onClick={() => setManaging(!managing)}>
        {t(managing ? "settings.layout.done" : "settings.layout.manage")}
      </Button>
    </SettingRow>
  );
}

// ---- 编辑

export function EditingGroup() {
  const { trials, timeline } = useWorkbench();
  const { t } = useTranslation();
  const { enabled, count } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  const { snapping, overwriting, multiSelecting } = useSyncExternalStore(
    timeline.subscribe,
    timeline.getSnapshot,
  );
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
      <RowsHeading>{t("settings.timeline")}</RowsHeading>
      <SettingRow id="editing.snapping">
        <Toggle
          label={t("settings.items.editing.snapping.name")}
          checked={snapping}
          onChange={(on) => on !== snapping && timeline.toggleSnapping()}
        />
      </SettingRow>
      <SettingRow id="editing.overwriting">
        <Toggle
          label={t("settings.items.editing.overwriting.name")}
          checked={overwriting}
          onChange={(on) => on !== overwriting && timeline.toggleOverwriting()}
        />
      </SettingRow>
      <SettingRow id="editing.multiSelecting">
        <Toggle
          label={t("settings.items.editing.multiSelecting.name")}
          checked={multiSelecting}
          onChange={(on) => on !== multiSelecting && timeline.toggleMultiSelecting()}
        />
      </SettingRow>
      <SettingRow id="editing.timecode">
        <span className={styles.value}>{t("settings.timecodeValue")}</span>
      </SettingRow>
    </GroupPage>
  );
}

// ---- 预览和播放

export function PlaybackGroup() {
  const { previewQuality, proxyOffer } = useWorkbench();
  const { t } = useTranslation();
  const { choice } = useSyncExternalStore(previewQuality.subscribe, previewQuality.getSnapshot);
  const offer = useSyncExternalStore(proxyOffer.subscribe, proxyOffer.getSnapshot);
  return (
    <GroupPage title={t("settings.groups.playback")}>
      <SettingRow
        id="playback.quality"
        below={<span className={styles.note}>{t(`preview.quality.about.${choice}`)}</span>}
      >
        <Choice<QualityChoice>
          label={t("settings.items.playback.quality.name")}
          value={choice}
          options={QUALITY_CHOICES.map((value) => ({
            value,
            label: t(`preview.quality.${value}`),
          }))}
          onChange={(value) => previewQuality.choose(value)}
        />
      </SettingRow>
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

const QUALITIES: readonly Quality[] = ["small", "standard", "high"];

export function ExportGroup() {
  const { videos } = useWorkbench();
  const { t } = useTranslation();
  const [quality, setQuality] = useState<Quality>();
  const [failed, setFailed] = useState<ReadonlyMap<VideoCodecName, number>>();
  const read = useCallback(() => {
    void videos.defaultQuality().then(setQuality);
    void videos.hardwareFailed().then(setFailed);
  }, [videos]);
  useEffect(read, [read]);

  const failures = failed ? [...failed.keys()] : [];
  return (
    <GroupPage title={t("settings.groups.export")}>
      <SettingRow id="export.quality">
        {quality && (
          <Segmented<Quality>
            label={t("settings.items.export.quality.name")}
            value={quality}
            options={QUALITIES.map((value) => ({
              value,
              label: t(`export.video.qualities.${value}`),
            }))}
            onChange={(value) => {
              setQuality(value);
              void videos.setDefaultQuality(value);
            }}
          />
        )}
      </SettingRow>
      <SettingRow
        id="export.hardware"
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
        <Button
          disabled={failures.length === 0}
          onClick={() => void videos.retryHardware().then(read)}
        >
          {t("settings.hardware.retry")}
        </Button>
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
          <ul>
            <li>{t("settings.account.why.cloud")}</li>
            <li>{t("settings.account.why.sync")}</li>
            <li>{t("settings.account.why.ai")}</li>
          </ul>
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
        help={t("settings.account.via")}
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
      <UsageRow />
    </GroupPage>
  );
}

function PersistRow() {
  const { persistence, notifications } = useWorkbench();
  const { t } = useTranslation();
  const [kept, setKept] = useState<boolean>();
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    void persistence?.persisted().then(setKept);
  }, [persistence]);
  if (!persistence) return null;
  const ask = async () => {
    setAsking(true);
    const now = await (persistence.askAgain ?? persistence.persist)();
    setKept(now);
    setAsking(false);
    if (!now) notifications.push(t("settings.persist.refused"));
  };
  return (
    <SettingRow
      id="storage.persist"
      below={
        kept !== undefined && (
          <span
            className={styles.status}
            data-testid="settings-persist"
            data-state={kept ? "kept" : "notKept"}
          >
            {t(kept ? "settings.persist.kept" : "settings.persist.notKept")}
            {!kept && persistence.clearsWhenIdle && ` ${t("settings.persist.idle")}`}
          </span>
        )
      }
    >
      {kept === false && (
        <Button disabled={asking} onClick={() => void ask()}>
          {t("settings.persist.ask")}
        </Button>
      )}
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
  return (
    <SettingRow
      id="storage.keys"
      below={
        <span
          className={styles.status}
          data-testid="ai-keys-where"
          title={snapshot.keysWhere}
          data-where={snapshot.keysWhere}
        >
          {snapshot.keysWhere === undefined
            ? t("ai.keysNowhere")
            : snapshot.keyed.size === 0
              ? t("settings.keys.none")
              : t("settings.keys.count", { count: snapshot.keyed.size })}
        </span>
      }
    >
      <Button danger disabled={snapshot.keyed.size === 0} onClick={() => void removeAll()}>
        {t("ai.removeAllKeys")}
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

  return (
    <SettingRow
      id="storage.chats"
      below={
        <span className={styles.status} data-testid="settings-chats">
          {usage === undefined
            ? t("settings.space.reading")
            : usage === "failed"
              ? t("settings.chats.failed")
              : t("settings.chats.usage", {
                  count: usage.all.count,
                  size: formatBytes(t, usage.all.bytes),
                  local: usage.local.count,
                }) +
                (usage.images.count > 0
                  ? t("settings.chats.images", {
                      count: usage.images.count,
                      size: formatBytes(t, usage.images.bytes),
                    })
                  : "")}
        </span>
      }
    >
      <Button
        danger
        disabled={busy || usage === undefined || usage === "failed" || usage.local.count === 0}
        onClick={() => void clear()}
      >
        {t("settings.chats.clear")}
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
      <SettingRow id="about.errors" />
    </GroupPage>
  );
}
