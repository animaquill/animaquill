import type { ChatEntry } from "@animaquill/agent";
import { MoreHorizontal, SquarePen } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
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
  const [renaming, setRenaming] = useState(false);
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
      <Tip
        name={running ? t("chat.switcher.newWhenDone") : newName}
        usage=""
        shortcut={keys === undefined ? undefined : formatCombo(keys, keybindings.platform)}
      >
        <button
          type="button"
          className={styles.iconButton}
          aria-label={newName}
          data-testid="chat-new"
          disabled={running}
          onClick={props.onNew}
        >
          <SquarePen size={14} aria-hidden />
        </button>
      </Tip>
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
    } = {},
  ) => (
    <button
      type="button"
      role="menuitem"
      className={options.sub ? styles.menuSub : undefined}
      data-danger={options.danger || undefined}
      data-testid={key}
      disabled={options.disabled}
      onClick={() => {
        menu.chosen();
        action();
      }}
    >
      {label}
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
            disabled: !saved || props.running,
            danger: true,
          })}
        </div>
      )}
    </div>
  );
}
