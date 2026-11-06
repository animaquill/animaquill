import "./theme/tokens.css";
import type { Host } from "@animaquill/host";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { createI18n } from "./i18n/i18n.ts";
import { builtinPanels } from "./panels/builtin.tsx";
import type { PanelDefinition } from "./workbench/panels.ts";
import { Workbench } from "./workbench/workbench.ts";
import { workspaces } from "./workbench/workspaces.ts";

export interface EditorOptions {
  readonly host: Host;
  /** Shown in the status bar, so that a report can say which build it is about. */
  readonly version: string;
  /** The page with the compositor, on a site of its own where that is possible. */
  readonly compositorUrl: string;
  /** Panels the host adds to the built-in ones. */
  readonly panels?: readonly PanelDefinition[];
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
    workspaces,
    compositorUrl: options.compositorUrl,
  });
  await workbench.load();

  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App workbench={workbench} i18n={i18n} />
    </StrictMode>,
  );

  // Pages can go away without warning, so hiding is the last reliable moment to save.
  const save = () => {
    if (document.visibilityState !== "hidden") return;
    void workbench.layout.flush();
    workbench.timeline.flush();
  };
  document.addEventListener("visibilitychange", save);

  // A dialog has to be answered first: nothing behind it should change in the meantime.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!workbench.dialogs.getSnapshot()) workbench.keybindings.handle(event);
  };
  window.addEventListener("keydown", onKeyDown);

  // A file dropped next to where it can go would replace the whole page.
  const keepFiles = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  };
  window.addEventListener("dragover", keepFiles);
  window.addEventListener("drop", keepFiles);

  // Leaving now would lose work, which the browser can still ask about.
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (workbench.session.hasUnsavedChanges) event.preventDefault();
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    window.removeEventListener("drop", keepFiles);
    window.removeEventListener("dragover", keepFiles);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("visibilitychange", save);
    root.unmount();
  };
}
