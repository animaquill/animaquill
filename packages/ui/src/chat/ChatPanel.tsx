import type { AssistantEntry, ChatEntry, ConversationSnapshot } from "@animaquill/agent";
import { entryOf, type ProjectState } from "@animaquill/core";
import { ArrowDown, ChevronDown, ChevronUp, Menu, MoreHorizontal, Quote } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import { EmptyStart, Onboarding } from "./ChatStart.tsx";
import { Composer } from "./Composer.tsx";
import { ConversationList } from "./ConversationList.tsx";
import { firstWords } from "./conversations.ts";
import type { ModelPacks } from "./packs.ts";
import { PackViewer } from "./PackViews.tsx";
import { noteLabel } from "./packText.ts";
import { RunState } from "./RunState.tsx";
import { followsAfterScroll, showsToLatest } from "./scroll.ts";
import type { ChatSession } from "./session.ts";
import type { Names } from "./toolSummary.ts";
import { groupsOf, turnOf } from "./turns.ts";
import { TurnView } from "./TurnView.tsx";
import { UsageMeter } from "./UsageMeter.tsx";

const NO_CONVERSATION: ConversationSnapshot = { entries: [], running: undefined, last: undefined };
const noop = () => () => {};

/** What the project calls its objects, for the lines of tools. */
function namesIn(state: ProjectState | undefined): Names {
  return {
    timeline: (id) => {
      const wanted = id ?? state?.manifest.timelines[0];
      return wanted === undefined || !state ? undefined : entryOf(state.timelines, wanted)?.name;
    },
    object: (id, timeline) => {
      if (!state) return undefined;
      const timelines = timeline === undefined ? Object.keys(state.timelines) : [timeline];
      for (const each of timelines) {
        const found = entryOf(state.timelines, each);
        if (!found) continue;
        const named =
          entryOf(found.clips, id) ??
          entryOf(found.tracks, id) ??
          entryOf(found.markers, id) ??
          entryOf(found.sections, id);
        if (named) return named.name;
      }
      return (
        entryOf(state.timelines, id)?.name ??
        entryOf(state.scenes, id)?.name ??
        entryOf(state.sounds, id)?.name ??
        entryOf(state.assets, id)?.name
      );
    },
  };
}

