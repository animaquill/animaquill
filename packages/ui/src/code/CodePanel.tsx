import { CodeXml, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { isDirty, type CodeDocument } from "./documents.ts";
import { loadCodeEditor } from "./load.ts";
import styles from "./CodePanel.module.css";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function DocumentTab({ document, active }: { document: CodeDocument; active: boolean }) {
  const { code } = useWorkbench();
  const { t } = useTranslation();
  const { path } = document;
  const dirty = isDirty(document);
  const name = nameOf(path);
  const closeOnMiddleClick = (event: MouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    void code.close(path);
  };
  return (
    <div
      className={styles.tab}
      data-active={active || undefined}
      data-dirty={dirty || undefined}
      title={path}
      onAuxClick={closeOnMiddleClick}
    >
      <button
        type="button"
        role="tab"
        className={styles.name}
        aria-selected={active}
        onClick={() => code.activate(path)}
      >
        {dirty ? t("code.unsavedName", { name }) : name}
      </button>
      <button
        type="button"
        className={styles.close}
        aria-label={t("code.closeFile", { name })}
        onClick={() => void code.close(path)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** The project moved on under what is in this tab. Nothing goes away until people say so. */
function ConflictBar({ document }: { document: CodeDocument }) {
  const { code } = useWorkbench();
  const { t } = useTranslation();
  const { path, conflict } = document;
  return (
    <div className={styles.conflict} role="alert">
      <span>{t(conflict === "removed" ? "code.conflictRemoved" : "code.conflictChanged")}</span>
      <button type="button" onClick={() => code.keepMine(path)}>
        {t("code.keepMine")}
      </button>
      <button type="button" onClick={() => code.takeTheirs(path)}>
        {t(conflict === "removed" ? "code.closeRemoved" : "code.takeTheirs")}
      </button>
    </div>
  );
}

type Stage = "loading" | "ready" | "failed";

interface EditorHostProps {
  readonly hidden: boolean;
  readonly onStage: (stage: Stage) => void;
}

/** Monaco is most of what it takes to edit code, and nobody needs it to open a project. */
function EditorHost({ hidden, onStage }: EditorHostProps) {
  const { code, problems, t } = useWorkbench();
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const editor = new AbortController();
    onStage("loading");
    loadCodeEditor().then(
      ({ CodeView }) => {
        if (editor.signal.aborted) return;
        const view = new CodeView(element, code, problems, t);
        editor.signal.addEventListener("abort", () => view.dispose());
        onStage("ready");
      },
      (error: unknown) => {
        console.warn("The code editor did not load", error);
        if (!editor.signal.aborted) onStage("failed");
      },
    );
    return () => editor.abort();
  }, [code, onStage, problems, t]);

  return <div ref={host} className={styles.editor} hidden={hidden} />;
}

export function CodePanel() {
  const { code } = useWorkbench();
  const { t } = useTranslation();
  const { documents, active } = useSyncExternalStore(code.subscribe, code.getSnapshot);
  const [stage, setStage] = useState<Stage>("loading");
  const [attempt, setAttempt] = useState(0);
  // It stays once it is there: tabs come and go, and starting it costs time.
  const [wanted, setWanted] = useState(false);
  if (documents.length > 0 && !wanted) setWanted(true);
  const current = documents.find(({ path }) => path === active);

  return (
    <div className={styles.panel}>
      {documents.length > 0 && (
        <div className={styles.tabs} role="tablist" aria-label={t("panel.code.title")}>
          {documents.map((document) => (
            <DocumentTab
              key={document.path}
              document={document}
              active={document.path === active}
            />
          ))}
        </div>
      )}
      {current?.conflict && <ConflictBar document={current} />}
      <div className={styles.stage}>
        {wanted && <EditorHost key={attempt} hidden={!current} onStage={setStage} />}
        {documents.length === 0 && (
          <div className={styles.message}>
            <CodeXml size={32} />
            <p>{t("code.empty")}</p>
          </div>
        )}
        {current && stage === "loading" && (
          <div className={styles.message} role="status">
            <p>{t("code.loading")}</p>
          </div>
        )}
        {current && stage === "failed" && (
          <div className={styles.message} role="alert">
            <p>{t("code.loadFailed")}</p>
            <button type="button" onClick={() => setAttempt(attempt + 1)}>
              {t("panel.retry")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
