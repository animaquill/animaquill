import { ProjectStore, isProjectFile, type CommandCall } from "@animaquill/core";
import { SYNC_PROTOCOL } from "@animaquill/host/sync";
import { createProject } from "@animaquill/schema";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Archiver, type ArchiveKind, type ArchiveOutcome } from "../archive/archiver.ts";
import { ProjectExporter } from "../archive/exporter.ts";
import { RepoHosts, type RepoHost } from "../archive/repo-host.ts";
import { RepositoryService } from "../archive/service.ts";
import type { GitHubPersonRepos } from "../archive/github-host.ts";
import {
  projectRepos,
  projectSnapshots,
  projectUpdates,
  repoConflicts,
  repoMerges,
} from "../schema.ts";
import { SyncHub, type SyncLimits } from "../sync/hub.ts";
import type { SyncWho } from "../sync/hub.ts";
import { linkTo, quiet, WEB_URL, type World } from "./archive-support.ts";
import type { FakeContent, FakeRepo, FakeUser } from "./fake-github.ts";
import { TestPeer } from "./sync-support.ts";

/**
 * What tests of merging changes on GitHub share: a project made by a window of the hub, as an
 * editor makes one, linked to a repository of the fake GitHub; the hub that merges, and archives
 * that look, as the worker and the API do them; windows that change the project, also without
 * hearing the platform first; and people on GitHub, whose commits are made of what another copy of
 * the project exports, so that they are what an editor writes.
 */

let windows = 0;
let pushes = 0;

/** A window of the project: a copy of it, which hears the platform and sends what it changes. */
export class Window {
  readonly store: ProjectStore;
  readonly peer: TestPeer;
  /** Updates of the platform taken in so far, and the last one. */
  #heard = 0;
  seq = 0;
  /** Changes made without the platform, to be sent later on the update the window had then. */
  readonly #later: { readonly update: Uint8Array; readonly base: number }[] = [];
  readonly #made: Uint8Array[] = [];

  constructor(peer: TestPeer, store: ProjectStore) {
    this.peer = peer;
    this.store = store;
    this.store.onLocalUpdate((update) => this.#made.push(update));
  }

  static async open(hub: SyncHub, who: SyncWho, project: string, create?: ProjectStore) {
    const store = create ?? ProjectStore.create(createProject({ name: "空" }));
    const peer = new TestPeer(hub, who);
    windows += 1;
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project,
      after: 0,
      device: `d${windows}`,
      window: `w${windows}`,
      editor: "test",
      ...(create && { create: { name: "测试", projectId: create.getState().manifest.id } }),
      payload: create ? create.encodeState() : new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0 || peer.closedWith !== undefined, "synced");
    if (peer.closedWith) throw new Error(`closed: ${JSON.stringify(peer.closedWith)}`);
    const window = new Window(peer, store);
    window.hear();
    const synced = peer.of("synced").at(-1);
    if (synced) window.seq = Math.max(window.seq, synced.head);
    return window;
  }