/** The chat with AI in the browser, about the open project. */
export function ChatPanel() {
  const workbench = useWorkbench();
  const { chat, ai, packs } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  // Which pack a new conversation would get changes with the packs installed.
  useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const conversation = snapshot.conversation;
  const talk = useSyncExternalStore(
    conversation?.subscribe ?? noop,
    conversation?.getSnapshot ?? (() => NO_CONVERSATION),
  );
  const { store } = useSession();
  // What a task can take back changes with every change of the project.
  const state = useProject(store);
  const names = useMemo(() => namesIn(state), [state]);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Puts the cursor in the input box, after something went there. */
  const focusInput = () =>
    panelRef.current?.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')?.focus();
  // The list of conversations over this one, or with this one's name to change.
  const [listOpen, setListOpen] = useState<false | "list" | "rename">(false);
  const model = chat.modelNow()?.ref.model;
  const modelName = useCallback(
    (id: string) => {
      for (const service of settings.services) {
        const name = ai.modelOf(service.id, id)?.name;
        if (name) return name;
      }
      return id;
    },
    [ai, settings],
  );

  // New words come in at the bottom, where people read, unless they scrolled up to read before.
  const listRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const [toLatest, setToLatest] = useState(false);
  const toBottom = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    lastTop.current = list.scrollTop;
  }, []);
  useLayoutEffect(() => {
    if (following.current) toBottom();
  });
  // The words of an answer on their way grow the column without drawing the panel again.
  const columnRef = useCallback(
    (column: HTMLDivElement | null) => {
      if (!column) return;
      const observer = new ResizeObserver(() => {
        if (following.current) toBottom();
        const list = listRef.current;
        if (list) setToLatest(showsToLatest(list.scrollTop, list.clientHeight, list.scrollHeight));
      });
      observer.observe(column);
      return () => observer.disconnect();
    },
    [toBottom, setToLatest],
  );
  /** Goes to the turn a search found, once the conversation it is in shows. */
  const showTurn = (task: string | undefined) => {
    if (task === undefined) return;
    requestAnimationFrame(() => {
      const turn = listRef.current?.querySelector(`[data-task="${CSS.escape(task)}"]`);
      if (!turn) return;
      following.current = false;
      turn.scrollIntoView({ block: "start" });
    });
  };

  const runningTask = talk.running?.task;
  const turns = useMemo(
    () =>
      groupsOf(talk.entries).map((group) =>
        turnOf(group.user, group.entries, group.user.task === runningTask),
      ),
    [talk.entries, runningTask],
  );
  const project = chat.projectKey;
  const putInBox = (text: string) => {
    if (project !== undefined && snapshot.id !== undefined) {
      chat.drafts.write(project, snapshot.id, text);
    }
    focusInput();
  };

  if (settings.services.length === 0) {
    return (
      <div className={styles.panel} data-testid="chat">
        <Onboarding />
      </div>
    );
  }

  const switches = packSwitches(t, talk.entries, packs.getSnapshot().packs);
  const packLines = packLinesOf(t, talk.entries, model, chat, packs);
  const title =
    snapshot.titleBy === undefined && snapshot.forkedFrom
      ? t("chat.list.forked", { ...snapshot.forkedFrom })
      : snapshot.title || firstWords(talk.entries, 40) || t("chat.list.newTitle");
  return (
    <div className={styles.panel} data-testid="chat" ref={panelRef}>
      <div className={styles.bar}>
        <button
          type="button"
          className={styles.title}
          data-testid="chat-title"
          aria-expanded={listOpen !== false}
          title={t("chat.list.title")}
          onClick={() => setListOpen(listOpen ? false : "list")}
        >
          <Menu size={12} aria-hidden />
          <span className={styles.titleText}>{title}</span>
          {listOpen ? <ChevronUp size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
        </button>
        <UsageMeter entries={talk.entries} />
        <MoreMenu
          title={title}
          entries={talk.entries}
          running={talk.running !== undefined}
          onRename={() => setListOpen("rename")}
        />
      </div>

      <div className={styles.listWrap}>
        <div
          className={styles.list}
          ref={listRef}
          onScroll={(event) => {
            const list = event.currentTarget;
            following.current = followsAfterScroll(
              following.current,
              lastTop.current,
              list.scrollTop,
              list.clientHeight,
              list.scrollHeight,
            );
            lastTop.current = list.scrollTop;
            setToLatest(showsToLatest(list.scrollTop, list.clientHeight, list.scrollHeight));
          }}
        >
          <div className={styles.column} ref={columnRef}>
            {snapshot.forkedFrom && (
              <p className={styles.muted} data-testid="chat-forked">
                {t("chat.forked", { ...snapshot.forkedFrom })}
              </p>
            )}
            {packLines.map(({ text: line, testId }) => (
              <p key={testId} className={styles.muted} data-testid={testId}>
                {line}
              </p>
            ))}
            {turns.length === 0 && <EmptyStart onExample={putInBox} />}
            {conversation &&
              turns.map((turn, index) => {
                const running = talk.running?.task === turn.task ? talk.running : undefined;
                const latest = index === turns.length - 1;
                return (
                  <TurnView
                    key={turn.task}
                    turn={turn}
                    running={running}
                    busy={talk.running !== undefined}
                    conversation={conversation}
                    outcome={latest && talk.last?.task === turn.task ? talk.last : undefined}
                    latest={latest}
                    maxToolCalls={settings.maxToolCalls}
                    switches={turn.entries.flatMap((entry) => {
                      const line = switches.get(entry);
                      return line ? [line] : [];
                    })}
                    names={names}
                    modelName={modelName}
                    onForked={focusInput}
                  />
                );
              })}
          </div>
        </div>
        <QuoteButton
          list={listRef}
          onQuote={(text) => {
            if (project !== undefined && snapshot.id !== undefined) {
              chat.drafts.quote(project, snapshot.id, text);
            }
            focusInput();
          }}
        />
        {toLatest && (
          <button
            type="button"
            className={styles.toLatest}
            data-testid="chat-to-latest"
            onClick={() => {
              following.current = true;
              toBottom();
              setToLatest(false);
            }}
          >
            <ArrowDown size={12} /> {t("chat.latest")}
          </button>
        )}
        {listOpen && (
          <ConversationList
            rename={listOpen === "rename"}
            onClose={() => setListOpen(false)}
            onFound={showTurn}
          />
        )}
      </div>

      {conversation && talk.running && (
        <RunState conversation={conversation} running={talk.running} />
      )}
      {snapshot.hold && (
        <p className={styles.hold} role="alert" data-testid="chat-hold">
          {t(`chat.hold.${snapshot.hold}`)}
          {snapshot.hold === "relaySignIn" && workbench.account && (
            <>
              {" "}
              <button type="button" onClick={() => void workbench.signIn()}>
                {t("account.signIn")}
              </button>
            </>
          )}
        </p>
      )}
      <Composer
        onSent={() => {
          following.current = true;
        }}
      />
    </div>
  );
}

