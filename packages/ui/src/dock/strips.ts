import type { DockviewGroupPanel } from "dockview-react";
import type { TabStrip } from "../workbench/layout.ts";
import { Emitter } from "../workbench/emitter.ts";

/**
 * How each group shows its tabs. Dockview keeps which side they are on, and saves it with the
 * group. Whether the names show is ours, kept by the id of the group.
 */
export class TabStrips {
  readonly #emitter = new Emitter();
  #unpinned = new Set<string>();
  #revision = 0;

  subscribe = this.#emitter.subscribe;
  /** Changes with every change of any strip. */
  getSnapshot = (): number => this.#revision;

  stripOf(group: DockviewGroupPanel): TabStrip {
    const position = group.api.getHeaderPosition();
    return position === "left" || position === "right" ? position : "top";
  }

  /** Only tabs down a side can show just their icons. */
  isPinned(group: DockviewGroupPanel): boolean {
    return this.stripOf(group) === "top" || !this.#unpinned.has(group.id);
  }

  setStrip(group: DockviewGroupPanel, strip: TabStrip): void {
    if (this.stripOf(group) === strip) return;
    group.api.setHeaderPosition(strip);
    this.#changed();
  }

  setPinned(group: DockviewGroupPanel, pinned: boolean): void {
    if (pinned) this.#unpinned.delete(group.id);
    else this.#unpinned.add(group.id);
    this.#changed();
  }

  /** Quietly: the group is gone, and its going is a change of its own. */
  forget(id: string): void {
    this.#unpinned.delete(id);
  }

  /** The groups among these that show only icons, for saving. */
  unpinnedOf(groups: readonly DockviewGroupPanel[]): string[] {
    return groups.flatMap((group) => (this.isPinned(group) ? [] : [group.id]));
  }

  /** After a whole new arrangement. */
  reset(unpinned: Iterable<string>): void {
    this.#unpinned = new Set(unpinned);
    this.#changed();
  }

  #changed(): void {
    this.#revision += 1;
    this.#emitter.emit();
  }
}
