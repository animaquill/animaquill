import { ExternalLink, Lock, RefreshCw, Globe } from "lucide-react";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { unusableText } from "../cloud/repository-text.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { useWorkbench } from "./context.ts";
import host from "./DialogHost.module.css";
import styles from "./RepositoryDialog.module.css";

type RepositoryRequest = Extract<DialogRequest, { kind: "repository" }>;

/**
 * "存到 GitHub": a new private repository, or one people have, see `RepositoryPicker`. What cannot
 * be chosen stays in the list, grey, with why; nothing goes to GitHub until people press the button.
 */
export function RepositoryDialog({ request }: { request: RepositoryRequest }) {
  const { dialogs } = useWorkbench();
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

  const { mode, name, list, notInstalled, selected, publicConfirmed, working, failure } = snapshot;
  const dismiss = () => {
    if (!working) dialogs.answer(false);
  };
  const submit = async () => {
    if (await picker.submit()) dialogs.answer(true);
  };
  const { title } = request;
  const choice = picker.selectedChoice;
  const problem = mode === "create" ? snapshot.nameProblem : undefined;
  // An empty box is not wrong yet: it says so only once there was something in it.
  const showProblem = problem !== undefined && !(problem === "empty" && name === "");

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
        {picker.asking && <p>{t("repository.askIntro")}</p>}
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
          <>
            <div className={styles.modes} role="radiogroup" aria-label={t("repository.mode")}>
              {(["create", "existing"] as const).map((id) => (
                <label key={id} className={styles.mode}>
                  <input
                    type="radio"
                    name="repository-mode"
                    checked={mode === id}
                    onChange={() => picker.setMode(id)}
                  />
                  {t(id === "create" ? "repository.modeCreate" : "repository.modeExisting")}
                </label>
              ))}
            </div>

            {mode === "create" ? (
              <div className={styles.section}>
                <label className={styles.nameLabel}>
                  <span>{t("repository.name")}</span>
                  <input
                    ref={nameInput}
                    spellCheck={false}
                    autoComplete="off"
                    value={name}
                    aria-invalid={showProblem}
                    onChange={(event) => picker.setName(event.target.value)}
                  />
                </label>
                <p className={showProblem ? styles.problem : styles.hint} role="status">
                  {showProblem
                    ? t(`repository.nameProblem.${problem}`)
                    : picker.owner
                      ? t("repository.where", {
                          owner: picker.owner,
                          name: name.trim(),
                          interpolation: { escapeValue: false },
                        })
                      : t("repository.nameHint")}
                </p>
              </div>
            ) : (
              <div className={styles.section}>
                <div className={styles.toolbar}>
                  <span className={styles.toolbarTitle}>{t("repository.choices")}</span>
                  {list.manageUrl && (
                    <a
                      className={styles.toolbarLink}
                      href={list.manageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={12} />
                      {t("repository.manage")}
                    </a>
                  )}
                  <button
                    type="button"
                    className={styles.toolbarButton}
                    disabled={list.state === "loading"}
                    onClick={() => void picker.refresh()}
                  >
                    <RefreshCw size={12} />
                    {t("repository.refresh")}
                  </button>
                </div>
                <div
                  className={styles.choices}
                  role="radiogroup"
                  aria-label={t("repository.choices")}
                >
                  {list.repositories.map((each) => {
                    const reason = picker.unusable(each);
                    const refusal = snapshot.refused.get(each.id);
                    return (
                      <label
                        key={each.id}
                        className={styles.choice}
                        data-unusable={reason !== undefined || undefined}
                      >
                        <input
                          type="radio"
                          name="repository-choice"
                          checked={selected === each.id}
                          disabled={reason !== undefined}
                          onChange={() => picker.select(each.id)}
                        />
                        <span className={styles.choiceText}>
                          <span className={styles.choiceName}>
                            {each.fullName}
                            <span className={styles.badge}>
                              {each.private ? <Lock size={10} /> : <Globe size={10} />}
                              {t(each.private ? "repository.private" : "repository.public")}
                            </span>
                          </span>
                          {reason && (
                            <span className={styles.reason}>
                              {unusableText(reason, refusal, t)}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                  {list.state === "loading" && (
                    <p className={styles.note}>{t("repository.loading")}</p>
                  )}
                  {list.state === "failed" && (
                    <p className={styles.problem}>{t("repository.listFailed")}</p>
                  )}
                  {list.state === "ready" && list.repositories.length === 0 && (
                    <p className={styles.note}>{t("repository.nothing")}</p>
                  )}
                  {list.more && list.state === "ready" && (
                    <button
                      type="button"
                      className={styles.more}
                      onClick={() => void picker.more()}
                    >
                      {t("repository.more")}
                    </button>
                  )}
                </div>
                <p className={styles.hint}>{t("repository.orgs")}</p>
                {choice && !choice.private && (
                  <div className={styles.public} role="status">
                    <p>{t("repository.publicWarning")}</p>
                    <label className={styles.mode}>
                      <input
                        type="checkbox"
                        checked={publicConfirmed}
                        onChange={(event) => picker.confirmPublic(event.target.checked)}
                      />
                      {t("repository.publicConfirm")}
                    </label>
                  </div>
                )}
              </div>
            )}
          </>
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
            {picker.asking ? t("repository.later") : t("dialog.cancel")}
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
