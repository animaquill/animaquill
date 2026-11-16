import { Check, Circle, LoaderCircle } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { CatchUp, OpeningStep } from "../workbench/opening.ts";
import { useProject, useSession, useWorkbench } from "./context.ts";
import styles from "./OpeningView.module.css";

type RowState = "done" | "running" | "waiting";

const ORDER: readonly OpeningStep[] = ["log", "cloud", "folder", "live"];

/**
 * Opening a project, step by step (the design of the start page of AnimaQuill Cloud, screen G4):
 * the records of this computer, what the platform has, the folder; each ticked as it is done,
 * and how the platform went where it did not catch up. Over the editor until it is live; it shows
 * only where that takes a moment (see the CSS), as most openings are over at once. No words
 * beyond the steps and their states.
 */
export function OpeningView() {
  const { opening, projectFolders } = useWorkbench();
  const { t } = useTranslation();
  const { store, key } = useSession();
  const project = useProject(store);
  const snapshot = useSyncExternalStore(opening.subscribe, opening.getSnapshot);
  const isOpening =
    snapshot.key !== undefined &&
    snapshot.key === key &&
    snapshot.step !== undefined &&
    snapshot.step !== "live";
  if (!isOpening || !project) return null;
  const at = ORDER.indexOf(snapshot.step ?? "log");
  const stateOf = (step: OpeningStep): RowState => {
    const index = ORDER.indexOf(step);
    return index < at ? "done" : index === at ? "running" : "waiting";
  };
  const cloudWord = (cloud: CatchUp | undefined): string | undefined =>
    cloud === "offline"
      ? t("repoMerge.opening.offline")
      : cloud === "timeout"
        ? t("repoMerge.opening.slow")
        : cloud === "failed"
          ? t("repoMerge.opening.failed")
          : undefined;
  type Row = { id: OpeningStep; label: string; state: RowState; word: string | undefined };
  const rows: Row[] = [
    { id: "log", label: t("repoMerge.opening.log"), state: stateOf("log"), word: undefined },
  ];
  if (snapshot.cloud !== "none")
    rows.push({
      id: "cloud",
      label: t("repoMerge.opening.cloud"),
      state: stateOf("cloud"),
      word: cloudWord(snapshot.cloud),
    });
  if (key !== undefined && projectFolders?.holds(key) === true)
    rows.push({
      id: "folder",
      label: t("repoMerge.opening.folder"),
      state: stateOf("folder"),
      word: undefined,
    });
  return (
    <div className={styles.page} role="status" aria-live="polite" data-opening={snapshot.step}>
      <div className={styles.box}>
        <h2>{t("repoMerge.opening.title", { name: project.manifest.name })}</h2>
        <ol className={styles.steps}>
          {rows.map((row) => (
            <li key={row.id} data-step={row.id} data-state={row.word ? "said" : row.state}>
              {row.state === "done" ? (
                <Check size={14} aria-hidden="true" className={styles.done} />
              ) : row.state === "running" ? (
                <LoaderCircle size={14} aria-hidden="true" className={styles.running} />
              ) : (
                <Circle size={14} aria-hidden="true" className={styles.waiting} />
              )}
              <span>{row.label}</span>
              {row.word && <span className={styles.word}>{row.word}</span>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
