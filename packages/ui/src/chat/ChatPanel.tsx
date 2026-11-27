import type {
  AssistantEntry,
  ChatEntry,
  ConversationSnapshot,
  SummaryEntry,
} from "@animaquill/agent";
import { entryOf, type ProjectState } from "@animaquill/core";
import { DEFAULT_PACK } from "@animaquill/tools";
import { ArrowDown, ChevronDown, ChevronUp, Menu, MoreHorizontal, Quote } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type RefObject,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import { EmptyStart, Onboarding } from "./ChatStart.tsx";
import { ConversationList } from "./ConversationList.tsx";
import { InputArea } from "./input/InputArea.tsx";
import { firstWords } from "./conversations.ts";
import { plainOf } from "./refs.ts";
import type { ModelPacksSnapshot } from "./packs.ts";
import packStyles from "./ModelPacks.module.css";
import { OpenPackView, PackViewer, type PackViewRequest } from "./PackViews.tsx";
import { noteLabel, packLabel } from "./packText.ts";
import { RunState } from "./RunState.tsx";
import { followsAfterScroll, showsToLatest } from "./scroll.ts";
import type { Names } from "./toolSummary.ts";
import { groupsOf, turnOf } from "./turns.ts";
import { TurnView } from "./TurnView.tsx";
import { SummaryDivider } from "./SummaryDivider.tsx";
import { ContextPie, ConversationInfo } from "./model/ConversationInfo.tsx";

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
    panelRef.current?.querySelector<HTMLElement>('[data-testid="chat-input"]')?.focus();
  // The list of conversations over this one, or with this one's name to change.
  const [listOpen, setListOpen] = useState<false | "list" | "rename">(false);
  // Pictures dragged over the chat: all of it takes them, and says so meanwhile.
  const [dropping, setDropping] = useState(false);
  const hasFiles = (event: DragEvent) =>
    [...event.dataTransfer.items].some((item) => item.kind === "file");
  const drop = {
    onDragEnter: (event: DragEvent) => {
      if (hasFiles(event)) setDropping(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropping(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
    },
    onDrop: (event: DragEvent) => {
      setDropping(false);
      const files = [...event.dataTransfer.files];
      if (files.length === 0) return;
      event.preventDefault();
      const id = snapshot.id;
      if (chat.projectKey === undefined || id === undefined) return;
      void chat.attachments.add(chat.projectKey, id, files).then((refused) => {
        if (refused) workbench.notifications.push(t(`chat.pictures.${refused}`));
      });
    },
  };
  // A view of model packs over the whole chat: details, all a model gets, or a comparison.
  const [packView, setPackView] = useState<PackViewRequest | undefined>();
  // What the conversation took and goes with, under the bar.
  const [infoOpen, setInfoOpen] = useState(false);
  const closeInfo = useCallback(() => setInfoOpen(false), []);
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
  /**
   * Goes to the turn a search found, once the conversation it is in shows: the words found light
   * up in it for a while, and the turn too.
   */
  const showTurn = (task: string | undefined, query?: string) => {
    if (task === undefined) return;
    requestAnimationFrame(() => {
      const turn = listRef.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(task)}"]`);
      if (!turn) return;
      following.current = false;
      if (query) markFound(turn, query);
      const hit = turn.querySelector("[data-found]") ?? turn;
      hit.scrollIntoView({ block: "center" });
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
  const summed = useMemo(() => summariesByTurn(talk.entries), [talk.entries]);
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

  const switches = packSwitches(t, talk.entries, packs.getSnapshot());
  const title =
    snapshot.titleBy === undefined && snapshot.forkedFrom
      ? t("chat.list.forked", { ...snapshot.forkedFrom })
      : snapshot.title || firstWords(talk.entries, 40) || t("chat.list.newTitle");
  return (
    <OpenPackView.Provider value={setPackView}>
      <div
        className={styles.panel}
        data-testid="chat"
        ref={panelRef}
        data-dropping={dropping ? "" : undefined}
        {...drop}
      >
        {dropping && (
          <div className={styles.dropHint} data-testid="chat-drop-hint">
            {t("chat.pictures.dropHere")}
          </div>
        )}
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
          <ContextPie
            entries={talk.entries}
            open={infoOpen}
            onOpen={() => setInfoOpen(!infoOpen)}
          />
          <MoreMenu
            title={title}
            entries={talk.entries}
            running={talk.running !== undefined}
            onRename={() => setListOpen("rename")}
            onInfo={() => setInfoOpen(true)}
          />
          {infoOpen && (
            <ConversationInfo
              entries={talk.entries}
              onCompact={conversation?.compactable ? () => void chat.compact() : undefined}
              onClose={closeInfo}
            />
          )}
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
              {summed.get("")?.map((entry) => (
                <SummaryDivider key={`${entry.at}/${entry.through}`} entry={entry} />
              ))}
              {turns.length === 0 && <EmptyStart onExample={putInBox} />}
              {conversation &&
                turns.map((turn, index) => {
                  const running = talk.running?.task === turn.task ? talk.running : undefined;
                  const latest = index === turns.length - 1;
                  return (
                    <Fragment key={turn.task}>
                      {summed.get(turn.task)?.map((entry) => (
                        <SummaryDivider key={`${entry.at}/${entry.through}`} entry={entry} />
                      ))}
                      <TurnView
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
                    </Fragment>
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
        <InputArea
          onSent={() => {
            following.current = true;
          }}
        />
        {packView && (
          <div className={packStyles.overChat}>
            <PackViewer
              {...packView}
              onClose={() => {
                setPackView(undefined);
                focusInput();
              }}
            />
          </div>
        )}
      </div>
    </OpenPackView.Provider>
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
  readonly onInfo: () => void;
}) {
  const { chat, dialogs, notifications } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [open, setOpen] = useState(false);
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
          {item(t("chat.more.download"), download, props.entries.length === 0)}
          {item(t("chat.info.title"), props.onInfo)}
        </div>
      )}
    </div>
  );
}

/** A conversation as Markdown: what people said and what AI answered, turn by turn. */
export function markdownOf(t: TFunction, title: string, entries: readonly ChatEntry[]): string {
  const parts = [`# ${title}`];
  for (const group of groupsOf(entries)) {
    const pictures = (group.user.images ?? []).map(
      (image, index) =>
        `[${t("chat.attached.picture", { number: index + 1 })}${image.label ? `: ${image.label}` : ""}]`,
    );
    parts.push(
      `**${t("chat.you")}**:\n\n${[plainOf(group.user.text), ...pictures].filter(Boolean).join("\n\n")}`,
    );
    const turn = turnOf(group.user, group.entries);
    // Links of the editor mean nothing outside it: what they say stays.
    if (turn.answer) parts.push(`**${t("chat.assistant")}**:\n\n${plainOf(turn.answer)}`);
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
  snapshot: ModelPacksSnapshot,
): ReadonlyMap<ChatEntry, string> {
  const packs = snapshot.packs;
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
          name: noteLabel(t, entry.pack, entry.texts.id, snapshot),
          version: entry.texts.version,
        }),
      );
    } else if (before?.texts && before.pack && before.texts.id !== entry.texts.id) {
      const name = noteLabel(t, entry.pack, entry.texts.id, snapshot);
      const was = before.texts.id;
      lines.set(
        entry,
        before.model === entry.model
          ? // People chose another while the one before is still there; else it went.
            packs.some(({ id }) => id === was)
            ? t("chat.packChosen", { name })
            : t("chat.packChanged", { name })
          : entry.pack.by === "fallback"
            ? t("chat.packSwitchedNone", {
                model: entry.model,
                label: packLabel(t, DEFAULT_PACK, snapshot, true),
              })
            : t("chat.packSwitched", { model: entry.model, name }),
      );
    }
    before = entry;
  }
  return lines;
}

