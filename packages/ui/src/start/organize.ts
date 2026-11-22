import {
  cleanGroupName,
  groupNameKey,
  MAX_GROUP_NAME,
  OrganizerOffline,
  type ProjectGroup,
  type ProjectMarksChange,
  type ProjectOrganizer,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { NOTHING_ORGANIZED, shownGroups, type MarksTarget, type Organized } from "./cards.ts";

export { MAX_GROUP_NAME };

/**
 * How people organise their projects on the start page, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.6: stars, groups of one level with a
 * project in one at most, and when each project was last opened. Where it is kept is the host's,
 * see `Host.organizer`: in this browser offline, on the backend online, which every change goes to
 * at once (docs/design/online-offline.md of AnimaQuill Cloud, 2.1). Nothing is merged.
 */

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
  const wanted = cleanGroupName(name);
  if (wanted === "") return "empty";
  if ([...wanted].length > MAX_GROUP_NAME) return "tooLong";
  const key = groupNameKey(wanted);
  const isTaken = groups.some(
    (group) => !group.deleted && group.id !== except && groupNameKey(group.name) === key,
  );
  return isTaken ? "taken" : undefined;
}

export interface OrganizeSnapshot extends Organized {
  /** It could not be read: projects show without stars or groups. */
  readonly failed: boolean;
}

export interface StartOrganizerOptions {
  readonly organizer: ProjectOrganizer;
  /**
   * Nothing changed, as the backend cannot be reached (`OrganizerOffline`): people are told so
   * here, and the change resolves to "offline".
   */
  readonly offline?: () => void;
  readonly now?: () => number;
  /** A new id for a group. */
  readonly newId?: () => string;
}

const NOTHING: OrganizeSnapshot = { ...NOTHING_ORGANIZED, failed: false };

/** A change that did not go as the backend cannot be reached, which people were told. */
export type Offline = "offline";

export class StartOrganizer {
  readonly #organizer: ProjectOrganizer;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #offline: (() => void) | undefined;
  readonly #emitter = new Emitter();
  #snapshot: OrganizeSnapshot = NOTHING;
  #turn = 0;
  #stop: (() => void) | undefined;

  constructor({
    organizer,
    offline,
    now = Date.now,
    newId = () => crypto.randomUUID(),
  }: StartOrganizerOptions) {
    this.#organizer = organizer;
    this.#offline = offline;
    this.#now = now;
    this.#newId = newId;
  }

  getSnapshot = (): OrganizeSnapshot => this.#snapshot;

