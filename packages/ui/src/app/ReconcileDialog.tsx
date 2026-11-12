import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DialogRequest, FormAnswer } from "../workbench/dialogs.ts";
import { useWorkbench } from "./context.ts";
import styles from "./DialogHost.module.css";
import own from "./ReconcileDialog.module.css";

type ReconcileRequest = Extract<DialogRequest, { kind: "reconcile" }>;

/**
 * Which side each file of a project is to be, where two sides have it differently, see
 * `reconcile.ts`: one row a file, how the sides have it, and a choice of sides, with ways to choose
 * one side for all of them. Nothing happens until people say so.
 */
export function ReconcileDialog({ request }: { request: ReconcileRequest }) {
  const { dialogs } = useWorkbench();
  const { t } = useTranslation();
  const { title, message, items, all, notes, error, confirm } = request;
  const [values, setValues] = useState<FormAnswer>(() =>
    Object.fromEntries(items.map(({ path, value }) => [path, value])),
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    // Both sides may lose something: nothing happens by pressing Enter.
    cancel.current?.focus();
    return () => element?.close();
  }, []);

  const dismiss = () => dialogs.answer(undefined);
  const chooseAll = (side: string) =>
    setValues(
      Object.fromEntries(
        items.map(({ path, options, value }) => [
          path,
          options.some(({ id }) => id === side) ? side : (values[path] ?? value),
        ]),
      ),
    );
  return (
    <dialog
      ref={dialog}
      className={`${styles.wide} ${own.dialog}`}
      aria-label={title}
      data-reconcile
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className={styles.content}>
        <h2>{title}</h2>
        <p>{message}</p>
        <ul className={own.files}>
          {items.map(({ path, status, options }) => (
            <li key={path} className={own.file} data-path={path}>
              <span className={own.path} title={path}>
                {path}
              </span>
              <span className={own.status}>{status}</span>
              <span className={own.sides} role="radiogroup" aria-label={path}>
                {options.map(({ id, label }) => (
                  <label key={id} className={own.side}>
                    <input
                      type="radio"
                      name={path}
                      value={id}
                      checked={values[path] === id}
                      onChange={() => setValues({ ...values, [path]: id })}
                    />
                    {label}
                  </label>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <div className={own.all}>
          {all.map(({ id, label }) => (
            <button key={id} type="button" onClick={() => chooseAll(id)}>
              {label}
            </button>
          ))}
        </div>
        {notes.length > 0 && (
          <ul className={styles.notes}>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        {error !== undefined && (
          <p className={own.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.buttons}>
          <button ref={cancel} type="button" onClick={dismiss}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className={styles.primary} onClick={() => dialogs.answer(values)}>
            {confirm}
          </button>
        </div>
      </div>
    </dialog>
  );
}
