import { ProjectStore, type CommandCall } from "@animaquill/core";
import { MemoryCloudLinks, newSyncId, type CloudAccess } from "@animaquill/host";
import { MemoryWriters } from "@animaquill/host/memory";
import { SYNC_PROTOCOL } from "@animaquill/host/sync";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  CODE,
  LOCAL,
  fixture,
  PROJECT,
  TestBrowser,
  type TestWindow,
} from "../../../ui/src/folder/folder-support.ts";
import { MemoryLines } from "../../../ui/src/cloud/cloud-support.ts";
import { CloudSession } from "../../../ui/src/cloud/session.ts";
import { ProjectOpening } from "../../../ui/src/workbench/opening.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { TestPeer, hubConnection, someone, type LineFaults } from "../test/sync-support.ts";
import { projectRepos, projectUpdates, repoConflicts, repoMerges } from "../schema.ts";
import { writeMergeInput, type MergeInput } from "./batches.ts";
import { SyncHub } from "./hub.ts";

/**
 * Opening a project folder that is a clone of the repository of its project of the platform, where
 * the platform answers too late: the folder comes in first (`ProjectOpening`, the design of data and
 * syncing, 2.5), with the same change that the platform merged from GitHub meanwhile. What the
 * folder brought says the update of the platform it was made on, so that this platform knows it
 * came without the merge: the line is there once in the end where it can put that right, and
 * where it cannot, people are asked to look (`check-duplicate`). On a real PostgreSQL: needs
 * AQ_TEST_DATABASE, see vitest.config.ts.
 */

const quiet = { info() {}, warn() {}, error() {} };
const PLATFORM = "https://editor.example.com";
const FAST = {
  quietMs: 20,
  longestMs: 200,
  retryMs: 100,
  settleMs: 50,
  answerMs: 100,
};
const REPO = 525_252;
let repos = 0;

const write = (path: string, text: string): CommandCall =>
  ({ type: "file.write", params: { path, text } }) as CommandCall;