  /** Reads what is kept the first time somebody listens, and keeps up with every window from then. */
  subscribe = (listener: () => void): (() => void) => {
    if (!this.#stop) this.#stop = this.#organizer.listen(() => void this.refresh());
    // The start page came: what changed elsewhere comes too.
    if (this.#listening === 0) void this.refresh();
    this.#listening += 1;
    const stop = this.#emitter.subscribe(listener);
    return () => {
      this.#listening -= 1;
      stop();
    };
  };
  #listening = 0;

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.#turn += 1;
  }

  /** Reads everything again. Never rejects: what cannot be read is "failed". */
  async refresh(): Promise<void> {
    const turn = ++this.#turn;
    try {
      const content = await this.#organizer.read();
      if (turn !== this.#turn) return;
      this.#snapshot = {
        marks: content.marks,
        groups: shownGroups(content.groups),
        failed: false,
      };
    } catch (error) {
      if (turn !== this.#turn) return;
      console.warn("How projects are organised could not be read", error);
      this.#snapshot = { ...this.#snapshot, failed: true };
    }
    this.#emitter.emit();
  }

  /** What went wrong, said where the backend could not be reached. */
  #failed(error: unknown, what: string): Offline | undefined {
    if (error instanceof OrganizerOffline) {
      this.#offline?.();
      return "offline";
    }
    console.warn(what, error);
    return undefined;
  }

  /** A project was opened in this window, by where its marks are kept. */
  async noteOpened(key: string): Promise<boolean> {
    try {
      await this.#organizer.mark(key, { openedAt: this.#now(), at: this.#now() });
      return true;
    } catch (error) {
      // Nobody needs to hear of it: the start page goes by when it last changed then.
      if (!(error instanceof OrganizerOffline))
        console.warn("When a project was opened could not be kept", error);
      return false;
    }
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

  async #markTarget(
    target: MarksTarget,
    change: Pick<ProjectMarksChange, "starredAt" | "group">,
  ): Promise<boolean | Offline> {
    try {
      await this.#organizer.mark(target.key, { ...change, at: this.#now() });
      return true;
    } catch (error) {
      return this.#failed(error, "How a project is organised could not be kept") ?? false;
    }
  }

  /** Resolves to whether it is kept, or "offline" where people were told it could not be. */
  star(target: MarksTarget, starred: boolean): Promise<boolean | Offline> {
    return this.#markTarget(target, { starredAt: starred ? this.#now() : null });
  }

  /** Into a group by its id, or out of any with undefined. */
  moveToGroup(target: MarksTarget, group: string | undefined): Promise<boolean | Offline> {
    return this.#markTarget(target, { group: group ?? null });
  }

  /** What is wrong with a name for a new group, or for `group` as it is renamed. */
  nameProblem(name: string, group?: string): GroupNameProblem | undefined {
    return groupNameProblem(name, this.#snapshot.groups, group);
  }

  /**
   * Makes a group. Resolves to its id, or to what is wrong with the name; to undefined where it
   * could not be kept, and to "offline" where people were told it could not be.
   */
  async createGroup(
    name: string,
  ): Promise<
    { readonly id: string } | { readonly problem: GroupNameProblem } | Offline | undefined
  > {
    const problem = this.nameProblem(name);
    if (problem) return { problem };
    const group: ProjectGroup = { id: this.#newId(), name: cleanGroupName(name), at: this.#now() };
    let outcome;
    try {
      outcome = await this.#organizer.putGroup(group);
    } catch (error) {
      return this.#failed(error, "A group could not be kept");
    }
    // Another window made one of that name a moment ago.
    if (typeof outcome === "object") return { problem: "taken" };
    if (outcome !== "kept") return undefined;
    // Shown at once, before every window hears of it.
    this.#snapshot = {
      ...this.#snapshot,
      groups: shownGroups([...this.#snapshot.groups.filter(({ id }) => id !== group.id), group]),
    };
    this.#emitter.emit();
    return { id: group.id };
  }

  /** Resolves to true once it is kept, or to what is wrong with the name. */
  async renameGroup(
    id: string,
    name: string,
  ): Promise<true | GroupNameProblem | Offline | undefined> {
    const group = this.#snapshot.groups.find((each) => each.id === id);
    if (!group) return undefined;
    const problem = this.nameProblem(name, id);
    if (problem) return problem;
    return this.#putGroup({ ...group, name: cleanGroupName(name), at: this.#after(group) });
  }

  /**
   * Takes a group away: only the group, see 6.6. Its projects show as in none from then on: they
   * keep its id, which leads nowhere.
   */
  async deleteGroup(id: string): Promise<boolean | Offline> {
    const group = this.#snapshot.groups.find((each) => each.id === id);
    if (!group) return false;
    const outcome = await this.#putGroup({ ...group, deleted: true, at: this.#after(group) });
    return outcome === "offline" ? outcome : outcome === true;
  }

  /** When people change `group` here: now, after whatever is kept of it. */
  #after(group: ProjectGroup): number {
    return Math.max(this.#now(), group.at + 1);
  }

  /**
   * Resolves to true once it is kept; to "taken" where another window gave a group that name a
   * moment ago, and to undefined where it could not be kept, or another window changed it later.
   */
  async #putGroup(group: ProjectGroup): Promise<true | "taken" | Offline | undefined> {
    try {
      const outcome = await this.#organizer.putGroup(group);
      if (typeof outcome === "object") return "taken";
      if (outcome !== "kept") return undefined;
      return true;
    } catch (error) {
      return this.#failed(error, "A group could not be kept");
    }
  }
}
