import { failureOf } from "@animaquill/agent";
import type {
  AssistantEntry,
  ChatEntry,
  ConversationSnapshot,
  TaskOutcome,
  ToolCallEntry,
  ToolEntry,
} from "@animaquill/agent";
import { pathOfObject, type ObjectRef, type ProjectState } from "@animaquill/core";
import { Check, LoaderCircle, Plus, Square, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import { failureText } from "./failure.ts";
import type { ModelPacks } from "./packs.ts";
import { noteLabel } from "./packText.ts";
import type { ChatSession } from "./session.ts";
import { summaryOf, type TurnChange } from "./summary.ts";

const NO_CONVERSATION: ConversationSnapshot = { entries: [], running: undefined, last: undefined };
const noop = () => () => {};
const ARGS_SUMMARY = 90;
/** How close to the bottom still counts as reading the newest. */
const STICK_PX = 24;

/** What people and AI said, by task: each message of people starts one. */
interface TaskGroup {
  readonly task: string;
  readonly entries: readonly ChatEntry[];
}

function groupsOf(entries: readonly ChatEntry[]): TaskGroup[] {
  const groups: { task: string; entries: ChatEntry[] }[] = [];
  for (const entry of entries) {
    if (entry.role === "user") groups.push({ task: entry.task, entries: [entry] });
    else groups.at(-1)?.entries.push(entry);
  }
  return groups;
}

/** The tools before these, which read, for the count of changes of an earlier conversation. */
const OLD_READ_TOOLS = new Set([
  "project_overview",
  "timeline_read",
  "selection_read",
  "file_read",
]);
/** What a turn shows of what it changed before it opens up. */
const SHOWN_CHANGES = 5;
const SHOWN_SAID = 3;
const SHOWN_FIELDS = 3;

/**
 * How an earlier task ended, as far as what was kept says: only a failure or a stop leave a mark.
 * The limit of tools does not, as its answer looks like any other.
 */
function keptOutcome(group: TaskGroup): TaskOutcome | undefined {
  const last = group.entries.findLast((entry) => entry.role === "assistant");
  if (last?.role !== "assistant") return undefined;
  if (last.end === "stopped") return { task: group.task, end: "stopped" };
  if (last.end === "failed") {
    return { task: group.task, end: "failed", failure: failureOf(last.error ?? "") };
  }
  return undefined;
}

/** A command by its type, as people know it from the command system: the tools before these. */
const commandOf = (tool: string) => tool.replaceAll("_", ".");

/** Whether an object is still in the project, to go to it. */
function isThere(state: ProjectState | undefined, ref: ObjectRef): boolean {
  let node: unknown = state;
  for (const key of pathOfObject(ref)) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return node !== undefined;
}

function argsSummaryOf(args: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(args);
  return text.length > ARGS_SUMMARY ? `${text.slice(0, ARGS_SUMMARY)}…` : text;
}

/** The chat with AI in the browser, about the open project. */
export function ChatPanel() {
  const workbench = useWorkbench();
  const { chat, ai, layout, packs } = workbench;
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
  useProject(store);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const current = ai.current;

  // New words come in at the bottom, where people read, unless they scrolled up to read before.
  const stick = useRef(true);
  useEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  });

  const send = () => {
    const message = text;
    if (!message.trim() || talk.running) return;
    setText("");
    void chat.send(message);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  if (settings.services.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.none}>
          <p>{t("chat.noServices")}</p>
          <button type="button" onClick={() => layout.openPanel("settings")}>
            {t("chat.setUp")}
          </button>
        </div>
      </div>
    );
  }

  const groups = groupsOf(talk.entries);
  const switches = packSwitches(t, talk.entries, packs.getSnapshot().packs);
  const packLines = packLinesOf(t, talk.entries, current?.model, chat, packs);
  return (
    <div className={styles.panel} data-testid="chat">
      <div className={styles.bar}>
        <select
          aria-label={t("chat.service")}
          value={settings.current ?? ""}
          onChange={(event) => ai.choose(event.target.value)}
        >
          {settings.services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
        {current && <ModelPicker key={current.id} />}
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
      </div>

      <div
        className={styles.list}
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          stick.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_PX;
        }}
      >
        {packLines.map(({ text: line, testId }) => (
          <p key={testId} className={styles.muted} data-testid={testId}>
            {line}
          </p>
        ))}
        {groups.length === 0 && <p className={styles.empty}>{t("chat.empty")}</p>}
        {groups.map((group, index) => (
          <TaskView
            key={group.task}
            group={group}
            running={talk.running?.task === group.task ? talk.running : undefined}
            outcome={index === groups.length - 1 ? talk.last : undefined}
            maxToolCalls={settings.maxToolCalls}
            last={index === groups.length - 1}
            switches={switches}
          />
        ))}
      </div>

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
          <button type="button" className={styles.stop} onClick={() => chat.stop()}>
            <Square size={12} /> {t("chat.stop")}
          </button>
        ) : (
          <button type="button" disabled={!text.trim()} onClick={send}>
            {t("chat.send")}
          </button>
        )}
      </div>
    </div>
  );
}