  /** Takes in what came from the platform. */
  hear(): void {
    const updates = this.peer.of("update");
    for (const update of updates.slice(this.#heard)) {
      this.store.applyCloud([update.payload], update.seq);
      this.seq = Math.max(this.seq, update.seq);
    }
    this.#heard = updates.length;
  }

  /**
   * A change, sent at once on what the window has heard; resolves to the answer. Behind changes made
   * offline and not sent yet, it waits for them, as an editor sends its changes in order.
   */
  async change(call: CommandCall) {
    this.hear();
    if (this.#later.length > 0) {
      this.changeOffline(call);
      return { t: "later" } as const;
    }
    const update = this.#run(call);
    return this.send(update, this.seq);
  }

  /** A change made offline: sent with `flush`, on what the window had when it made it. */
  changeOffline(call: CommandCall): void {
    this.#later.push({ update: this.#run(call), base: this.seq });
  }

  /** Sends what was changed offline. */
  async flush() {
    const answers = [];
    for (const { update, base } of this.#later.splice(0))
      answers.push(await this.send(update, base));
    this.hear();
    return answers;
  }

  #run(call: CommandCall): Uint8Array {
    const before = this.#made.length;
    const result = this.store.execute(call);
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    const made = this.#made.slice(before);
    if (made.length !== 1) throw new Error(`${made.length} updates`);
    return made[0]!;
  }

  async send(payload: Uint8Array, base: number) {
    const id = ++pushes;
    this.peer.send({
      t: "push",
      id,
      kind: "user",
      base,
      at: Date.now(),
      window: "w",
      behind: base < this.seq,
      payload,
    });
    await this.peer.until(
      () => this.peer.received.some((message) => "id" in message && message.id === id),
      `an answer to ${id}`,
    );
    const answer = this.peer.received.find((message) => "id" in message && message.id === id)!;
    if (answer.t === "ack") this.seq = Math.max(this.seq, answer.seq);
    return answer;
  }
}

export interface MergeWorld {
  readonly w: World;
  readonly hub: SyncHub;
  readonly who: SyncWho;
  readonly project: string;
  readonly repo: FakeRepo;
  readonly window: Window;
  readonly service: RepositoryService;
  /** Merges queued by archives, and archives queued by the hub or the service. */
  readonly queued: string[];
  readonly archivesQueued: string[];
  merging: boolean;
  limits: { files: number; bytes: number } | undefined;
  /** The host archives use: a test can put one that does something at a moment in its place. */
  host: RepoHost;
  archiver(): Archiver;
}

/**
 * A project of a window, its first archive written into a new repository, and merges on (unless
 * said): what each test of merging starts from.
 */
export const mergeWorld = async (
  w: World,
  options: {
    readonly merging?: boolean;
    readonly hubLimits?: Partial<SyncLimits>;
    readonly store?: ProjectStore;
    readonly repo?: FakeRepo;
  } = {},
): Promise<MergeWorld> => {
  const queued: string[] = [];
  const archivesQueued: string[] = [];
  const hub = new SyncHub({
    db: w.db,
    log: quiet,
    limits: options.hubLimits ?? {},
    merged: async (project) => {
      archivesQueued.push(project);
    },
  });
  const who: SyncWho = { userId: w.userId, session: `s-${w.userId}` };
  const project = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
  const store =
    options.store ??
    (() => {
      const made = ProjectStore.create(createProject({ name: "测试" }));
      const run = (call: CommandCall) => {
        const result = made.execute(call);
        if (!result.ok) throw new Error(result.error.code);
      };
      run({
        type: "scene.add",
        params: {
          id: "intro",
          manifest: { name: "开场", entry: "index.html", runtime: 1 },
          files: { "index.html": "<p>intro</p>\n" },
        },
      });
      run({ type: "file.write", params: { path: CODE, text: LINES.join("") } });
      return made;
    })();
  const window = await Window.open(hub, who, project, store);
  const repo =
    options.repo ?? w.github.addRepo(w.person, { name: `film-${project}`, select: true });
  await linkTo(w, project, repo);
  const world: MergeWorld = {
    w,
    hub,
    who,
    project,
    repo,
    window,
    queued,
    archivesQueued,
    merging: options.merging ?? true,
    limits: undefined,
    host: w.host,
    service: new RepositoryService({
      db: w.db,
      host: w.host,
      people: {} as GitHubPersonRepos,
      tokenFor: undefined,
      enqueue: async (job) => {
        archivesQueued.push(job.project);
      },
      isQueued: async () => false,
      webUrl: WEB_URL,
      log: quiet,
      now: () => w.time.now,
    }),
    archiver: () =>
      new Archiver({
        db: w.db,
        hosts: RepoHosts.github(world.host),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => w.time.now,
        merging: async () => world.merging,
        enqueueMerge: async (merge) => {
          queued.push(merge);
        },
        ...(world.limits && { mergeLimits: world.limits }),
      }),
  };
  const first = await world.archiver().run(project, "first");
  if (first.kind !== "archived") throw new Error(`the first archive: ${JSON.stringify(first)}`);
  w.github.takeDeliveries();
  return world;
};

/** The code file every project of these tests has, of ten lines. */
export const CODE = "code/shared.js";
export const LINES = Array.from(
  { length: 10 },
  (_, index) => `export const v${index} = ${index};\n`,
);

/** A code file with one line in place of another. */
export const withLine = (text: string, index: number, line: string): string => {
  const lines = text.split(/(?<=\n)/);
  lines[index] = line;
  return lines.join("");
};

/**
 * An archive, and what it leads to: the merges it queued, done by the hub, and the archives after
 * them, until one comes to something else. Resolves to what each came to.
 */
export const archiveAndMerge = async (
  m: MergeWorld,
  kind: ArchiveKind = "auto",
  most = 6,
): Promise<ArchiveOutcome[]> => {
  const outcomes: ArchiveOutcome[] = [];
  let next: ArchiveKind = kind;
  for (let round = 0; round < most; round++) {
    const outcome = await m.archiver().run(m.project, next);
    outcomes.push(outcome);
    if (outcome.kind !== "merging") return outcomes;
    for (const merge of m.queued.splice(0)) await m.hub.mergeRepo(merge);
    m.window.hear();
    next = "auto";
  }
  return outcomes;
};

/** The project files on GitHub's branch, by path. */
export const projectFilesOf = (m: MergeWorld, sha?: string): Map<string, string> => {
  const all = sha ? m.w.github.filesAt(m.repo.id, sha) : m.w.github.files(m.repo.id);
  return new Map([...all].filter(([path]) => isProjectFile(path)));
};

/**
 * A commit on GitHub by someone else: the project as GitHub has it, changed by these commands in a
 * copy of its own, or by files written as they are (`files`).
 */
export const pushOnGitHub = (
  m: MergeWorld,
  change: {
    readonly calls?: readonly CommandCall[];
    readonly files?: Readonly<Record<string, FakeContent>>;
    readonly message?: string;
    readonly parent?: string | null;
  },
  who: FakeUser = m.w.person,
): string => {
  const before = projectFilesOf(m, change.parent ?? undefined);
  const files: Record<string, FakeContent> = {};
  if (change.calls && change.calls.length > 0) {
    const opened = ProjectStore.open(new Map(before));
    const store = opened.store;
    if (!store) throw new Error("GitHub's files do not open as a project");
    for (const call of change.calls) {
      const result = store.execute(call);
      if (!result.ok)
        throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    }
    const after = store.exportFiles({ here: { repo: String(m.repo.id) } }).files;
    for (const path of new Set([...before.keys(), ...after.keys()]))
      if (before.get(path) !== after.get(path)) files[path] = after.get(path) ?? null;
  }
  Object.assign(files, change.files ?? {});
  return m.w.github.commitAs(m.repo.id, who, files, change.message ?? "Edit on GitHub", {
    ...(change.parent !== undefined && { parent: change.parent }),
  });
};

export const linkRow = async (m: MergeWorld) =>
  (await m.w.db.select().from(projectRepos).where(eq(projectRepos.projectId, m.project)))[0]!;

export const mergesOf = async (m: MergeWorld) =>
  m.w.db.select().from(repoMerges).where(eq(repoMerges.projectId, m.project));

export const conflictsOf = async (m: MergeWorld) =>
  m.w.db.select().from(repoConflicts).where(eq(repoConflicts.projectId, m.project));

/** The project as the working copy has it now, as files. */
export const workingFiles = (m: MergeWorld): Map<string, string> => {
  m.window.hear();
  return m.window.store.exportFiles({ here: { repo: String(m.repo.id) } }).files;
};

/** The project as the platform has it, read from the database as an archive reads it, as files. */
export const platformFiles = async (m: MergeWorld): Promise<Map<string, string>> => {
  const [snapshot] = await m.w.db
    .select()
    .from(projectSnapshots)
    .where(and(eq(projectSnapshots.projectId, m.project), eq(projectSnapshots.reason, "compact")))
    .orderBy(desc(projectSnapshots.seq))
    .limit(1);
  const rows = await m.w.db
    .select()
    .from(projectUpdates)
    .where(and(eq(projectUpdates.projectId, m.project), gt(projectUpdates.seq, snapshot?.seq ?? 0)))
    .orderBy(asc(projectUpdates.seq));
  const parts = [...(snapshot ? [snapshot.state] : []), ...rows.map((row) => row.data)];
  const { store } = ProjectStore.fromUpdates(parts);
  if (!store || store.isMissingUpdates) throw new Error("the database does not have all of it");
  return store.exportFiles({ here: { repo: String(m.repo.id) } }).files;
};
