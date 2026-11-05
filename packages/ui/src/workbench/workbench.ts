import type { Host } from "@animaquill/host";
import type { TFunction } from "i18next";
import { ActionRegistry } from "./actions.ts";
import { KeybindingService } from "./keybindings.ts";
import type { Platform } from "./keys.ts";
import { LayoutController, type WorkspaceDefinition } from "./layout.ts";
import { Notifications } from "./notifications.ts";
import { CommandPalette } from "./palette.ts";
import { PanelRegistry, type PanelDefinition } from "./panels.ts";

export interface WorkbenchOptions {
  readonly host: Host;
  readonly t: TFunction;
  readonly version: string;
  readonly platform: Platform;
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
  readonly keybindings: KeybindingService;
  readonly palette: CommandPalette;

  constructor({ host, t, version, platform, panels, workspaces }: WorkbenchOptions) {
    this.t = t;
    this.version = version;
    this.layout = new LayoutController(host.settings, workspaces, {
      restoreFailed: () => this.notifications.push(t("notice.layoutRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.layoutSaveFailed")),
    });
    this.keybindings = new KeybindingService(host.settings, this.actions, platform, {
      restoreFailed: () => this.notifications.push(t("notice.keybindingsRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.keybindingsSaveFailed")),
    });
    this.palette = new CommandPalette(host.settings, this.actions);
    for (const panel of panels) this.panels.register(panel);
    this.#registerViewActions();
  }

  async load(): Promise<void> {
    await Promise.all([this.layout.load(), this.keybindings.load(), this.palette.load()]);
  }

  #registerViewActions(): void {
    this.actions.register({
      id: "view.commandPalette",
      title: (t) => t("palette.title"),
      run: () => this.palette.toggle(),
      keys: ["mod+shift+p", "f1"],
      menu: { name: "view", group: "commands" },
      palette: false,
    });
    this.layout.workspaces.forEach((workspace, index) => {
      this.actions.register({
        id: `view.workspace.${workspace.id}`,
        title: (t) => t("action.switchWorkspace", { workspace: workspace.title(t) }),
        run: () => this.layout.switchWorkspace(workspace.id),
        keys: [`alt+${index + 1}`],
        menu: { name: "view", group: "workspaces", title: workspace.title },
        selected: () => this.layout.getSnapshot().workspace === workspace.id,
      });
    });
    this.actions.register({
      id: "view.resetLayout",
      title: (t) => t("view.resetLayout"),
      run: () => this.layout.resetWorkspace(),
      menu: { name: "view", group: "layout" },
    });
    for (const panel of this.panels.list()) {
      this.actions.register({
        id: `view.open.${panel.type}`,
        title: (t) => t("action.openPanel", { panel: panel.title(t) }),
        run: () => this.layout.openPanel(panel.type),
        ...(panel.keys ? { keys: panel.keys } : {}),
        menu: { name: "view", group: `panels.${panel.area}`, title: panel.title },
      });
    }
  }
}
