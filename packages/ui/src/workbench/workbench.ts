import type { Host } from "@animaquill/host";
import type { TFunction } from "i18next";
import { ActionRegistry } from "./actions.ts";
import { LayoutController, type WorkspaceDefinition } from "./layout.ts";
import { Notifications } from "./notifications.ts";
import { PanelRegistry, type PanelDefinition } from "./panels.ts";

export interface WorkbenchOptions {
  readonly host: Host;
  readonly t: TFunction;
  readonly version: string;
  readonly panels: readonly PanelDefinition[];
  readonly workspaces: readonly WorkspaceDefinition[];
}

/** The editor's frame, without any rendering, so that it can be tested on its own. */
export class Workbench {
  readonly t: TFunction;
  readonly version: string;
  readonly panels = new PanelRegistry();
  readonly actions = new ActionRegistry();
  readonly notifications = new Notifications();
  readonly layout: LayoutController;

  constructor({ host, t, version, panels, workspaces }: WorkbenchOptions) {
    this.t = t;
    this.version = version;
    this.layout = new LayoutController(host.settings, workspaces, {
      restoreFailed: () => this.notifications.push(t("notice.layoutRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.layoutSaveFailed")),
    });
    for (const panel of panels) this.panels.register(panel);
    this.#registerViewActions();
  }

  #registerViewActions(): void {
    for (const workspace of this.layout.workspaces) {
      this.actions.register({
        id: `view.workspace.${workspace.id}`,
        title: workspace.title,
        run: () => this.layout.switchWorkspace(workspace.id),
        menu: { name: "view", group: "workspaces" },
        selected: () => this.layout.getSnapshot().workspace === workspace.id,
      });
    }
    this.actions.register({
      id: "view.resetLayout",
      title: (t) => t("view.resetLayout"),
      run: () => this.layout.resetWorkspace(),
      menu: { name: "view", group: "layout" },
    });
    for (const panel of this.panels.list()) {
      this.actions.register({
        id: `view.open.${panel.type}`,
        title: panel.title,
        run: () => this.layout.openPanel(panel.type),
        menu: { name: "view", group: `panels.${panel.area}` },
      });
    }
  }
}
