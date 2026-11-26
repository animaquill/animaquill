import { ExternalLink, Globe, LoaderCircle, Lock, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { momentText, unusableAdvice } from "../cloud/repository-text.ts";
import type { OpeningRow, RowState } from "../cloud/open-repository.ts";
import { formatSize } from "../transfer/transfer.ts";
import type { DialogRequest } from "../workbench/dialogs.ts";
import { useWorkbench } from "./context.ts";
import host from "./DialogHost.module.css";
import own from "./OpenRepositoryDialog.module.css";
import styles from "./RepositoryDialog.module.css";

type OpenRepositoryRequest = Extract<DialogRequest, { kind: "openRepository" }>;

/**
 * "从仓库打开", see `RepositoryOpening`: as the open dialog of any program, a list to select one in
 * and one button, whose words say what it does with the one selected; a double click is the button.
 * What cannot be chosen stays in the list, grey, with why.
 */
export function OpenRepositoryDialog({ request }: { request: OpenRepositoryRequest }) {
  const workbench = useWorkbench();
  const { dialogs } = workbench;
  const { t } = useTranslation();
  const { opening, title } = request;
  const snapshot = useSyncExternalStore(opening.subscribe, opening.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  // When the dialog came: what "3 天前" goes by.
  const [now] = useState(() => Date.now());

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    filter.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    void opening.refresh();
  }, [opening]);

  const { list, need, selected, source, manageUrl, more } = snapshot;
  const rows = opening.shown;
  const action = opening.action;
  const selectedState = selected === undefined ? undefined : snapshot.states.get(selected);
  const dismiss = () => dialogs.answer(undefined);
  const go = (row: OpeningRow | undefined = opening.selectedRow) => {
    const chosen = row && opening.stateOf(row);
    if (!row || chosen?.kind !== "action") return;
    dialogs.answer({ row, action: chosen.action });
  };
  const placed = (key: string) => (source === "local" ? `${key}_local` : key);
  const nameOf = (row: OpeningRow) =>
    row.kind === "github" ? row.choice.fullName : row.repository.name;

  const detailOf = (row: OpeningRow, state: RowState | undefined): string | undefined => {
    if (row.kind === "local") {
      const { archivedAt, bytes } = row.repository;
      return [
        archivedAt === undefined
          ? t("openRepository.neverArchived")
          : t("openRepository.archived", { time: momentText(archivedAt, now, t) }),
        formatSize(bytes ?? 0),
      ].join(" · ");
    }
    if (state?.kind === "unusable") {
      return unusableAdvice(row.choice, state.reason, state.refusal, t);
    }
    if (state?.kind === "action" && state.action.kind === "open") {
      return t("openRepository.isProject", {
        name: state.action.project.name,
        interpolation: { escapeValue: false },
      });
    }
    return undefined;
  };

  const buttonWords =
    action?.kind === "create" ? t("openRepository.createHere") : t("openRepository.open");

  return (
    <dialog
      ref={dialog}
      className={`${host.wide} ${own.dialog}`}
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
          go();
        }}
      >
        <h2>{title}</h2>
        {need ? (
          <div className={styles.install} role="status" data-open-need={need}>
            <p className={styles.strong}>{t(`cloud.connect.need.${need}`)}</p>
            {need === "installApp" && <p>{t("cloud.connect.need.installAdvice")}</p>}
            <button
              type="button"
              className={styles.installButton}
              onClick={() => void (need === "signIn" ? workbench.signIn() : workbench.installApp())}
            >
              {need === "signIn" ? t("cloud.connect.signIn") : t("cloud.connect.install")}
            </button>
          </div>
        ) : (
          <div className={styles.section}>
            <div className={styles.toolbar}>
              <input
                ref={filter}
                className={own.filter}
                type="search"
                aria-label={t("openRepository.filter")}
                placeholder={t("openRepository.filter")}
                spellCheck={false}
                autoComplete="off"
                value={snapshot.filter}
                onChange={(event) => opening.setFilter(event.target.value)}
              />
              {manageUrl && (
                <a
                  className={styles.toolbarLink}
                  href={manageUrl}
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
                disabled={list === "loading"}
                onClick={() => void opening.refresh()}
              >
                <RefreshCw size={12} />
                {t("repository.refresh")}
              </button>
            </div>
            <div
              className={`${styles.choices} ${own.choices}`}
              role="listbox"
              aria-label={t("openRepository.list")}
              tabIndex={rows.length > 0 ? 0 : -1}
              {...(selected !== undefined && { "aria-activedescendant": `open-repo-${selected}` })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  go();
                  return;
                }
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const usable = rows.filter((row) => opening.stateOf(row)?.kind !== "unusable");
                const index = usable.findIndex(({ id }) => id === selected);
                const next =
                  event.key === "ArrowDown"
                    ? usable[Math.min(index + 1, usable.length - 1)]
                    : usable[Math.max(index - 1, 0)];
                if (next) opening.select(next.id);
              }}
            >
              {rows.map((row) => {
                const state = opening.stateOf(row);
                const unusable = state?.kind === "unusable";
                const detail = detailOf(row, state);
                const isPublic = row.kind === "github" && !row.choice.private;
                return (
                  <div
                    key={row.id}
                    id={`open-repo-${row.id}`}
                    role="option"
                    aria-selected={selected === row.id}
                    aria-disabled={unusable || undefined}
                    className={`${styles.choiceRow} ${own.row}`}
                    data-unusable={unusable || undefined}
                    data-repository={nameOf(row)}
                    onClick={() => opening.select(row.id)}
                    onDoubleClick={() => go(row)}
                  >
                    <span className={`${styles.choice} ${own.choice}`}>
                      <span className={styles.choiceText}>
                        <span className={styles.choiceName}>
                          {nameOf(row)}
                          {row.kind === "github" && (
                            <span className={styles.badge}>
                              {isPublic ? <Globe size={10} /> : <Lock size={10} />}
                              {t(isPublic ? "repository.public" : "repository.private")}
                            </span>
                          )}
                          {state?.kind === "checking" && (
                            <LoaderCircle size={12} className={own.spin} aria-hidden />
                          )}
                        </span>
                        {detail && <span className={styles.reason}>{detail}</span>}
                      </span>
                    </span>
                  </div>
                );
              })}
              {list === "loading" && <p className={styles.note}>{t("repository.loading")}</p>}
              {list === "failed" && <p className={styles.problem}>{t("repository.listFailed")}</p>}
              {list === "ready" && snapshot.rows.length === 0 && (
                <p className={styles.note}>
                  {t(placed("openRepository.empty") as "openRepository.empty")}
                </p>
              )}
              {more && list === "ready" && (
                <button type="button" className={styles.more} onClick={() => void opening.more()}>
                  {t("repository.more")}
                </button>
              )}
            </div>
            {/* Only where the one people look for is not there, which is when it helps. */}
            {source === "github" && list === "ready" && rows.length === 0 && (
              <p className={styles.hint}>{t("repository.orgs")}</p>
            )}
          </div>
        )}

        <div className={host.buttons}>
          <button type="button" onClick={dismiss}>
            {t("dialog.cancel")}
          </button>
          {!need && (
            <button
              type="submit"
              className={host.primary}
              disabled={action === undefined}
              aria-busy={selectedState?.kind === "checking" || undefined}
            >
              {buttonWords}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