/** The model of the current service, picked from what it has or typed. */
function ModelPicker() {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const service = ai.current;
  if (!service) return null;
  const models = ai.modelsFor(service.id);
  const listId = `chat-models-${service.id}`;
  return (
    <>
      <input
        className={styles.model}
        aria-label={t("chat.model")}
        list={listId}
        key={service.model}
        defaultValue={service.model}
        placeholder={t("ai.modelPlaceholder")}
        spellCheck={false}
        onFocus={() => void ai.loadKnown(service.kind)}
        onBlur={(event) => {
          const model = event.target.value.trim();
          if (model !== service.model) ai.update(service.id, { model });
        }}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      />
      <datalist id={listId}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </datalist>
    </>
  );
}

function TaskView({
  group,
  running,
  outcome,
  maxToolCalls,
  last,
  switches,
}: {
  /** The line before an answer that had another model pack than the one before it. */
  readonly switches: ReadonlyMap<ChatEntry, string>;
  readonly group: TaskGroup;
  readonly running: ConversationSnapshot["running"];
  readonly outcome: TaskOutcome | undefined;
  readonly maxToolCalls: number;
  /** It is the newest task, whose question people can still answer. */
  readonly last: boolean;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const results = new Map<string, ToolEntry>();
  for (const entry of group.entries) if (entry.role === "tool") results.set(entry.call, entry);
  const summary = summaryOf(group.entries);
  // Earlier conversations had tools that said nothing of what they changed: those count calls.
  const changes = summary.told
    ? summary.changes.length
    : [...results.values()].filter((result) => result.ok && !OLD_READ_TOOLS.has(result.name))
        .length;
  const undo = running ? undefined : chat.undoState(group.task);
  const question = last ? questionOf(group) : undefined;

  return (
    <div className={styles.task} data-testid="chat-task">
      {group.entries.map((entry, index) => {
        if (entry.role === "user") {
          return (
            <div key={index} className={styles.user}>
              {entry.text}
            </div>
          );
        }
        if (entry.role === "assistant") {
          const switched = switches.get(entry);
          return (
            <div key={index}>
              {switched && (
                <p className={styles.muted} data-testid="chat-pack-switch">
                  {switched}
                </p>
              )}
              <AnswerView entry={entry} results={results} running={running} />
            </div>
          );
        }
        return null;
      })}
      {running && (
        <div className={styles.answer} aria-live="polite">
          {running.thinking.trim() !== "" && (
            <p className={styles.thinking} data-testid="chat-thinking">
              {running.thinking.trim()}
            </p>
          )}
          {running.text ? (
            <p className={styles.text}>{running.text}</p>
          ) : (
            !running.tool &&
            running.thinking.trim() === "" && (
              <p className={styles.muted}>
                <LoaderCircle size={12} className={styles.spin} /> {t("chat.thinking")}
              </p>
            )
          )}
        </div>
      )}
      {(() => {
        const shown = outcome ?? (running ? undefined : keptOutcome(group));
        return shown && <OutcomeView outcome={shown} maxToolCalls={maxToolCalls} />;
      })()}
      {question && !running && <QuestionView question={question} />}
      {(undo || (summary.told && changes > 0 && !running)) && (
        <div className={styles.undo}>
          {changes > 0 && (
            <span className={styles.muted}>{t("chat.changes", { count: changes })}</span>
          )}
          {undo && (
            <button
              type="button"
              onClick={() =>
                undo === "undo" ? chat.undoTask(group.task) : chat.redoTask(group.task)
              }
            >
              {undo === "undo" ? t("chat.undoTask") : t("chat.redoTask")}
            </button>
          )}
        </div>
      )}
      {!running && summary.told && changes > 0 && (
        <ChangesView said={summary.said} changes={summary.changes} />
      )}
    </div>
  );
}

/** What the batches of a turn did, as AI said it, and the objects they changed. */
function ChangesView({
  said,
  changes,
}: {
  readonly said: readonly string[];
  readonly changes: readonly TurnChange[];
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const [open, setOpen] = useState(false);
  const lines = open ? changes : changes.slice(0, SHOWN_CHANGES);
  const sentences = open ? said : said.slice(0, SHOWN_SAID);
  return (
    <div className={styles.changes} data-testid="chat-changes">
      {sentences.map((sentence, index) => (
        <p key={index} className={styles.said}>
          {sentence}
        </p>
      ))}
      {lines.map((change) => {
        const ref: ObjectRef = {
          kind: change.kind,
          id: change.id,
          ...(change.timeline !== undefined && { timeline: change.timeline }),
        };
        const there = change.change !== "removed" && isThere(state, ref);
        return (
          <div key={change.key} className={styles.change} data-testid="chat-change">
            <span className={styles.changeText}>{changeText(t as unknown as Say, change)}</span>
            {change.change !== "removed" && change.kind !== "project" && (
              <button
                type="button"
                disabled={!there}
                title={there ? undefined : t("chat.summary.gone")}
                onClick={() => workbench.goToObject(ref)}
              >
                {change.kind === "file" || change.kind === "scene"
                  ? t("chat.summary.open")
                  : t("chat.summary.locate")}
              </button>
            )}
          </div>
        );
      })}
      {(changes.length > SHOWN_CHANGES || said.length > SHOWN_SAID) && (
        <button type="button" className={styles.more} onClick={() => setOpen(!open)}>
          {open
            ? t("chat.summary.less")
            : changes.length > SHOWN_CHANGES
              ? t("chat.summary.more", { count: changes.length - SHOWN_CHANGES })
              : t("chat.summary.saidMore", { count: said.length - SHOWN_SAID })}
        </button>
      )}
    </div>
  );
}

/** Words by a key made at run time, which the types of the keys cannot follow. */
type Say = (key: string, options?: Readonly<Record<string, unknown>>) => string;

/** One change in a line: what it is, and how up to three of its fields changed. */
function changeText(say: Say, change: TurnChange): string {
  const t = say;
  const kind = t(`chat.kinds.${change.kind}`);
  const name = change.name ? `「${change.name}」` : ` ${change.id}`;
  const head = `${t(`chat.summary.${change.change}`, { kind })}${name}`;
  if (change.lines) {
    return `${head}  ${t("chat.summary.lines", change.lines)}`;
  }
  if (change.change !== "changed") return head;
  const fieldName = (path: string) => {
    const field = path.split(".")[0] ?? path;
    return t(`chat.fields.${field}`, { defaultValue: path });
  };
  const fields = change.fields.slice(0, SHOWN_FIELDS).map(({ path, before, after }) => {
    const field = fieldName(path);
    if (after === undefined) return t("chat.summary.cleared", { field });
    if (before === undefined) return t("chat.summary.set", { field, after });
    return t("chat.summary.from", { field, before, after });
  });
  const more =
    change.fields.length > SHOWN_FIELDS
      ? [t("chat.summary.fieldsMore", { count: change.fields.length - SHOWN_FIELDS })]
      : [];
  return [head, ...fields, ...more].join("  ");
}

/** A question AI asked with aq_propose, which the newest task can still have answered. */
interface Question {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly detail?: string }[];
  readonly other: boolean;
}

function questionOf(group: TaskGroup): Question | undefined {
  const asked = group.entries.findLast(
    (entry) => entry.role === "tool" && entry.name === "aq_propose" && entry.ok,
  );
  const data = asked?.role === "tool" ? asked.data?.question : undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { question, options, allow_other: other } = data as Record<string, unknown>;
  if (typeof question !== "string" || !Array.isArray(options)) return undefined;
  const choices = options.flatMap((option: Record<string, unknown>) =>
    typeof option?.label === "string"
      ? [
          {
            label: option.label,
            ...(typeof option.detail === "string" && { detail: option.detail }),
          },
        ]
      : [],
  );
  return { question, options: choices, other: other !== false };
}

/** The question of AI, with its answers to pick: the pick goes as the next message. */
function QuestionView({ question }: { readonly question: Question }) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  return (
    <div className={styles.question} data-testid="chat-question" role="group">
      <div className={styles.muted}>{t("chat.question.title")}</div>
      <p className={styles.text}>{question.question}</p>
      <div className={styles.options}>
        {question.options.map(({ label, detail }) => (
          <button key={label} type="button" title={detail} onClick={() => void chat.send(label)}>
            {label}
            {detail && <span className={styles.muted}> · {detail}</span>}
          </button>
        ))}
      </div>
      {question.other && <p className={styles.muted}>{t("chat.question.other")}</p>}
    </div>
  );
}

