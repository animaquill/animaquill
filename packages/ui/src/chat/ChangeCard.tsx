import type { ChatEntry, ToolEntry } from "@animaquill/agent";
import {
  aiTask,
  pathOfObject,
  type BeforeAfter,
  type ObjectRef,
  type Origin,
  type ProjectState,
} from "@animaquill/core";
import {
  Check,
  ChevronRight,
  ExternalLink,
  LocateFixed,
  PenLine,
  TriangleAlert,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { Tip } from "../app/Tip.tsx";
import styles from "./card.module.css";
import {
  othersOfTurn,
  placesOf,
  problemsOfTurn,
  summaryOf,
  type OtherRow,
  type TurnChange,
} from "./summary.ts";
import { changeLine, changeParts, fieldName } from "./change-line.ts";
import { mayOpen } from "./change-detail.ts";
import { ChangeDetailView, useDetail } from "./ChangeDetailView.tsx";
import type { Say } from "./toolSummary.ts";

/** The tools before these, which read, for the count of changes of an earlier conversation. */
const OLD_READ_TOOLS = new Set([
  "project_overview",
  "timeline_read",
  "selection_read",
  "file_read",
]);
/** What the card shows of what changed before it opens up. */
const SHOWN_CHANGES = 5;
const SHOWN_SAID = 3;
const SHOWN_FIELDS = 3;
/** How many objects the line of what others changed names. */
const SHOWN_OTHERS = 3;

/** Whether an object is still in the project, to go to it. */
function isThere(state: ProjectState | undefined, ref: ObjectRef): boolean {
  let node: unknown = state;
  for (const key of pathOfObject(ref)) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return false;
    node = (node as Record<string, unknown>)[key];
  }
  return node !== undefined;
}

/**
 * What a task did to the project, in one card under its answer (docs/design/chat-panel.md of
 * AnimaQuill Cloud, 5.5): how many places, "对比" that opens every row to before and after, taking
 * all of it back (or doing it again), the first thing AI said of it, each object with where it is,
 * what people or others changed meanwhile and whether AI kept it, and how the problems changed.
 */
export function ChangeCard({
  task,
  entries,
  running,
}: {
  readonly task: string;
  readonly entries: readonly ChatEntry[];
  readonly running: boolean;
}) {
  const workbench = useWorkbench();
  const { chat } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const [compare, setCompare] = useState(false);
  const summary = summaryOf(entries);
  const results = entries.filter((entry): entry is ToolEntry => entry.role === "tool");
  // Earlier conversations had tools that said nothing of what they changed: those count calls.
  const count = summary.told
    ? placesOf(summary)
    : results.filter(
        (result) => result.ok && !result.name.startsWith("aq_") && !OLD_READ_TOOLS.has(result.name),
      ).length;
  // What can be taken back changes with the project, and with what other windows did.
  useSyncExternalStore(workbench.undo.subscribe, workbench.undo.getSnapshot);
  const state = running ? undefined : workbench.undo.stateOf(aiTask(task));
  const undo = state?.direction;
  const whyNot = state?.whyNot;
  const others = othersOfTurn(entries);
  const problems = problemsOfTurn(entries);
  const problemsChanged = problems.added > 0 || problems.resolved > 0;
  const hasOthers = others.mine.length > 0 || others.elsewhere.length > 0;
  if (running || (count === 0 && !undo && !hasOthers && !problemsChanged)) return null;
  const shown = undo !== undefined || (whyNot !== undefined && count > 0);
  const origin = aiTask(task);
  // Only where a row can open to before and after: this device has the undo log of the task.
  const hasLog =
    store !== undefined && (store.canUndoOrigin(origin) || store.canRedoOrigin(origin));
  const comparable =
    summary.told && hasLog && summary.changes.some((change) => mayOpen(change) !== "never");
  // What AI said each batch does: the first under the title, the rest in "对比"; where nothing
  // compares (no undo log here), up to three under the title as before, the rest below them.
  const head = summary.said.slice(0, comparable ? 1 : SHOWN_SAID);
  const moreSaid = summary.said.slice(head.length);
  const undoName = undo === "redo" ? t("chat.redoTask") : t("chat.undoTask");
  return (
    <div className={styles.card} data-testid="chat-card" data-undone={undo === "redo" || undefined}>
      <div className={styles.head}>
        <span className={styles.title}>
          <PenLine size={13} aria-hidden />
          {count === 0
            ? t("chat.card.noChanges")
            : undo === "redo"
              ? t("chat.card.undone", { count })
              : t("chat.changes", { count })}
        </span>
        {comparable && (
          <button
            type="button"
            className={styles.textButton}
            aria-pressed={compare}
            data-testid="chat-card-compare"
            onClick={() => setCompare(!compare)}
          >
            {t("chat.card.compare")}
          </button>
        )}
        {shown && (
          <Tip name={undoName} usage={undo === "redo" || whyNot ? "" : t("chat.card.undoTitle")}>
            <button
              type="button"
              className={styles.textButton}
              data-testid="chat-card-undo"
              // What cannot go back here stays in its place, grey, its reason on a line of the card.
              aria-disabled={whyNot ? "true" : undefined}
              aria-describedby={whyNot ? `${task}-why-not` : undefined}
              onClick={() => {
                if (!whyNot) void (undo === "redo" ? chat.redoTask(task) : chat.undoTask(task));
              }}
            >
              {undoName}
            </button>
          </Tip>
        )}
      </div>
      {shown && whyNot && (
        <p className={styles.whyNot} id={`${task}-why-not`} data-testid="chat-card-why-not">
          {t(`chat.card.whyNot.${whyNot}`)}
        </p>
      )}
      {summary.told &&
        head.map((sentence, index) => (
          <p key={index} className={styles.said} data-testid="chat-card-said">
            {sentence}
          </p>
        ))}
      {summary.told && summary.changes.length + moreSaid.length > 0 && (
        <ChangesView
          task={task}
          said={compare || !comparable ? moreSaid : []}
          changes={summary.changes}
          allOpen={compare}
        />
      )}
      {others.mine.length > 0 && <OthersLine rows={others.mine} mine />}
      {others.elsewhere.length > 0 && <OthersLine rows={others.elsewhere} mine={false} />}
      {(problemsChanged || problems.checked !== undefined) && (
        <div className={styles.foot} data-testid="chat-card-problems">
          <Check size={12} aria-hidden className={styles.ok} />
          <span className={styles.grow}>
            {problemsChanged
              ? t("chat.card.problems", { added: problems.added, resolved: problems.resolved })
              : problems.checked === 0
                ? t("chat.card.checkedNone")
                : t("chat.card.checked", { count: problems.checked })}
          </span>
          <button
            type="button"
            className={styles.link}
            onClick={() => workbench.layout.openPanel("problems")}
          >
            {t("chat.card.openProblems")}
          </button>
        </div>
      )}
    </div>
  );
}

