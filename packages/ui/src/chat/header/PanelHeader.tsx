import type { ChatEntry } from "@animaquill/agent";
import { MoreHorizontal, SquarePen } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { Tip } from "../../app/Tip.tsx";
import { formatCombo } from "../../workbench/keys.ts";
import { markdownOf } from "../export.ts";
import { useBoxMenu } from "../input/menu.ts";
import { ContextPie, ConversationInfo } from "../model/ConversationInfo.tsx";
import styles from "./header.module.css";
import { TitleSwitcher } from "./TitleSwitcher.tsx";

/**
 * The head of the chat (docs/design/chat-panel.md of AnimaQuill Cloud, 2.1): the title, which opens
 * the conversations and changes its name on a double click; the pie of the context, which opens
 * what the conversation took; a new conversation (Ctrl+Alt+N); and "⋯": renaming, exporting,
 * what the conversation took, deleting it.
 */
export function PanelHeader(props: {
  readonly title: string;
  readonly entries: readonly ChatEntry[];
  readonly onFound: (task: string | undefined, query?: string) => void;
  readonly onAll: () => void;
  readonly onNew: () => void;
}) {
  const workbench = useWorkbench();
  const { chat, keybindings } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  useSyncExternalStore(keybindings.subscribe, keybindings.getSnapshot);
  const running = snapshot.conversation?.running === true;
  // The conversation whose name is being changed: another one opened meanwhile has none.
  const [renamingId, setRenamingId] = useState<string>();
  const renaming = renamingId !== undefined && renamingId === snapshot.id;
  const setRenaming = (on: boolean) => setRenamingId(on ? snapshot.id : undefined);
  // A new conversation asked for while a task runs: why nothing happens, at ✎, for a moment.
  const refused = useRefused(snapshot.refusedNew);
  const [infoOpen, setInfoOpen] = useState(false);
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const closeInfo = useCallback(
    (back: boolean) => {
      setInfoOpen(false);
      // With Esc, back to what opened it: the pie, else "⋯".
      if (!back) return;
      (
        head?.querySelector<HTMLElement>('[data-testid="chat-context"]') ??
        head?.querySelector<HTMLElement>('[data-testid="chat-more"]')
      )?.focus();
    },
    [head],
  );
  const keys = keybindings.keysFor("chat.newConversation")[0];
  const newName = t("chat.newConversation");
  return (
    <div className={styles.head} ref={setHead}>
      <TitleSwitcher
        title={props.title}
        renaming={renaming}
        onRenaming={setRenaming}
        onFound={props.onFound}
        onAll={props.onAll}
      />
      <span className={styles.grow} />
      <ContextPie entries={props.entries} open={infoOpen} onOpen={() => setInfoOpen(!infoOpen)} />
      <span className={styles.newWrap}>
        <Tip
          name={running ? t("chat.switcher.newWhenDone") : newName}
          usage=""
          shortcut={keys === undefined ? undefined : formatCombo(keys, keybindings.platform)}
        >
          <button
            type="button"
            className={styles.iconButton}
            aria-label={newName}
            // Still to be reached while a task runs: it says why it waits.
            aria-disabled={running || undefined}
            data-testid="chat-new"
            onClick={() => (running ? chat.newConversation() : props.onNew())}
          >
            <SquarePen size={14} aria-hidden />
          </button>
        </Tip>
        {refused && (
          <span className={styles.note} role="status" data-testid="chat-new-why">
            {t("chat.switcher.newWhenDone")}
          </span>
        )}
      </span>
      <MoreMenu
        title={props.title}
        entries={props.entries}
        running={running}
        onRename={() => setRenaming(true)}
        onInfo={() => setInfoOpen(true)}
      />
      {infoOpen && (
        <ConversationInfo
          entries={props.entries}
          onCompact={snapshot.conversation?.compactable ? () => void chat.compact() : undefined}
          onClose={closeInfo}
        />
      )}
    </div>
  );
}

/**
 * "⋯" of the head: renaming (in place, in the title), exporting as Markdown (copied, or as a
 * file: both in the menu itself, never in a menu beside it), what the conversation took, and,
 * apart and in red, deleting it.
 */