describe.skipIf(!TEST_DATABASE)("opening a folder where the platform answers too late", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });

  const conflictsOf = (project: string) =>
    database.db
      .select()
      .from(repoConflicts)
      .where(and(eq(repoConflicts.projectId, project), eq(repoConflicts.state, "open")));

  /** The project as the database has it, read anew. */
  async function kept(project: string): Promise<ProjectStore> {
    const rows = await database.db
      .select()
      .from(projectUpdates)
      .where(eq(projectUpdates.projectId, project))
      .orderBy(asc(projectUpdates.seq));
    const { store } = ProjectStore.fromUpdates(rows.map((row) => row.data));
    if (!store || store.isMissingUpdates) throw new Error("the database does not have all of it");
    return store;
  }

  /** A browser with a project folder, and the way its windows connect to the hub. */
  async function setUp() {
    const hub = new SyncHub({
      db: database.db,
      log: quiet,
      limits: {},
      merged: async () => {},
    });
    const who = await someone(database.db);
    const browser = new TestBrowser();
    const links = new MemoryCloudLinks();
    const writers = new MemoryWriters();
    const lines = new MemoryLines();
    const faults: LineFaults = { silent: false };
    const connections = new Set<ReturnType<typeof hubConnection>>();
    const access = (page: { isAlive: () => boolean; asleep: boolean }): CloudAccess => ({
      platform: PLATFORM,
      connect: () => {
        const line = hubConnection(hub, who, faults);
        connections.add(line);
        void line.closed.then(() => connections.delete(line));
        return line;
      },
      list: async () => [],
      links,
      syncer: (key) => writers.writer(`cloud.${key}`, page),
      line: (key) => lines.line(key),
    });
    /** Syncs a window's project, as `CloudProjects` starts it. */
    const syncOf = async (window: TestWindow) => {
      const link = await links.get(LOCAL);
      if (!link) throw new Error("no link");
      const page = { isAlive: () => true, asleep: false };
      const cloud = new CloudSession({
        store: window.store,
        journal: window.project.journal,
        cloud: access(page),
        link,
        window: "w",
        editor: "test",
        timing: { scanMs: 5, noteMs: 20, firstRetryMs: 50, helloMs: 5000 },
        onSeq: (seq) => {
          window.project.cloudSeq = seq;
        },
        ...(link.creating && {
          create: {
            name: "原子",
            projectId: window.store.getState().manifest.id,
          },
        }),
      });
      window.project.cloudSeq = link.seq;
      return cloud;
    };
    const online = (cloud: CloudSession) =>
      vi.waitFor(
        () =>
          expect(cloud.getSnapshot()).toMatchObject({
            state: "online",
            pending: 0,
            problem: undefined,
          }),
        { timeout: 10_000 },
      );

    // The project goes to the platform from a first window, and is saved to a repository. Its log
    // is the folder read as the editor opens a project, see `ProjectStore.open`.
    const opened = ProjectStore.open(fixture()).store as ProjectStore;
    await browser.library.create({ id: LOCAL, name: "原子" }, opened.encodeState());
    opened.destroy();
    const first = await browser.open({ start: false, timing: FAST });
    const project = newSyncId();
    const mark = (await (await browser.library.open(LOCAL)).entries?.())?.at(-1)?.mark ?? 0;
    await links.put({
      key: LOCAL,
      platform: PLATFORM,
      project,
      seq: 0,
      pushed: mark,
      linkedAt: 1,
      creating: true,
    });
    const firstCloud = await syncOf(first);
    firstCloud.start();
    await online(firstCloud);
    await firstCloud.close();
    await first.project.close();
    repos += 1;
    const repoId = REPO + repos * 10 + Math.floor(Math.random() * 9);
    await database.db.insert(projectRepos).values({
      projectId: project,
      installationId: 1,
      repoId,
      ownerId: 77,
      ownerLogin: "ada",
      name: `repo-${repoId}`,
      branch: "main",
      private: true,
      createdHere: true,
      prefer: "editor",
      archivedSeq: 1,
      headSha: "a".repeat(40),
    });
    const repository = first.store.exportFiles({
      here: { repo: String(repoId) },
    }).files;

    /** A commit on GitHub, which the platform merges into its working copy. */
    const merge = async (next: ReadonlyMap<string, string>) => {
      const files: MergeInput[] = [...new Set([...repository.keys(), ...next.keys()])]
        .filter((path) => repository.get(path) !== next.get(path))
        .map((path) => ({
          path,
          base: repository.get(path),
          theirs: next.get(path),
        }));
      const [row] = await database.db
        .insert(repoMerges)
        .values({
          projectId: project,
          repoId,
          fromSha: "a".repeat(40),
          toSha: "b".repeat(40),
          input: writeMergeInput(files),
        })
        .returning({ id: repoMerges.id });
      expect(await hub.mergeRepo((row as { id: string }).id)).toMatchObject({
        kind: "applied",
      });
    };

    /** A change from another computer, which the platform has. */
    const elsewhere = async (call: CommandCall) => {
      const store = await kept(project);
      const made: Uint8Array[] = [];
      store.onLocalUpdate((update) => made.push(update));
      const result = store.execute(call);
      if (!result.ok) throw new Error(result.error.code);
      const peer = new TestPeer(hub, who);
      peer.send({
        t: "hello",
        v: SYNC_PROTOCOL,
        project,
        after: 0,
        device: "elsewhere",
        window: "w1",
        editor: "test",
        payload: new Uint8Array(0),
      });
      await peer.until(() => peer.of("synced").length > 0, "synced");
      const head = peer.of("synced").at(-1)?.head ?? 0;
      for (const update of made) {
        peer.send({
          t: "push",
          id: 1,
          kind: "user",
          base: head,
          at: Date.now(),
          window: "w1",
          behind: false,
          payload: update,
        });
      }
      await peer.until(() => peer.of("ack").length > 0, "ack");
      peer.connection.close();
    };

    /**
     * Opens the project again with the platform silent, as `Workbench` puts the steps together,
     * and lets the platform answer once the folder came in.
     */
    const reopen = async () => {
      faults.silent = true;
      const again = await browser.open({ start: false, timing: FAST });
      const cloud = await syncOf(again);
      const opening = new ProjectOpening({
        session: again.project,
        undoLoaded: async () => {},
        cloud: { follow: async () => cloud.start(), syncOf: () => cloud },
        isFolder: () => true,
        timing: { catchUpMs: 300 },
      });
      await opening.folder(again.store, () => again.session.start());
      await vi.waitFor(() => expect(opening.getSnapshot().step).toBe("live"));
      expect(opening.getSnapshot().cloud).toBe("timeout");
      faults.silent = false;
      for (const line of Array.from(connections)) line.drop();
      await online(cloud);
      await hub.idle();
      return { again, cloud };
    };

    return {
      browser,
      project,
      repository,
      merge,
      elsewhere,
      reopen,
      kept,
      conflictsOf,
    };
  }

  test("the same lines from GitHub and from the folder are there once in the end", async () => {
    const { browser, project, repository, merge, reopen } = await setUp();
    const shared = repository.get(CODE) as string;
    const pulled = `${shared}// 推送的\n`;
    const next = new Map(repository);
    next.set(CODE, pulled);
    await merge(next);
    browser.disk.write(`${PROJECT}/${CODE}`, pulled, { quietly: true });

    const { again, cloud } = await reopen();
    await vi.waitFor(
      async () => expect((await kept(project)).getState().files[CODE]).toBe(pulled),
      {
        timeout: 10_000,
      },
    );
    await vi.waitFor(() => expect(again.store.getState().files[CODE]).toBe(pulled), {
      timeout: 10_000,
    });
    expect(await conflictsOf(project)).toEqual([]);
    await cloud.close();
    await again.session.close();
    await again.project.close();
  });

  test("where the platform cannot put it right, people are asked to look at the file", async () => {
    const { browser, project, repository, merge, elsewhere, reopen } = await setUp();
    const shared = repository.get(CODE) as string;
    // Another computer changed the file meanwhile: what GitHub brought is not taken as it is.
    await elsewhere(write(CODE, `// 另一台电脑\n${shared}`));
    const pulled = `${shared}// 推送的\n`;
    const next = new Map(repository);
    next.set(CODE, pulled);
    await merge(next);
    browser.disk.write(`${PROJECT}/${CODE}`, pulled, { quietly: true });

    const { again, cloud } = await reopen();
    await vi.waitFor(
      async () =>
        expect(
          (await conflictsOf(project)).filter(
            (conflict) => conflict.kind === "check-duplicate" && conflict.file === CODE,
          ),
        ).not.toEqual([]),
      { timeout: 10_000 },
    );
    await cloud.close();
    await again.session.close();
    await again.project.close();
  });
});
