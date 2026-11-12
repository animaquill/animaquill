import type { SavedChatSummary } from "@animaquill/host";
import { Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { agoText } from "../app/start-view.ts";
import styles from "./ChatPanel.module.css";
import { useNow } from "./clock.ts";
import { byDay, type Found } from "./conversations.ts";

/**
 * What the list calls a conversation: the name people gave it, or the one the model wrote; one that
 * was copied from another and has no name of its own says where from; else its first words.
 */
export function titleOf(
  t: TFunction,
  chat: Pick<SavedChatSummary, "title" | "titleBy" | "forkedFrom">,
): string {
  if (chat.titleBy === undefined && chat.forkedFrom) {
    return t("chat.list.forked", { ...chat.forkedFrom });
  }
  return chat.title || t("chat.untitled");
}

/** How long typing rests before the conversations are searched. */
const SEARCH_DELAY_MS = 150;

/**
 * The conversations of the project, over the conversation open (a narrow column has no room for a
 * list beside it): a search, a new conversation, and the conversations by day, each with when it
 * changed and how much AI changed, a spinner for the one that runs and a dot for one that waits
 * for an answer. Renaming and deleting are in the row; deleting asks there first.
 */
export function ConversationList(props: {
  /** It opens with the name of the conversation open to change. */
  readonly rename?: boolean;
  readonly onClose: () => void;
  /** A conversation opened from a search: the turn the words are in. */
  readonly onFound: (task: string | undefined) => void;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const running = snapshot.conversation?.running === true;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<readonly Found[] | undefined>();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>(() => {
    const open = snapshot.saved.find((each) => each.id === snapshot.id);
    return props.rename && open ? { id: open.id, title: open.title } : undefined;
  });
  const [removing, setRemoving] = useState<string | undefined>();
  // When conversations changed, said again each minute.
  const now = useNow(true, 60_000);

  useEffect(() => {
    if (!query.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      void chat.search(query).then((hits) => {
        if (current) setFound(hits);
      });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [chat, query]);

  const open = async (id: string, task?: string) => {
    if (id !== snapshot.id) await chat.open(id);
    props.onClose();
    props.onFound(task);
  };
  // Esc closes it wherever the focus is, such as after the row that had it went away.
  const busy = renaming !== undefined || removing !== undefined;
  const { onClose } = props;
  useEffect(() => {
    if (busy) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy, onClose]);

  const row = (chat_: SavedChatSummary) => {
    const id = chat_.id;
    const current = id === snapshot.id;
    if (renaming?.id === id) {
      const done = () => {
        void chat.rename(id, renaming.title);
        setRenaming(undefined);
      };
      return (
        <form
          key={id}
          className={styles.conv}
          data-testid="chat-conversation"
          onSubmit={(event) => {
            event.preventDefault();
            done();
          }}
        >
          <input
            autoFocus
            className={styles.convRename}
            aria-label={t("chat.list.renameLabel")}
            value={renaming.title}
            onChange={(event) => setRenaming({ id, title: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setRenaming(undefined);
              }
            }}
          />
          <button type="submit" className={styles.primary} disabled={!renaming.title.trim()}>
            {t("chat.list.ok")}
          </button>
        </form>
      );
    }
    if (removing === id) {
      return (
        <div key={id} className={styles.conv} data-testid="chat-conversation" data-removing="">
          <div className={styles.convInfo}>
            <div className={styles.convTitle}>{t("chat.list.removeConfirm")}</div>
            <div className={styles.convMeta}>{t("chat.list.removeNote")}</div>
          </div>
          <button type="button" onClick={() => setRemoving(undefined)}>
            {t("chat.list.cancel")}
          </button>
          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              setRemoving(undefined);
              void chat.remove(id);
            }}
          >
            {t("chat.list.remove")}
          </button>
        </div>
      );
    }
    const meta = [
      agoText(chat_.updatedAt, now, t),
      ...(chat_.asking
        ? [t("chat.list.asking")]
        : chat_.changes
          ? [t("chat.list.changes", { count: chat_.changes })]
          : []),
    ].join(" · ");
    return (
      <div
        key={id}
        className={styles.conv}
        data-testid="chat-conversation"
        data-current={current ? "" : undefined}
      >
        <button
          type="button"
          className={styles.convOpen}
          aria-current={current}
          disabled={running && !current}
          onClick={() => void open(id)}
        >
          <span className={styles.convInfo}>
            <span className={styles.convTitle}>{titleOf(t, chat_)}</span>
            <span className={styles.convMeta}>{meta}</span>
          </span>
          {current && running ? (
            <Loader2 size={12} className={styles.spin} aria-label={t("chat.running")} role="img" />
          ) : (
            chat_.asking && (
              <span
                className={styles.askDot}
                role="img"
                aria-label={t("chat.list.asking")}
                data-testid="chat-conversation-asking"
              />
            )
          )}
        </button>
        <span className={styles.convActions}>
          <button
            type="button"
            className={styles.icon}
            aria-label={t("chat.list.rename", { title: chat_.title })}
            title={t("chat.list.renameLabel")}
            onClick={() => setRenaming({ id, title: chat_.title })}
          >
            <Pencil size={12} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.icon}
            aria-label={t("chat.list.removeLabel", { title: chat_.title })}
            title={t("chat.list.remove")}
            disabled={current && running}
            onClick={() => setRemoving(id)}
          >
            <Trash2 size={12} aria-hidden />
          </button>
        </span>
      </div>
    );
  };

  return (
    <div
      className={styles.sheet}
      role="dialog"
      aria-label={t("chat.list.title")}
      data-testid="chat-list"
    >
      <div className={styles.sheetHead}>
        <label className={styles.sheetSearch}>
          <Search size={12} aria-hidden />
          <input
            autoFocus
            value={query}
            placeholder={t("chat.list.search")}
            aria-label={t("chat.list.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={styles.primary}
          disabled={running}
          onClick={() => {
            chat.newConversation();
            props.onClose();
          }}
        >
          <Plus size={12} aria-hidden /> {t("chat.newConversation")}
        </button>
      </div>
      <div className={styles.sheetBody}>
        {query.trim() && found !== undefined ? (
          found.length === 0 ? (
            <p className={styles.sheetNone}>{t("chat.list.noHits", { query: query.trim() })}</p>
          ) : (
            found.map((hit, index) => (
              <button
                key={`${hit.id}/${index}`}
                type="button"
                className={styles.hit}
                data-testid="chat-search-hit"
                disabled={running && hit.id !== snapshot.id}
                onClick={() => void open(hit.id, hit.task)}
              >
                <span className={styles.convTitle}>
                  {titleOf(t, snapshot.saved.find((each) => each.id === hit.id) ?? hit)}
                </span>
                <span className={styles.convMeta}>
                  {hit.before}
                  <mark>{hit.match}</mark>
                  {hit.after}
                </span>
              </button>
            ))
          )
        ) : snapshot.saved.length === 0 ? (
          <p className={styles.sheetNone}>{t("chat.list.none")}</p>
        ) : (
          byDay(snapshot.saved, now).map(({ day, chats }) => (
            <div key={day} role="group" aria-label={t(`chat.list.${day}`)}>
              <div className={styles.sheetGroup}>{t(`chat.list.${day}`)}</div>
              {chats.map(row)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
