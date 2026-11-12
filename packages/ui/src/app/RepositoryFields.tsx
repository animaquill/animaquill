import { ExternalLink, Globe, Lock, RefreshCw } from "lucide-react";
import { useSyncExternalStore, type Ref } from "react";
import { useTranslation } from "react-i18next";
import type { RepositoryPicker } from "../cloud/repository-picker.ts";
import { choiceNote, linkedProjectOf, unusableAdvice } from "../cloud/repository-text.ts";
import styles from "./RepositoryDialog.module.css";

/**
 * Choosing a repository, as every dialog that asks for one shows it, see `RepositoryPicker`: a new
 * private one by a name GitHub takes, or one people have. What cannot be chosen stays in the
 * list, grey, with why and the way out where there is one (the design of the start page, 5); what
 * the platform says about the choice shows before people go on, where the dialog asks it.
 */
export function RepositoryFields({
  picker,
  project,
  disabled = false,
  nameInput,
  onOpenProject,
  onRestore,
}: {
  readonly picker: RepositoryPicker;
  /**
   * The project of the platform that the repository is chosen for, where it is there already: a
   * repository the platform says is of a project of the person's is of this one, which is not
   * another to open in its place.
   */
  readonly project?: string | undefined;
  /** While the dialog works on what was chosen. */
  readonly disabled?: boolean;
  readonly nameInput?: Ref<HTMLInputElement>;
  /** Opens the project that a repository of the list is saved for already, in place of this one. */
  readonly onOpenProject?:
    ((project: { readonly id: string; readonly name: string }) => void) | undefined;
  /**
   * Makes a repository of the list that has a project at its top a project of the platform, in
   * place of choosing it here, see `CloudProjects.restoreFromRepository`.
   */
  readonly onRestore?:
    | ((repository: {
        readonly id: number;
        readonly fullName: string;
        readonly public: boolean;
      }) => void)
    | undefined;
}) {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(picker.subscribe, picker.getSnapshot);
  const { mode, owner, name, list, selected, publicConfirmed, checking, checked } = snapshot;
  const choice = picker.selectedChoice;
  const problem = mode === "create" ? snapshot.nameProblem : undefined;
  // An empty box is not wrong yet: it says so only once there was something in it.
  const showProblem = problem !== undefined && !(problem === "empty" && name === "");
  const isBusy = disabled || snapshot.working;
  const note = choice && !picker.unusable(choice) ? choiceNote(choice, t) : undefined;

  return (
    <>
      <div className={styles.modes} role="radiogroup" aria-label={t("repository.mode")}>
        {(["create", "existing"] as const).map((id) => (
          <label key={id} className={styles.mode}>
            <input
              type="radio"
              name="repository-mode"
              checked={mode === id}
              disabled={isBusy}
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
              disabled={isBusy}
              aria-invalid={showProblem}
              onChange={(event) => picker.setName(event.target.value)}
            />
          </label>
          <p
            className={showProblem ? styles.problem : styles.hint}
            role="status"
            data-check={
              showProblem ? "problem" : checking ? "checking" : checked ? "ok" : undefined
            }
          >
            {showProblem
              ? t(`repository.nameProblem.${problem}`)
              : [
                  owner
                    ? t("repository.where", {
                        owner,
                        name: name.trim(),
                        interpolation: { escapeValue: false },
                      })
                    : t("repository.nameHint"),
                  ...(checking ? [t("cloud.connect.checking")] : []),
                  ...(checked ? [t("cloud.connect.nameOk")] : []),
                ].join(" · ")}
          </p>
          {picker.nameMovedOn && !showProblem && (
            <p className={styles.hint}>{t("cloud.connect.nameMoved")}</p>
          )}
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
              disabled={list.state === "loading" || isBusy}
              onClick={() => void picker.refresh()}
            >
              <RefreshCw size={12} />
              {t("repository.refresh")}
            </button>
          </div>
          <div className={styles.choices} role="radiogroup" aria-label={t("repository.choices")}>
            {list.repositories.map((each) => {
              const refusal = snapshot.refused.get(each.id);
              const said = picker.unusable(each);
              const linkedTo = said === "linked" ? linkedProjectOf(each, refusal) : undefined;
              // The repository of this very project, as the platform has it already.
              const isOwn = linkedTo !== undefined && linkedTo.id === project;
              const reason = isOwn ? "current" : said;
              const itsProject = isOwn ? undefined : linkedTo;
              return (
                <div
                  key={each.id}
                  className={styles.choiceRow}
                  data-unusable={reason !== undefined || undefined}
                  data-repository={each.fullName}
                >
                  <label className={styles.choice}>
                    <input
                      type="radio"
                      name="repository-choice"
                      checked={selected === each.id}
                      disabled={reason !== undefined || isBusy}
                      onChange={() => picker.select(each.id)}
                    />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceName}>
                        {each.fullName}
                        <span className={styles.badge}>
                          {picker.isPublic(each) ? <Globe size={10} /> : <Lock size={10} />}
                          {t(picker.isPublic(each) ? "repository.public" : "repository.private")}
                        </span>
                      </span>
                      {reason && (
                        <span className={styles.reason}>
                          {unusableAdvice(each, reason, refusal, t)}
                        </span>
                      )}
                    </span>
                  </label>
                  {itsProject && onOpenProject && (
                    <button
                      type="button"
                      className={styles.openLinked}
                      disabled={isBusy}
                      onClick={() => onOpenProject(itsProject)}
                    >
                      {t("repository.openLinked")}
                    </button>
                  )}
                  {reason === "hasProject" && onRestore && (
                    <button
                      type="button"
                      className={styles.openLinked}
                      disabled={isBusy}
                      data-restore={each.fullName}
                      onClick={() =>
                        onRestore({
                          id: each.id,
                          fullName: each.fullName,
                          public: picker.isPublic(each),
                        })
                      }
                    >
                      {t("repository.restore")}
                    </button>
                  )}
                </div>
              );
            })}
            {list.state === "loading" && <p className={styles.note}>{t("repository.loading")}</p>}
            {list.state === "failed" && (
              <p className={styles.problem}>{t("repository.listFailed")}</p>
            )}
            {list.state === "ready" && list.repositories.length === 0 && (
              <p className={styles.note}>{t("repository.nothing")}</p>
            )}
            {list.more && list.state === "ready" && (
              <button type="button" className={styles.more} onClick={() => void picker.more()}>
                {t("repository.more")}
              </button>
            )}
          </div>
          <p className={styles.hint}>{t("repository.orgs")}</p>
          {choice && (checking || checked || note) && (
            <p
              className={styles.hint}
              role="status"
              data-check={checking ? "checking" : checked ? "ok" : undefined}
            >
              {[
                ...(checking ? [t("cloud.connect.checking")] : []),
                ...(checked ? [t("cloud.connect.repositoryOk")] : []),
                ...(note ? [note] : []),
              ].join(" · ")}
            </p>
          )}
          {choice && picker.isPublic(choice) && (
            <div className={styles.public} role="status">
              <p>{t("repository.publicWarning")}</p>
              <label className={styles.mode}>
                <input
                  type="checkbox"
                  checked={publicConfirmed}
                  disabled={isBusy}
                  onChange={(event) => picker.confirmPublic(event.target.checked)}
                />
                {t("repository.publicConfirm")}
              </label>
            </div>
          )}
        </div>
      )}
    </>
  );
}
