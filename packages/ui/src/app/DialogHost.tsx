import { useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { useWorkbench } from "./context.ts";
import styles from "./DialogHost.module.css";

/** The browser's own dialog: it keeps the focus inside and hands it back afterwards. */
function Dialog({ request }: { request: DialogRequest }) {
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
  const danger = request.kind === "confirm" && request.danger === true;
  const canConfirm = !isPrompt || value.trim().length > 0;
  const confirm = () => {
    if (canConfirm) dialogs.answer(isPrompt ? value.trim() : true);
  };
  const dismiss = () => dialogs.answer(isPrompt ? undefined : false);

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
      className={styles.dialog}
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
        {request.kind === "confirm" && <p>{request.message}</p>}
        {isPrompt && (
          <input
            ref={input}
            aria-label={request.title}
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <div className={styles.buttons}>
          {!(request.kind === "confirm" && request.noticeOnly) && (
            <button ref={cancel} type="button" onClick={dismiss}>
              {t("dialog.cancel")}
            </button>
          )}
          <button
            type="button"
            className={danger ? styles.danger : styles.primary}
            disabled={!canConfirm}
            onClick={confirm}
          >
            {request.confirm}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function DialogHost() {
  const { dialogs } = useWorkbench();
  const request = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot);
  return request ? <Dialog key={request.id} request={request} /> : null;
}
