import {
  groupNameKey,
  MAX_GROUP_NAME,
  type AccountAccess,
  type OrganizerAccess,
  type OrganizerContent,
  type ProjectGroup,
  type ProjectMarks,
  type ProjectMarksChange,
  type ProjectOrganizer,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { NOTHING_ORGANIZED, shownGroups, type MarksTarget, type Organized } from "./cards.ts";
import { OrganizerSync } from "./organize-sync.ts";

export { MAX_GROUP_NAME };

/**
 * How people organise their projects on the start page, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.6: stars, groups of one level with a
 * project in one at most, and when each project was last opened here. All of it is kept in this
 * browser, see `Host.organizer`; where people are signed in to a platform that keeps it too
 * (`CloudAccess.organizer`), the stars and groups of its projects and the groups go with the
 * account, see `OrganizerSync`, and the start page only ever reads what comes out of here: the
 * groups of whoever is signed in, or was last, and those of this browser, which become the
 * account's once it is read.
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
  const wanted = name.trim();
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
  /** Who is signed in to the platform, where there is one. */
  readonly account?: AccountAccess | undefined;
  /** The platform's copy, see `CloudAccess.organizer`. */
  readonly cloud?: OrganizerAccess | undefined;
  /** Only tests: how the account is gone a round with. */
  readonly sync?: OrganizerSync;
  readonly now?: () => number;
  /** A new id for a group. */
  readonly newId?: () => string;
}

const NOTHING: OrganizeSnapshot = { ...NOTHING_ORGANIZED, failed: false };

/** The id of a group that `id` became, see `ProjectGroup.into`, or `id`. */
const finalOf = (id: string, into: ReadonlyMap<string, string>): string => {
  let at = id;
  // A few at most: one each time a group of this browser or an offline one met the account.
  for (let step = 0; step < 8; step += 1) {
    const next = into.get(at);
    if (next === undefined) return at;
    at = next;
  }
  return at;
};

/**
 * What people see of what is kept: the groups of `viewer` and of this browser, and projects in the
 * group that the one they say became.
 */
function shownOf(content: OrganizerContent, viewer: string | undefined): Organized {
  const into = new Map(
    content.groups.flatMap((group) =>
      group.into === undefined ? [] : [[group.id, group.into] as const],
    ),
  );
  const marks =
    into.size === 0
      ? content.marks
      : new Map(
          [...content.marks].map(([key, each]): [string, ProjectMarks] =>
            typeof each.group === "string" && into.has(each.group)
              ? [key, { ...each, group: finalOf(each.group, into) }]
              : [key, each],
          ),
        );
  const groups = content.groups.filter(
    (group) =>
      group.scope === "browser" || (viewer !== undefined && group.scope.account === viewer),
  );
  return { marks, groups: shownGroups(groups) };
}

export class StartOrganizer {
  readonly #organizer: ProjectOrganizer;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #emitter = new Emitter();
  readonly #account: AccountAccess | undefined;
  readonly #sync: OrganizerSync | undefined;
  #snapshot: OrganizeSnapshot = NOTHING;
  #turn = 0;
  #stop: (() => void) | undefined;
  #stopAccount: (() => void) | undefined;
  #signedIn: string | undefined;

