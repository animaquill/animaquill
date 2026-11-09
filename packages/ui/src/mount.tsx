import "./theme/tokens.css";
import type { Host } from "@animaquill/host";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { watchPage } from "./diagnostics/errors.ts";
import { createI18n } from "./i18n/i18n.ts";
import { builtinPanels } from "./panels/builtin.tsx";
import type { PanelDefinition } from "./workbench/panels.ts";
import { Workbench } from "./workbench/workbench.ts";
import { layouts } from "./workbench/layouts.ts";
import { workerHasher } from "./media/hasher.ts";
import { workerProxyMaker } from "./proxy/maker.ts";

export interface EditorOptions {
  readonly host: Host;
  /** Shown in the status bar, so that a report can say which build it is about. */
  readonly version: string;
  /** The page with the compositor, on a site of its own where that is possible. */
  readonly compositorUrl: string;
  /**
   * Where scenes run, each with an origin of its own, and none where the compositor is. Without
   * them scenes show a placeholder.
   */
  readonly sceneOrigins?: readonly string[];
  /** For development: runs scenes as normal pages, without capture. */
  readonly sceneStage?: "plain";
  /** For tests: how long code gets to make a sound. */
  readonly soundLimitMs?: number;
  /** For tests: how long making a proxy waits after each frame, to see one on its way. */
  readonly proxyFrameMs?: number;
  /** Panels the host adds to the built-in ones. */
  readonly panels?: readonly PanelDefinition[];
  /** For tests: what no control can do yet, such as changing code. */
  readonly onWorkbench?: (workbench: Workbench) => void;
}

/** Starts the editor in an element. Returns how to remove it again. */
export async function mountEditor(element: HTMLElement, options: EditorOptions) {
  const i18n = await createI18n();
  const workbench = new Workbench({
    host: options.host,
    t: i18n.t,
    version: options.version,
    platform: /Mac/.test(navigator.platform) ? "mac" : "other",
    panels: [...builtinPanels, ...(options.panels ?? [])],
    layouts,
    compositorUrl: options.compositorUrl,
    sceneOrigins: options.sceneOrigins ?? [],
    ...(options.sceneStage && { sceneStage: options.sceneStage }),
    ...(options.soundLimitMs !== undefined && { soundLimitMs: options.soundLimitMs }),
    // A large video takes a while to hash, and the page goes on meanwhile.
    hasher: workerHasher(),
    // The same for making smaller copies of large videos for the preview.
    proxyMaker: workerProxyMaker({ frameMs: options.proxyFrameMs }),
  });
  // Before anything else runs, so that whatever fails from here on is caught.
  const stopWatching = watchPage(workbench.errors, workbench.diagnostics, options.compositorUrl);
  await workbench.load();
  options.onWorkbench?.(workbench);

  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App workbench={workbench} i18n={i18n} />
    </StrictMode>,
  );
  void workbench.resume();

  // Pages can go away without warning, so hiding is the last reliable moment to save.
  const save = () => {
    if (document.visibilityState !== "hidden") return;
    void workbench.layout.flush();
    workbench.timeline.flush();
    workbench.keyframes.flush();
    // What is in the log is safe, and the folder should have it too, should the page not come back.
    void workbench.projectFolders?.flush();
  };
  document.addEventListener("visibilitychange", save);

  // People come back from their files, where they may have taken proxies away.
  const lookAgain = () => void workbench.proxies?.lookAgain();
  window.addEventListener("focus", lookAgain);

  // A dialog has to be answered first: nothing behind it should change in the meantime.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!workbench.dialogs.getSnapshot()) workbench.keybindings.handle(event);
  };
  window.addEventListener("keydown", onKeyDown);

  // A file dropped next to where it can go would replace the whole page.
  const keepFiles = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  };
  // A folder dropped anywhere else opens as a project, where projects are folders. What a panel
  // takes, such as assets, it has taken already.
  const openDropped = (event: DragEvent) => {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes("Files")) return;
    const taken = event.defaultPrevented;
    event.preventDefault();
    if (!taken && !workbench.dialogs.getSnapshot()) workbench.projectFolders?.dropped(transfer);
  };
  window.addEventListener("dragover", keepFiles);
  window.addEventListener("drop", openDropped);

  // Leaving now would lose work, which the browser can still ask about.
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    const { code, session, transfer, trials, videos, projectFolders } = workbench;
    // An export that stops halfway can go on after a reload, but its sound has to catch up first.
    const exporting = videos.getSnapshot() !== undefined;
    // A project that is moving into a folder stays in the browser, and the folder has half of it.
    const moving = projectFolders?.moving === true;
    const atRisk =
      session.hasUnsavedChanges || transfer.running || trials.notKept || exporting || moving;
    if (atRisk || code.hasUnsaved) event.preventDefault();
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    window.removeEventListener("drop", openDropped);
    window.removeEventListener("dragover", keepFiles);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("visibilitychange", save);
    window.removeEventListener("focus", lookAgain);
    workbench.proxies?.dispose();
    root.unmount();
    stopWatching();
  };
}
