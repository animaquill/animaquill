import type { SavedChatSummary } from "@animaquill/host";
import { Check, ChevronDown, CloudOff, LoaderCircle, Search } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { agoText } from "../../app/start-view.ts";
import { useNow } from "../clock.ts";
import { byDay } from "../conversations.ts";
import { useChatUi } from "../ui.ts";
import styles from "./header.module.css";
import { useFound } from "./search.ts";
import { titleOf } from "./title.ts";

/** At most so many conversations in the switcher; the page of all of them has the rest. */
const SHOWN = 10;

/**
 * The title of the conversation (docs/design/chat-panel.md of AnimaQuill Cloud, 2.1–2.2), with ⌄:
 * a click opens the conversations under it, a double click changes its name in place (Enter keeps
 * it, Esc does not). The switcher does not cover the conversation: a search on top, which finds
 * what was said in any of them; the newest, today and earlier, each with when it changed, a
 * spinner for the one that runs, a dot for one that waits for people, a tick for this one; at its
 * foot the page of all of them. While a task runs no other conversation opens yet, which it says.
 */
export function TitleSwitcher(props: {
  readonly title: string;
  /** Changing the name, from "⋯" or a double click. */
  readonly renaming: boolean;
  readonly onRenaming: (renaming: boolean) => void;
  /** A conversation was opened from a search: the turn the words are in. */
  readonly onFound: (task: string | undefined, query?: string) => void;
  readonly onAll: () => void;
}) {
  const { chat } = useWorkbench();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const saved = snapshot.saved.some((each) => each.id === snapshot.id);
  const close = (back: boolean) => {
    setOpen(false);
    if (back) requestAnimationFrame(() => button.current?.focus());
  };
  if (props.renaming && saved && snapshot.id !== undefined)
    return (
      <Rename
        id={snapshot.id}
        title={props.title}
        onDone={() => {
          props.onRenaming(false);
          requestAnimationFrame(() => button.current?.focus());
        }}
      />
    );
  return (
    <>
      <button
        ref={button}
        type="button"
        className={styles.title}
        data-testid="chat-title"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={props.title}
        onClick={() => setOpen(!open)}
        onDoubleClick={() => {
          if (!saved) return;
          setOpen(false);
          props.onRenaming(true);
        }}
      >
        <span className={styles.titleText}>{props.title}</span>
        <ChevronDown size={12} aria-hidden className={styles.titleChevron} />
      </button>
      {open && (
        <Switcher
          onClose={close}
          onFound={props.onFound}
          onAll={() => {
            setOpen(false);
            props.onAll();
          }}
        />
      )}
    </>
  );
}

