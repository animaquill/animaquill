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
    panels: [...builtinPanels, ...(options.panels ?? [])],
    workspaces,
  });
  await workbench.layout.load();

  const root = createRoot(element);
  root.render(
    <StrictMode>
      <App workbench={workbench} i18n={i18n} />
    </StrictMode>,
  );

  // Pages can go away without warning, so hiding is the last reliable moment to save.
  const save = () => {
    if (document.visibilityState === "hidden") void workbench.layout.flush();
  };
  document.addEventListener("visibilitychange", save);

  return () => {
    document.removeEventListener("visibilitychange", save);
    root.unmount();
  };
}
