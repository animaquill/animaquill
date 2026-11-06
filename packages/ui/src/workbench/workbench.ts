import type { Host, ProjectLibrary } from "@animaquill/host";
import type { TFunction } from "i18next";
import { projectFrameRate, type ProjectStore } from "@animaquill/core";
import type { ProjectSummary } from "@animaquill/host";
import { MediaLibrary } from "../media/library.ts";
import { registerTimelineActions } from "../timeline/actions.ts";
import { TimelineEditor } from "../timeline/editor.ts";
import { ActionRegistry } from "./actions.ts";
import { Dialogs } from "./dialogs.ts";
import { InputMode } from "./input-mode.ts";
import { KeybindingService } from "./keybindings.ts";
import type { Platform } from "./keys.ts";
import { LayoutController, type WorkspaceDefinition } from "./layout.ts";
import { Notifications } from "./notifications.ts";
import { CommandPalette } from "./palette.ts";
import { ProjectSession } from "./session.ts";
import { PanelRegistry, type PanelDefinition } from "./panels.ts";

export interface WorkbenchOptions {
  readonly host: Host;
  readonly t: TFunction;
  readonly version: string;
  readonly platform: Platform;
  readonly panels: readonly PanelDefinition[];
  readonly workspaces: readonly WorkspaceDefinition[];
  readonly compositorUrl: string;
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
  readonly dialogs = new Dialogs();
  readonly session: ProjectSession;
  readonly timeline: TimelineEditor;
  readonly input: InputMode;
  readonly media: MediaLibrary;
  readonly projects: ProjectLibrary;
  /** Where the page with the compositor is. A site of its own keeps it apart from the editor. */
  readonly compositorUrl: string;
  #changingProject = false;

  constructor(options: WorkbenchOptions) {
    const { host, t, version, platform, panels, workspaces, compositorUrl } = options;
    this.t = t;
    this.version = version;
    this.projects = host.projects;
    this.compositorUrl = compositorUrl;
    this.layout = new LayoutController(host.settings, host.windowMemory, workspaces, {
      restoreFailed: () => this.notifications.push(t("notice.layoutRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.layoutSaveFailed")),
    });
    this.keybindings = new KeybindingService(host.settings, this.actions, platform, {
      restoreFailed: () => this.notifications.push(t("notice.keybindingsRestoreFailed")),
      saveFailed: () => this.notifications.push(t("notice.keybindingsSaveFailed")),
    });
    this.layout.subscribe(() => this.keybindings.notePanel(this.layout.getSnapshot().active));
    this.palette = new CommandPalette(host.settings, this.actions);
    this.session = new ProjectSession(host.projects, host.address, {
      createFailed: () => this.notifications.push(t("notice.projectCreateFailed")),
      notFound: () => this.notifications.push(t("notice.projectNotFound")),
      openFailed: () => this.notifications.push(t("notice.projectOpenFailed")),
      tooNew: () => this.notifications.push(t("notice.projectTooNew")),
      damaged: () => this.notifications.push(t("notice.projectDamaged")),
      saveFailed: () => this.notifications.push(t("notice.projectSaveFailed")),
      saveRecovered: () => this.notifications.push(t("notice.projectSaveRecovered")),
    });
    this.input = new InputMode(host.settings);
    this.media = new MediaLibrary(this.session, host.projects, {
      unsupported: (name) => this.notifications.push(t("notice.mediaUnsupported", { name })),
      tooLarge: (name) => this.notifications.push(t("notice.mediaTooLarge", { name })),
      saveFailed: (name) => this.notifications.push(t("notice.mediaSaveFailed", { name })),
    });
    this.timeline = new TimelineEditor(this.session, host.windowMemory, host.settings, {
      commandFailed: (message) => this.notifications.push(t("notice.commandFailed", { message })),
    });
    for (const panel of panels) this.panels.register(panel);
    this.#registerProjectActions();
    this.#registerEditActions();
    this.#registerViewActions();
    this.#registerHelpActions();
    registerTimelineActions(this.actions, this.timeline);
  }

  async load(): Promise<void> {
    await Promise.all([
      this.layout.load(),
      this.keybindings.load(),
      this.palette.load(),
      this.timeline.load(),
      this.input.load(),
    ]);
    await this.session.restore();
  }

  async newProject(): Promise<void> {
    const { t } = this;
    const name = await this.dialogs.prompt({
      title: t("project.nameLabel"),
      value: t("project.defaultName"),
      confirm: t("project.create"),
    });
    if (name) await this.#changeProject(() => this.session.create(name));
  }

  async openProject(id: string): Promise<void> {
    await this.#changeProject(() => this.session.open(id));
  }

  /** Back to the start page. */
  async closeProject(): Promise<void> {
    await this.#changeProject();
  }

  async renameProject(): Promise<void> {
    const { store } = this.session;
    if (!store) return;
    const { t } = this;
    const name = await this.dialogs.prompt({
      title: t("project.nameLabel"),
      value: store.getState().manifest.name,
      confirm: t("project.rename"),
    });
    if (!name) return;
    const result = store.execute({ type: "project.rename", params: { name } });
    if (!result.ok) {
      this.notifications.push(t("notice.commandFailed", { message: result.error.message }));
    }
  }

  /** Sets the rate of editing. Formats keep the rates they are exported at. */
  applyFrameRate(fps: string): boolean {
    const result = this.session.store?.execute({
      type: "project.setFrameRate",
      params: { fps: fps.trim() },
    });
    return result?.ok === true;
  }

