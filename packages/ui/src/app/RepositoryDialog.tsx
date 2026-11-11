import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { CloudProjectsSnapshot } from "../cloud/projects.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { useWorkbench } from "./context.ts";
import host from "./DialogHost.module.css";
import styles from "./RepositoryDialog.module.css";
import { RepositoryFields } from "./RepositoryFields.tsx";

type RepositoryRequest = Extract<DialogRequest, { kind: "repository" }>;

/**
 * Another repository for a project of the platform ("换一个仓库…"): a new private one, or one
 * people have, see `RepositoryFields`. Nothing goes to GitHub until people press the button. The
 * first repository of a project is chosen where it is connected, see `ConnectDialog`.
 */
export function RepositoryDialog({ request }: { request: RepositoryRequest }) {
  const { dialogs, cloud } = useWorkbench();
  const linked = useSyncExternalStore(
    cloud?.subscribe ?? noSubscription,
    cloud?.getSnapshot ?? none,
  );
  const { t } = useTranslation();
  const { picker, installApp } = request;
  const snapshot = useSyncExternalStore(picker.subscribe, picker.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    nameInput.current?.focus();
    nameInput.current?.select();
    return () => element?.close();
  }, []);

  const { mode, notInstalled, working, failure } = snapshot;
  const dismiss = () => {
    if (!working) dialogs.answer(false);
  };
  const submit = async () => {
    if (await picker.submit()) dialogs.answer(true);
  };
  const { title } = request;

  return (
    <dialog
      ref={dialog}
      className={host.wide}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <form
        className={host.content}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2>{title}</h2>
        <p>{t("repository.intro")}</p>
        {picker.current && <p>{t("repository.switchNote")}</p>}

        {notInstalled ? (
          <div className={styles.install} role="status">
            <p className={styles.strong}>{t("repository.notInstalled")}</p>
            <p>{t("repository.installAdvice")}</p>
            {installApp && (
              <button type="button" className={styles.installButton} onClick={installApp}>
                {t("repository.install")}
              </button>
            )}
          </div>
        ) : (
          <RepositoryFields
            picker={picker}
            nameInput={nameInput}
            {...(linked.kind === "linked" && { project: linked.link.project })}
            onOpenProject={
              cloud &&
              (({ id, name }) => {
                dialogs.answer(false);
                void cloud.openCloudProject(id, { name });
              })
            }
          />
        )}

        {failure && (
          <p className={styles.problem} role="alert">
            {failure in FAILURES
              ? t(`repository.failure.${failure as keyof typeof FAILURES}`)
              : t("repository.failure.other", { code: failure })}
          </p>
        )}

        <div className={host.buttons}>
          <button type="button" onClick={dismiss} disabled={working}>
            {t("dialog.cancel")}
          </button>
          {!notInstalled && (
            <button type="submit" className={host.primary} disabled={!picker.canSubmit}>
              {t(mode === "create" ? "repository.create" : "repository.useExisting")}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}

const noSubscription = () => () => {};
const NONE: CloudProjectsSnapshot = { kind: "none" };
const none = () => NONE;

/** The refusals that have words of their own; the others say their code. */
const FAILURES = {
  nameTaken: true,
  invalidName: true,
  alreadyLinked: true,
  notFound: true,
  signedOut: true,
  busy: true,
  unavailable: true,
} as const;
