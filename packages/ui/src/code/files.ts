import { entryOf, type ProjectStore } from "@animaquill/core";
import type { TFunction } from "i18next";
import type { Dialogs } from "../workbench/dialogs.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { Notifications } from "../workbench/notifications.ts";
import type { ProjectSession } from "../workbench/session.ts";
import type { CodeDocuments } from "./documents.ts";
import {
  canChange,
  fileTree,
  filesIn,
  findNode,
  takesFiles,
  type FolderNode,
  type TreeNode,
} from "./tree.ts";
import { commandFailedText } from "../i18n/failures.ts";

export interface FilesSnapshot {
  readonly selected: string | undefined;
  /** Folders are open unless somebody closed them, so that new ones show what is in them. */
  readonly collapsed: ReadonlySet<string>;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/**
 * What people do to the files of a project. Everything in here ends in a command: this only knows
 * which one, and what to ask first.
 */
export class FileActions {
  readonly #emitter = new Emitter();
  readonly #session: ProjectSession;
  readonly #code: CodeDocuments;
  /** Shows a file. With `edit` people want to work in it, and otherwise they stay in the list. */
  readonly #show: (path: string, edit: boolean) => void;
  readonly #dialogs: Dialogs;
  readonly #notifications: Notifications;
  readonly #t: TFunction;
  #snapshot: FilesSnapshot = { selected: undefined, collapsed: new Set() };

  constructor(
    session: ProjectSession,
    code: CodeDocuments,
    show: (path: string, edit: boolean) => void,
    dialogs: Dialogs,
    notifications: Notifications,
    t: TFunction,
  ) {
    this.#session = session;
    this.#code = code;
    this.#show = show;
    this.#dialogs = dialogs;
    this.#notifications = notifications;
    this.#t = t;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): FilesSnapshot => this.#snapshot;

  get #store(): ProjectStore | undefined {
    return this.#session.store;
  }

  /** The tree as it is right now. */
  get tree(): readonly FolderNode[] {
    const state = this.#store?.getState();
    if (!state) return [];
    const t = this.#t;
    return fileTree(state, {
      scenes: t("files.scenes"),
      sounds: t("files.sounds"),
      shared: t("files.shared"),
    });
  }

  get #selectedNode(): TreeNode | undefined {
    const { selected } = this.#snapshot;
    return selected === undefined ? undefined : findNode(this.tree, selected);
  }

  /** Where a new file goes: next to what is selected, or else in what all scenes share. */
  #folderForNew(node = this.#selectedNode): string {
    if (node?.kind === "file") return parentOf(node.path);
    return node && takesFiles(node) ? node.path : "code";
  }

  select(path: string | undefined): void {
    if (this.#snapshot.selected === path) return;
    this.#snapshot = { ...this.#snapshot, selected: path };
    this.#emitter.emit();
  }

  setCollapsed(path: string, collapsed: boolean): void {
    const next = new Set(this.#snapshot.collapsed);
    if (collapsed) next.add(path);
    else next.delete(path);
    this.#snapshot = { ...this.#snapshot, collapsed: next };
    this.#emitter.emit();
  }

  #run(calls: Parameters<ProjectStore["executeBatch"]>[0]): boolean {
    const result = this.#store?.executeBatch(calls);
    if (!result) return false;
    if (!result.ok) {
      this.#notifications.push(commandFailedText(this.#t, result.error));
    }
    return result.ok;
  }

  /** Can have folders in its name, which is how a folder comes about. */
  async newFile(node?: TreeNode): Promise<void> {
    const store = this.#store;
    if (!store) return;
    const t = this.#t;
    const folder = this.#folderForNew(node);
    const name = await this.#dialogs.prompt({
      title: t("files.newFileTitle", { folder }),
      confirm: t("files.create"),
    });
    if (!name) return;
    const path = `${folder}/${name}`;
    // Writing is also how a file gets replaced, which nobody asked for here.
    if (entryOf(store.getState().files, path) !== undefined) {
      this.#notifications.push(t("files.exists", { path }));
      return;
    }
    if (!this.#run([{ type: "file.write", params: { path, text: "" } }])) return;
    this.select(path);
    this.#show(path, true);
  }

  async rename(node = this.#selectedNode): Promise<void> {
    if (!node || !canChange(node)) return;
    const t = this.#t;
    const name = await this.#dialogs.prompt({
      title: t("files.renameTitle", { name: node.name }),
      value: node.name,
      confirm: t("files.rename"),
    });
    if (!name || name === node.name) return;
    if (node.kind === "folder" && node.role === "scene") {
      const params = { scene: node.id, changes: { name } };
      this.#run([{ type: "scene.update", params }]);
      return;
    }
    const to = `${parentOf(node.path)}/${name}`;
    const moves = new Map(filesIn(node).map((from) => [from, to + from.slice(node.path.length)]));
    const calls = [...moves].map(([from, target]) => ({
      type: "file.rename",
      params: { from, to: target },
    }));
    if (this.#code.moving(moves, () => this.#run(calls))) this.select(to);
  }

  async remove(node = this.#selectedNode): Promise<void> {
    if (!node || !canChange(node)) return;
    const t = this.#t;
    const scene = node.kind === "folder" && node.role === "scene" ? node.id : undefined;
    const paths = filesIn(node);
    const confirmed = await this.#dialogs.confirm({
      title: t("files.removeTitle", { name: node.name }),
      message:
        node.kind === "file"
          ? t("files.removeWarning")
          : t("files.removeFolderWarning", { count: paths.length }),
      confirm: t("files.remove"),
      danger: true,
    });
    if (!confirmed) return;
    const calls =
      scene === undefined
        ? paths.map((path) => ({ type: "file.remove", params: { path } }))
        : [{ type: "scene.remove", params: { scene } }];
    if (this.#run(calls)) this.select(undefined);
  }

  /** A scene can only lose the file it starts with after it starts with another one. */
  setEntry(path: string): void {
    const [, scene = "", ...rest] = path.split("/");
    this.#run([{ type: "scene.update", params: { scene, changes: { entry: rest.join("/") } } }]);
  }

  /** What a click on a row means. */
  activate(node: TreeNode): void {
    this.select(node.path);
    if (node.kind === "file") this.#show(node.path, false);
    else this.setCollapsed(node.path, !this.#snapshot.collapsed.has(node.path));
  }
}