function MoreMenu(props: {
  readonly title: string;
  readonly entries: readonly ChatEntry[];
  readonly running: boolean;
  readonly onRename: () => void;
  readonly onInfo: () => void;
}) {
  const { chat, dialogs, notifications } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const { wrapRef, buttonRef, ...menu } = useBoxMenu();
  const id = snapshot.id;
  const saved = snapshot.saved.some((each) => each.id === id);
  const empty = props.entries.length === 0;
  const item = (
    key: string,
    label: string,
    action: () => void,
    options: {
      readonly disabled?: boolean;
      readonly danger?: boolean;
      readonly sub?: boolean;
      /** Why it waits, under it: still to be reached, it does nothing meanwhile. */
      readonly waits?: string | undefined;
    } = {},
  ) => (
    <button
      type="button"
      role="menuitem"
      className={options.sub ? styles.menuSub : undefined}
      data-danger={options.danger || undefined}
      data-testid={key}
      disabled={options.disabled}
      aria-disabled={options.waits !== undefined || undefined}
      onClick={() => {
        if (options.waits !== undefined) return;
        menu.chosen();
        action();
      }}
    >
      <span>{label}</span>
      {options.waits && <span className={styles.menuWhy}>{options.waits}</span>}
    </button>
  );
  const remove = async () => {
    if (id === undefined) return;
    const sure = await dialogs.confirm({
      title: t("chat.list.removeConfirm"),
      message: t("chat.list.removeNote"),
      confirm: t("chat.list.remove"),
      danger: true,
    });
    if (sure) await chat.remove(id);
  };
  const copy = () => {
    const text = markdownOf(t, props.title, props.entries);
    void navigator.clipboard?.writeText(text).then(
      () => notifications.push(t("chat.more.copied")),
      () => notifications.push(t("chat.more.copyFailed")),
    );
  };
  const download = () => {
    const text = markdownOf(t, props.title, props.entries);
    const name = `${props.title.replace(/[\\/:*?"<>|\n]+/g, " ").trim() || "chat"}.md`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <div ref={wrapRef}>
      <Tip name={t("chat.more.title")} usage="">
        <button
          type="button"
          ref={buttonRef}
          className={styles.iconButton}
          aria-label={t("chat.more.title")}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          data-testid="chat-more"
          onClick={menu.onButtonClick}
          onKeyDown={menu.onButtonKeyDown}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </Tip>
      {menu.open && (
        <div
          className={`${styles.popover} ${styles.menu}`}
          role="menu"
          aria-label={t("chat.more.title")}
          onKeyDown={menu.onMenuKeyDown}
        >
          {item("chat-more-rename", t("chat.more.rename"), props.onRename, { disabled: !saved })}
          <div className={styles.menuLabel} aria-hidden>
            {t("chat.more.export")}
          </div>
          <div className={styles.menuGroup} role="group" aria-label={t("chat.more.export")}>
            {item("chat-more-copy", t("chat.more.copy"), copy, { disabled: empty, sub: true })}
            {item("chat-more-download", t("chat.more.download"), download, {
              disabled: empty,
              sub: true,
            })}
          </div>
          {item("chat-more-info", t("chat.info.title"), props.onInfo)}
          <div className={styles.menuLine} role="separator" />
          {item("chat-more-remove", t("chat.more.remove"), () => void remove(), {
            disabled: !saved,
            waits: props.running ? t("chat.switcher.removeWhenDone") : undefined,
            danger: true,
          })}
        </div>
      )}
    </div>
  );
}

/** How long the word of why nothing happened stays. */
const REFUSED_MS = 2500;

/** Whether something people asked for just now was refused, as of `at`, for a moment. */
function useRefused(at: number | undefined): boolean {
  const [shown, setShown] = useState<number>();
  useEffect(() => {
    if (at === undefined) return;
    const show = setTimeout(() => setShown(at), 0);
    const hide = setTimeout(() => setShown((was) => (was === at ? undefined : was)), REFUSED_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [at]);
  return shown !== undefined && shown === at;
}
