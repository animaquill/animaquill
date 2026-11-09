import { CodeXml, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ResourcePage } from "../panels/ResourceDetails.tsx";
import { useResourceCatalog } from "../resources/catalog.ts";
import type { ResourceTab } from "../resources/pages.ts";
import { isDirty, type CodeDocument } from "./documents.ts";
import { loadCodeEditor } from "./load.ts";
import styles from "./CodePanel.module.css";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function DocumentTab({ document, active }: { document: CodeDocument; active: boolean }) {
  const { code, resourcePages } = useWorkbench();
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
        onClick={() => resourcePages.showCode(path)}
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

/** The tab of the details of a resource, named as the resource is now. */
function PageTab({
  id,
  name,
  active,
  names,
}: {
  id: string;
  name: string;
  active: boolean;
  names: ReadonlyMap<string, string>;
}) {
  const { resourcePages } = useWorkbench();
  const { t } = useTranslation();
  const shown = names.get(id) ?? name;
  return (
    <div
      className={styles.tab}
      data-active={active || undefined}
      title={shown}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        resourcePages.close(id);
      }}
    >
      <button
        type="button"
        role="tab"
        className={styles.name}
        aria-selected={active}
        onClick={() => resourcePages.show(id)}
      >
        {shown}
      </button>
      <button
        type="button"
        className={styles.close}
        aria-label={t("resourcePage.close", { name: shown })}
        onClick={() => resourcePages.close(id)}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * The tabs of what is open, in the order it was opened. Names come from what the project has now,
 * without looking for what is missing, which goes through every clip: a page of something missing
 * keeps the name it was opened with.
 */
function Tabs({
  tabs,
  page,
  documents,
  active,
}: {
  tabs: readonly ResourceTab[];
  page: string | undefined;
  documents: readonly CodeDocument[];
  active: string | undefined;
}) {
  const { t } = useTranslation();
  const hasPages = tabs.some((tab) => tab.kind === "resource");
  return (
    <div className={styles.tabs} role="tablist" aria-label={t("panel.code.title")}>
      {hasPages ? (
        <NamedTabs tabs={tabs} page={page} documents={documents} active={active} />
      ) : (
        documents.map((document) => (
          <DocumentTab
            key={document.path}
            document={document}
            active={page === undefined && document.path === active}
          />
        ))
      )}
    </div>
  );
}

function NamedTabs({
  tabs,
  page,
  documents,
  active,
}: {
  tabs: readonly ResourceTab[];
  page: string | undefined;
  documents: readonly CodeDocument[];
  active: string | undefined;
}) {
  const { byId } = useResourceCatalog({ missing: false });
  const names = new Map([...byId].map(([id, resource]) => [id, resource.name]));
  return tabs.map((tab) => {
    if (tab.kind === "resource") {
      return (
        <PageTab
          key={`page:${tab.id}`}
          id={tab.id}
          name={tab.name}
          active={tab.id === page}
          names={names}
        />
      );
    }
    const document = documents.find(({ path }) => path === tab.path);
    return document ? (
      <DocumentTab
        key={`code:${tab.path}`}
        document={document}
        active={page === undefined && tab.path === active}
      />
    ) : null;
  });
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

/**
 * The resources tab: the code of scenes and sounds in the code editor, and the details of any other
 * resource, each in a tab of its own inside. Its type stays `code`, which is what layouts that
 * people saved call it.
 */
export function CodePanel() {
  const { code, resourcePages } = useWorkbench();
  const { t } = useTranslation();
  const { documents, active } = useSyncExternalStore(code.subscribe, code.getSnapshot);
  const { tabs, page } = useSyncExternalStore(resourcePages.subscribe, resourcePages.getSnapshot);
  const [stage, setStage] = useState<Stage>("loading");
  const [attempt, setAttempt] = useState(0);
  // It stays once it is there: tabs come and go, and starting it costs time.
  const [wanted, setWanted] = useState(false);
  if (documents.length > 0 && !wanted) setWanted(true);
  const shownPage =
    page === undefined ? undefined : tabs.find((tab) => tab.kind === "resource" && tab.id === page);
  const current = shownPage ? undefined : documents.find(({ path }) => path === active);

  return (
    <div className={styles.panel}>
      {tabs.length > 0 && <Tabs tabs={tabs} page={page} documents={documents} active={active} />}
      {current?.conflict && <ConflictBar document={current} />}
      <div className={styles.stage}>
        {wanted && <EditorHost key={attempt} hidden={!current} onStage={setStage} />}
        {shownPage?.kind === "resource" && (
          <div className={styles.page} role="tabpanel">
            <ResourcePage key={shownPage.id} id={shownPage.id} name={shownPage.name} />
          </div>
        )}
        {tabs.length === 0 && (
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
