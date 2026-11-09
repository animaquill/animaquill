import type { CodeDocuments } from "../code/documents.ts";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";

/**
 * The tabs inside the resources tab: files of code, which the code editor shows, and the details of
 * other resources, side by side in the order they were opened. What is in the files is up to
 * `CodeDocuments`, this only follows which of them are open. Like the explorer, this is the state of
 * the window, not of the project, see docs/design/resource-panels.md.
 */

export type ResourceTab =
  | { readonly kind: "code"; readonly path: string }
  /** `name` is what it was called when it was opened, for when it is not there any more. */
  | { readonly kind: "resource"; readonly id: string; readonly name: string };

export interface PagesSnapshot {
  readonly tabs: readonly ResourceTab[];
  /** The resource whose details show, or undefined when the code editor does. */
  readonly page: string | undefined;
}

const NOTHING_OPEN: PagesSnapshot = { tabs: [], page: undefined };

const pathsOf = (code: CodeDocuments) => code.getSnapshot().documents.map(({ path }) => path);

export class ResourcePages {
  readonly #emitter = new Emitter();
  readonly #code: CodeDocuments;
  readonly #session: ProjectSession;
  #snapshot = NOTHING_OPEN;
  /** The files open in the code editor as last seen, in its order. */
  #paths: readonly string[];
  #store: ProjectSession["store"];

  constructor(session: ProjectSession, code: CodeDocuments) {
    this.#session = session;
    this.#code = code;
    this.#paths = pathsOf(code);
    this.#store = session.store;
    this.#snapshot = { ...NOTHING_OPEN, tabs: this.#paths.map((path) => ({ kind: "code", path })) };
    code.subscribe(this.#followCode);
    session.subscribe(this.#followSession);
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): PagesSnapshot => this.#snapshot;

  /** Whether the code editor is what shows, rather than the details of a resource. */
  get showsCode(): boolean {
    return this.#snapshot.page === undefined;
  }

  #set(snapshot: PagesSnapshot): void {
    if (
      snapshot.page === this.#snapshot.page &&
      snapshot.tabs.length === this.#snapshot.tabs.length &&
      snapshot.tabs.every((tab, index) => tab === this.#snapshot.tabs[index])
    ) {
      return;
    }
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }

  #followSession = (): void => {
    if (this.#session.store === this.#store) return;
    this.#store = this.#session.store;
    this.#paths = pathsOf(this.#code);
    this.#set({ tabs: this.#paths.map((path) => ({ kind: "code", path })), page: undefined });
  };

  /**
   * Files come and go in the code editor. A file that moved keeps its place: the code editor gives
   * it the same place in its own order, under the new path.
   */
  #followCode = (): void => {
    const before = this.#paths;
    const now = pathsOf(this.#code);
    if (now.length === before.length && now.every((path, index) => path === before[index])) return;
    this.#paths = now;
    const open = new Set(now);
    const was = new Set(before);
    const moved = new Map<string, string>();
    before.forEach((path, index) => {
      const next = now[index];
      if (!open.has(path) && next !== undefined && !was.has(next)) moved.set(path, next);
    });
    const tabs = this.#snapshot.tabs.flatMap((tab): ResourceTab[] => {
      if (tab.kind === "resource" || open.has(tab.path)) return [tab];
      const path = moved.get(tab.path);
      return path === undefined ? [] : [{ kind: "code", path }];
    });
    const listed = new Set(tabs.flatMap((tab) => (tab.kind === "code" ? [tab.path] : [])));
    for (const path of now) if (!listed.has(path)) tabs.push({ kind: "code", path });
    // With no files left the code editor has nothing to show, and a page shows instead.
    let { page } = this.#snapshot;
    if (page === undefined && now.length === 0) page = this.#lastPage(tabs);
    this.#set({ tabs, page });
  };

  #lastPage(tabs: readonly ResourceTab[]): string | undefined {
    const last = tabs.findLast((tab) => tab.kind === "resource");
    return last?.kind === "resource" ? last.id : undefined;
  }

  /** Opens the details of a resource, or goes to them when they are open already. */
  open(id: string, name: string): void {
    const known = this.#snapshot.tabs.some((tab) => tab.kind === "resource" && tab.id === id);
    const tabs = known
      ? this.#snapshot.tabs
      : [...this.#snapshot.tabs, { kind: "resource" as const, id, name }];
    this.#set({ tabs, page: id });
  }

  /** Goes to a page that is open. */
  show(id: string): void {
    if (this.#snapshot.tabs.some((tab) => tab.kind === "resource" && tab.id === id)) {
      this.#set({ ...this.#snapshot, page: id });
    }
  }

  /** Shows the code editor, at a file that is open there if one is given. */
  showCode(path?: string): void {
    if (path !== undefined) this.#code.activate(path);
    if (this.#paths.length > 0) this.#set({ ...this.#snapshot, page: undefined });
  }

  /** Closes the details of a resource. When they were showing, the tab next to them shows. */
  close(id: string): void {
    const { tabs, page } = this.#snapshot;
    const index = tabs.findIndex((tab) => tab.kind === "resource" && tab.id === id);
    if (index === -1) return;
    const left = tabs.filter((_, at) => at !== index);
    if (page !== id) {
      this.#set({ tabs: left, page });
      return;
    }
    const next = left[Math.min(index, left.length - 1)];
    if (next?.kind === "code") {
      this.#code.activate(next.path);
      this.#set({ tabs: left, page: undefined });
    } else {
      this.#set({ tabs: left, page: next?.id });
    }
  }
}
