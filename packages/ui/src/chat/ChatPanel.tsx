import type { AssistantEntry, ChatEntry, ConversationSnapshot } from "@animaquill/agent";
import { entryOf, type ProjectState } from "@animaquill/core";
import { ArrowDown, Plus, SendHorizontal, Square } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import type { ModelPacks } from "./packs.ts";
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
  const [text, setText] = useState("");
  const chosen = ai.defaultModel();
  const modelName = useCallback(
    (model: string) => {
      for (const service of settings.services) {
        const name = ai.modelOf(service.id, model)?.name;
        if (name) return name;
      }
      return model;
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

  const runningTask = talk.running?.task;
  const turns = useMemo(
    () =>
      groupsOf(talk.entries).map((group) =>
        turnOf(group.user, group.entries, group.user.task === runningTask),
      ),
    [talk.entries, runningTask],
  );

  const send = () => {
    const message = text;
    if (!message.trim() || talk.running) return;
    setText("");
    following.current = true;
    void chat.send(message);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape" && talk.running) {
      event.preventDefault();
      chat.stop();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  if (settings.services.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.none}>
          <p>{t("chat.noServices")}</p>
          <button
            type="button"
            onClick={() => workbench.openSettings({ page: "models", depth: 2, adding: true })}
          >
            {t("chat.setUp")}
          </button>
        </div>
      </div>
    );
  }

  const switches = packSwitches(t, talk.entries, packs.getSnapshot().packs);
  const packLines = packLinesOf(t, talk.entries, chosen?.model, chat, packs);
  return (
    <div className={styles.panel} data-testid="chat">
      <div className={styles.bar}>
        <ModelButton />
        <button
          type="button"
          title={t("chat.newConversation")}
          aria-label={t("chat.newConversation")}
          disabled={talk.running !== undefined}
          onClick={() => chat.newConversation()}
        >
          <Plus size={14} />
        </button>
        {snapshot.saved.length > 0 && (
          <select
            className={styles.history}
            aria-label={t("chat.history")}
            value=""
            disabled={talk.running !== undefined}
            onChange={(event) => {
              if (event.target.value) void chat.open(event.target.value);
            }}
          >
            <option value="">{t("chat.history")}</option>
            {snapshot.saved.map((saved) => (
              <option key={saved.id} value={saved.id}>
                {saved.id === snapshot.id ? "· " : ""}
                {saved.title || t("chat.untitled")}
              </option>
            ))}
          </select>
        )}
        <UsageMeter entries={talk.entries} />
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
            {packLines.map(({ text: line, testId }) => (
              <p key={testId} className={styles.muted} data-testid={testId}>
                {line}
              </p>
            ))}
            {turns.length === 0 && <p className={styles.empty}>{t("chat.empty")}</p>}
            {conversation &&
              turns.map((turn, index) => {
                const running = talk.running?.task === turn.task ? talk.running : undefined;
                const latest = index === turns.length - 1;
                return (
                  <TurnView
                    key={turn.task}
                    turn={turn}
                    running={running}
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
                  />
                );
              })}
          </div>
        </div>
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
      </div>

      {conversation && talk.running && (
        <RunState conversation={conversation} running={talk.running} />
      )}
      {snapshot.hold && (
        <p className={styles.hold} role="alert">
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
      <div className={styles.compose}>
        <textarea
          aria-label={t("chat.placeholder")}
          placeholder={t("chat.placeholder")}
          value={text}
          rows={3}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {talk.running ? (
          <button
            type="button"
            className={styles.stop}
            aria-label={t("chat.stop")}
            onClick={() => chat.stop()}
          >
            <Square size={12} /> <span className={styles.buttonText}>{t("chat.stop")}</span>
          </button>
        ) : (
          <button
            type="button"
            className={styles.send}
            aria-label={t("chat.send")}
            disabled={!text.trim()}
            onClick={send}
          >
            <SendHorizontal size={12} className={styles.narrowIcon} />
            <span className={styles.buttonText}>{t("chat.send")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The model new conversations use, by name: picking another is in the settings for now, where this
 * goes. (The model of each conversation, picked here, comes with the input box redone.)
 */
function ModelButton() {
  const { ai } = useWorkbench();
  const workbench = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const chosen = ai.defaultModel();
  const name = chosen && (ai.modelOf(chosen.service.id, chosen.model)?.name ?? chosen.model);
  return (
    <button
      type="button"
      className={styles.model}
      data-testid="chat-model"
      title={
        chosen
          ? t("chat.modelTitle", { service: chosen.service.name, model: name })
          : t("chat.modelNoneTitle")
      }
      onClick={() =>
        workbench.openSettings({ page: "models", depth: 2, service: chosen?.service.id })
      }
    >
      {name ?? t("chat.modelNone")}
    </button>
  );
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
