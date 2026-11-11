import { ProjectStore } from "@animaquill/core";
import {
  CloudSignedOut,
  MemoryCloudLinks,
  RepositoryRefused,
  newSyncId,
  type AccountAccess,
  type CloudAccess,
  type CloudProjectSummary,
  type RepositoryAccess,
  type RepositoryCheck,
  type RepositoryChoice,
  type RepositoryLink,
  type RepositoryList,
  type RepositoryRefusal,
  type RepositoryStatus,
} from "@animaquill/host";
import { MemoryWriters } from "@animaquill/host/memory";
import { createProject } from "@animaquill/schema";
import { MemoryLines, MemoryPlatform, digestOf } from "../src/cloud/cloud-support.ts";

/**
 * For the browser tests, and for looking at the pages (`?cloud=fake`, with `?account=fake`): a
 * platform in this tab that keeps projects in step and saves them to pretend repositories, the
 * way the tests of the editor's own logic have one (`MemoryPlatform`). The development page has no
 * real one: AnimaQuill Cloud does, and tests it there.
 *
 * It lives as long as the page: a reload starts it empty, and with it the links of this browser,
 * so that the two never disagree. A test sets up what it needs through `window.aqCloud`.
 */

/** Who is signed in, as the fake account names them. */
const USER = "octo";
const PAGE = { isAlive: () => true, asleep: false };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The pretend repositories, a status for every project. */
export class LabRepositories implements RepositoryAccess {
  readonly statuses = new Map<string, RepositoryStatus>();
  /** What "用已有的仓库" lists. */
  choices: RepositoryChoice[] = [];
  /** Names of repositories the person has already, which a new one cannot take. */
  readonly taken = new Set<string>();
  /** What a check says about a repository of the list, by its id, where that is not a yes. */
  readonly checks = new Map<number, RepositoryCheck>();
  /** How long making or linking a repository takes, and the first archive after it. */
  linkMs = 0;
  archiveMs = 600;
  /** What the next try to make or link a repository is refused with, once. */
  refuseLink: RepositoryRefusal | undefined;
  #nextId = 100;
  readonly #platform: MemoryPlatform;

  constructor(platform: MemoryPlatform) {
    this.#platform = platform;
  }

  async list(page = 1): Promise<RepositoryList> {
    return {
      repositories: this.choices,
      page,
      more: false,
      manageUrl: "https://github.com/settings/installations/9",
    };
  }

  async check(choice: RepositoryLink): Promise<RepositoryCheck> {
    if ("create" in choice) {
      return this.taken.has(choice.create.name.toLowerCase())
        ? { ok: false, reason: "nameTaken" }
        : { ok: true };
    }
    const said = this.checks.get(choice.existing.id);
    if (said) return said;
    const chosen = this.choices.find((each) => each.id === choice.existing.id);
    if (!chosen) return { ok: false, reason: "notFound" };
    if (!chosen.private && choice.confirmPublic !== true) return { ok: false, reason: "public" };
    return { ok: true };
  }

  async link(project: string, choice: RepositoryLink): Promise<RepositoryStatus> {
    await wait(this.linkMs);
    const refusal = this.refuseLink;
    if (refusal) {
      this.refuseLink = undefined;
      throw new RepositoryRefused(refusal);
    }
    if ("create" in choice && this.taken.has(choice.create.name.toLowerCase()))
      throw new RepositoryRefused("nameTaken");
    const chosen =
      "create" in choice
        ? { id: this.#nextId++, owner: USER, name: choice.create.name, private: true }
        : this.choices.find((each) => each.id === choice.existing.id);
    if (!chosen) throw new RepositoryRefused("notFound");
    if ("create" in choice) this.taken.add(chosen.name.toLowerCase());
    this.#platform.repositories.set(project, chosen);
    const status: RepositoryStatus = {
      repository: {
        id: chosen.id,
        owner: chosen.owner,
        name: chosen.name,
        fullName: `${chosen.owner}/${chosen.name}`,
        private: chosen.private,
        branch: "main",
        url: `https://github.com/${chosen.owner}/${chosen.name}`,
        createdHere: "create" in choice,
        linkedAt: Date.now(),
      },
      state: "ready",
      archiving: true,
      head: this.#head(project),
      archivedSeq: 0,
    };
    this.statuses.set(project, status);
    if (this.archiveMs >= 0) setTimeout(() => this.archived(project), this.archiveMs);
    return status;
  }

  #head(project: string): number {
    return this.#platform.projects.get(project)?.head ?? 1;
  }

  async status(project: string): Promise<RepositoryStatus> {
    const kept = this.statuses.get(project);
    const head = this.#head(project);
    if (!kept) return { state: "none", archiving: false, head, archivedSeq: 0 };
    // Changes since the last archive wait for a quiet moment, as on the platform.
    const isBehind = kept.state === "ready" && !kept.archiving && head > kept.archivedSeq;
    return {
      ...kept,
      head,
      ...(isBehind && { dirtySince: Date.now() - 2 * 60_000, nextAt: Date.now() + 3 * 60_000 }),
    };
  }