/**
 * "Quote" over words selected in an answer of AI: they go to the input box as a Markdown quote,
 * pi-web's way.
 */
function QuoteButton(props: {
  readonly list: RefObject<HTMLDivElement | null>;
  readonly onQuote: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [at, setAt] = useState<{ top: number; left: number; text: string } | undefined>();
  const { list } = props;
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const look = () => {
      const selection = document.getSelection();
      const text = selection?.toString().trim() ?? "";
      const node = selection?.anchorNode;
      const from = (node instanceof Element ? node : node?.parentElement)?.closest(
        '[data-testid="chat-answer"], [data-testid="chat-said"]',
      );
      if (!selection || selection.rangeCount === 0 || !text || !from || !element.contains(from)) {
        setAt(undefined);
        return;
      }
      const box = selection.getRangeAt(0).getBoundingClientRect();
      const wrap = element.getBoundingClientRect();
      setAt({
        top: Math.max(0, box.top - wrap.top - 28),
        left: Math.min(Math.max(0, box.left - wrap.left), wrap.width - 64),
        text,
      });
    };
    document.addEventListener("selectionchange", look);
    return () => document.removeEventListener("selectionchange", look);
  }, [list]);
  if (!at) return null;
  return (
    <button
      type="button"
      className={styles.quote}
      data-testid="chat-quote"
      style={{ top: at.top, left: at.left }}
      // Pressing it must not take the selection away first.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        props.onQuote(at.text);
        document.getSelection()?.removeAllRanges();
        setAt(undefined);
      }}
    >
      <Quote size={12} aria-hidden /> {t("chat.compose.quote")}
    </button>
  );
}

/**
 * More of the conversation open: a new one, renaming or deleting it, copying it as Markdown, and
 * all its model gets with the pack it has (its system prompt and tools).
 */
function MoreMenu(props: {
  readonly title: string;
  readonly entries: readonly ChatEntry[];
  readonly running: boolean;
  readonly onRename: () => void;
}) {
  const { chat, dialogs, notifications } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<{ pack: string; model: string } | undefined>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const id = snapshot.id;
  const saved = snapshot.saved.some((each) => each.id === id);
  const item = (label: string, action: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
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
  const sent = () => {
    const model = chat.modelNow()?.ref.model;
    if (!model) return;
    const last = props.entries.findLast((entry) => entry.role === "assistant");
    const pack =
      last?.role === "assistant" && last.model === model && last.texts
        ? last.texts.id
        : chat.choiceFor(model).pack.id;
    setViewing({ pack, model });
  };
  return (
    <div className={styles.moreWrap} ref={ref}>
      <button
        type="button"
        className={styles.icon}
        aria-label={t("chat.more.title")}
        title={t("chat.more.title")}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="chat-more"
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={14} aria-hidden />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {item(t("chat.newConversation"), () => chat.newConversation(), props.running)}
          {item(t("chat.more.rename"), props.onRename, !saved)}
          {item(t("chat.more.remove"), () => void remove(), !saved || props.running)}
          {item(t("chat.more.copy"), copy, props.entries.length === 0)}
          {item(t("chat.more.sent"), sent, chat.modelNow() === undefined)}
        </div>
      )}
      {viewing && (
        <PackViewer
          view="full"
          pack={viewing.pack}
          model={viewing.model}
          onClose={() => setViewing(undefined)}
        />
      )}
    </div>
  );
}

