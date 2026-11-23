import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { lfsWorld, oidOf, type LfsWorld } from "../test/lfs-support.ts";
import { lfsObjects, lfsUploads, users } from "../schema.ts";
import { PUSHES_AT_ONCE } from "./jobs.ts";

/**
 * The worker puts what came in into Git LFS of the repository, on a real PostgreSQL and the fake
 * GitHub: an address of its own for each try, the whole file in one PUT, verified, noted, and the
 * staging file gone; what GitHub has is done at once, where it has it as large as the file is; what
 * is not the file that came in never gets there; what GitHub says no to fails and says why;
 * everything else is tried again, for a day. And the sweep every 15 minutes. Needs
 * AQ_TEST_DATABASE, see vitest.config.ts.
 */

const CHUNK = 1024;
const HOUR = 3600_000;

describe.skipIf(!TEST_DATABASE)("pushing uploads into Git LFS, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let l: LfsWorld;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    l = await lfsWorld(w, { limits: { chunkBytes: CHUNK }, transferMs: 2000 });
  });
  afterEach(() => {
    l.done();
  });

  /** A file that came in whole and was checked, waiting for the worker. */
  const received = async (data = randomBytes(3 * CHUNK + 7)) => {
    const { project, repo } = await l.linked();
    const begun = await l.begin(project.id, data);
    const answer = await l.sendAll(begun.json.id, data, CHUNK);
    expect(answer.json.state).toBe("received");
    return { project, repo, data, id: begun.json.id as string };
  };

  const batches = () => w.github.calls.filter((call) => call === "POST lfs/batch upload").length;

  test("puts the whole file into the storage, verifies it, notes it, and takes the staging file away", async () => {
    const { project, repo, data, id } = await received();
    expect(await l.pusher.push(id)).toEqual({ kind: "done" });
    const stored = repo.lfs.get(oidOf(data));
    expect(stored).toEqual(data);
    expect(w.github.calls).toContain("PUT lfs/object");
    expect(w.github.calls).toContain("POST lfs/verify");
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(data))),
    ).toMatchObject([{ repoId: repo.id, size: data.length }]);
    expect(await l.rowOf(id)).toMatchObject({ state: "done", error: null, attempts: 1 });
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
    expect((await l.p.send("GET", `/api/lfs/uploads/${id}`)).json).toMatchObject({
      state: "done",
    });
    // Done is done: pushing it again does nothing.
    expect(await l.pusher.push(id)).toEqual({ kind: "none" });
    // And the next time the editor asks, it is there.
    expect((await l.begin(project.id, data)).json.state).toBe("present");
  });

  test("an object the storage has by now is done at once, without sending it", async () => {
    const { repo, data, id } = await received();
    w.github.addLfsObject(repo.id, data);
    expect(await l.pusher.push(id)).toEqual({ kind: "done" });
    expect(w.github.calls).not.toContain("PUT lfs/object");
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(data))),
    ).toHaveLength(1);
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
  });

  test("an object GitHub says it has, but not as large as the file is: the upload fails, and nothing is noted", async () => {
    const { project, repo, data, id } = await received();
    // The storage goes by the oid alone, and has something of another size under this one.
    repo.lfs.set(oidOf(data), randomBytes(data.length - 1));
    w.github.faults.lfsAnySize = true;
    expect(await l.pusher.push(id)).toEqual({ kind: "failed", error: "changed" });
    expect(w.github.calls).not.toContain("PUT lfs/object");
    expect(await l.rowOf(id)).toMatchObject({ state: "failed", error: "changed" });
    expect((await l.rowOf(id))?.detail).toContain(String(data.length - 1));
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(data))),
    ).toEqual([]);
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
    expect((await l.begin(project.id, data)).json).toMatchObject({
      state: "failed",
      error: "changed",
    });
  });

  test("a staging file that changed after it was checked is not the file: it never gets into the storage, the upload fails, and the file goes", async () => {
    for (const what of ["other bytes", "more bytes"] as const) {
      const { project, repo, data, id } = await received();
      // After the check, before the push: a disk that went wrong, a mistake, someone at the volume.
      writeFileSync(
        l.staging.pathOf(id),
        randomBytes(what === "other bytes" ? data.length : data.length + 500),
      );
      const fds = () => readdirSync("/proc/self/fd").length;
      const open = fds();
      expect(await l.pusher.push(id), what).toEqual({ kind: "failed", error: "changed" });
      // Neither an object, nor what would become one once verified.
      expect(repo.lfs.has(oidOf(data)), what).toBe(false);
      expect(repo.lfsPut.has(oidOf(data)), what).toBe(false);
      expect(w.github.calls, what).not.toContain("POST lfs/verify");
      expect(
        await t.db
          .select()
          .from(lfsObjects)
          .where(eq(lfsObjects.oid, oidOf(data))),
        what,
      ).toEqual([]);
      expect(await l.rowOf(id), what).toMatchObject({ state: "failed", error: "changed" });
      expect(existsSync(l.staging.pathOf(id)), what).toBe(false);
      // The file it read is closed.
      await vi.waitFor(() => expect(fds(), what).toBeLessThanOrEqual(open));
      // Not tried again; the editor has the file, and starts anew.
      expect(await l.pusher.push(id), what).toEqual({ kind: "none" });
      expect((await l.begin(project.id, data)).status, what).toBe(201);
    }
  });

  test("asks for an address every time: one that ran out is tried again later, with a new one", async () => {
    const { repo, data, id } = await received();
    // The editor's start asked once, whether GitHub had it.
    const before = batches();
    w.github.faults.lfsExpireEarly = 1;
    const first = await l.pusher.push(id);
    expect(first).toMatchObject({ kind: "later" });
    expect(await l.rowOf(id)).toMatchObject({ state: "received", attempts: 1 });
    expect((await l.rowOf(id))?.detail).toMatch(/403/);
    // The staging file stays: what is not in the storage can still go there.
    expect(existsSync(l.staging.pathOf(id))).toBe(true);
    // Not before it is due.
    expect(await l.pusher.push(id)).toEqual({ kind: "none" });
    w.time.later(60_000);
    expect(await l.pusher.push(id)).toEqual({ kind: "done" });
    expect(batches() - before).toBe(2);
    expect(repo.lfs.get(oidOf(data))).toEqual(data);
  });

  test("a connection that breaks halfway is tried again later, with the whole file", async () => {
    const { repo, data, id } = await received(randomBytes(64 * CHUNK));
    w.github.faults.lfsCutUploads = 1;
    expect(await l.pusher.push(id)).toMatchObject({ kind: "later" });
    expect(repo.lfs.has(oidOf(data))).toBe(false);
    w.time.later(60_000);
    expect(await l.pusher.push(id)).toEqual({ kind: "done" });
    expect(repo.lfs.get(oidOf(data))).toEqual(data);
  });

  test("a storage that is too slow is given up on and tried again later, waiting longer each time", async () => {
    const { repo, data, id } = await received();
    w.github.faults.lfsDelayMs = 2500;
    const first = await l.pusher.push(id);
    expect(first).toMatchObject({ kind: "later" });
    w.time.later(60_000);
    const second = await l.pusher.push(id);
    expect(second).toMatchObject({ kind: "later" });
    // 1 minute, then 2.
    const waited = (second as { at: Date }).at.getTime() - w.time.now.getTime();
    expect(waited).toBe(2 * 60_000);
    w.github.faults.lfsDelayMs = 0;
    w.time.later(2 * 60_000);
    expect(await l.pusher.push(id)).toEqual({ kind: "done" });
    expect(repo.lfs.get(oidOf(data))).toEqual(data);
  });

  test("no room left at GitHub, a file too large for it, or the repository gone: fails for good, says why, and the file goes", async () => {
    const cases: [string, () => void, string][] = [
      ["quota", () => (w.github.faults.lfsQuota = true), "githubQuota"],
      ["too large", () => (w.github.faults.lfsMaxBytes = 10), "tooLarge"],
      ["gone", () => {}, "gone"],
    ];
    for (const [what, fault, error] of cases) {
      const { repo, id } = await received();
      fault();
      if (what === "gone") w.github.deleteRepo(repo.id);
      expect(await l.pusher.push(id), what).toEqual({ kind: "failed", error });
      expect((await l.rowOf(id))?.state, what).toBe("failed");
      expect(existsSync(l.staging.pathOf(id)), what).toBe(false);
      const said = (await l.p.send("GET", `/api/lfs/uploads/${id}`)).json;
      expect(said, what).toMatchObject({ state: "failed", error });
      expect(said.detail, what).toBeTruthy();
      w.github.faults.lfsQuota = false;
      w.github.faults.lfsMaxBytes = 2 * 1024 ** 3;
    }
  });

  test("tried for a day from when it came in, then it expires and the file goes", async () => {
    const { id } = await received();
    w.github.faults.down = 1000;
    let outcome = await l.pusher.push(id);
    for (let tries = 0; outcome.kind === "later" && tries < 100; tries++) {
      w.time.now = (outcome as { at: Date }).at;
      outcome = await l.pusher.push(id);
    }
    w.github.faults.down = 0;
    expect(outcome).toEqual({ kind: "expired" });
    const row = await l.rowOf(id);
    expect(row?.state).toBe("expired");
    expect(w.time.now.getTime() - row!.receivedAt!.getTime()).toBeLessThanOrEqual(24 * HOUR);
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
  });

  test("the staging file gone, or a project linked to another repository: fails, and says so", async () => {
    const lost = await received();
    await l.staging.remove(lost.id);
    expect(await l.pusher.push(lost.id)).toEqual({ kind: "failed", error: "lost" });
    const moved = await received();
    await t.db.update(lfsUploads).set({ repoId: 1 }).where(eq(lfsUploads.id, moved.id));
    expect(await l.pusher.push(moved.id)).toEqual({ kind: "failed", error: "gone" });
  });

  test("nothing goes to GitHub for someone who is disabled: it waits", async () => {
    const { id } = await received();
    const before = batches();
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, w.userId));
    expect(await l.pusher.push(id)).toMatchObject({ kind: "later" });
    expect(batches()).toBe(before);
    await t.db.update(users).set({ disabledAt: null }).where(eq(users.id, w.userId));
  });

  test("given up while it is pushed, it stays given up", async () => {
    const { data, id } = await received();
    // Given up after the push took it, before it read the file.
    let given = false;
    w.github.onCall = async (call) => {
      if (given || !call.startsWith("GET /repositories/")) return;
      given = true;
      expect((await l.p.send("DELETE", `/api/lfs/uploads/${id}`)).status).toBe(204);
    };
    const outcome = await l.pusher.push(id);
    w.github.onCall = undefined;
    expect(given).toBe(true);
    expect(outcome).toEqual({ kind: "failed", error: "lost" });
    expect(await l.rowOf(id)).toMatchObject({ state: "failed", error: "cancelled" });
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(data))),
    ).toEqual([]);
  });

  test("two at a time", () => {
    expect(PUSHES_AT_ONCE).toBe(2);
  });
});

