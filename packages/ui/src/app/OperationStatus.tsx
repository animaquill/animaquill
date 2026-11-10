import { History } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { Operation } from "../workbench/operations.ts";
import { useWorkbench } from "./context.ts";
import { Bubble } from "./Bubble.tsx";
import { operationText } from "./operation-text.ts";
import styles from "./OperationStatus.module.css";
import { Tip } from "./Tip.tsx";

const when = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" });

/** What can be done with one operation from the list, or why nothing can. */
interface Choice {
  readonly label?: string;
  readonly run?: () => string | undefined;
  readonly why?: string;
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
  const [last] = list;
  const text = last ? operationText(t, last) : t("operations.none");
  const redoable = operations.redoable;

  const choiceOf = (operation: Operation): Choice => {
    switch (operation.source) {
      case "other":
        return { why: t("operations.why.other") };
      case "ai":
      case "folder":
        if (operations.canUndoOrigin(operation)) {
          const run = () => workbench.undoOperation(operation, "undo");
          return { label: t("operations.undoThis"), run };
        }
        if (operations.canRedoOrigin(operation)) {
          const run = () => workbench.undoOperation(operation, "redo");
          return { label: t("operations.redoThis"), run };
        }
        return { why: t("operations.why.originGone") };
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
                const name = operationText(t, operation);
                return (
                  <li
                    key={operation.id}
                    className={styles.item}
                    aria-label={name}
                    data-undone={operation.undone || undefined}
                  >
                    <span className={styles.name}>{name}</span>
                    <span className={styles.about}>
                      <span className={styles.source} data-source={operation.source}>
                        {t(`operations.source.${operation.source}`)}
                      </span>
                      <time dateTime={new Date(operation.time).toISOString()}>
                        {when.format(operation.time)}
                      </time>
                      {operation.undone && <span>{t("operations.undone")}</span>}
                    </span>
                    {choice.run ? (
                      <button
                        type="button"
                        className={styles.action}
                        onClick={() => {
                          setMessage(choice.run?.());
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