  /** Asks for a frame rate that is not on the list. */
  async setFrameRate(): Promise<void> {
    const { store } = this.session;
    if (!store) return;
    const { t } = this;
    const fps = await this.dialogs.prompt({
      title: t("project.frameRateLabel"),
      value: projectFrameRate(store.getState().manifest),
      confirm: t("project.frameRateConfirm"),
    });
    if (fps && !this.applyFrameRate(fps)) this.notifications.push(t("notice.frameRateInvalid"));
  }

  async showAbout(): Promise<void> {
    const { t, version } = this;
    await this.dialogs.confirm({
      title: t("about.title"),
      message: t("about.message", { version }),
      confirm: t("about.close"),
      noticeOnly: true,
    });
  }

  /** Resolves to whether the project was removed. */
  async removeProject(project: ProjectSummary): Promise<boolean> {
    const { t } = this;
    const confirmed = await this.dialogs.confirm({
      title: t("project.removeTitle", { name: project.name }),
      message: t("project.removeWarning"),
      confirm: t("project.remove"),
      danger: true,
    });
    if (!confirmed) return false;
    try {
      await this.session.remove(project.id);
      return true;
    } catch (error) {
      console.warn("Project could not be removed", error);
      this.notifications.push(t("notice.projectRemoveFailed"));
      return false;
    }
  }

  /**
   * Leaves the open project, then does the next thing. Whatever comes next can fail, and then the
   * start page is a clear place to be. One at a time, because a double click must not open a
   * project twice.
   */
  async #changeProject(next?: () => Promise<unknown>): Promise<void> {
    if (this.#changingProject) return;
    this.#changingProject = true;
    try {
      if (await this.#leaveProject()) await next?.();
    } finally {
      this.#changingProject = false;
    }
  }

  /** Resolves to false when people would rather stay with what could not be saved. */
  async #leaveProject(): Promise<boolean> {
    if (!this.session.store) return true;
    if (!(await this.session.trySave())) {
      const { t } = this;
      const leave = await this.dialogs.confirm({
        title: t("project.unsavedTitle"),
        message: t("project.unsavedWarning"),
        confirm: t("project.leaveAnyway"),
        danger: true,
      });
      if (!leave) return false;
    }
    await this.layout.detach();
    await this.session.close();
    return true;
  }

  #registerProjectActions(): void {
    const isOpen = () => this.session.store !== undefined;
    this.actions.register({
      id: "project.new",
      title: (t) => t("project.new"),
      run: () => void this.newProject(),
      menu: { name: "file", group: "open" },
    });
    this.actions.register({
      id: "project.close",
      title: (t) => t("project.close"),
      run: () => void this.closeProject(),
      menu: { name: "file", group: "open" },
      enabled: isOpen,
    });
    // Every change is saved right away. Still, people press this out of habit, and the browser
    // would answer with its dialog for saving the web page.
    this.actions.register({
      id: "project.save",
      title: (t) => t("project.save"),
      run: () => void this.session.trySave(),
      keys: ["mod+s"],
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.rename",
      title: (t) => t("project.renameAction"),
      run: () => void this.renameProject(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.importMedia",
      title: (t) => t("assets.importAction"),
      run: () => void this.media.pickFiles(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
    this.actions.register({
      id: "project.frameRate",
      title: (t) => t("project.frameRate"),
      run: () => void this.setFrameRate(),
      menu: { name: "file", group: "project" },
      enabled: isOpen,
    });
  }

  #registerHelpActions(): void {
    this.actions.register({
      id: "help.about",
      title: (t) => t("about.title"),
      run: () => void this.showAbout(),
      menu: { name: "help", group: "about" },
    });
  }

  #stepThroughHistory(step: (store: ProjectStore) => boolean): void {
    const { store } = this.session;
    if (store && !step(store)) this.notifications.push(this.t("notice.undoFailed"));
  }

  #registerEditActions(): void {
    this.actions.register({
      id: "edit.undo",
      title: (t) => t("edit.undo"),
      run: () => this.#stepThroughHistory((store) => store.undo()),
      keys: ["mod+z"],
      menu: { name: "edit", group: "history" },
      enabled: () => this.session.store?.canUndo === true,
    });
    this.actions.register({
      id: "edit.redo",
      title: (t) => t("edit.redo"),
      run: () => this.#stepThroughHistory((store) => store.redo()),
      keys: ["mod+shift+z", "mod+y"],
      menu: { name: "edit", group: "history" },
      enabled: () => this.session.store?.canRedo === true,
    });
  }

  #registerViewActions(): void {
    const isOpen = () => this.session.store !== undefined;
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
        enabled: isOpen,
      });
    });
    this.actions.register({
      id: "view.resetLayout",
      title: (t) => t("view.resetLayout"),
      run: () => this.layout.resetWorkspace(),
      menu: { name: "view", group: "layout" },
      enabled: isOpen,
    });
    for (const panel of this.panels.list()) {
      this.actions.register({
        id: `view.open.${panel.type}`,
        title: (t) => t("action.openPanel", { panel: panel.title(t) }),
        run: () => this.layout.openPanel(panel.type),
        ...(panel.keys ? { keys: panel.keys } : {}),
        menu: { name: "view", group: `panels.${panel.area}`, title: panel.title },
        enabled: isOpen,
      });
    }
  }
}
