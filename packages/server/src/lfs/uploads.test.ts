import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { newProject, world, type World } from "../test/archive-support.ts";
import {
  connection,
  createTestDatabase,
  TEST_DATABASE,
  type TestDatabase,
} from "../test/database.ts";
import { lfsWorld, oidOf, RoomyStaging, type LfsWorld } from "../test/lfs-support.ts";
import { changeLfs } from "../me/lfs.ts";
import { lfsObjects, lfsUploads, users } from "../schema.ts";
import { LFS_LOCK } from "./uploads.ts";

/**
 * Files on their way into Git LFS as the editor sends them: through the HTTP API, on a real
 * PostgreSQL, the fake GitHub and a staging folder of the test's own. Pieces go on from where the
 * upload got, a piece twice is taken once, what does not fit is turned away, a file that is not the
 * one its hash says fails, and there is room for so much only, also for two that come at once, and
 * for so long only. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

/** A small piece, so that files of a few pieces are small too. */
const CHUNK = 1024;
const HOUR = 3600_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!TEST_DATABASE)("uploads into Git LFS through the API, on a database", () => {
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
    l = await lfsWorld(w, { limits: { chunkBytes: CHUNK, fileBytes: 64 * CHUNK } });
  });
  afterEach(() => {
    l.done();
  });

  test("takes no file from someone who never said they know what the storage means, whatever the page asked", async () => {
    l.done();
    w = await world(t.db);
    l = await lfsWorld(w, { acknowledged: false });
    const { project } = await l.linked();
    const data = randomBytes(3000);
    const refused = await l.begin(project.id, data);
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "notAcknowledged" });
    expect(await t.db.select().from(lfsUploads)).toEqual([]);
    expect(w.github.calls.filter((call) => /lfs/.test(String(call)))).toEqual([]);
    // Once said, it goes.
    await changeLfs(t.db, w.userId, { account: w.userId, acknowledged: true }, Date.now());
    expect((await l.begin(project.id, data)).status).toBe(201);
    // The tests share the database: what this one began goes.
    await t.db.delete(lfsUploads);
  });

  test("a file the storage has is there at once: by what the platform knows, or as GitHub says", async () => {
    const { project, repo } = await l.linked();
    const known = randomBytes(3000);
    await t.db.insert(lfsObjects).values({ repoId: repo.id, oid: oidOf(known), size: 3000 });
    const calls = w.github.calls.length;
    const first = await l.begin(project.id, known);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      state: "present",
      repo: String(repo.id),
      oid: oidOf(known),
      size: 3000,
      received: 3000,
      chunk: CHUNK,
      minChunk: 1,
    });
    // Not even asked.
    expect(w.github.calls.length).toBe(calls);

    // Pushed there some other way, as with Git LFS on a computer: GitHub says so, and it is noted.
    const pushed = randomBytes(2000);
    w.github.addLfsObject(repo.id, pushed);
    const second = await l.begin(project.id, pushed);
    expect(second.json).toMatchObject({ state: "present", repo: String(repo.id) });
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(pushed))),
    ).toMatchObject([{ repoId: repo.id, size: 2000 }]);
    expect(await t.db.select().from(lfsUploads)).toEqual([]);
  });

  test("a new file comes in piece by piece, each on the disk before it counts, and is checked and queued once all of it is there, which its last piece does not wait for", async () => {
    const { project, repo } = await l.linked();
    const data = randomBytes(3 * CHUNK + 100);
    const begun = await l.begin(project.id, data);
    expect(begun.status).toBe(201);
    const id = begun.json.id as string;
    expect(begun.json).toEqual({
      id,
      state: "receiving",
      repo: String(repo.id),
      oid: oidOf(data),
      size: data.length,
      received: 0,
      chunk: CHUNK,
      minChunk: 1,
    });
    expect(existsSync(l.staging.pathOf(id))).toBe(true);
    for (let at = 0; at < 3 * CHUNK; at += CHUNK) {
      const answer = await l.piece(id, at, data.subarray(at, at + CHUNK));
      expect(answer.status).toBe(200);
      expect(answer.json).toMatchObject({ state: "receiving", received: at + CHUNK });
      expect(answer.headers["upload-offset"]).toBe(String(at + CHUNK));
      expect((await l.rowOf(id))?.received).toBe(at + CHUNK);
    }
    expect(l.queued).toEqual([]);
    // The last piece is answered as the others: all of the file is there, and how the platform
    // finds it, it says when asked.
    const last = await l.piece(id, 3 * CHUNK, data.subarray(3 * CHUNK));
    expect(last.json).toMatchObject({ state: "receiving", received: data.length });
    expect((await l.checked(id)).json).toMatchObject({ state: "received", received: data.length });
    expect(readFileSync(l.staging.pathOf(id))).toEqual(data);
    // The row says received first, then it is queued (a failed enqueue is left to the sweep): the
    // check above can see the first before the second has happened.
    await vi.waitFor(() => expect(l.queued).toEqual([id]));
    expect(await l.rowOf(id)).toMatchObject({ state: "received", receivedAt: w.time.now });
    expect((await l.p.send("GET", `/api/lfs/uploads/${id}`)).json).toMatchObject({
      state: "received",
      received: data.length,
    });
  });

  test("goes on from where it got: a piece again is taken once, one that does not go there is told where to go", async () => {
    const { project } = await l.linked();
    const data = randomBytes(3 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    expect((await l.piece(id, 0, data.subarray(0, CHUNK))).json.received).toBe(CHUNK);
    // The same piece again, as after an answer that got lost: taken once, nothing written.
    const again = await l.piece(id, 0, data.subarray(0, CHUNK));
    expect(again.status).toBe(200);
    expect(again.json.received).toBe(CHUNK);
    // Ahead of where it got, out of order: where to go instead.
    const ahead = await l.piece(id, 2 * CHUNK, data.subarray(2 * CHUNK));
    expect(ahead.status).toBe(409);
    expect(ahead.json).toEqual({ error: "offset", received: CHUNK });
    // Over where it got, partly before: the same.
    const over = await l.piece(id, CHUNK / 2, data.subarray(CHUNK / 2, CHUNK / 2 + CHUNK));
    expect(over.status).toBe(409);
    expect(over.json).toEqual({ error: "offset", received: CHUNK });
    expect((await l.rowOf(id))?.received).toBe(CHUNK);
    // Where it got: on it goes.
    const answer = await l.sendAll(id, data, CHUNK);
    expect(answer.json).toMatchObject({ state: "received", received: data.length });
    expect(readFileSync(l.staging.pathOf(id))).toEqual(data);
    // A piece of what came, once it is all there: it says how the upload is.
    expect((await l.piece(id, 0, data.subarray(0, CHUNK))).json).toMatchObject({
      state: "received",
    });
  });

  test("turns away a piece that is too large, past the end of the file, empty, or without where it goes", async () => {
    const { project } = await l.linked();
    const data = randomBytes(2 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    const tooLarge = await l.piece(id, 0, randomBytes(CHUNK + 1));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.json).toEqual({ error: "tooLarge" });
    // Larger than any piece may be, which the API does not take in at all.
    const huge = await l.piece(id, 0, Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(huge.status).toBe(413);
    expect(huge.json).toEqual({ error: "tooLarge" });
    await l.sendAll(id, data.subarray(0, CHUNK), CHUNK);
    const pastEnd = await l.piece(id, 2 * CHUNK - 10, randomBytes(20));
    expect(pastEnd.status).toBe(400);
    expect(pastEnd.json).toEqual({ error: "invalid" });
    for (const offset of ["", "-1", "1.5", "01", "x"]) {
      const wrong = await l.piece(id, offset, data.subarray(CHUNK, CHUNK + 10));
      expect(wrong.status, offset).toBe(400);
    }
    const empty = await l.piece(id, CHUNK, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    for (const [type, status] of [
      ["text/plain", 400],
      ["image/png", 415],
    ] as const) {
      const other = await l.p.send("PUT", `/api/lfs/uploads/${id}`, {
        payload: "text",
        headers: { "content-type": type, "upload-offset": String(CHUNK) },
      });
      expect(other.status, type).toBe(status);
      expect(other.json, type).toEqual({ error: "invalid" });
    }
    expect((await l.rowOf(id))?.received).toBe(CHUNK);
  });

  test("finds out a file that changed while it was sent: what came is not the file of its hash, and goes", async () => {
    const { project } = await l.linked();
    const data = randomBytes(3 * CHUNK);
    const begun = await l.begin(project.id, data);
    const id = begun.json.id as string;
    await l.piece(id, 0, data.subarray(0, CHUNK));
    // The file changed on the computer: the rest of the pieces are of the new one.
    const changed = Buffer.from(data);
    changed.writeUInt8(changed.readUInt8(2 * CHUNK + 5) ^ 0xff, 2 * CHUNK + 5);
    await l.piece(id, CHUNK, changed.subarray(CHUNK, 2 * CHUNK));
    const last = await l.piece(id, 2 * CHUNK, changed.subarray(2 * CHUNK));
    expect(last.status).toBe(200);
    expect((await l.checked(id)).json).toMatchObject({ state: "failed", error: "changed" });
    // The upload says "failed" as soon as the database has it, and its file goes right after that.
    await vi.waitFor(() => expect(existsSync(l.staging.pathOf(id))).toBe(false));
    expect(l.queued).toEqual([]);
    expect(
      await t.db
        .select()
        .from(lfsObjects)
        .where(eq(lfsObjects.oid, oidOf(data))),
    ).toEqual([]);
    // Sending it again starts anew.
    const again = await l.begin(project.id, data);
    expect(again.status).toBe(201);
    expect(again.json.id).not.toBe(id);
  });

  test("a file changed on the disk of the platform is found out too: the hash is of what is there", async () => {
    const { project } = await l.linked();
    const data = randomBytes(2 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    await l.piece(id, 0, data.subarray(0, CHUNK));
    writeFileSync(l.staging.pathOf(id), randomBytes(CHUNK));
    await l.piece(id, CHUNK, data.subarray(CHUNK));
    expect((await l.checked(id)).json).toMatchObject({ state: "failed", error: "changed" });
  });

  test("the last piece is answered before the file is read through for its hash: nobody holds a place for that", async () => {
    // A file that takes its time to read through, as 2 GiB do.
    let reading: (() => void) | undefined;
    const slow = await lfsWorld(w, {
      limits: { chunkBytes: CHUNK },
      staging: (dir) =>
        new (class extends RoomyStaging {
          override async hash(id: string, size: number) {
            await new Promise<void>((go) => (reading = go));
            return super.hash(id, size);
          }
        })(dir),
    });
    try {
      const { project } = await slow.linked();
      const data = randomBytes(2 * CHUNK);
      const id = (await slow.begin(project.id, data)).json.id as string;
      await slow.piece(id, 0, data.subarray(0, CHUNK));
      const last = await Promise.race([
        slow.piece(id, CHUNK, data.subarray(CHUNK)),
        sleep(2000).then(() => "still waiting for the hash" as const),
      ]);
      expect(last).not.toBe("still waiting for the hash");
      expect(last).toMatchObject({
        status: 200,
        json: { state: "receiving", received: data.length, size: data.length },
      });
      // Asked meanwhile, it says the same, and the file is read through once.
      await vi.waitFor(() => expect(reading).toBeDefined());
      const asked = await slow.p.send("GET", `/api/lfs/uploads/${id}`);
      expect(asked.json).toMatchObject({ state: "receiving", received: data.length });
      expect(slow.queued).toEqual([]);
      // The last piece again, as after an answer that got lost: the same.
      expect((await slow.piece(id, CHUNK, data.subarray(CHUNK))).json).toMatchObject({
        state: "receiving",
        received: data.length,
      });
      reading!();
      expect((await slow.checked(id)).json).toMatchObject({ state: "received" });
      await vi.waitFor(() => expect(slow.queued).toEqual([id]));
    } finally {
      reading?.();
      slow.done();
    }
  });

  test("pieces are as large as the platform says, the last one of a file as small as it is", async () => {
    const sized = await lfsWorld(w, { limits: { chunkBytes: 4 * CHUNK, minChunkBytes: CHUNK } });
    try {
      const { project } = await sized.linked();
      const data = randomBytes(3 * CHUNK + 10);
      const begun = await sized.begin(project.id, data);
      expect(begun.json).toMatchObject({ chunk: 4 * CHUNK, minChunk: CHUNK });
      const id = begun.json.id as string;
      // Smaller than a piece may be, and not the rest of the file: not taken, nothing written.
      const small = await sized.piece(id, 0, data.subarray(0, CHUNK - 1));
      expect(small.status).toBe(400);
      expect(small.json).toEqual({ error: "invalid" });
      expect((await sized.rowOf(id))?.received).toBe(0);
      // The smallest and anything up to the largest are.
      expect((await sized.piece(id, 0, data.subarray(0, CHUNK))).json.received).toBe(CHUNK);
      expect((await sized.piece(id, CHUNK, data.subarray(CHUNK, 3 * CHUNK))).json.received).toBe(
        3 * CHUNK,
      );
      // A piece it has already, however small, changes nothing, as before.
      expect((await sized.piece(id, 0, data.subarray(0, 10))).json.received).toBe(3 * CHUNK);
      // The rest of the file, of 10 bytes.
      const last = await sized.piece(id, 3 * CHUNK, data.subarray(3 * CHUNK));
      expect(last.json).toMatchObject({ state: "receiving", received: data.length });
      expect((await sized.checked(id)).json.state).toBe("received");
      expect(readFileSync(sized.staging.pathOf(id))).toEqual(data);
    } finally {
      sized.done();
    }
    // No piece has to be larger than the largest: a file smaller than both goes in one.
    const tiny = await lfsWorld(w, { limits: { chunkBytes: CHUNK, minChunkBytes: 64 * CHUNK } });
    try {
      const { project } = await tiny.linked("tiny");
      expect((await tiny.begin(project.id, randomBytes(10))).json).toMatchObject({
        chunk: CHUNK,
        minChunk: CHUNK,
      });
    } finally {
      tiny.done();
    }
  });

  for (const noHead of [false, true]) {
    test(`a file GitHub says it has counts only as large as the storage has it: of another size, it is not the file (${noHead ? "an address that takes GET alone" : "asked with HEAD"})`, async () => {
      const { project, repo } = await l.linked();
      const stored = randomBytes(3000);
      // In the storage some other way, which goes by the oid alone and says the size it is asked.
      w.github.addLfsObject(repo.id, stored);
      w.github.faults.lfsAnySize = true;
      w.github.faults.lfsNoHead = noHead;
      const noted = () =>
        t.db
          .select()
          .from(lfsObjects)
          .where(eq(lfsObjects.oid, oidOf(stored)));
      // The editor says the file of that hash has another size: what it has is not that file.
      const wrong = await l.begin(project.id, stored, 2999);
      expect(wrong.status).toBe(200);
      expect(wrong.json).toMatchObject({
        state: "failed",
        error: "changed",
        oid: oidOf(stored),
        size: 2999,
        received: 0,
      });
      expect(wrong.json.detail).toContain("3000");
      expect(typeof wrong.json.id).toBe("string");
      // Nothing to send, and nothing noted but what the storage has: 3000 bytes.
      expect(existsSync(l.staging.pathOf(wrong.json.id))).toBe(false);
      expect(await noted()).toMatchObject([{ repoId: repo.id, size: 3000 }]);
      expect(w.github.calls.includes("GET lfs/object")).toBe(noHead);
      // Asked again, the platform knows by itself, and says the same.
      const calls = w.github.calls.length;
      const again = await l.begin(project.id, stored, 2999);
      expect(again.json).toMatchObject({ state: "failed", error: "changed" });
      expect(w.github.calls.length).toBe(calls);
      expect((await l.p.send("GET", `/api/lfs/uploads/${again.json.id}`)).json).toMatchObject({
        state: "failed",
        error: "changed",
      });
      // With the size the file has, it is there.
      expect((await l.begin(project.id, stored)).json).toMatchObject({
        state: "present",
        size: 3000,
      });
    });
  }

  test("another computer goes on with the upload that is on its way, from where it got", async () => {
    const { project } = await l.linked();
    const data = randomBytes(2 * CHUNK);
    const first = await l.begin(project.id, data);
    await l.piece(first.json.id, 0, data.subarray(0, CHUNK));
    const second = await l.begin(project.id, data);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ id: first.json.id, state: "receiving", received: CHUNK });
    // Of another size, one of the two is not what it says.
    expect((await l.begin(project.id, data, data.length + 1)).status).toBe(400);
  });

  test("an upload whose file is all there, but that was not checked as the API stopped, is checked when asked about", async () => {
    const { project } = await l.linked();
    const data = randomBytes(CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    writeFileSync(l.staging.pathOf(id), data);
    await t.db.update(lfsUploads).set({ received: CHUNK }).where(eq(lfsUploads.id, id));
    await vi.waitFor(async () => {
      expect((await l.p.send("GET", `/api/lfs/uploads/${id}`)).json.state).toBe("received");
    });
    expect(l.queued).toEqual([id]);
  });

  test("an upload whose file was all there when the API stopped is checked as it starts again, without anybody asking", async () => {
    const { project } = await l.linked();
    const data = randomBytes(CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    writeFileSync(l.staging.pathOf(id), data);
    await t.db.update(lfsUploads).set({ received: CHUNK }).where(eq(lfsUploads.id, id));
    // Nothing reads it until it is asked about: the API that stopped is gone.
    expect((await l.rowOf(id))?.state).toBe("receiving");
    expect(await l.uploads.settleWaiting()).toBe(1);
    await vi.waitFor(async () => expect((await l.rowOf(id))?.state).toBe("received"));
    expect(l.queued).toEqual([id]);
    expect(await l.uploads.settleWaiting()).toBe(0);
  });

  test("a piece that cannot go is said before it is read: no such upload, one that is over, or the wrong place", async () => {
    const { project } = await l.linked();
    const data = randomBytes(2 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    const user = { userId: w.userId } as never;
    await expect(l.uploads.expecting(user, randomUUID(), 0)).rejects.toMatchObject({
      code: "notFound",
    });
    await expect(l.uploads.expecting(user, id, CHUNK)).rejects.toMatchObject({
      code: "offset",
      extra: { received: 0 },
    });
    expect(await l.uploads.expecting(user, id, 0)).toBeUndefined();
    await l.piece(id, 0, data.subarray(0, CHUNK));
    // Sent again: taken as before, once.
    expect(await l.uploads.expecting(user, id, 0)).toBeUndefined();
    // Over: the answer is the upload, and the piece is never read.
    await l.p.send("DELETE", `/api/lfs/uploads/${id}`);
    expect(await l.uploads.expecting(user, id, CHUNK)).toMatchObject({ state: "failed" });
    // The route says so as well, with what it got to.
    const late = await l.piece(id, CHUNK, data.subarray(CHUNK));
    expect(late.status).toBe(200);
    expect(late.json).toMatchObject({ state: "failed", error: "cancelled" });
    expect(late.headers.connection).toBe("close");
  });

  test("a file larger than the storage takes is turned away before GitHub is asked", async () => {
    const { project } = await l.linked();
    const calls = w.github.calls.length;
    const large = await l.begin(project.id, randomBytes(64 * CHUNK + 1));
    expect(large.status).toBe(413);
    expect(large.json).toEqual({ error: "tooLarge" });
    expect(w.github.calls.length).toBe(calls);
  });

  test("a file the storage has in another size is said to be another file once a day, not with a row each time", async () => {
    const { project, repo } = await l.linked();
    const data = randomBytes(3000);
    await t.db.insert(lfsObjects).values({ repoId: repo.id, oid: oidOf(data), size: 2999 });
    const first = await l.begin(project.id, data);
    const again = await l.begin(project.id, data);
    expect(first.json).toMatchObject({ state: "failed", error: "changed" });
    expect(again.json).toEqual(first.json);
    const rows = await t.db
      .select()
      .from(lfsUploads)
      .where(eq(lfsUploads.oid, oidOf(data)));
    expect(rows).toHaveLength(1);
    // A day on, once more.
    w.time.later(25 * HOUR);
    await l.begin(project.id, data);
    expect(
      await t.db
        .select()
        .from(lfsUploads)
        .where(eq(lfsUploads.oid, oidOf(data))),
    ).toHaveLength(2);
  });

  test("one person has so many files on its way at once, however small", async () => {
    const few = await lfsWorld(w, { limits: { chunkBytes: CHUNK, personUploads: 2 } });
    await t.db.delete(lfsUploads);
    try {
      const { project } = await few.linked();
      expect((await few.begin(project.id, randomBytes(10))).status).toBe(201);
      expect((await few.begin(project.id, randomBytes(10))).status).toBe(201);
      const third = await few.begin(project.id, randomBytes(10));
      expect(third.status).toBe(429);
      expect(third.json).toEqual({ error: "busy", detail: "person" });
    } finally {
      few.done();
      await t.db.delete(lfsUploads);
    }
  });

  test("takes so much at a time only: a file, what one person has on its way, everybody's, and what the disk keeps free", async () => {
    const small = await lfsWorld(w, {
      limits: {
        chunkBytes: CHUNK,
        fileBytes: 4 * CHUNK,
        personBytes: 6 * CHUNK,
        totalBytes: 9 * CHUNK,
        floorBytes: 100 * CHUNK,
      },
    });
    // Only what this test has on its way counts.
    await t.db.delete(lfsUploads);
    try {
      const { project } = await small.linked();
      const tooLarge = await small.begin(project.id, randomBytes(4 * CHUNK + 1));
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.json).toEqual({ error: "tooLarge" });
      expect((await small.begin(project.id, randomBytes(4 * CHUNK))).status).toBe(201);
      // One person: 4 of 6 on its way.
      const person = await small.begin(project.id, randomBytes(3 * CHUNK));
      expect(person.status).toBe(429);
      // The person's own, which they can do something about.
      expect(person.json).toEqual({ error: "busy", detail: "person" });
      expect(Number(person.headers["retry-after"])).toBeGreaterThan(0);
      // Everybody: someone else with 4 more makes 8 of 9.
      const other = await world(t.db);
      const theirs = await lfsWorld(other, { limits: { chunkBytes: CHUNK } });
      const otherProject = await theirs.linked();
      try {
        expect((await theirs.begin(otherProject.project.id, randomBytes(4 * CHUNK))).status).toBe(
          201,
        );
      } finally {
        theirs.done();
      }
      const all = await small.begin(project.id, randomBytes(CHUNK + CHUNK / 2));
      expect(all.status).toBe(503);
      expect(all.json).toEqual({ error: "busy" });
      expect(Number(all.headers["retry-after"])).toBeGreaterThan(0);
      // The disk: free space, less what is still to come, less the file, stays above its floor.
      small.staging.free = 100 * CHUNK + 4 * CHUNK + 4 * CHUNK + CHUNK - 1;
      const disk = await small.begin(project.id, randomBytes(CHUNK));
      expect(disk.status).toBe(503);
      expect(disk.json).toEqual({ error: "busy" });
      small.staging.free += 1;
      expect((await small.begin(project.id, randomBytes(CHUNK))).status).toBe(201);
    } finally {
      small.done();
      await t.db.delete(lfsUploads);
    }
  });

  for (const what of ["one person", "everybody"] as const) {
    test(`two uploads that begin at once and do not both fit (${what}): one of them is turned away`, async () => {
      // Both are counted against what is on its way: without one lock for that, each would count
      // before the other is there, and both would fit. Each as from a process of its own.
      let counting = 0;
      let counted: () => void = () => {};
      const waited = new Promise<void>((go) => (counted = go));
      const staging = (dir: string) =>
        new (class extends RoomyStaging {
          override async freeBytes() {
            counting += 1;
            await waited;
            return this.free;
          }
        })(dir);
      const limits = {
        chunkBytes: CHUNK,
        personBytes: what === "one person" ? 6 * CHUNK : 60 * CHUNK,
        totalBytes: what === "everybody" ? 6 * CHUNK : 60 * CHUNK,
      };
      const other = what === "everybody" ? await world(t.db) : w;
      const first = await lfsWorld(w, { limits, staging });
      const second = await lfsWorld(other, { limits, staging });
      await t.db.delete(lfsUploads);
      try {
        const mine = await first.linked();
        const theirs = what === "everybody" ? await second.linked() : mine;
        const begun = [
          first.begin(mine.project.id, randomBytes(4 * CHUNK)),
          second.begin(theirs.project.id, randomBytes(3 * CHUNK)),
        ];
        await vi.waitFor(() => expect(counting).toBeGreaterThan(0));
        // Time enough for the other one to count as well, were nothing in its way.
        await sleep(400);
        expect(counting).toBe(1);
        counted();
        const answers = await Promise.all(begun);
        expect(answers.map(({ status }) => status).toSorted()).toEqual([
          201,
          what === "one person" ? 429 : 503,
        ]);
        expect(answers.find(({ status }) => status !== 201)?.json).toEqual(
          what === "one person" ? { error: "busy", detail: "person" } : { error: "busy" },
        );
        expect(await t.db.select().from(lfsUploads)).toHaveLength(1);
      } finally {
        counted();
        first.done();
        second.done();
        await t.db.delete(lfsUploads);
      }
    });
  }

  test("uploads that wait to be counted hold no connection of the database: the rest of the platform goes on", async () => {
    const { project } = await l.linked();
    // Another process counts, and takes its time.
    const holder = await connection(t);
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1)", [LFS_LOCK]);
      // More at once than the platform has connections.
      const begun = Array.from({ length: 14 }, () => l.begin(project.id, randomBytes(CHUNK)));
      await sleep(500);
      const answered = await Promise.race([
        t.db.execute(sql`select 1`).then(
          () => "answered",
          () => "no connection left",
        ),
        sleep(3000).then(() => "no connection left"),
      ]);
      expect(answered).toBe("answered");
      await holder.query("commit");
      for (const each of begun) expect((await each).status).toBe(201);
    } finally {
      await holder.query("rollback").catch(() => {});
      await holder.end();
    }
  });

  test("an upload that cannot be counted in time is told to come back, and is not there", async () => {
    const quick = await lfsWorld(w, { limits: { chunkBytes: CHUNK, lockWaitMs: 200 } });
    const holder = await connection(t);
    try {
      const { project } = await quick.linked();
      const data = randomBytes(CHUNK);
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1)", [LFS_LOCK]);
      const waited = await quick.begin(project.id, data);
      expect(waited.status).toBe(503);
      expect(waited.json).toEqual({ error: "busy" });
      expect(Number(waited.headers["retry-after"])).toBeGreaterThan(0);
      expect(
        await t.db
          .select()
          .from(lfsUploads)
          .where(eq(lfsUploads.oid, oidOf(data))),
      ).toEqual([]);
      await holder.query("commit");
      expect((await quick.begin(project.id, data)).status).toBe(201);
    } finally {
      await holder.query("rollback").catch(() => {});
      await holder.end();
      quick.done();
    }
  });

  test("comes in within three days of its start, however its pieces come: then it is over, and its room is free again", async () => {
    const { project } = await l.linked();
    const data = randomBytes(6 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    // A piece now and then, each within a day of the one before.
    for (let piece = 0; piece < 4; piece++) {
      const at = piece * CHUNK;
      expect(
        (await l.piece(id, at, data.subarray(at, at + CHUNK))).json,
        `piece ${piece}`,
      ).toMatchObject({
        state: "receiving",
        received: at + CHUNK,
      });
      w.time.later(piece < 3 ? 23 * HOUR : 4 * HOUR);
    }
    // 73 hours after its start: the next piece finds it over, and what came of it is gone.
    const late = await l.piece(id, 4 * CHUNK, data.subarray(4 * CHUNK, 5 * CHUNK));
    expect(late.status).toBe(200);
    expect(late.json).toMatchObject({ state: "expired", received: 4 * CHUNK });
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
    expect((await l.rowOf(id))?.state).toBe("expired");
    // Sent again, it starts anew.
    const again = await l.begin(project.id, data);
    expect(again.status).toBe(201);
    expect(again.json.id).not.toBe(id);
  });

  test("says what keeps a file out: no repository, the repository gone, no room left at GitHub, too large for GitHub", async () => {
    // Only what this test begins: none of it is to become an upload.
    await t.db.delete(lfsUploads);
    const lone = await newProject(w);
    const data = randomBytes(CHUNK);
    expect((await l.begin(lone.id, data)).json).toEqual({ error: "notLinked" });
    const { project, repo } = await l.linked();
    w.github.faults.lfsQuota = true;
    const quota = await l.begin(project.id, data);
    expect(quota.status).toBe(409);
    expect(quota.json).toMatchObject({ error: "githubQuota" });
    expect(quota.json.detail).toMatch(/quota/);
    w.github.faults.lfsQuota = false;
    w.github.faults.lfsMaxBytes = CHUNK - 1;
    const large = await l.begin(project.id, data);
    expect(large.status).toBe(413);
    expect(large.json).toMatchObject({ error: "tooLarge" });
    w.github.faults.lfsMaxBytes = 2 * 1024 ** 3;
    w.github.deleteRepo(repo.id);
    expect((await l.begin(project.id, data)).json).toEqual({ error: "gone" });
    const { project: other } = await l.linked("other");
    w.github.faults.unreachable = true;
    const away = await l.begin(other.id, data);
    expect(away.status).toBe(503);
    expect(away.json).toEqual({ error: "unavailable" });
    w.github.faults.unreachable = false;
    expect(await t.db.select().from(lfsUploads)).toEqual([]);
  });

  test("only the person whose project it is, signed in, and what changes something only from pages of this site", async () => {
    const { project } = await l.linked();
    const data = randomBytes(2 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    const path = `/api/lfs/uploads/${id}`;
    const piece = { "content-type": "application/octet-stream", "upload-offset": "0" };
    const elsewhere = await l.p.send("PUT", path, {
      payload: data.subarray(0, CHUNK),
      headers: piece,
      fromHere: false,
    });
    expect(elsewhere.status).toBe(403);
    expect((await l.p.send("DELETE", path, { fromHere: false })).status).toBe(403);
    const begin = await l.p.send("POST", `/api/projects/${project.id}/lfs/objects`, {
      payload: JSON.stringify({ oid: oidOf(data), size: data.length }),
      headers: { "content-type": "application/json" },
      fromHere: false,
    });
    expect(begin.status).toBe(403);
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const anonymous = await l.p.send(method, path, {
        signedIn: false,
        ...(method === "PUT" && { payload: data.subarray(0, CHUNK), headers: piece }),
      });
      expect(anonymous.status, method).toBe(401);
      expect(anonymous.json, method).toEqual({ error: "signedOut" });
    }
    // Someone else's project, and someone else's upload: as if they were not there.
    const someone = await world(t.db);
    const theirs = await lfsWorld(someone);
    try {
      const other = await theirs.linked();
      expect((await l.begin(other.project.id, data)).json).toEqual({ error: "notFound" });
      expect((await theirs.p.send("GET", path)).status).toBe(404);
      expect((await theirs.piece(id, 0, data.subarray(0, CHUNK))).status).toBe(404);
      expect((await theirs.p.send("DELETE", path)).status).toBe(404);
    } finally {
      theirs.done();
    }
    // Nobody who is disabled.
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, w.userId));
    expect((await l.p.send("GET", path)).status).toBe(401);
    await t.db.update(users).set({ disabledAt: null }).where(eq(users.id, w.userId));
    expect((await l.p.send("GET", `/api/lfs/uploads/${randomUUID()}`)).status).toBe(404);
    expect((await l.p.send("GET", "/api/lfs/uploads/not-an-id")).status).toBe(404);
    const wrong = await l.p.send("POST", `/api/projects/${project.id}/lfs/objects`, {
      payload: JSON.stringify({ oid: "A".repeat(64), size: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(wrong.status).toBe(400);
  });

  test("given up, the file goes; a piece of it after that says so", async () => {
    const { project } = await l.linked();
    const data = randomBytes(2 * CHUNK);
    const id = (await l.begin(project.id, data)).json.id as string;
    await l.piece(id, 0, data.subarray(0, CHUNK));
    expect((await l.p.send("DELETE", `/api/lfs/uploads/${id}`)).status).toBe(204);
    expect(existsSync(l.staging.pathOf(id))).toBe(false);
    expect((await l.p.send("GET", `/api/lfs/uploads/${id}`)).json).toMatchObject({
      state: "failed",
      error: "cancelled",
    });
    expect((await l.piece(id, CHUNK, data.subarray(CHUNK))).json).toMatchObject({
      state: "failed",
    });
    // A new one starts anew.
    expect((await l.begin(project.id, data)).status).toBe(201);
  });
});
