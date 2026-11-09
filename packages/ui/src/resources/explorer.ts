import { Emitter } from "../workbench/emitter.ts";
import { parseProjectResourceId } from "./project-resources.ts";

/**
 * Where people are in the explorer: which source of resources, and which resource. This is the
 * state of the window, not of the project, see docs/design/resource-panels.md, section 1.
 */

/** The places of the tree of sources, in the order they show. */
export const EXPLORER_NODES = [
  "built-in",
  "built-in.transitions",
  "built-in.effects",
  "project",
  "project.media",
  "project.scenes",
  "project.sounds",
  "project.transitions",
  "project.effects",
  "missing",
  "libraries",
] as const;

export type ExplorerNode = (typeof EXPLORER_NODES)[number];

/** The place under which a node is, if it is under one. */
export const parentOf = (node: ExplorerNode): ExplorerNode | undefined =>
  node.startsWith("built-in.") ? "built-in" : node.startsWith("project.") ? "project" : undefined;

export interface ExplorerSnapshot {
  readonly node: ExplorerNode;
  /** The resource whose details show, by its id. */
  readonly selected: string | undefined;
  /** Goes up each time something is shown from elsewhere, which the list then scrolls to. */
  readonly revealed: number;
}

/** Where a resource is listed, by its id. */
export function nodeOfResource(id: string): ExplorerNode | undefined {
  if (id.startsWith("transition:built-in:")) return "built-in.transitions";
  if (id.startsWith("effect:built-in:")) return "built-in.effects";
  const project = parseProjectResourceId(id);
  if (!project) return undefined;
  return project.kind === "asset"
    ? "project.media"
    : project.kind === "scene"
      ? "project.scenes"
      : "project.sounds";
}

export class ExplorerState {
  readonly #emitter = new Emitter();
  #snapshot: ExplorerSnapshot = { node: "project", selected: undefined, revealed: 0 };

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ExplorerSnapshot => this.#snapshot;

  choose(node: ExplorerNode): void {
    if (node === this.#snapshot.node) return;
    this.#set({ ...this.#snapshot, node });
  }

  select(id: string | undefined): void {
    if (id === this.#snapshot.selected) return;
    this.#set({ ...this.#snapshot, selected: id });
  }

  /** Shows a resource, in the place where it is listed. Resolves to whether there is one. */
  reveal(id: string, node = nodeOfResource(id)): boolean {
    if (!node) return false;
    this.#set({ node, selected: id, revealed: this.#snapshot.revealed + 1 });
    return true;
  }

  #set(snapshot: ExplorerSnapshot): void {
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }
}