describe.skipIf(!TEST_DATABASE)("the sweep of uploads into Git LFS, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let l: LfsWorld;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    l = await lfsWorld(w, { limits: { chunkBytes: CHUNK } });
    await t.db.delete(lfsUploads);
  });
  afterEach(() => {
    l.done();
  });

  test("expires what got no piece for a day, and takes its file away", async () => {
    const { project } = await l.linked();
    const data = randomBytes(2 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    await l.piece(id, 0, data.subarray(0, CHUNK));
    w.time.later(23 * HOUR);
    expect((await l.sweeper.sweep()).expired).toBe(0);
    // A piece now: a day from now.
    await l.piece(id, CHUNK, data.subarray(CHUNK, CHUNK + 10));
    w.time.later(23 * HOUR);
    expect((await l.sweeper.sweep()).expired).toBe(0);
    w.time.later(2 * HOUR);
    const swept = await l.sweeper.sweep();
    expect(swept).toMatchObject({ expired: 1, removed: 1 });
    expect((await l.rowOf(id))?.state).toBe("expired");
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
    // A piece of it after that: it says so.
    expect((await l.piece(id, CHUNK + 10, data.subarray(CHUNK + 10))).json.state).toBe("expired");
  });

  test("expires what is not all there three days after its start, whatever came meanwhile", async () => {
    const { project } = await l.linked();
    const data = randomBytes(6 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    // A piece every 23 hours: never a day without one.
    for (let piece = 0; piece < 4; piece++) {
      await l.piece(id, piece * CHUNK, data.subarray(piece * CHUNK, (piece + 1) * CHUNK));
      expect((await l.sweeper.sweep()).expired, `after piece ${piece}`).toBe(0);
      w.time.later(piece < 3 ? 23 * HOUR : 2 * HOUR);
    }
    // 71 hours after its start, an hour after its last piece.
    expect((await l.sweeper.sweep()).expired).toBe(0);
    w.time.later(2 * HOUR);
    expect(await l.sweeper.sweep()).toMatchObject({ expired: 1, removed: 1 });
    expect(await l.rowOf(id)).toMatchObject({ state: "expired", received: 4 * CHUNK });
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
    // Its room is free: sent again, it starts anew.
    expect((await l.begin(project.id, data)).status).toBe(201);
  });

  test("expires what could not be put into the storage for a day since it came in, and queues what is due", async () => {
    const { project } = await l.linked();
    const data = randomBytes(CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    await l.piece(id, 0, data);
    await l.checked(id);
    expect((await l.sweeper.sweep()).due).toEqual([id]);
    await t.db
      .update(lfsUploads)
      .set({ nextAttemptAt: new Date(w.time.now.getTime() + HOUR) })
      .where(eq(lfsUploads.id, id));
    expect((await l.sweeper.sweep()).due).toEqual([]);
    w.time.later(HOUR);
    expect((await l.sweeper.sweep()).due).toEqual([id]);
    w.time.later(24 * HOUR);
    const swept = await l.sweeper.sweep();
    expect(swept).toMatchObject({ expired: 1, removed: 1, due: [] });
    expect((await l.rowOf(id))?.state).toBe("expired");
  });

  test("goes on with what a worker that stopped was pushing: at once when a worker starts, otherwise once it is stale", async () => {
    const { project } = await l.linked();
    const data = randomBytes(CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    await l.piece(id, 0, data);
    await l.checked(id);
    await t.db.update(lfsUploads).set({ state: "pushing" }).where(eq(lfsUploads.id, id));
    expect((await l.sweeper.sweep()).due).toEqual([]);
    expect((await l.sweeper.sweep({ resume: true })).due).toEqual([id]);
    w.time.later(3 * HOUR + 1);
    expect((await l.sweeper.sweep()).due).toEqual([id]);
    // And a push takes it over.
    expect(await l.pusher.push(id)).toEqual({ kind: "done" });
  });

  test("takes away the files of uploads that are over or not there, and nothing else in the folder", async () => {
    const { project } = await l.linked();
    const open = randomBytes(CHUNK);
    const openId = (await l.begin(project.id, open)).json.id as string;
    const over = randomBytes(CHUNK);
    const overId = (await l.begin(project.id, over)).json.id as string;
    await t.db.update(lfsUploads).set({ state: "failed" }).where(eq(lfsUploads.id, overId));
    const orphan = randomUUID();
    writeFileSync(l.staging.pathOf(orphan), "of an upload the database has nothing of");
    const foreign = ["notes.txt", `${randomUUID()}.part.bak`, "lost+found"];
    writeFileSync(join(l.dir, foreign[0]!), "someone else's");
    writeFileSync(join(l.dir, foreign[1]!), "x");
    mkdirSync(join(l.dir, foreign[2]!));
    const swept = await l.sweeper.sweep();
    expect(swept).toMatchObject({ removed: 2, others: 3 });
    expect(existsSync(l.staging.pathOf(openId))).toBe(true);
    expect(existsSync(l.staging.pathOf(overId))).toBe(false);
    expect(existsSync(l.staging.pathOf(orphan))).toBe(false);
    for (const name of foreign) expect(existsSync(join(l.dir, name)), name).toBe(true);
  });

  test("forgets uploads a week after they were over", async () => {
    const { project } = await l.linked();
    const id = (await l.begin(project.id, randomBytes(CHUNK))).json.id as string;
    await l.p.send("DELETE", `/api/lfs/uploads/${id}`);
    w.time.later(6 * 24 * HOUR);
    expect((await l.sweeper.sweep()).forgotten).toBe(0);
    w.time.later(2 * 24 * HOUR);
    expect((await l.sweeper.sweep()).forgotten).toBe(1);
    expect(await l.rowOf(id)).toBeUndefined();
  });
});