/** What people (or others) changed while the task ran, in one line that opens to the list. */
function OthersLine({
  rows,
  mine,
}: {
  readonly rows: readonly OtherRow[];
  readonly mine: boolean;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const [open, setOpen] = useState(false);
  const over = rows.filter((row) => row.overwritten);
  const listed = (over.length > 0 && mine ? over : rows).slice(0, SHOWN_OTHERS);
  const list = listed.map((row) => otherText(say, row)).join("、");
  const more = rows.length > SHOWN_OTHERS ? "…" : "";
  const line = !mine
    ? t("chat.card.elsewhere", { count: rows.length, list: list + more })
    : over.length > 0
      ? t("chat.card.mineOverwritten", { count: rows.length, over: over.length, list: list + more })
      : t("chat.card.mine", { count: rows.length, list: list + more });
  return (
    <div className={styles.others} data-testid="chat-card-others">
      <button
        type="button"
        className={styles.othersHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <TriangleAlert size={12} aria-hidden="true" className={styles.warn} />
        <span>{line}</span>
      </button>
      {open && (
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              {otherText(say, row)}
              {row.change.removed && t("chat.card.removedMark")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An object others changed, and which of its fields: "片段「标题」 位置". */
function otherText(say: Say, row: OtherRow): string {
  const { kind, id, name, fields } = row.change;
  const what = `${say(`chat.kinds.${kind}`)}${name ? `「${name}」` : ` ${id}`}`;
  const named = fields
    .slice(0, SHOWN_FIELDS)
    .map((path) => fieldName(say as unknown as TFunction, path));
  return named.length > 0 ? `${what} ${named.join("、")}` : what;
}

/**
 * What the batches of a turn did, as AI said it, and the objects they changed, a row each. A row
 * opens to what it changed before and after where this device has the undo log of the task, see
 * `ChangeDetailView`; without the log, or with nothing more to show, it does not. `allOpen` opens
 * every row at once ("对比"), each of which can still be closed. A change that waits for people to
 * allow it (S-D4) gives its own before and after (`seen`), and `origin` to tell it from what the
 * task did.
 */
export function ChangesView({
  task,
  said,
  changes,
  seen,
  origin: given,
  allOpen = false,
}: {
  readonly task: string;
  readonly said: readonly string[];
  readonly changes: readonly TurnChange[];
  readonly seen?: BeforeAfter;
  readonly origin?: Origin;
  readonly allOpen?: boolean;
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const [open, setOpen] = useState(false);
  const lines = open ? changes : changes.slice(0, SHOWN_CHANGES);
  const sentences = open ? said : said.slice(0, SHOWN_SAID);
  const origin = given ?? aiTask(task);
  // The card follows what can be taken back, which follows the undo logs, see `ChangeCard`.
  const hasLog =
    seen !== undefined ||
    (store !== undefined && (store.canUndoOrigin(origin) || store.canRedoOrigin(origin)));
  const indent = hasLog && lines.some((change) => mayOpen(change) !== "never");
  return (
    <div className={styles.changes} data-testid="chat-changes">
      {sentences.map((sentence, index) => (
        <p key={index} className={styles.said}>
          {sentence}
        </p>
      ))}
      {lines.map((change) => (
        <ChangeRow
          key={change.key}
          origin={origin}
          change={change}
          hasLog={hasLog}
          indent={indent}
          allOpen={allOpen}
          state={state}
          workbench={workbench}
          {...(seen && { seen })}
        />
      ))}
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

/**
 * One object a turn changed, in a row: the object, what of it, its value before and after (which a
 * narrow chat leaves to the row opened), and where it is. The whole sentence is what it is called.
 */
function ChangeRow({
  origin,
  change,
  hasLog,
  indent,
  allOpen,
  state,
  workbench,
  seen,
}: {
  readonly origin: Origin;
  readonly change: TurnChange;
  readonly hasLog: boolean;
  readonly indent: boolean;
  readonly allOpen: boolean;
  readonly state: ProjectState | undefined;
  readonly workbench: ReturnType<typeof useWorkbench>;
  readonly seen?: BeforeAfter;
}) {
  const { t } = useTranslation();
  // Opened or closed by people; else as "对比" says, which takes back what they did when it changes.
  const [own, setOwn] = useState<{ readonly open: boolean; readonly under: boolean }>();
  const open = own !== undefined && own.under === allOpen ? own.open : allOpen;
  const may = hasLog ? mayOpen(change) : "never";
  const found = useDetail(origin, change, may !== "never" && (open || may === "maybe"), seen);
  const opens = may === "surely" || (may === "maybe" && found !== undefined);
  const ref: ObjectRef = {
    kind: change.kind,
    id: change.id,
    ...(change.timeline !== undefined && { timeline: change.timeline }),
  };
  const there = change.change !== "removed" && isThere(state, ref);
  const pending = seen !== undefined;
  const sentence = changeLine(t, change, state, pending);
  const parts = changeParts(t, change, state, pending);
  const words = (
    <>
      <span className={styles.object}>{parts.object}</span>
      <span className={styles.what}>{parts.what}</span>
      {parts.after !== undefined && (
        <span className={styles.value} data-testid="chat-change-value">
          {parts.before !== undefined && `${parts.before} → `}
          <span className={styles.after}>{parts.after}</span>
        </span>
      )}
    </>
  );
  const opensCode = change.kind === "file" || change.kind === "scene";
  const goName = opensCode ? t("chat.summary.open") : t("chat.summary.locate");
  return (
    <div className={styles.row} data-testid="chat-change">
      <div
        className={styles.line}
        data-opens={opens || undefined}
        // Open, the values are in what opened: the row does not say them twice.
        data-open={(open && opens && found !== undefined) || undefined}
      >
        {opens ? (
          <button
            type="button"
            className={styles.open}
            aria-expanded={open}
            aria-label={sentence}
            title={sentence}
            onClick={() => setOwn({ open: !open, under: allOpen })}
          >
            <ChevronRight size={12} className={styles.twisty} aria-hidden="true" />
            {words}
          </button>
        ) : (
          <span
            className={styles.still}
            data-indent={indent || undefined}
            title={sentence}
            aria-label={sentence}
            role="group"
          >
            {words}
          </span>
        )}
        {change.change !== "removed" && change.kind !== "project" && (
          <Tip name={there ? goName : t("chat.summary.gone")} usage="">
            <button
              type="button"
              className={styles.go}
              disabled={!there}
              aria-label={goName}
              onClick={() => workbench.goToObject(ref)}
            >
              {opensCode ? (
                <ExternalLink size={12} aria-hidden />
              ) : (
                <LocateFixed size={13} aria-hidden />
              )}
            </button>
          </Tip>
        )}
      </div>
      {open && opens && found && (
        <ChangeDetailView origin={origin} change={change} detail={found.detail} seen={found.seen} />
      )}
    </div>
  );
}
