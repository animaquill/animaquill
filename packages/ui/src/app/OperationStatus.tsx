import { History } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { Operation } from "../workbench/operations.ts";
import { useWorkbench } from "./context.ts";
import { Bubble } from "./Bubble.tsx";
import { operationText } from "./operation-text.ts";
import { toolName } from "../workbench/tool-activity.ts";
import { batchWhyKey } from "../cloud/batch-undo.ts";
import styles from "./OperationStatus.module.css";
import { Tip } from "./Tip.tsx";

const when = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" });
const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** What can be done with one operation from the list, or why nothing can. */
interface Choice {
  readonly label?: string;
  /** What it says comes in the list, or as a notification where it takes a moment. */
  readonly run?: () => string | undefined | Promise<unknown>;
  readonly why?: string;
  /** It can be done elsewhere, or could before: the button is there, grey, and says why. */
  readonly off?: boolean;
  /** It asks people first, in a dialog of its own: the list goes out of the way. */
  readonly asks?: boolean;
}

/**
 * The last thing that changed the project, in a few words, and the way to what happened before:
 * a list of the latest operations, with who did them and when, where people take back what they
 * did here up to a step, an AI task or a batch of files as a whole, and do again what they took
 * back last. Each window lists what it can take back.
 */
export function OperationStatus() {
  const workbench = useWorkbench();
  const { operations } = workbench;
  const { t } = useTranslation();
  const list = useSyncExternalStore(operations.subscribe, operations.getSnapshot);
  const [anchor, setAnchor] = useState<DOMRect>();
  const [message, setMessage] = useState<string>();
  const listElement = useRef<HTMLOListElement>(null);
  // Re-rendered as AI tools on this computer change the project, which names their operations.
  useSyncExternalStore(workbench.tools.subscribe, workbench.tools.getSnapshot);
  // And as what can be taken back changes, also in other windows, and what the platform says of
  // merges.
  useSyncExternalStore(workbench.undo.subscribe, workbench.undo.getSnapshot);
  useSyncExternalStore(workbench.batchUndo.subscribe, workbench.batchUndo.getSnapshot);
  const toolOf = (operation: Operation) => {
    const batch = operation.source === "ai" ? workbench.tools.batchOf(operation.origin) : undefined;
    if (batch) {
      const { startedAt: from, updatedAt: to } = batch;
      return { from, to, name: toolName(t, batch.client), count: batch.changes.length };
    }
    // A batch from before the page was loaded, as it was kept.
    const { tool, from = operation.time, time: to, count } = operation;
    return tool === undefined ? undefined : { from, to, name: tool, count };
  };
  const nameOf = (operation: Operation) => operationText(t, operation, toolOf(operation));
  const [last] = list;
  const text = last ? nameOf(last) : t("operations.none");
  const redoable = operations.redoable;

  const choiceOf = (operation: Operation): Choice => {
    switch (operation.source) {
      case "other":
        return { why: t("operations.why.other") };
      // A merge of GitHub's goes back as a whole on the platform (2E); files people chose to take
      // out never come back.
      case "github": {
        const { batches } = operation;
        if (operation.dropped || !batches || batches.length === 0) return {};
        const { direction, why } = workbench.batchUndo.stateOf(batches, operation.undone);
        if (!direction) return why === undefined ? {} : { why: t(batchWhyKey(why)) };
        const label = direction === "redo" ? t("operations.redoThis") : t("operations.undoThis");
        if (why !== undefined) return { label, off: true, why: t(batchWhyKey(why)) };
        return {
          label,
          ...(direction === "undo" && { asks: true }),
          run: () => workbench.batchUndo.takeBack(batches, direction, operation.count),
        };
      }
      // A rename on the start page goes back as a whole on the platform too, without asking: it
      // is one name.
      case "rename": {
        const { batches } = operation;
        if (!batches || batches.length === 0) return {};
        const { direction, why } = workbench.batchUndo.stateOf(batches, operation.undone);
        if (!direction) return why === undefined ? {} : { why: t(batchWhyKey(why)) };
        const label = direction === "redo" ? t("operations.redoThis") : t("operations.undoThis");
        if (why !== undefined) return { label, off: true, why: t(batchWhyKey(why)) };
        return {
          label,
          run: () => workbench.batchUndo.takeBack(batches, direction, 1, { asks: false }),
        };
      }
      case "ai":
      case "folder": {
        if (operation.origin === undefined) return { why: t("operations.why.originGone") };
        const { direction, whyNot } = workbench.undo.stateOf(operation.origin);
        const label = direction === "redo" ? t("operations.redoThis") : t("operations.undoThis");
        if (whyNot) return { label, off: true, why: t(`operations.why.${whyNot}`) };
        if (direction) return { label, run: () => workbench.undoOperation(operation, direction) };
        return { why: t("operations.why.originGone") };
      }
      case "you":
        if (operation.undone) {
          return operation === redoable
            ? { label: t("operations.redo"), run: () => workbench.redoLast() }
            : { why: t("operations.why.redoFirst") };
        }
        return operations.canUndoTo(operation)
          ? { label: t("operations.undoTo"), run: () => workbench.undoTo(operation) }
          : { why: t("operations.why.gone") };
    }
  };

  return (
    <>
      <Tip name={t("operations.label")} usage={t("operations.usage")}>
        <button
          type="button"
          className={styles.status}
          aria-haspopup="dialog"
          aria-label={`${t("operations.label")}：${text}`}
          onClick={(event) => {
            setMessage(undefined);
            setAnchor(event.currentTarget.getBoundingClientRect());
          }}
        >
          <History size={12} />
          <span className={styles.text}>{text}</span>
        </button>
      </Tip>
      {anchor && (
        <Bubble anchor={anchor} title={t("operations.title")} onClose={() => setAnchor(undefined)}>
          {list.length === 0 ? (
            <p className={styles.empty}>{t("operations.none")}</p>
          ) : (
            <ol
              ref={listElement}
              className={styles.list}
              aria-label={t("operations.listLabel")}
              tabIndex={-1}
            >
              {list.map((operation) => {
                const choice = choiceOf(operation);
                const name = nameOf(operation);
                const tool = toolOf(operation);
                return (
                  <li
                    key={operation.id}
                    className={styles.item}
                    aria-label={name}
                    data-undone={operation.undone || undefined}
                  >
                    <span className={styles.name}>{name}</span>
                    <span className={styles.about}>
                      {/* A rename on the start page says where it was in its name already. */}
                      {operation.source !== "rename" && (
                        <span className={styles.source} data-source={operation.source}>
                          {tool
                            ? t("localAi.source")
                            : // What people chose to take out is their doing, not GitHub's.
                              t(
                                `operations.source.${operation.dropped ? "you" : operation.source}`,
                              )}
                        </span>
                      )}
                      {tool ? (
                        <time dateTime={new Date(tool.from).toISOString()}>
                          {clock.format(tool.from) === clock.format(tool.to)
                            ? clock.format(tool.from)
                            : `${clock.format(tool.from)}–${clock.format(tool.to)}`}
                        </time>
                      ) : (
                        <time dateTime={new Date(operation.time).toISOString()}>
                          {when.format(operation.time)}
                        </time>
                      )}
                      {operation.undone && <span>{t("operations.undone")}</span>}
                    </span>
                    {choice.off ? (
                      <Tip name={choice.why ?? ""} usage="">
                        <button type="button" className={styles.action} aria-disabled="true">
                          {choice.label}
                        </button>
                      </Tip>
                    ) : choice.run ? (
                      <button
                        type="button"
                        className={styles.action}
                        onClick={() => {
                          if (!choice.run) return;
                          if (choice.asks) {
                            setAnchor(undefined);
                            void choice.run();
                            return;
                          }
                          const said = choice.run();
                          setMessage(typeof said === "string" ? said : undefined);
                          // Its button goes with what it did: the keys stay in the list, for Escape.
                          requestAnimationFrame(() => {
                            if (!listElement.current?.contains(document.activeElement)) {
                              listElement.current?.focus({ preventScroll: true });
                            }
                          });
                        }}
                      >
                        {choice.label}
                      </button>
                    ) : (
                      <span className={styles.why}>{choice.why}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {message !== undefined && (
            <p className={styles.message} role="status">
              {message}
            </p>
          )}
        </Bubble>
      )}
    </>
  );
}
