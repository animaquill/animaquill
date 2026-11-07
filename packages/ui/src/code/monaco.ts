// oxlint-disable import/default, import/no-named-as-default -- `?worker` is something Vite makes
import * as monaco from "monaco-editor/editor/editor.api.js";
// All of the features of the editor that are not languages, such as finding and folding.
import "monaco-editor/internal/common/workers.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/language/css/monaco.contribution.js";
import "monaco-editor/language/html/monaco.contribution.js";
import { javascriptDefaults } from "monaco-editor/languages/features/typescript/register.js";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import type { TFunction } from "i18next";
import type { ProblemList } from "../problems/list.ts";
import type { CodeDocument, CodeDocuments, CodeSnapshot } from "./documents.ts";

/**
 * This file is the only one that knows Monaco, and it comes with the code panel, not with the page.
 * It comes through `load.ts`, which brings the messages of the editor first.
 * Everything that matters about open files is in `CodeDocuments`: this shows them, and says what
 * people typed.
 */

/** Workers are files of this site, which is the only place the policy of the site lets them be. */
(
  globalThis as { MonacoEnvironment?: { getWorker(id: string, label: string): Worker } }
).MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "css") return new CssWorker();
    if (label === "html") return new HtmlWorker();
    if (label === "javascript" || label === "typescript") return new TypeScriptWorker();
    return new EditorWorker();
  },
};

/** What a scene has that no browser describes, see the scene runtime. */
const SCENE_API = `
interface AqView {
  /** Width of the clip box in world units, which are CSS pixels here. */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly format: string;
  readonly language: string;
}
declare const aq: {
  /** The version of the runtime. */
  readonly runtime: number;
  readonly view: AqView;
  /** The address of an asset. Write the id as a literal, or the editor cannot find it. */
  asset(id: string): string;
  /** Called with the time in seconds. Returns how to stop that. */
  frame(callback: (seconds: number) => void): () => void;
};
`;

const LANGUAGES: Readonly<Record<string, string>> = {
  css: "css",
  htm: "html",
  html: "html",
  svg: "html",
  cjs: "javascript",
  js: "javascript",
  mjs: "javascript",
};

const languageOf = (path: string) =>
  LANGUAGES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "plaintext";

const THEME = "animaquill";

function defineTheme(): void {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  monaco.editor.defineTheme(THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": token("--aq-bg-panel"),
      "editorWidget.background": token("--aq-bg-menu"),
      "editorWidget.border": token("--aq-border"),
      focusBorder: token("--aq-accent"),
    },
  });
}

let configured = false;

/** What goes for all of Monaco, which is one thing per page. */
function configure(): void {
  if (configured) return;
  configured = true;
  defineTheme();
  // Scenes are plain JavaScript in a page with globals nobody declares, so all it can say about
  // types is noise. What it says about syntax is real.
  javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
  });
  javascriptDefaults.addExtraLib(SCENE_API, "aq.d.ts");
  // This key opens the command palette of the editor around it.
  monaco.editor.addKeybindingRules([
    { keybinding: monaco.KeyCode.F1, command: "-editor.action.quickCommand" },
  ]);
}

interface OpenFile {
  readonly model: monaco.editor.ITextModel;
  /** The last text from outside that it took over. */
  version: number;
  /** Where people were, for coming back to this tab. */
  state: monaco.editor.ICodeEditorViewState | null;
}

const uriOf = (path: string) => monaco.Uri.from({ scheme: "file", path: `/${path}` });

const SEVERE = new Set([monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning]);

/** The editor in the code panel. */
export class CodeView {
  readonly #editor: monaco.editor.IStandaloneCodeEditor;
  readonly #code: CodeDocuments;
  readonly #problems: ProblemList;
  readonly #origin: string;
  readonly #files = new Map<string, OpenFile>();
  readonly #stop: readonly (() => void)[];
  #shown: string | undefined;
  #revealed = 0;
  /** True while text from outside goes in, which is not people typing. */
  #applying = false;

