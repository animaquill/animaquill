import { OWNER_ONLY } from "../access.ts";
import { ProjectStore, isProjectFile, mergeUpdates, type CommandCall } from "@animaquill/core";
import { SYNC_CLOSE, SYNC_PROTOCOL } from "@animaquill/host/sync";
import { and, desc, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { linkTo, newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import type { FakeRepo } from "../test/fake-github.ts";
import { TestPeer } from "../test/sync-support.ts";
import { projectRepos, projects, projectSnapshots, projectUpdates } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { listProjects } from "../sync/list.ts";
import { wakeCopy } from "../sync/wake.ts";
import { ProjectExporter } from "./exporter.ts";
import { Rebuilder } from "./rebuild.ts";

/**
 * Letting go of working copies and making them again, at random (the plan of the redesign, 13.7,
 * "重建、P2", what the platform can test of it): windows change a project, it is archived, people
 * change it on GitHub, the platform lets go of its copy with or without changes the repository does
 * not have, and makes it again as a window comes for it; windows of the copies before come back with
 * changes of their own. After every step:
 *
 * 1. A copy made again has what the archive it was made from has, file by file, and nothing else.
 * 2. Each copy is the one after the one before: `generation` goes up by one, and only then.
 * 3. The list says of the project what it said before its copy went, but for the copy itself.
 * 4. A window of a copy before is turned away (`SYNC_CLOSE.rebuilt`), and nothing it sends is taken:
 *    the copy is as it was.
 *
 * Seeds go by AQ_FUZZ_SEEDS ("1,2,3"); a failure says its seed and step.
 */

/** A small generator of numbers, the same for the same seed. */
const randomOf = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (below: number) => Math.floor(next() * below),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T,
  };
};

const SEEDS = (process.env["AQ_FUZZ_SEEDS"] ?? "1,2,3,4,5,6").split(",").map(Number);
const STEPS = 40;
const SCENE = { name: "场景", entry: "index.html", runtime: 1 };

/** A window of the editor, with what it has of the project and which copy that is of. */
class Window {
  store: ProjectStore | undefined;
  generation: number | undefined;
  head = 0;
  peer: TestPeer | undefined;

  /** Says hello, and takes in what comes, until it is synced or closed. */
  async open(hub: SyncHub, who: { userId: string; session: string }, project: string) {
    const peer = new TestPeer(hub, who);
    this.peer = peer;
    peer.send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project,
      after: this.head,
      ...(this.generation !== undefined && { generation: this.generation }),
      device: "d",
      window: "w",
      editor: "dev",
      payload: new Uint8Array(0),
    });
    await peer.until(() => peer.of("synced").length > 0 || peer.closedWith !== undefined, "synced");
    if (peer.closedWith) return peer.closedWith;
    const payloads = peer.of("update").map((each) => each.payload);
    if (!this.store) this.store = ProjectStore.fromUpdates(payloads).store;
    else this.store.applyUpdates(payloads);
    this.generation = peer.of("welcome")[0]!.generation;
    this.head = peer.of("synced")[0]!.head;
    return undefined;
  }

  /** A change of its own, not sent yet. */
  change(call: CommandCall): Uint8Array {
    const made: Uint8Array[] = [];
    const off = this.store!.onLocalUpdate((update) => made.push(update));
    const result = this.store!.execute(call);
    off();
    if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
    return made.length === 1 ? made[0]! : mergeUpdates(made);
  }

  /** Sends a change, and waits for its answer, or for the connection to close. */
  async push(update: Uint8Array, id: number) {
    const peer = this.peer!;
    peer.send({
      t: "push",
      id,
      kind: "user",
      base: this.head,
      at: Date.now(),
      window: "w",
      behind: false,
      payload: update,
    });
    await peer.until(
      () =>
        peer.of("ack").some((each) => each.id === id) ||
        peer.of("reject").some((each) => each.id === id) ||
        peer.closedWith !== undefined,
      "an answer",
    );
    const ack = peer.of("ack").find((each) => each.id === id);
    if (ack) this.head = ack.seq;
    return ack;
  }

  close() {
    this.peer?.connection.close();
    this.peer = undefined;
  }
}