function AnswerView({
  entry,
  results,
  running,
}: {
  readonly entry: AssistantEntry;
  readonly results: ReadonlyMap<string, ToolEntry>;
  readonly running: ConversationSnapshot["running"];
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.answer}>
      {entry.thinking && (
        <details className={styles.thinking} data-testid="chat-thinking">
          <summary>{t("chat.thinkingSummary")}</summary>
          {entry.thinking}
        </details>
      )}
      {entry.text && <p className={styles.text}>{entry.text}</p>}
      {entry.calls.map((call) => (
        <ToolView
          key={call.id}
          call={call}
          result={results.get(call.id)}
          active={running?.tool?.id === call.id}
        />
      ))}
    </div>
  );
}

function ToolView({
  call,
  result,
  active,
}: {
  readonly call: ToolCallEntry;
  readonly result: ToolEntry | undefined;
  readonly active: boolean;
}) {
  const { t } = useTranslation();
  const failed = result !== undefined && !result.ok;
  const [open, setOpen] = useState(false);
  const shown = open || failed;
  const label = t(`chat.tool.${call.name}` as "chat.tool.file_read", {
    defaultValue: commandOf(call.name),
  });
  const state =
    result === undefined ? (active ? "running" : "waiting") : result.ok ? "ok" : "failed";
  return (
    <div className={styles.tool} data-state={state} data-testid="chat-tool">
      <button
        type="button"
        className={styles.toolHead}
        onClick={() => setOpen(!open)}
        aria-expanded={shown}
      >
        <span className={styles.toolIcon}>
          {state === "ok" && <Check size={12} aria-label={t("chat.toolOk")} />}
          {state === "failed" && <X size={12} aria-label={t("chat.toolFailed")} />}
          {(state === "running" || state === "waiting") && (
            <LoaderCircle size={12} className={styles.spin} aria-label={t("chat.running")} />
          )}
        </span>
        <span className={styles.toolName}>{label}</span>
        <span className={styles.toolArgs}>{argsSummaryOf(call.args)}</span>
      </button>
      {shown && (
        <div className={styles.toolBody}>
          <div className={styles.muted}>{t("chat.args")}</div>
          <pre>{JSON.stringify(call.args, undefined, 2)}</pre>
          {result && (
            <>
              <div className={styles.muted}>{t("chat.result")}</div>
              <pre>{result.text}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function OutcomeView({
  outcome,
  maxToolCalls,
}: {
  readonly outcome: TaskOutcome;
  readonly maxToolCalls: number;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  switch (outcome.end) {
    case "stopped":
      return <p className={styles.notice}>{t("chat.stopped")}</p>;
    case "limit":
      return <p className={styles.notice}>{t("chat.limit", { count: maxToolCalls })}</p>;
    case "length":
      return <p className={styles.notice}>{t("chat.length")}</p>;
    case "failed": {
      const { advice, detail } = failureText(t, outcome.failure, {
        relayed: outcome.relayed === true,
        canRelay: ai.canRelay,
      });
      return (
        <div className={styles.failure} role="alert" data-testid="chat-failure">
          <p>{advice}</p>
          {detail && <p className={styles.muted}>{detail}</p>}
        </div>
      );
    }
    default:
      return null;
  }
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