/** How long the words a search found stay lit up in the turn it went to. */
const FOUND_MS = 4000;

/**
 * Lights up the words a search found in a turn, where the browser can (`CSS.highlights`), and the
 * turn itself, for a while.
 */
function markFound(turn: HTMLElement, query: string): void {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(turn, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? "";
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      if (ranges.length === 1) node.parentElement?.setAttribute("data-found", "");
    }
  }
  turn.setAttribute("data-found-turn", "");
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  if (highlights && Highlight && ranges.length > 0)
    highlights.set("chat-found", new Highlight(...ranges));
  setTimeout(() => {
    turn.removeAttribute("data-found-turn");
    for (const each of turn.querySelectorAll("[data-found]")) each.removeAttribute("data-found");
    highlights?.delete("chat-found");
  }, FOUND_MS);
}

/**
 * The summaries of a conversation by the turn they show before: the one where the summed up part
 * ends, or the first one after it, as for a conversation that starts from the summary of another;
 * under "" where there is no turn yet.
 */
export function summariesByTurn(
  entries: readonly ChatEntry[],
): ReadonlyMap<string, SummaryEntry[]> {
  const users = entries.flatMap((entry, index) =>
    entry.role === "user" ? [{ index, task: entry.task }] : [],
  );
  const found = new Map<string, SummaryEntry[]>();
  for (const entry of entries) {
    if (entry.role !== "summary") continue;
    const turn =
      users.findLast(({ index }) => index <= entry.through) ??
      users.find(({ index }) => index > entry.through);
    // Before any turn, as of a new conversation that goes on from another: at the top.
    const task = turn?.task ?? "";
    found.set(task, [...(found.get(task) ?? []), entry]);
  }
  return found;
}
