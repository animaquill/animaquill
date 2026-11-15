import type { WindowMemory } from "@animaquill/host";
import { Emitter } from "./emitter.ts";
import { Flag } from "./flag.ts";

/**
 * The groups of the project properties, in the order of their list (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 5.2). "给 AI 的说明" comes with AGENTS.md (6.16a),
 * not before.
 */
export const PROJECT_GROUPS = [
  "general",
  "picture",
  "sound",
  "timelines",
  "languages",
  "cover",
  "fonts",
  "libraries",
  "storage",
] as const;

export type ProjectGroup = (typeof PROJECT_GROUPS)[number];

export const isProjectGroup = (value: unknown): value is ProjectGroup =>
  PROJECT_GROUPS.includes(value as ProjectGroup);

/**
 * Where the project properties of a window are: which group, and something in it to show and make
 * stand out, such as the name as "重命名项目" opens them. Narrow, they show one level at a time, as
 * the settings do: the list of groups (0), a group (1).
 */
export interface ProjectPlace {
  readonly group: ProjectGroup;
  readonly depth: 0 | 1;
  /** What to show and put the focus in, such as `name`, see `data-property` of the dialog. */
  readonly item?: string | undefined;
}

/** Where the window keeps the group the properties were last in, see `WindowMemory`. */
const MEMORY_KEY = "properties.group";

/**
 * The project properties of a window: whether they are open, and where in them. Both are the
 * window's own, as with the settings (`SettingsNav`); the group survives a reload.
 */
export class ProjectNav {
  readonly #emitter = new Emitter();
  readonly #memory: WindowMemory | undefined;
  #place: ProjectPlace;
  /** Whether the properties are open in this window. */
  readonly shown = new Flag();

  constructor(memory?: WindowMemory) {
    this.#memory = memory;
    const kept = memory?.read(MEMORY_KEY);
    this.#place = { group: isProjectGroup(kept) ? kept : "general", depth: 1 };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ProjectPlace => this.#place;

  get isOpen(): boolean {
    return this.shown.getSnapshot();
  }

  /** Opens them at a place, or in the group they were in last. */
  open(place?: ProjectPlace): void {
    this.go(place ?? { group: this.#place.group, depth: 1 });
    this.shown.set(true);
  }

  close(): void {
    this.shown.set(false);
  }

  go(place: ProjectPlace): void {
    this.#place = place;
    this.#memory?.write(MEMORY_KEY, place.group);
    this.#emitter.emit();
  }

  /** One level up, where they are narrow. */
  back(): void {
    this.go({ group: this.#place.group, depth: 0 });
  }
}
