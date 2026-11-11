import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DialogRequest, FormAnswer, ProgressRequest } from "../workbench/dialogs.ts";
import { useWorkbench } from "./context.ts";
import { ConnectDialog } from "./ConnectDialog.tsx";
import styles from "./DialogHost.module.css";
import { RepositoryDialog } from "./RepositoryDialog.tsx";

/** Something that takes a while. It stays until that is over, whatever people press. */
function Progress({ request }: { request: ProgressRequest }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const { title, detail, ratio, amount, cancel, stopping, stopped, stop } = request;
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        stop();
      }}
    >
      <div className={styles.content}>
        <h2>{title}</h2>
        <p className={styles.detail}>{stopped ? stopping : (detail ?? "\u00A0")}</p>
        <progress
          className={styles.bar}
          aria-label={title}
          {...(ratio === undefined ? {} : { value: ratio })}
        />
        <div className={styles.buttons}>
          <span className={styles.amount}>{amount}</span>
          <button type="button" disabled={stopped} onClick={stop}>
            {cancel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

type FormRequest = Extract<DialogRequest, { kind: "form" }>;
type RepositoryRequest = Extract<DialogRequest, { kind: "repository" }>;
type ConnectRequest = Extract<DialogRequest, { kind: "connect" }>;
type QuestionRequest = Exclude<
  DialogRequest,
  ProgressRequest | FormRequest | RepositoryRequest | ConnectRequest
>;

/** Choices before something starts. A list each, because there are few options and no typing. */
function Form({ request }: { request: FormRequest }) {
  const { dialogs } = useWorkbench();
  const { t } = useTranslation();
  const [values, setValues] = useState<FormAnswer>(() =>
    Object.fromEntries(request.fields.map(({ id, value }) => [id, value])),
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    confirm.current?.focus();
    return () => element?.close();
  }, []);

  const dismiss = () => dialogs.answer(undefined);
  const { title, fields, notes = [] } = request;
  return (
    <dialog
      ref={dialog}
      className={styles.wide}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className={styles.content}>
        <h2>{title}</h2>
        <div className={styles.fields}>
          {fields.map(({ id, label, options }) => (
            <label key={id} className={styles.field}>
              <span>{label}</span>
              <select
                value={values[id]}
                onChange={(event) => setValues({ ...values, [id]: event.target.value })}
              >
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {notes.length > 0 && (
          <ul className={styles.notes}>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
        <div className={styles.buttons}>
          <button type="button" onClick={dismiss}>
            {t("dialog.cancel")}
          </button>
          <button
            ref={confirm}
            type="button"
            className={styles.primary}
            onClick={() => dialogs.answer(values)}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** The browser's own dialog: it keeps the focus inside and hands it back afterwards. */
function Dialog({ request }: { request: QuestionRequest }) {
  const { dialogs } = useWorkbench();
  const { t } = useTranslation();
  const [value, setValue] = useState(request.kind === "prompt" ? (request.value ?? "") : "");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  // A layout effect, because the dialog has to close while it is still on the page to hand the
  // focus back. A normal effect runs after React has removed it.
  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    // A dangerous action should not happen by pressing Enter once more.
    if (input.current) input.current.select();
    else cancel.current?.focus();
    return () => element?.close();
  }, []);

  const isPrompt = request.kind === "prompt";
  const isConfirm = request.kind === "confirm";
  const danger = isConfirm && request.danger === true;
  const details = request.kind === "confirm" ? (request.details ?? []) : [];
  const canConfirm = !isPrompt || request.allowEmpty === true || value.trim().length > 0;
  const confirm = () => {
    if (canConfirm) dialogs.answer(isPrompt ? value.trim() : true);
  };
  const dismiss = () => dialogs.answer(isConfirm ? false : undefined);

  const onKeyDown = (event: KeyboardEvent) => {
    // During composition Enter belongs to the input method.
    if (event.key === "Enter" && isPrompt && !event.nativeEvent.isComposing) {
      event.preventDefault();
      confirm();
    }
  };

  return (
    <dialog
      ref={dialog}
      className={details.length > 0 ? styles.wide : styles.dialog}
      aria-label={request.title}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      // The inner element fills the dialog, so what reaches the dialog itself is the backdrop.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <div className={styles.content} onKeyDown={onKeyDown}>
        <h2>{request.title}</h2>
        {!isPrompt && <p>{request.message}</p>}
        {details.map(({ title, items }) => (
          <section key={title} className={styles.list}>
            <h3>{title}</h3>
            <ul>
              {items.map((item, index) =>
                typeof item === "string" ? (
                  <li key={`${index}:${item}`}>{item}</li>
                ) : (
                  <li key={`${index}:${item.label}`}>
                    <button type="button" className={styles.link} onClick={item.show}>
                      {item.label}
                    </button>
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
        {isPrompt && (
          <input
            ref={input}
            aria-label={request.title}
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        {isPrompt && request.hint && <p className={styles.hint}>{request.hint}</p>}
        <div className={styles.buttons}>
          {!(isConfirm && request.noticeOnly) && (
            <button ref={cancel} type="button" onClick={dismiss}>
              {(isConfirm && request.cancel) || t("dialog.cancel")}
            </button>
          )}
          {request.kind === "choice" ? (
            request.choices.map(({ id, label, kind }) => (
              <button
                key={id}
                type="button"
                {...(kind ? { className: styles[kind] } : {})}
                onClick={() => dialogs.answer(id)}
              >
                {label}
              </button>
            ))
          ) : (
            <button
              type="button"
              className={danger ? styles.danger : styles.primary}
              disabled={!canConfirm}
              onClick={confirm}
            >
              {request.confirm}
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}

export function DialogHost() {
  const { dialogs } = useWorkbench();
  const request = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot);
  if (!request) return null;
  if (request.kind === "progress") return <Progress key={request.id} request={request} />;
  if (request.kind === "form") return <Form key={request.id} request={request} />;
  if (request.kind === "repository") return <RepositoryDialog key={request.id} request={request} />;
  if (request.kind === "connect") return <ConnectDialog key={request.id} request={request} />;
  return <Dialog key={request.id} request={request} />;
}