  async archiveNow(project: string): Promise<RepositoryStatus> {
    const kept = this.statuses.get(project);
    if (!kept?.repository) throw new RepositoryRefused("notFound");
    const { reason: _, detail: __, diverged: ___, ...rest } = kept;
    this.statuses.set(project, { ...rest, state: "ready", archiving: true });
    if (this.archiveMs >= 0) setTimeout(() => this.archived(project), this.archiveMs);
    return this.status(project);
  }

  /** The first archive, or one people asked for, is done. `at`: when, for one of some time ago. */
  archived(project: string, at = Date.now()): void {
    const kept = this.statuses.get(project);
    if (!kept?.repository || kept.state !== "ready") return;
    const head = this.#head(project);
    this.statuses.set(project, {
      ...kept,
      archiving: false,
      archivedSeq: head,
      lastArchive: {
        sha: "a".repeat(40),
        seq: head,
        at,
        kind: kept.lastArchive ? "manual" : "first",
        changed: 1,
        removed: 0,
        url: "",
      },
    });
  }

  /** Archiving a project pauses, as the platform says it. */
  pause(project: string, reason: string, more: Partial<RepositoryStatus> = {}): void {
    const kept = this.statuses.get(project);
    if (!kept?.repository) return;
    this.statuses.set(project, { ...kept, ...more, state: "paused", archiving: false, reason });
    const repository = this.#platform.repositories.get(project);
    if (repository) this.#platform.repositories.set(project, { ...repository, state: "paused" });
  }
}

export interface CloudLab {
  readonly platform: MemoryPlatform;
  readonly repositories: LabRepositories;
  /**
   * A project that is on the platform already, as one from another computer: with a repository of
   * that name, or without one. `ago`: how long ago it changed, in milliseconds. Returns its id.
   */
  seed(
    name: string,
    options?: {
      readonly repository?: string;
      readonly ago?: number;
      readonly listed?: Partial<CloudProjectSummary>;
    },
  ): string;
}

export function fakeCloud(account: AccountAccess): { cloud: CloudAccess; lab: CloudLab } {
  const platform = new MemoryPlatform();
  const repositories = new LabRepositories(platform);
  const links = new MemoryCloudLinks();
  const writers = new MemoryWriters();
  const lines = new MemoryLines();
  const isSignedIn = () => account.getSnapshot().status === "signedIn";
  // The platform ends the connections of whoever signs out, as the real one does.
  account.subscribe(() => {
    if (account.getSnapshot().status === "signedOut") platform.signOut(USER);
    else if (isSignedIn()) platform.signIn(USER);
  });
  const signedIn = <T>(work: () => T): T => {
    if (!isSignedIn()) throw new CloudSignedOut("Nobody is signed in");
    return work();
  };
  let seeded = 0;
  return {
    cloud: {
      platform: location.origin,
      connect: () => platform.connect(USER, "lab"),
      // The list says what a project is called now, as the platform's does.
      list: async () =>
        signedIn(() =>
          platform.list(USER).map((summary) => ({
            ...summary,
            name: platform.workingCopy(summary.id).getState().manifest.name,
          })),
        ),
      remove: async (project) => signedIn(() => platform.remove(USER, project)),
      links,
      syncer: (key) => writers.writer(`cloud.${key}`, PAGE),
      line: (key) => lines.line(key),
      repository: repositories,
    },
    lab: {
      platform,
      repositories,
      seed(name, { repository, ago = 0, listed } = {}) {
        const store = ProjectStore.create(createProject({ name }));
        const data = store.encodeState();
        const projectId = store.getState().manifest.id;
        store.destroy();
        const id = newSyncId();
        const digest = digestOf("", 1, data);
        platform.projects.set(id, {
          id,
          owner: USER,
          projectId,
          name,
          generation: 1,
          head: 1,
          digest,
          updates: [
            { seq: 1, digest, data, kind: "first", device: "seed", base: 0, behind: false },
          ],
          snapshot: undefined,
          beforeMerge: [],
        });
        if (repository !== undefined) {
          const number = 500 + ++seeded;
          platform.repositories.set(id, { id: number, owner: USER, name: repository });
          repositories.taken.add(repository.toLowerCase());
          repositories.statuses.set(id, {
            repository: {
              id: number,
              owner: USER,
              name: repository,
              fullName: `${USER}/${repository}`,
              private: true,
              branch: "main",
              url: `https://github.com/${USER}/${repository}`,
              createdHere: true,
              linkedAt: Date.now() - ago,
            },
            state: "ready",
            archiving: false,
            head: 1,
            archivedSeq: 1,
            lastArchive: {
              sha: "b".repeat(40),
              seq: 1,
              at: Date.now() - ago,
              kind: "first",
              changed: 3,
              removed: 0,
              url: "",
            },
          });
        }
        platform.listed.set(id, { updatedAt: Date.now() - ago, ...listed });
        return id;
      },
    },
  };
}
