import { CircleCheck, CircleX, FileCode, TriangleAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { canGoTo, type ListedProblem } from "./list.ts";
import styles from "./ProblemsPanel.module.css";

/** Goes by file, like the list is sorted. What is about no file is a group of its own. */
function byFile(problems: readonly ListedProblem[]) {
  const groups = new Map<string | undefined, ListedProblem[]>();
  for (const problem of problems) {
    const group = groups.get(problem.file);
    if (group) group.push(problem);
    else groups.set(problem.file, [problem]);
  }
  return [...groups];
}

function Row({ problem }: { problem: ListedProblem }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { severity, text, line, column, place, origin, action } = problem;
  const Icon = severity === "error" ? CircleX : TriangleAlert;
  const where = line === undefined ? place : t("problems.position", { line, column: column ?? 1 });
  return (
    <li className={styles.item}>
      <button
        type="button"
        className={styles.row}
        disabled={!canGoTo(problem)}
        data-severity={severity}
        onClick={() => workbench.goToProblem(problem)}
      >
        <Icon size={14} className={styles.icon} />
        <span className={styles.text}>{text}</span>
        {problem.problem?.affectsOutput && (
          <span className={styles.output} title={t("problems.affectsOutputHint")}>
            {t("problems.affectsOutput")}
          </span>
        )}
        <span className={styles.origin}>{origin}</span>
        {where !== undefined && <span className={styles.where}>{where}</span>}
      </button>
      {action && (
        <button type="button" className={styles.action} onClick={action.run}>
          {action.label}
        </button>
      )}
    </li>
  );
}

export function ProblemsPanel() {
  const { problems } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(problems.subscribe, problems.getSnapshot);
  const { imported } = snapshot;

  if (snapshot.problems.length === 0) {
    return (
      <div className={styles.none}>
        <CircleCheck size={16} />
        {t("problems.none")}
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {imported && (
        <div className={styles.toolbar}>
          <button type="button" onClick={() => problems.clearImport()}>
            {t("problems.clearImport")}
          </button>
        </div>
      )}
      <ul className={styles.groups} aria-label={t("panel.problems.title")}>
        {byFile(snapshot.problems).map(([file, listed]) => (
          <li key={file ?? ""}>
            <div className={styles.file}>
              <FileCode size={14} />
              <span>{file ?? t("problems.noFile")}</span>
              <span className={styles.count}>{listed.length}</span>
            </div>
            <ul>
              {listed.map((problem) => (
                <Row key={problem.id} problem={problem} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
