import {
  RepositoryRefused,
  type RepositoryAccess,
  type RepositoryCheck,
  type RepositoryChoice,
  type RepositoryLink,
  type RepositoryList,
  type RepositoryStatus,
} from "@animaquill/host";
import type { RepositoryEnvironment } from "./repository-watch.ts";
import type { MemoryPlatform, TestTime } from "./cloud-support.ts";

/**
 * A platform that saves projects to GitHub, for tests of the editor's side of it: what it says is
 * what a test sets, and it notes what it was asked.
 */
export class FakeRepositories implements RepositoryAccess {
  answer: RepositoryStatus = { state: "none", archiving: false, head: 1, archivedSeq: 0 };
  repositories: RepositoryChoice[] = [];
  manageUrl = "https://github.com/settings/installations/9";
  /** What the next call of each kind rejects with, once. */
  readonly refuse: {
    list?: Error;
    check?: Error;
    link?: Error;
    status?: Error;
    archiveNow?: Error;
    recheck?: Error;
  } = {};
  /** What the repository is like once GitHub is asked again, see `recheck`: as it is, where unsaid. */
  recheckAnswer: RepositoryStatus | undefined;
  readonly calls: string[] = [];
  readonly links: RepositoryLink[] = [];
  readonly archives: { readonly replace?: string }[] = [];
  /** Repositories a page, for paging. */
  page = 100;
  /** Names of repositories the person has already, which a new one cannot take. */
  readonly taken = new Set<string>();
  /** What a check says about a repository people have, by its id, where that is not a yes. */
  readonly checks = new Map<number, RepositoryCheck>();
  /** What was checked, in order. */
  readonly checked: RepositoryLink[] = [];
  /** The platform whose projects these repositories are of: it hears which project has one. */
  platform: MemoryPlatform | undefined;
  /**
   * "Archive now" archives what the platform has right away, as a worker that is quick: the
   * repository has all of it, see `MemoryPlatform.archivedSeq`.
   */
  autoArchive = false;
  /**
   * What the status says follows the platform: the update it has of the project, and how far its
   * repository has it, see `MemoryPlatform.archivedSeq`.
   */
  followsPlatform = false;
  /** What the platform has of a project now, where it is one of its own. */
  #headOf(project: string): number {
    return this.platform?.projects.get(project)?.head ?? this.answer.head;
  }

  #once<K extends keyof FakeRepositories["refuse"]>(kind: K): void {
    const error = this.refuse[kind];
    if (error) {
      delete this.refuse[kind];
      throw error;
    }
  }

  async list(page = 1): Promise<RepositoryList> {
    this.calls.push(`list ${page}`);
    this.#once("list");
    const start = (page - 1) * this.page;
    return {
      repositories: this.repositories.slice(start, start + this.page),
      page,
      more: start + this.page < this.repositories.length,
      manageUrl: this.manageUrl,
    };
  }

  async check(choice: RepositoryLink): Promise<RepositoryCheck> {
    this.calls.push("check");
    this.checked.push(choice);
    this.#once("check");
    if ("create" in choice) {
      return this.taken.has(choice.create.name.toLowerCase())
        ? { ok: false, reason: "nameTaken" }
        : { ok: true };
    }
    const said = this.checks.get(choice.existing.id);
    if (said) return said;
    const chosen = this.repositories.find((each) => each.id === choice.existing.id);
    if (!chosen) return { ok: false, reason: "notFound" };
    if (!chosen.private && choice.confirmPublic !== true) return { ok: false, reason: "public" };
    return { ok: true };
  }

  async link(project: string, choice: RepositoryLink): Promise<RepositoryStatus> {
    this.calls.push(`link ${project}`);
    this.links.push(choice);
    this.#once("link");
    if ("create" in choice && this.taken.has(choice.create.name.toLowerCase()))
      throw new RepositoryRefused("nameTaken");
    // Another repository in place of one that archives as it should only where people say so.
    if (this.answer.state === "ready" && choice.switch !== true)
      throw new RepositoryRefused("alreadyLinked");
    const chosen =
      "create" in choice
        ? { id: 99, owner: "ada", name: choice.create.name, private: true }
        : this.repositories.find((each) => each.id === choice.existing.id);
    if (!chosen) throw new RepositoryRefused("notFound");
    this.platform?.repositories.set(project, {
      id: chosen.id,
      owner: chosen.owner,
      name: chosen.name,
    });
    this.answer = {
      repository: {
        id: chosen.id,
        owner: chosen.owner,
        name: chosen.name,
        fullName: `${chosen.owner}/${chosen.name}`,
        private: chosen.private,
        branch: "main",
        url: `https://github.com/${chosen.owner}/${chosen.name}`,
        createdHere: "create" in choice,
        linkedAt: 1,
      },
      state: "ready",
      archiving: true,
      head: this.answer.head,
      archivedSeq: 0,
    };
    return this.answer;
  }

  async status(project: string): Promise<RepositoryStatus> {
    this.calls.push(`status ${project}`);
    this.#once("status");
    if (this.followsPlatform && this.platform?.projects.has(project)) {
      const head = this.#headOf(project);
      this.answer = {
        ...this.answer,
        head,
        archivedSeq: this.platform.archivedSeq.get(project) ?? this.answer.archivedSeq,
      };
    }
    return this.answer;
  }

  async archiveNow(
    project: string,
    options: { readonly replace?: string } = {},
  ): Promise<RepositoryStatus> {
    this.calls.push(`archiveNow ${project}`);
    this.archives.push(options);
    this.#once("archiveNow");
    this.answer = {
      ...this.answer,
      state: "ready",
      archiving: true,
    };
    delete (this.answer as { reason?: string }).reason;
    delete (this.answer as { diverged?: unknown }).diverged;
    if (this.autoArchive) {
      this.answer = { ...this.answer, head: this.#headOf(project) };
      this.archived(1, project);
    }
    return this.answer;
  }

  async recheck(project: string): Promise<RepositoryStatus> {
    this.calls.push(`recheck ${project}`);
    this.#once("recheck");
    if (this.recheckAnswer) {
      this.answer = this.recheckAnswer;
      this.recheckAnswer = undefined;
    }
    return this.answer;
  }

  /** The worker archived what the platform has, of `project` where it says which. */
  archived(at: number, project?: string): void {
    if (project !== undefined) this.platform?.archivedSeq.set(project, this.answer.head);
    const { reason: _, diverged: __, ...rest } = this.answer;
    this.answer = {
      ...rest,
      state: "ready",
      archiving: false,
      archivedSeq: this.answer.head,
      lastArchive: {
        sha: "a".repeat(40),
        seq: this.answer.head,
        at,
        kind: "manual",
        changed: 1,
        removed: 0,
        url: "",
      },
    };
  }
}

/** A window that can go to the back, on the clock of a test. */
export class TestWindow implements RepositoryEnvironment {
  visible = true;
  readonly #time: TestTime;
  readonly #listeners = new Set<() => void>();

  constructor(time: TestTime) {
    this.#time = time;
  }

  isVisible = () => this.visible;
  onVisible(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  setTimeout = (run: () => void, ms: number) => this.#time.setTimeout(run, ms);
  clearTimeout = (timer: unknown) => this.#time.clearTimeout(timer);
  now = () => this.#time.now();

  /** The window goes to the back, or comes to the front again. */
  show(visible: boolean): void {
    this.visible = visible;
    if (visible) for (const listener of this.#listeners) listener();
  }
}
