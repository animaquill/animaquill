import { ProjectStore, mergeUpdates, type CommandCall, type Origin } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { eq, sql } from "drizzle-orm";
import {
  Archiver,
  CONFIRM_AFTER_MS,
  type ArchiveKind,
  type ArchiverOptions,
} from "../archive/archiver.ts";
import { ProjectExporter } from "../archive/exporter.ts";
import { GitHubRepoHost } from "../archive/github-host.ts";
import {
  RepoHosts,
  type RepoHost,
  type RepoPlace,
  type RepoSession,
} from "../archive/repo-host.ts";
import type { Db } from "../database.ts";
import { GitHubApp } from "../github/app.ts";
import { digestOf } from "../sync/hub.ts";
import { installations, projectRepos, projects, projectUpdates, users } from "../schema.ts";
import { FakeGitHub, type FakeRepo, type FakeUser } from "./fake-github.ts";

/**
 * What tests of archiving share: a person with the App installed, projects in the database as the
 * hub keeps them (numbered updates, `dirty_since` in the same statement), repositories on a fake
 * GitHub, and an archiver whose clock the test moves.
 */

export const API = "https://github.test/api";
/** Where the fake GitHub's web site is, and Git LFS with it. */
export const WEB_URL = "https://github.test";

export const quiet = { info() {}, warn() {}, error() {} };

/** A project of the editor, and the updates its changes make. */
export class Editor {
  readonly store: ProjectStore;
  readonly updates: Uint8Array[] = [];

  constructor(name = "测试") {
    this.store = ProjectStore.create(createProject({ name }));
    this.store.onLocalUpdate((update) => this.updates.push(update));
  }

  get projectId(): string {
    return this.store.getState().manifest.id;
  }

  /** A command, as people run it, or as `origin` does, such as an upload (`STORAGE`). */
  change(call: CommandCall, origin?: Origin): Uint8Array {
    const before = this.updates.length;
    const result = this.store.execute(call, origin === undefined ? {} : { origin });
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    return mergeAll(this.updates.slice(before));
  }

  /** Writes into the document behind the editor's back, as two windows at once can leave it. */
  raw(write: (doc: ProjectStore["doc"]) => void): Uint8Array {
    const made: Uint8Array[] = [];
    const take = (update: Uint8Array) => made.push(update);
    this.store.doc.on("update", take);
    this.store.doc.transact(() => write(this.store.doc));
    this.store.doc.off("update", take);
    if (made.length === 0) throw new Error("nothing changed");
    return mergeAll(made);
  }
}

/** One update made of several, as Yjs merges them. */
const mergeAll = (updates: readonly Uint8Array[]): Uint8Array =>
  updates.length === 1 ? (updates[0] as Uint8Array) : mergeUpdates(updates);

export interface Clock {
  now: Date;
  later(ms: number): Date;
}

export const clock = (start = new Date("2026-11-10T08:00:00Z")): Clock => {
  const made: Clock = {
    now: start,
    later(ms) {
      made.now = new Date(made.now.getTime() + ms);
      return made.now;
    },
  };
  return made;
};

/** A level of the document, as raw writes see it. */
export type Level = { get(key: string): unknown; set(key: string, value: unknown): void };

export const projectMap = (doc: ProjectStore["doc"]) => doc.getMap("project") as unknown as Level;

/** Ways a test makes a session of a repository fail at a moment, as a process that stops. */
export interface Crashes {
  /** Before the branch moves: the commit is made and noted, the branch is where it was. */
  beforeAdvance?: boolean;
  /** Once the branch moved, before the database knows. */
  afterAdvance?: boolean;
}

export class Crash extends Error {
  override name = "Crash";
}

/** A host whose sessions stop where a test says, see `Crashes`. */
export const crashingHost = (host: RepoHost, crashes: Crashes): RepoHost => ({
  open(place: RepoPlace, options): RepoSession {
    const session = host.open(place, options);
    return {
      info: () => session.info(),
      tip: (branch) => session.tip(branch),
      commit: (sha) => session.commit(sha),
      compare: (base, head) => session.compare(base, head),
      tree: (sha, listing) => session.tree(sha, listing),
      blob: (sha) => session.blob(sha),
      writeTree: (base, changes) => session.writeTree(base, changes),
      writeCommit: (commit) => session.writeCommit(commit),
      start: (file, message, author, at) => session.start(file, message, author, at),
      lfsBatch: (operation, objects) => session.lfsBatch(operation, objects),
      lfsSizes: (objects) => session.lfsSizes(objects),
      files: (commit, entries) => session.files(commit, entries),
      close: () => session.close(),
      async advance(branch, sha) {
        if (crashes.beforeAdvance) {
          crashes.beforeAdvance = false;
          throw new Crash("stopped before the branch moved");
        }
        const moved = await session.advance(branch, sha);
        if (crashes.afterAdvance) {
          crashes.afterAdvance = false;
          throw new Crash("stopped after the branch moved");
        }
        return moved;
      },
    };
  },
});