/** The name of the conversation, changed in place. */
function Rename(props: {
  readonly id: string;
  readonly title: string;
  readonly onDone: () => void;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const [value, setValue] = useState(props.title);
  const done = useRef(false);
  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep && value.trim() && value.trim() !== props.title) void chat.rename(props.id, value);
    props.onDone();
  };
  return (
    <input
      className={styles.rename}
      aria-label={t("chat.list.renameLabel")}
      data-testid="chat-title-rename"
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- people asked to change it just now
      autoFocus
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** One thing the switcher can open: a conversation, or where a search found words in one. */
interface Choice {
  readonly key: string;
  readonly id: string;
  readonly task?: string;
}

function Switcher(props: {
  readonly onClose: (back: boolean) => void;
  readonly onFound: (task: string | undefined, query?: string) => void;
  readonly onAll: () => void;
}) {
  const { chat } = useWorkbench();
  const ui = useChatUi();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const running = snapshot.conversation?.running === true;
  const [query, setQuery] = useState("");
  const found = useFound(query);
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const now = useNow(true, 60_000);
  const { onClose } = props;
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target)) return;
      // The title toggles it by itself.
      if ((target as Element).closest?.('[data-testid="chat-title"]')) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);

  const searching = query.trim() !== "";
  const recent = snapshot.saved.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, SHOWN);
  const groups = searching ? [] : byDay(recent, now, "short");
  const choices: readonly Choice[] = searching
    ? (found ?? []).map((hit, index) => ({
        key: `${hit.id}/${index}`,
        id: hit.id,
        ...(hit.task !== undefined && { task: hit.task }),
      }))
    : groups.flatMap(({ chats }) => chats.map((each) => ({ key: each.id, id: each.id })));
  const at = Math.min(active, Math.max(0, choices.length - 1));
  // While a task runs, only the conversation it runs in.
  const closed = (id: string) => running && id !== snapshot.id;
  const choose = async (choice: Choice) => {
    if (closed(choice.id)) return;
    if (choice.id !== snapshot.id) await chat.open(choice.id);
    props.onClose(false);
    // Opened: where people go on, the box.
    ui.focusInput();
    props.onFound(choice.task, searching ? query.trim() : undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (choices.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at + step + choices.length) % choices.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices[at];
      if (choice) void choose(choice);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose(true);
    }
  };
  const optionId = (index: number) => `${listId}-${index}`;
  const places = new Map(choices.map((choice, index) => [choice.key, index]));
  const option = (chat_: SavedChatSummary) => {
    const mine = places.get(chat_.id) ?? -1;
    const current = chat_.id === snapshot.id;
    const waits = chat_.asking === true || (current && snapshot.approvals.length > 0);
    const off = closed(chat_.id);
    return (
      <div
        key={chat_.id}
        id={optionId(mine)}
        role="option"
        aria-selected={current}
        aria-disabled={off || undefined}
        className={styles.option}
        data-testid="chat-switcher-row"
        data-active={mine === at || undefined}
        data-current={current || undefined}
        title={off ? t("chat.switcher.whenDone") : undefined}
        onPointerMove={() => setActive(mine)}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => void choose({ key: chat_.id, id: chat_.id })}
      >
        <span className={styles.lead} aria-hidden>
          {current && running ? (
            <LoaderCircle size={12} className={styles.spin} />
          ) : waits ? (
            <span className={styles.dot} data-testid="chat-conversation-asking" />
          ) : current ? (
            <Check size={12} />
          ) : null}
        </span>
        <span className={styles.optionTitle}>{titleOf(t, chat_)}</span>
        {chat_.unsent && (
          <span
            className={styles.unsent}
            role="img"
            aria-label={t("chat.list.unsent")}
            title={t("chat.list.unsent")}
          >
            <CloudOff size={12} aria-hidden />
          </span>
        )}
        <span className={styles.ago}>
          {current && running
            ? t("chat.switcher.running")
            : waits
              ? t("chat.list.asking")
              : agoText(chat_.updatedAt, now, t)}
        </span>
      </div>
    );
  };
  return (
    <div
      ref={box}
      className={`${styles.popover} ${styles.switcher}`}
      role="dialog"
      aria-label={t("chat.switcher.title")}
      data-testid="chat-switcher"
    >
      <label className={styles.search}>
        <Search size={12} aria-hidden />
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- people opened it to look for one
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={choices.length > 0 ? optionId(at) : undefined}
          aria-label={t("chat.list.search")}
          placeholder={t("chat.list.search")}
          data-testid="chat-switcher-search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      {running && <p className={styles.why}>{t("chat.switcher.whenDone")}</p>}
      <div
        className={styles.scroll}
        role="listbox"
        id={listId}
        aria-label={t("chat.switcher.title")}
      >
        {searching ? (
          found === undefined ? null : found.length === 0 ? (
            <p className={styles.none}>{t("chat.list.noHits", { query: query.trim() })}</p>
          ) : (
            found.map((hit, hitIndex) => {
              const mine = places.get(`${hit.id}/${hitIndex}`) ?? -1;
              const off = closed(hit.id);
              const summary = snapshot.saved.find((each) => each.id === hit.id) ?? hit;
              return (
                <div
                  key={`${hit.id}/${hitIndex}`}
                  id={optionId(mine)}
                  role="option"
                  aria-selected={false}
                  aria-disabled={off || undefined}
                  className={`${styles.option} ${styles.hit}`}
                  data-testid="chat-search-hit"
                  data-active={mine === at || undefined}
                  title={off ? t("chat.switcher.whenDone") : undefined}
                  onPointerMove={() => setActive(mine)}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() =>
                    void choose({
                      key: hit.id,
                      id: hit.id,
                      ...(hit.task !== undefined && { task: hit.task }),
                    })
                  }
                >
                  <span className={styles.optionTitle}>{titleOf(t, summary)}</span>
                  <span className={styles.hitText}>
                    {hit.before}
                    <mark>{hit.match}</mark>
                    {hit.after}
                  </span>
                </div>
              );
            })
          )
        ) : snapshot.saved.length === 0 ? (
          <p className={styles.none}>{t("chat.list.none")}</p>
        ) : (
          groups.map(({ day, chats }) => (
            <div key={day} role="group" aria-label={t(`chat.list.${day}`)}>
              <div className={styles.group} aria-hidden>
                {t(`chat.list.${day}`)}
              </div>
              {chats.map(option)}
            </div>
          ))
        )}
      </div>
      <div className={styles.foot}>
        <button
          type="button"
          className={styles.footButton}
          data-testid="chat-switcher-all"
          onClick={props.onAll}
        >
          {t("chat.switcher.all")}
        </button>
      </div>
    </div>
  );
}