describe.skipIf(!TEST_DATABASE)("making working copies again at random, on a database", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  /** The working copy as the database has it, as files. */
  const copyFiles = async (id: string): Promise<Map<string, string>> => {
    const [snapshot] = await t.db
      .select()
      .from(projectSnapshots)
      .where(and(eq(projectSnapshots.projectId, id), eq(projectSnapshots.reason, "compact")))
      .orderBy(desc(projectSnapshots.seq))
      .limit(1);
    const updates = await t.db
      .select()
      .from(projectUpdates)
      .where(and(eq(projectUpdates.projectId, id), gt(projectUpdates.seq, snapshot?.seq ?? 0)))
      .orderBy(projectUpdates.seq);
    const { store } = ProjectStore.fromUpdates([
      ...(snapshot ? [snapshot.state] : []),
      ...updates.map((row) => row.data),
    ]);
    const files = new Map(store!.exportFiles().files);
    store!.destroy();
    return files;
  };
  const repoFiles = (w: World, repo: FakeRepo, sha: string) =>
    new Map([...w.github.filesAt(repo.id, sha)].filter(([path]) => isProjectFile(path)));
  const rowOf = async (id: string) =>
    (await t.db.select().from(projects).where(eq(projects.id, id)))[0]!;
  const linkOf = async (id: string) =>
    (await t.db.select().from(projectRepos).where(eq(projectRepos.projectId, id)))[0]!;
  const listed = async (w: World, id: string) => {
    const { projects: list } = await listProjects(t.db, w.userId, {
      webUrl: "https://github.test",
      now: w.time.now.getTime(),
    });
    const found = list.find((each) => each.id === id)!;
    return {
      id: found.id,
      name: found.name,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
      repository: found.repository,
      cover: found.cover,
    };
  };

  test.each(SEEDS)("seed %i", async (seed) => {
    const random = randomOf(seed);
    const w = await world(t.db);
    const who = { userId: w.userId, session: `fuzz-${seed}` };
    const hub = new SyncHub({
      db: t.db,
      log: quiet,
      now: () => w.time.now,
      rebuild: async () => {},
    });
    const rebuilder = new Rebuilder({
      db: t.db,
      host: w.host,
      exporter: new ProjectExporter({ heapMb: 256 }),
      log: quiet,
      now: () => w.time.now,
    });
    const project = await newProject(w);
    const repo = w.github.addRepo(w.person, { name: `fuzz-${seed}`, select: true });
    await linkTo(w, project.id, repo);
    await w.archiver().run(project.id, "first");

    let current: Window | undefined;
    /** Windows of copies before this one, with a change each has not sent. */
    const stale: Window[] = [];
    let pushes = 0;
    let released:
      { sha: string; generation: number; list: Awaited<ReturnType<typeof listed>> } | undefined;
    const generations: number[] = [1];
    const log: string[] = [];
    let rebuilds = 0;
    let turnedAway = 0;
    /** 4. A window of a copy before comes back with its change: turned away, nothing taken. */
    const comesBack = async (window: Window, where: string) => {
      const row = await rowOf(project.id);
      const before = { head: row.head, files: await copyFiles(project.id) };
      const opened = new Window();
      Object.assign(opened, {
        store: window.store,
        generation: window.generation,
        head: window.head,
      });
      const closed = await opened.open(hub, who, project.id);
      // Let in, it sends its change, and then all it has, as an editor does where the platform
      // says that the change needs what it does not have ("incomplete"): of another document.
      if (!closed) {
        opened.store!.applyUpdates([(window as Window & { pending: Uint8Array }).pending]);
        await opened.push(opened.store!.encodeWhole(), ++pushes);
      }
      opened.close();
      await hub.idle();
      // Nothing of it taken, first: what would be lost otherwise.
      expect((await rowOf(project.id)).head, where).toBe(before.head);
      expect(await copyFiles(project.id), where).toEqual(before.files);
      expect(closed?.code, where).toBe(SYNC_CLOSE.rebuilt);
      turnedAway += 1;
    };
    const randomChange = (window: Window): Uint8Array => {
      // The scenes this window's project has.
      const scenes = new Set<string>();
      for (const path of window.store!.exportFiles().files.keys()) {
        const scene = /^scenes\/([^/]+)\/scene\.json$/.exec(path);
        if (scene) scenes.add(scene[1]!);
      }
      const kind = random.int(3);
      if (kind === 0 || scenes.size === 0) {
        const id = `s${random.int(6)}`;
        if (!scenes.has(id)) {
          scenes.add(id);
          return window.change({
            type: "scene.add",
            params: {
              id,
              manifest: SCENE,
              files: { "index.html": `<p>${random.int(1000)}</p>\n` },
            },
          });
        }
      }
      if (kind === 1 && scenes.size > 0) {
        const id = random.pick([...scenes]);
        scenes.delete(id);
        return window.change({ type: "scene.remove", params: { scene: id } });
      }
      return window.change({
        type: "file.write",
        params: {
          path: `code/f${random.int(4)}.js`,
          text: `export const v = ${random.int(1e6)};\n`,
        },
      });
    };

    for (let step = 0; step < STEPS; step++) {
      const action = random.pick([
        "edit",
        "edit",
        "edit",
        "archive",
        "archive",
        "github",
        "release",
        "release",
        "rebuild",
        "stale",
      ] as const);
      log.push(action);
      const where = `seed ${seed}, step ${step} (${log.join(" ")})`;
      const row = await rowOf(project.id);
      switch (action) {
        case "edit": {
          if (row.copyState !== "live") break;
          if (!current) {
            current = new Window();
            const closed = await current.open(hub, who, project.id);
            expect(closed, where).toBeUndefined();
          }
          const ack = await current.push(randomChange(current), ++pushes);
          expect(ack, where).toBeDefined();
          w.time.later(60_000);
          break;
        }
        case "archive":
          w.time.later(10 * 60_000);
          await w.archiver().run(project.id, "auto");
          break;
        case "github": {
          // People change the repository on GitHub: a file that is not the project's, or one that is.
          if (random.chance(0.5))
            w.github.commitAs(repo.id, w.person, { "README.md": `# ${random.int(1000)}\n` });
          else
            w.github.commitAs(repo.id, w.person, {
              "code/f0.js": `export const theirs = ${random.int(1000)};\n`,
            });
          if (row.copyState !== "live") break;
          // Archiving pauses for theirs: people choose to go on with what the editor has.
          await w.archiver().run(project.id, "check");
          const link = await linkOf(project.id);
          if (link.state === "paused" && link.pauseReason === "diverged" && random.chance(0.5))
            await t.db
              .update(projectRepos)
              .set({
                state: "ready",
                pauseReason: null,
                diverged: null,
                pausedAt: null,
                headSha: link.diverged!.sha,
                archivedSeq: 0,
              })
              .where(eq(projectRepos.projectId, project.id));
          break;
        }
        case "release": {
          if (row.copyState !== "live") break;
          // Mostly after everything is archived, as after a week nobody opened it.
          if (random.chance(0.6)) {
            w.time.later(10 * 60_000);
            await w.archiver().run(project.id, "auto");
          }
          // A window had it open, and keeps what it has.
          if (!current) {
            current = new Window();
            expect(await current.open(hub, who, project.id), where).toBeUndefined();
          }
          const window = current;
          current?.close();
          current = undefined;
          await hub.idle();
          const list = await listed(w, project.id);
          const outcome = await hub.release(project.id, { unarchived: random.chance(0.5) });
          log.push(`(${outcome.kind})`);
          if (outcome.kind === "released") {
            expect(outcome.from.generation, where).toBe(row.generation);
            released = { sha: outcome.from.headSha, generation: row.generation, list };
            expect(await rowOf(project.id), where).toMatchObject({
              copyState: "released",
              generation: row.generation,
            });
            // A window of it comes back later, with a change of its own.
            if (window) {
              const update = randomChange(window);
              stale.push(Object.assign(window, { pending: update }));
            }
          }
          // Otherwise it stays, and the next change opens a window again.
          break;
        }
        case "rebuild": {
          if (row.copyState === "live") break;
          await wakeCopy(t.db, project.id, { userId: w.userId, access: OWNER_ONLY }, w.time.now);
          const outcome = await rebuilder.run(project.id);
          expect(outcome.kind, where).toBe("rebuilt");
          const after = await rowOf(project.id);
          // 2. The copy after the one before.
          expect(after.generation, where).toBe(released!.generation + 1);
          expect(after.generation, where).toBe(generations.at(-1)! + 1);
          generations.push(after.generation);
          // 1. What the archive has, file by file.
          expect(await copyFiles(project.id), where).toEqual(repoFiles(w, repo, released!.sha));
          // 3. The list as it was.
          expect(await listed(w, project.id), where).toEqual(released!.list);
          rebuilds += 1;
          // The windows of the copies before come back at once, as they do once it is there.
          for (const window of stale) await comesBack(window, where);
          break;
        }
        case "stale": {
          const window = stale.length > 0 ? stale[random.int(stale.length)] : undefined;
          if (!window || row.copyState !== "live") break;
          await comesBack(window, where);
          break;
        }
      }
    }
    hub.stop();
    expect(generations, `seed ${seed}`).toEqual(generations.map((_, index) => index + 1));
    // It came to what it is for.
    expect(rebuilds, `seed ${seed}: ${log.join(" ")}`).toBeGreaterThan(0);
    expect(turnedAway, `seed ${seed}: ${log.join(" ")}`).toBeGreaterThan(0);
  });
});
