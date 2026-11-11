import type { ProjectGroup, ProjectMarksChange, ProjectOrganizer } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { NOTHING_ORGANIZED, shownGroups, type Organized } from "./cards.ts";

/**
 * How people organise their projects on the start page, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.6: stars, groups of one level with a
 * project in one at most, and when each project was last opened here. For now all of it is kept in
 * this browser, see `Host.organizer`; an account keeps the stars and groups of its projects later,
 * merged by `ProjectMarks.at`, and the start page only ever reads what comes out of here.
 */

/** How long the name of a group can be, see 6.6. */
export const MAX_GROUP_NAME = 60;

export type GroupNameProblem = "empty" | "tooLong" | "taken";

/**
 * What is wrong with a name for a group, or undefined: none can be empty, longer than 60, or what
 * another group that is there is called, whatever the case.
 */
export function groupNameProblem(
  name: string,
  groups: readonly ProjectGroup[],
  except?: string,
): GroupNameProblem | undefined {
  const wanted = name.trim();
  if (wanted === "") return "empty";
  if ([...wanted].length > MAX_GROUP_NAME) return "tooLong";
  const key = wanted.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const isTaken = groups.some(
    (group) =>
      !group.deleted &&
      group.id !== except &&
      group.name.normalize("NFKC").toLocaleLowerCase("zh-CN") === key,
  );
  return isTaken ? "taken" : undefined;
}

export interface OrganizeSnapshot extends Organized {
  /** It could not be read: projects show without stars or groups. */
  readonly failed: boolean;
}

export interface StartOrganizerOptions {
  readonly organizer: ProjectOrganizer;
  readonly now?: () => number;
  /** A new id for a group. */
  readonly newId?: () => string;
}

const NOTHING: OrganizeSnapshot = { ...NOTHING_ORGANIZED, failed: false };

export class StartOrganizer {
  readonly #organizer: ProjectOrganizer;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #emitter = new Emitter();
  #snapshot: OrganizeSnapshot = NOTHING;
  #turn = 0;
  #stop: (() => void) | undefined;

  constructor({
    organizer,
    now = Date.now,
    newId = () => crypto.randomUUID(),
  }: StartOrganizerOptions) {
    this.#organizer = organizer;
    this.#now = now;
    this.#newId = newId;
  }

  getSnapshot = (): OrganizeSnapshot => this.#snapshot;

  /** Reads what is kept the first time somebody listens, and keeps up with every window from then. */
  subscribe = (listener: () => void): (() => void) => {
    if (!this.#stop) {
      this.#stop = this.#organizer.listen(() => void this.refresh());
      void this.refresh();
    }
    return this.#emitter.subscribe(listener);
  };

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.#turn += 1;
  }

  /** Reads everything again. Never rejects: what cannot be read is "failed". */
  async refresh(): Promise<void> {
    const turn = ++this.#turn;
    try {
      const { marks, groups } = await this.#organizer.read();
      if (turn !== this.#turn) return;
      this.#snapshot = { marks, groups: shownGroups(groups), failed: false };
    } catch (error) {
      if (turn !== this.#turn) return;
      console.warn("How projects are organised could not be read", error);
      this.#snapshot = { ...this.#snapshot, failed: true };
    }
    this.#emitter.emit();
  }

  /** Resolves to whether it is kept: where it is not, nothing changed. */
  async #mark(project: string, change: Omit<ProjectMarksChange, "at">): Promise<boolean> {
    try {
      await this.#organizer.mark(project, { ...change, at: this.#now() });
      return true;
    } catch (error) {
      console.warn("How a project is organised could not be kept", error);
      return false;
    }
  }

  /** A project was opened in this window, by what this browser keeps it by. */
  noteOpened(key: string): Promise<boolean> {
    return this.#mark(key, { openedAt: this.#now() });
  }

  /** Forgets how a project that is gone was organised. */
  forget(key: string): Promise<boolean> {
    return this.#organizer.forget(key).then(
      () => true,
      (error: unknown) => {
        console.warn("How a project that is gone was organised stays for now", error);
        return false;
      },
    );
  }

  star(marksKey: string, starred: boolean): Promise<boolean> {
    return this.#mark(marksKey, { starredAt: starred ? this.#now() : null });
  }

  /** Into a group by its id, or out of any with undefined. */
  moveToGroup(marksKey: string, group: string | undefined): Promise<boolean> {
    return this.#mark(marksKey, { group: group ?? null });
  }

  /** What is wrong with a name for a new group, or for `group` as it is renamed. */
  nameProblem(name: string, group?: string): GroupNameProblem | undefined {
    return groupNameProblem(name, this.#snapshot.groups, group);
  }

  /**
   * Makes a group, of this browser: an account takes it over later. Resolves to its id, or to what
   * is wrong with the name; to undefined where it could not be kept.
   */
  async createGroup(
    name: string,
  ): Promise<{ readonly id: string } | { readonly problem: GroupNameProblem } | undefined> {
    const problem = this.nameProblem(name);
    if (problem) return { problem };
    const group: ProjectGroup = {
      id: this.#newId(),
      name: name.trim(),
      scope: "browser",
      at: this.#now(),
    };
    try {
      await this.#organizer.putGroup(group);
    } catch (error) {
      console.warn("A group could not be kept", error);
      return undefined;
    }
    // Shown at once, before every window hears of it.
    this.#snapshot = {
      ...this.#snapshot,
      groups: shownGroups([...this.#snapshot.groups.filter(({ id }) => id !== group.id), group]),
    };
    this.#emitter.emit();
    return { id: group.id };
  }

  /** Resolves to true once it is kept, or to what is wrong with the name. */
  async renameGroup(id: string, name: string): Promise<true | GroupNameProblem | undefined> {
    const group = this.#snapshot.groups.find((each) => each.id === id);
    if (!group) return undefined;
    const problem = this.nameProblem(name, id);
    if (problem) return problem;
    return this.#putGroup({ ...group, name: name.trim(), at: this.#now() });
  }

  /**
   * Takes a group away: only the group, see 6.6. Its projects show as in none from then on, as
   * they would where the group went elsewhere: they keep its id, which leads nowhere.
   */
  async deleteGroup(id: string): Promise<boolean> {
    const group = this.#snapshot.groups.find((each) => each.id === id);
    if (!group) return false;
    return (await this.#putGroup({ ...group, deleted: true, at: this.#now() })) === true;
  }

  async #putGroup(group: ProjectGroup): Promise<true | undefined> {
    try {
      await this.#organizer.putGroup(group);
      return true;
    } catch (error) {
      console.warn("A group could not be kept", error);
      return undefined;
    }
  }
}