/** A conversation as Markdown: what people said and what AI answered, turn by turn. */
export function markdownOf(t: TFunction, title: string, entries: readonly ChatEntry[]): string {
  const parts = [`# ${title}`];
  for (const group of groupsOf(entries)) {
    parts.push(`**${t("chat.you")}**:\n\n${group.user.text}`);
    const turn = turnOf(group.user, group.entries);
    if (turn.answer) parts.push(`**${t("chat.assistant")}**:\n\n${turn.answer}`);
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * Where an answer had another model pack than the answer before it: the model changed and a pack
 * was chosen again, or the pack was gone. The line says which pack it is now.
 */
function packSwitches(
  t: TFunction,
  entries: readonly ChatEntry[],
  packs: readonly { readonly id: string }[],
): ReadonlyMap<ChatEntry, string> {
  const lines = new Map<ChatEntry, string>();
  let before: AssistantEntry | undefined;
  for (const entry of entries) {
    if (entry.role !== "assistant" || !entry.pack || !entry.texts) continue;
    if (
      before?.texts &&
      before.pack &&
      before.texts.id === entry.texts.id &&
      before.texts.hash !== entry.texts.hash
    ) {
      // The version it began with is not kept any more: the one installed went on.
      lines.set(
        entry,
        t("chat.packUpdated", {
          name: noteLabel(t, entry.pack, entry.texts.id),
          version: entry.texts.version,
        }),
      );
    } else if (before?.texts && before.pack && before.texts.id !== entry.texts.id) {
      const name = noteLabel(t, entry.pack, entry.texts.id);
      const was = before.texts.id;
      lines.set(
        entry,
        before.model === entry.model
          ? // People chose another while the one before is still there; else it went.
            packs.some(({ id }) => id === was)
            ? t("chat.packChosen", { name })
            : t("chat.packChanged", { name })
          : entry.pack.by === "fallback"
            ? t("chat.packSwitchedNone", { model: entry.model })
            : t("chat.packSwitched", { model: entry.model, name }),
      );
    }
    before = entry;
  }
  return lines;
}

/**
 * What the top of a conversation says of its model pack: the pack of its first answer, or of a
 * new conversation the pack it would get; that a model has no pack of its own; and that the pack
 * chosen in the settings now comes with the next conversation.
 */
function packLinesOf(
  t: TFunction,
  entries: readonly ChatEntry[],
  model: string | undefined,
  chat: ChatSession,
  packs: ModelPacks,
): readonly { readonly text: string; readonly testId: string }[] {
  const answers = entries.filter((entry): entry is AssistantEntry => entry.role === "assistant");
  const lines: { text: string; testId: string }[] = [];
  /** What of a pack this version of the tools goes without, said once at the top. */
  const dropped = (id: string | undefined) => {
    const count = id === undefined ? 0 : (packs.installedOf(id)?.dropped.length ?? 0);
    if (count > 0)
      lines.push({ text: t("chat.packDropped", { count }), testId: "chat-pack-dropped" });
  };
  const first = answers.find((entry) => entry.pack && entry.texts);
  if (first?.pack) {
    lines.push({
      text:
        first.pack.by === "fallback"
          ? t("chat.packNone", { model: first.model })
          : t("chat.packLine", { name: noteLabel(t, first.pack, first.texts?.id) }),
      testId: "chat-pack",
    });
    dropped(first.texts?.id);
  } else if (answers.length === 0 && model) {
    const { pack, note } = chat.choiceFor(model);
    lines.push({
      text:
        note.by === "fallback"
          ? t("chat.packNone", { model })
          : t("chat.packLine", { name: noteLabel(t, note, pack.id) }),
      testId: "chat-pack",
    });
    dropped(pack.id);
  }
  const last = answers.at(-1);
  if (model && last?.pack && last.texts && last.model === model && last.pack.by !== "comparison") {
    const { pack, note } = chat.choiceFor(model);
    if (chat.repicking(model) && (pack.id !== last.texts.id || pack.hash !== last.texts.hash)) {
      // Chosen where the model is picked: it comes with the next answer of this conversation.
      lines.push({
        text: t("chat.packNextAnswer", { name: noteLabel(t, note, pack.id) }),
        testId: "chat-pack-next",
      });
    } else if (pack.id !== last.texts.id) {
      lines.push({
        text: t("chat.packNext", { model, name: noteLabel(t, note, pack.id) }),
        testId: "chat-pack-next",
      });
    } else if (pack.hash !== last.texts.hash) {
      lines.push({
        text: t("chat.packNextVersion", {
          name: noteLabel(t, note, pack.id),
          version: pack.version,
        }),
        testId: "chat-pack-next",
      });
    }
  }
  return lines;
}
