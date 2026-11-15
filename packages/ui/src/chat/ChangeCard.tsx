import type { ChatEntry, ToolEntry } from "@animaquill/agent";
import { pathOfObject, type ObjectRef, type ProjectState } from "@animaquill/core";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import {
  othersOfTurn,
  problemsOfTurn,
  summaryOf,
  type OtherRow,
  type TurnChange,
} from "./summary.ts";
import { changeName } from "./objectName.ts";
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
 * What a task did to the project, in one card under its answer: how many places, taking all of it
 * back (or doing it again), what AI said each batch does, each object with where it is, what people
 * or others changed meanwhile and whether AI kept it, and how the problems changed. It stays open:
 * for people who edit, what changed and whether it can go back matters more than how AI went about it.
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
  const summary = summaryOf(entries);
  const results = entries.filter((entry): entry is ToolEntry => entry.role === "tool");
  // Earlier conversations had tools that said nothing of what they changed: those count calls.
  const count = summary.told
    ? summary.changes.length
    : results.filter(
        (result) => result.ok && !result.name.startsWith("aq_") && !OLD_READ_TOOLS.has(result.name),
      ).length;
  const undo = running ? undefined : chat.undoState(task);
  const others = othersOfTurn(entries);
  const problems = problemsOfTurn(entries);
  const problemsChanged = problems.added > 0 || problems.resolved > 0;
  const hasOthers = others.mine.length > 0 || others.elsewhere.length > 0;
  if (running || (count === 0 && !undo && !hasOthers && !problemsChanged)) return null;
  return (
    <div className={styles.card} data-testid="chat-card">
      <div className={styles.cardHead}>
        <span className={styles.cardTitle}>
          {count > 0 ? t("chat.changes", { count }) : t("chat.card.noChanges")}
        </span>
        {undo && (
          <button
            type="button"
            title={t("chat.card.undoTitle")}
            onClick={() => (undo === "undo" ? chat.undoTask(task) : chat.redoTask(task))}
          >
            {undo === "undo" ? t("chat.undoTask") : t("chat.redoTask")}
          </button>
        )}
      </div>
      {summary.told && summary.changes.length + summary.said.length > 0 && (
        <ChangesView said={summary.said} changes={summary.changes} />
      )}
      {others.mine.length > 0 && <OthersLine rows={others.mine} mine />}
      {others.elsewhere.length > 0 && <OthersLine rows={others.elsewhere} mine={false} />}
      {(problemsChanged || problems.checked !== undefined) && (
        <div className={styles.cardLine} data-testid="chat-card-problems">
          <span>
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
      <button type="button" className={styles.othersHead} onClick={() => setOpen(!open)}>
        <TriangleAlert size={12} aria-hidden="true" />
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
    .map((path) => say(`chat.fields.${path.split(".")[0] ?? path}`, { defaultValue: path }));
  return named.length > 0 ? `${what} ${named.join("、")}` : what;
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
            <span className={styles.changeText}>
              {changeText(t as unknown as Say, change, changeName(t, change, state))}
            </span>
            {change.change !== "removed" && change.kind !== "project" && (
              <button
                type="button"
                className={styles.link}
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

/** One change in a line: what it is, and how up to three of its fields changed. */
function changeText(say: Say, change: TurnChange, named: string | undefined): string {
  const t = say;
  const kind = t(`chat.kinds.${change.kind}`);
  const name = named ? `「${named}」` : "";
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