export interface World {
  readonly db: Db;
  readonly github: FakeGitHub;
  readonly app: GitHubApp;
  readonly host: GitHubRepoHost;
  readonly time: Clock;
  readonly person: FakeUser;
  readonly userId: string;
  readonly installation: number;
  /** `more`: what else the archiver goes by, such as whether merges are on. */
  archiver(host?: RepoHost, more?: Partial<ArchiverOptions>): Archiver;
}

let people = 0;

/** A person with an account, the App installed on their account (selected repositories). */
export const world = async (db: Db, time = clock()): Promise<World> => {
  people += 1;
  const person = {
    id: 70_000_000 + people * 13 + Math.floor(Math.random() * 1e6),
    login: `artist${people}`,
  };
  const github = new FakeGitHub();
  const installation = github.install(person);
  github.takeDeliveries();
  const [user] = await db
    .insert(users)
    .values({ githubId: person.id, login: person.login })
    .returning({ id: users.id });
  await db.insert(installations).values({
    id: installation,
    accountId: person.id,
    accountLogin: person.login,
    accountType: "User",
    repositorySelection: "selected",
  });
  const app = new GitHubApp({
    apiUrl: API,
    fetch: github.fetch,
    issuer: github.clientId,
    privateKey: github.privateKey,
    now: () => Date.now(),
  });
  const host = new GitHubRepoHost(app, { apiUrl: API, webUrl: WEB_URL, fetch: github.fetch });
  return {
    db,
    github,
    app,
    host,
    time,
    person,
    userId: (user as { id: string }).id,
    installation,
    archiver: (other, more) =>
      new Archiver({
        db,
        hosts: RepoHosts.github(other ?? host),
        exporter: new ProjectExporter({ heapMb: 256 }),
        log: quiet,
        now: () => time.now,
        ...more,
      }),
  };
};

let projectNumber = 0;

/** A project on the platform, as the hub keeps it: its first version is update 1. */
export const newProject = async (w: World, editor = new Editor()) => {
  projectNumber += 1;
  const id = `p${Date.now().toString(36)}a${projectNumber}${Math.floor(Math.random() * 1e6)}`;
  const state = editor.store.encodeWhole();
  const digest = digestOf("", 1, state);
  await w.db.insert(projects).values({
    id,
    ownerId: w.userId,
    projectId: editor.projectId,
    name: editor.store.getState().manifest.name,
    head: 1,
    digest,
    bytes: state.length,
    createdAt: w.time.now,
    updatedAt: w.time.now,
    dirtySince: w.time.now,
  });
  await w.db.insert(projectUpdates).values({
    projectId: id,
    seq: 1,
    digest,
    data: Buffer.from(state),
    kind: "first",
    device: "d1",
    window: "w1",
    base: 0,
    madeAt: w.time.now,
    createdAt: w.time.now,
  });
  return { id, editor };
};

/** Takes a change as the hub does: the next number, and changes waiting since the first of them. */
export const keep = async (db: Db, id: string, update: Uint8Array, at: Date) => {
  await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ head: projects.head, digest: projects.digest })
      .from(projects)
      .where(eq(projects.id, id))
      .for("update");
    if (!project) throw new Error(`no project ${id}`);
    const seq = project.head + 1;
    const digest = digestOf(project.digest, seq, update);
    await tx
      .update(projects)
      .set({
        head: seq,
        digest,
        updatedAt: at,
        dirtySince: sql`coalesce(${projects.dirtySince}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(projects.id, id));
    await tx.insert(projectUpdates).values({
      projectId: id,
      seq,
      digest,
      data: Buffer.from(update),
      kind: "user",
      device: "d1",
      window: "w1",
      base: project.head,
      madeAt: at,
      createdAt: at,
    });
  });
};

/** A change of the editor, kept as the hub would. */
export const edit = async (
  w: World,
  project: { id: string; editor: Editor },
  call: CommandCall,
  origin?: Origin,
) => keep(w.db, project.id, project.editor.change(call, origin), w.time.now);

/** Links a project to a repository of the fake GitHub, as linking does. */
export const linkTo = async (w: World, projectId: string, repo: FakeRepo, createdHere = true) => {
  await w.db.insert(projectRepos).values({
    projectId,
    installationId: w.installation,
    repoId: repo.id,
    ownerId: repo.owner.id,
    ownerLogin: repo.owner.login,
    name: repo.name,
    branch: repo.defaultBranch,
    private: repo.private,
    createdHere,
    linkedBy: w.userId,
    linkedAt: w.time.now,
  });
};

export const write = (path: string, text: string): CommandCall => ({
  type: "file.write",
  params: { path, text },
});

/**
 * An archive that finds the repository cannot be used says so only where the next one, a few
 * minutes on, finds the same (`CONFIRM_AFTER_MS`): runs the first, and where it failed the second
 * one then, which resolves to what that came to.
 */
export const confirmed = async (w: World, id: string, kind: ArchiveKind = "auto") => {
  const first = await w.archiver().run(id, kind);
  if (first.kind !== "failed") return first;
  w.time.later(CONFIRM_AFTER_MS);
  return w.archiver().run(id, kind);
};
