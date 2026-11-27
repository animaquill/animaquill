import type { SavedChatSummary } from "@animaquill/host";
import { ArrowLeft, CloudOff, LoaderCircle, Pencil, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { Tip } from "../../app/Tip.tsx";
import { agoText } from "../../app/start-view.ts";
import { useNow } from "../clock.ts";
import { byDay } from "../conversations.ts";
import styles from "./header.module.css";
import { useFound } from "./search.ts";
import { titleOf } from "./title.ts";

/**
 * All conversations of the project, as a page over the conversation and its box, which stay as
 * they were (docs/design/chat-panel.md of AnimaQuill Cloud, 2.2): "← 返回" and a search of what was
 * said in them on top; today, yesterday, this week, earlier; each with when it changed, how much AI
 * changed and the model it had, a spinner for the one that runs, a dot for one that waits for
 * people, a cloud struck out for one not on the server yet. Renaming and deleting are in the row,
 * deleting asked there first. Esc goes back.
 */
export function AllConversations(props: {
  readonly onClose: () => void;
  /** A conversation opened from a search: the turn the words are in. */
  readonly onFound: (task: string | undefined, query?: string) => void;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const running = snapshot.conversation?.running === true;
  const [query, setQuery] = useState("");
  const found = useFound(query);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly title: string }>();
  const [removing, setRemoving] = useState<string>();
  const now = useNow(true, 60_000);
  const busy = renaming !== undefined || removing !== undefined;
  // Where the focus goes once a row is drawn again: after not deleting, or deleting.
  const [focus, setFocus] = useState<
    { readonly id: string; readonly on: "open" | "remove" } | { readonly on: "search" }
  >();
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    const root = page.current;
    const target =
      focus.on === "search"
        ? root?.querySelector<HTMLElement>('[data-testid="chat-all-search"]')
        : root?.querySelector<HTMLElement>(
            `[data-id="${CSS.escape(focus.id)}"] [data-role="${focus.on}"]`,
          );
    if (!target) return;
    target.focus();
    const done = setTimeout(() => setFocus(undefined), 0);
    return () => clearTimeout(done);
  });
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

  const open = async (id: string, task?: string) => {
    if (running && id !== snapshot.id) return;
    if (id !== snapshot.id) await chat.open(id);
    props.onClose();
    props.onFound(task, query.trim() || undefined);
  };

  const row = (chat_: SavedChatSummary) => {
    const id = chat_.id;
    const current = id === snapshot.id;
    const title = titleOf(t, chat_);
    if (renaming?.id === id) {
      const done = (keep: boolean) => {
        if (keep && renaming.title.trim()) void chat.rename(id, renaming.title);
        setRenaming(undefined);
      };
      return (
        <form
          key={id}
          className={styles.renameRow}
          data-testid="chat-conversation"
          onSubmit={(event) => {
            event.preventDefault();
            done(true);
          }}
        >
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- people asked to change it just now
            autoFocus
            className={styles.renameInput}
            aria-label={t("chat.list.renameLabel")}
            value={renaming.title}
            onChange={(event) => setRenaming({ id, title: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                done(false);
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
      const cancel = () => {
        setRemoving(undefined);
        setFocus({ id, on: "remove" });
      };
      return (
        <div
          key={id}
          className={styles.confirm}
          data-testid="chat-conversation"
          data-removing=""
          data-id={id}
          role="group"
          aria-label={t("chat.list.removeConfirm")}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }}
        >
          <p className={styles.confirmText}>
            <strong>{t("chat.list.removeConfirm")}</strong>
            <span>{t("chat.list.removeNote")}</span>
          </p>
          {/* Not deleting is where the focus starts: Enter there takes nothing away. */}
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the row it replaced had it */}
          <button type="button" autoFocus onClick={cancel}>
            {t("chat.list.cancel")}
          </button>
          <button
            type="button"
            className={styles.danger}
            onClick={() => {
              // The row after it has the focus once it is gone, else the one before, else the search.
              const order = byDay(snapshot.saved, now).flatMap(({ chats }) =>
                chats.map((each) => each.id),
              );
              const at = order.indexOf(id);
              const next = order[at + 1] ?? order[at - 1];
              setRemoving(undefined);
              setFocus(next === undefined ? { on: "search" } : { id: next, on: "open" });
              void chat.remove(id);
            }}
          >
            {t("chat.list.remove")}
          </button>
        </div>
      );
    }
    const waits = chat_.asking === true || (current && snapshot.approvals.length > 0);
    const meta = [
      current && running ? t("chat.switcher.running") : agoText(chat_.updatedAt, now, t),
      ...(waits
        ? [t("chat.list.asking")]
        : chat_.changes
          ? [t("chat.list.changes", { count: chat_.changes })]
          : []),
      ...(chat_.modelName ? [chat_.modelName] : []),
    ].join(" · ");
    const off = running && !current;
    return (
      <div
        key={id}
        className={styles.row}
        data-testid="chat-conversation"
        data-current={current ? "" : undefined}
        data-id={id}
      >
        <button
          type="button"
          className={styles.rowOpen}
          data-role="open"
          aria-current={current}
          disabled={off}
          title={off ? t("chat.switcher.whenDone") : undefined}
          onClick={() => void open(id)}
        >
          <span className={styles.lead} aria-hidden>
            {current && running ? (
              <LoaderCircle size={12} className={styles.spin} />
            ) : waits ? (
              <span className={styles.dot} data-testid="chat-conversation-asking" />
            ) : null}
          </span>
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>
              {title}
              {current && ` · ${t("chat.switcher.current")}`}
            </span>
            <span className={styles.rowMeta}>{meta}</span>
          </span>
        </button>
        {chat_.unsent && (
          <Tip name={t("chat.list.unsent")} usage="">
            <span
              className={styles.unsent}
              role="img"
              aria-label={t("chat.list.unsent")}
              tabIndex={0}
              data-testid="chat-unsent"
            >
              <CloudOff size={12} aria-hidden />
            </span>
          </Tip>
        )}
        <span className={styles.rowActions}>
          <Tip name={t("chat.list.renameLabel")} usage="">
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t("chat.list.rename", { title })}
              onClick={() => setRenaming({ id, title })}
            >
              <Pencil size={12} aria-hidden />
            </button>
          </Tip>
          <Tip
            name={current && running ? t("chat.switcher.whenDone") : t("chat.list.remove")}
            usage=""
          >
            <button
              type="button"
              className={styles.iconButton}
              aria-label={t("chat.list.removeLabel", { title })}
              data-role="remove"
              disabled={current && running}
              onClick={() => setRemoving(id)}
            >
              <Trash2 size={12} aria-hidden />
            </button>
          </Tip>
        </span>
      </div>
    );
  };

  return (
    <div
      ref={page}
      className={styles.page}
      role="region"
      aria-label={t("chat.switcher.allTitle")}
      data-testid="chat-all"
    >
      <div className={styles.pageHead}>
        <button type="button" className={styles.back} data-testid="chat-all-back" onClick={onClose}>
          <ArrowLeft size={13} aria-hidden />
          {t("chat.switcher.back")}
        </button>
        <label className={styles.search}>
          <Search size={12} aria-hidden />
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- people came here to look for one
            autoFocus
            value={query}
            placeholder={t("chat.list.search")}
            aria-label={t("chat.list.search")}
            data-testid="chat-all-search"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className={styles.pageBody}>
        {query.trim() ? (
          found === undefined ? null : found.length === 0 ? (
            <p className={styles.none}>{t("chat.list.noHits", { query: query.trim() })}</p>
          ) : (
            found.map((hit, index) => (
              <div key={`${hit.id}/${index}`} className={styles.row}>
                <button
                  type="button"
                  className={styles.rowOpen}
                  data-testid="chat-search-hit"
                  disabled={running && hit.id !== snapshot.id}
                  title={
                    running && hit.id !== snapshot.id ? t("chat.switcher.whenDone") : undefined
                  }
                  onClick={() => void open(hit.id, hit.task)}
                >
                  <span className={styles.lead} aria-hidden />
                  <span className={styles.rowText}>
                    <span className={styles.rowTitle}>
                      {titleOf(t, snapshot.saved.find((each) => each.id === hit.id) ?? hit)}
                    </span>
                    <span className={styles.rowMeta}>
                      {hit.before}
                      <mark>{hit.match}</mark>
                      {hit.after}
                    </span>
                  </span>
                </button>
              </div>
            ))
          )
        ) : snapshot.saved.length === 0 ? (
          <p className={styles.none}>{t("chat.list.none")}</p>
        ) : (
          <>
            {running && <p className={styles.why}>{t("chat.switcher.whenDone")}</p>}
            {byDay(snapshot.saved, now).map(({ day, chats }) => (
              <div key={day} role="group" aria-label={t(`chat.list.${day}`)}>
                <div className={styles.group} aria-hidden>
                  {t(`chat.list.${day}`)}
                </div>
                {chats.map(row)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