  constructor(host: HTMLElement, code: CodeDocuments, problems: ProblemList, t: TFunction) {
    configure();
    this.#code = code;
    this.#problems = problems;
    this.#origin = t("problems.origin.editor");
    this.#editor = monaco.editor.create(host, {
      model: null,
      theme: THEME,
      automaticLayout: true,
      // Suggestions and hovers need more room than a panel has.
      fixedOverflowWidgets: true,
      // With this the keys go to a textarea, which is what the shortcuts of the editor around it
      // take for text entry.
      editContext: false,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "Consolas, 'Cascadia Mono', Menlo, 'DejaVu Sans Mono', monospace",
      tabSize: 2,
      scrollBeyondLastLine: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    const markers = monaco.editor.onDidChangeMarkers((uris) => this.#noteMarkers(uris));
    const stopCode = code.subscribe(this.#sync);
    this.#stop = [stopCode, () => markers.dispose()];
    this.#sync();
  }

  dispose(): void {
    for (const stop of this.#stop) stop();
    for (const [path, { model }] of this.#files) {
      this.#problems.setFile(path, []);
      model.dispose();
    }
    this.#files.clear();
    this.#editor.dispose();
  }

  focus(): void {
    this.#editor.focus();
  }

  #sync = (): void => {
    const { documents, active, reveal } = this.#code.getSnapshot();
    const open = new Set(documents.map(({ path }) => path));
    for (const [path, { model }] of this.#files) {
      if (open.has(path)) continue;
      if (this.#shown === path) this.#show(undefined);
      this.#files.delete(path);
      this.#problems.setFile(path, []);
      model.dispose();
    }
    for (const document of documents) this.#follow(document);
    this.#show(active);
    this.#reveal(reveal);
  };

  #follow({ path, text, version }: CodeDocument): void {
    const file = this.#files.get(path);
    if (!file) {
      const model = monaco.editor.createModel(text, languageOf(path), uriOf(path));
      model.onDidChangeContent(() => {
        if (!this.#applying) this.#code.edit(path, model.getValue());
      });
      this.#files.set(path, { model, version, state: null });
      return;
    }
    if (file.version === version) return;
    file.version = version;
    const { model } = file;
    this.#applying = true;
    // As an edit of its own, so that what people had is one undo away.
    model.pushStackElement();
    model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
    model.pushStackElement();
    this.#applying = false;
  }

  #show(path: string | undefined): void {
    if (path === this.#shown) return;
    const before = this.#shown === undefined ? undefined : this.#files.get(this.#shown);
    if (before) before.state = this.#editor.saveViewState();
    this.#shown = path;
    const file = path === undefined ? undefined : this.#files.get(path);
    this.#editor.setModel(file?.model ?? null);
    if (file?.state) this.#editor.restoreViewState(file.state);
  }

  #reveal(reveal: CodeSnapshot["reveal"]): void {
    if (!reveal || reveal.request === this.#revealed || reveal.path !== this.#shown) return;
    this.#revealed = reveal.request;
    const { line, column = 1 } = reveal;
    const position = this.#editor.getModel()?.validatePosition({ lineNumber: line, column }) ?? {
      lineNumber: 1,
      column: 1,
    };
    this.#editor.setPosition(position);
    this.#editor.revealPositionInCenter(position);
    this.#editor.focus();
  }

  #noteMarkers(uris: readonly monaco.Uri[]): void {
    for (const uri of uris) {
      const path = uri.path.slice(1);
      if (!this.#files.has(path)) continue;
      const problems = monaco.editor
        .getModelMarkers({ resource: uri })
        .filter(({ severity }) => SEVERE.has(severity))
        .map(({ severity, message, startLineNumber, startColumn }) => ({
          severity:
            severity === monaco.MarkerSeverity.Error ? ("error" as const) : ("warning" as const),
          text: message,
          file: path,
          line: startLineNumber,
          column: startColumn,
          origin: this.#origin,
        }));
      this.#problems.setFile(path, problems);
    }
  }
}