  constructor({
    organizer,
    account,
    cloud,
    sync,
    now = Date.now,
    newId = () => crypto.randomUUID(),
  }: StartOrganizerOptions) {
    this.#organizer = organizer;
    this.#account = account;
    this.#now = now;
    this.#newId = newId;
    this.#signedIn = this.#whoIsSignedIn();
    this.#sync =
      sync ??
      (cloud && account
        ? new OrganizerSync({ local: organizer, remote: cloud, account: () => this.#signedIn })
        : undefined);
  }

  /** Who is signed in to a platform that keeps how projects are organised, by its id. */
  #whoIsSignedIn(): string | undefined {
    const snapshot = this.#account?.getSnapshot();
    return snapshot?.status === "signedIn" ? snapshot.id : undefined;
  }

  /** Has what changed here go to the account soon, where there is one. */
  #changed(): void {
    if (this.#signedIn !== undefined) this.#sync?.soon();
  }

  getSnapshot = (): OrganizeSnapshot => this.#snapshot;

  /** Reads what is kept the first time somebody listens, and keeps up with every window from then. */
  subscribe = (listener: () => void): (() => void) => {
    if (!this.#stop) {
      this.#stop = this.#organizer.listen(() => void this.refresh());
      this.#stopAccount = this.#account?.subscribe(() => {
        const now = this.#whoIsSignedIn();
        if (now === this.#signedIn) return;
        this.#signedIn = now;
        void this.refresh();
        if (now !== undefined) this.#sync?.soon(0);
      });
      void this.refresh();
    }
    // The start page is open: what changed on other computers comes.
    if (this.#signedIn !== undefined) this.#sync?.soon(0);
    return this.#emitter.subscribe(listener);
  };

  close(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.#stopAccount?.();
    this.#stopAccount = undefined;
    this.#sync?.close();
    this.#turn += 1;
  }

  /** Goes a round with the account now, where somebody is signed in; for tests. */
  syncNow(): Promise<void> {
    return this.#sync?.run() ?? Promise.resolve();
  }

  /** Reads everything again. Never rejects: what cannot be read is "failed". */
  async refresh(): Promise<void> {
    const turn = ++this.#turn;
    try {
      const content = await this.#organizer.read();
      if (turn !== this.#turn) return;
      this.#snapshot = { ...shownOf(content, this.#signedIn ?? content.account), failed: false };
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
      if (change.starredAt !== undefined || change.group !== undefined) this.#changed();
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

  /** Kept where `target` says, both places at the same time, see `MarksTarget`. */
  async #markTarget(
    target: MarksTarget,
    change: Pick<ProjectMarksChange, "starredAt" | "group">,
  ): Promise<boolean> {
    const at = this.#now();
    const write = async (key: string, more: Partial<ProjectMarksChange>) => {
      await this.#organizer.mark(key, { ...change, ...more, at });
    };
    try {
      await write(target.key, target.account === undefined ? {} : { account: target.account });
      if (target.also !== undefined) await write(target.also, {});
      this.#changed();
      return true;
    } catch (error) {
      console.warn("How a project is organised could not be kept", error);
      return false;
    }
  }

  star(target: MarksTarget, starred: boolean): Promise<boolean> {
    return this.#markTarget(target, { starredAt: starred ? this.#now() : null });
  }

  /** Into a group by its id, or out of any with undefined. */
  moveToGroup(target: MarksTarget, group: string | undefined): Promise<boolean> {
    return this.#markTarget(target, { group: group ?? null });
  }

  /** What is wrong with a name for a new group, or for `group` as it is renamed. */
  nameProblem(name: string, group?: string): GroupNameProblem | undefined {
    return groupNameProblem(name, this.#snapshot.groups, group);
  }

  /**
   * Makes a group, of the account that is signed in, or of this browser while nobody is: an account
   * takes it over later. Resolves to its id, or to what is wrong with the name; to undefined where
   * it could not be kept.
   */
  async createGroup(
    name: string,
  ): Promise<{ readonly id: string } | { readonly problem: GroupNameProblem } | undefined> {
    const problem = this.nameProblem(name);
    if (problem) return { problem };
    const group: ProjectGroup = {
      id: this.#newId(),
      name: name.trim(),
      scope: this.#signedIn !== undefined && this.#sync ? { account: this.#signedIn } : "browser",
      at: this.#now(),
    };
    let outcome;
    try {
      outcome = await this.#organizer.putGroup(group);
    } catch (error) {
      console.warn("A group could not be kept", error);
      return undefined;
    }
    // Another window made one of that name a moment ago.
    if (typeof outcome === "object") return { problem: "taken" };
    if (outcome !== "kept") return undefined;
    this.#changed();
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
    const outcome = await this.#putGroup({ ...group, name: name.trim(), at: this.#now() });
    return outcome === "taken" ? "taken" : outcome;
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

  /**
   * Resolves to true once it is kept; to "taken" where another window gave a group that name a
   * moment ago, and to undefined where it could not be kept, or another window changed it later.
   */
  async #putGroup(group: ProjectGroup): Promise<true | "taken" | undefined> {
    try {
      const outcome = await this.#organizer.putGroup(group);
      if (typeof outcome === "object") return "taken";
      if (outcome !== "kept") return undefined;
      this.#changed();
      return true;
    } catch (error) {
      console.warn("A group could not be kept", error);
      return undefined;
    }
  }
}
