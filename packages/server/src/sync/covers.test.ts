import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newProject, quiet, world, type World } from "../test/archive-support.ts";
import {
  connection,
  createTestDatabase,
  TEST_DATABASE,
  type TestDatabase,
} from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { projectCovers } from "../schema.ts";
import { COVER_BYTES, durationOf, etagOf, isPictureOf } from "./covers.ts";
import { SyncHub } from "./hub.ts";

/**
 * The covers of projects (sync/covers.ts): what the editor sends, what the platform keeps and gives
 * back, and what the list says of them. On a real PostgreSQL. Needs AQ_TEST_DATABASE, see
 * vitest.config.ts.
 */

/** A WebP of `size` bytes in all (even), as its container has it: one chunk of an image. */
const webp = (size = 64, fill = 1) => {
  const bytes = Buffer.alloc(size, fill);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(size - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8 ", 12, "ascii");
  bytes.writeUInt32LE(size - 20, 16);
  return bytes;
};

/** A segment of a JPEG: its marker and length, and what it has. */
const segment = (marker: number, body: Buffer) =>
  Buffer.concat([
    Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]),
    body,
  ]);

/**
 * A JPEG of `size` bytes in all, as its segments have it: JFIF, a table, a frame, the scan and what
 * it has, and the end.
 */
const jpeg = (size = 64, parts: { frame?: boolean; first?: number } = {}) => {
  const head = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(parts.first ?? 0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xdb, Buffer.alloc(65, 1)),
    ...(parts.frame === false
      ? []
      : [segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]))]),
    segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  ]);
  const scan = Buffer.alloc(Math.max(0, size - head.length - 2), 0x55);
  return Buffer.concat([head, scan, Buffer.from([0xff, 0xd9])]);
};

describe("what a cover is", () => {
  test("a WebP or a JPEG, as its first bytes say, of the length a WebP says", () => {
    expect(isPictureOf("image/webp", webp())).toBe(true);
    expect(isPictureOf("image/jpeg", jpeg())).toBe(true);
    // Each only as itself.
    expect(isPictureOf("image/webp", jpeg())).toBe(false);
    expect(isPictureOf("image/jpeg", webp())).toBe(false);
    // A WebP whose length is not what came, cut short or with more after it.
    expect(isPictureOf("image/webp", webp().subarray(0, 40))).toBe(false);
    expect(isPictureOf("image/webp", Buffer.concat([webp(), Buffer.from([0])]))).toBe(false);
    const other = webp();
    other.write("VP9 ", 12, "ascii");
    expect(isPictureOf("image/webp", other)).toBe(false);
    // Chunks that do not fill it as they say.
    const longer = webp();
    longer.writeUInt32LE(100, 16);
    expect(isPictureOf("image/webp", longer)).toBe(false);
    const shorter = webp();
    shorter.writeUInt32LE(10, 16);
    expect(isPictureOf("image/webp", shorter)).toBe(false);
    // A JPEG: its start, segments that stay within it, a frame before the scan, and the end.
    expect(isPictureOf("image/jpeg", jpeg(2000))).toBe(true);
    expect(isPictureOf("image/jpeg", jpeg(200, { first: 0xdb }))).toBe(true);
    expect(isPictureOf("image/jpeg", jpeg(200, { first: 0xe1 }))).toBe(true);
    // What only starts like one: HTML or SVG after the first marker.
    const html = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("<html>")]);
    expect(isPictureOf("image/jpeg", html)).toBe(false);
    expect(
      isPictureOf(
        "image/jpeg",
        Buffer.concat([html, Buffer.from("</html>"), Buffer.from([0xff, 0xd9])]),
      ),
    ).toBe(false);
    expect(isPictureOf("image/jpeg", jpeg(200).subarray(0, 150))).toBe(false);
    expect(isPictureOf("image/jpeg", jpeg(200, { frame: false }))).toBe(false);
    expect(isPictureOf("image/jpeg", jpeg(200, { first: 0x3c }))).toBe(false);
    const overlong = jpeg(200);
    overlong[5] = 0xff;
    expect(isPictureOf("image/jpeg", overlong)).toBe(false);
    for (const nothing of [Buffer.alloc(0), Buffer.from("RIFF"), Buffer.from("<svg>")]) {
      expect(isPictureOf("image/webp", nothing)).toBe(false);
      expect(isPictureOf("image/jpeg", nothing)).toBe(false);
    }
  });

  test("a duration is a whole number of milliseconds, up to a week", () => {
    expect(durationOf("0")).toBe(0);
    expect(durationOf("90500")).toBe(90_500);
    expect(durationOf(String(7 * 24 * 3600_000))).toBe(7 * 24 * 3600_000);
    for (const no of ["", "-1", "1.5", "1e3", " 1", String(7 * 24 * 3600_000 + 1), undefined, 5])
      expect(durationOf(no), String(no)).toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE)("the covers of projects, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let hub: SyncHub;
  /** The time of the limits. */
  let time: number;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    hub = new SyncHub({ db: t.db, log: quiet });
    time = Date.now();
    p = await platform(w, { hub, now: () => time });
  });
  afterEach(() => {
    hub.stop();
  });

  const put = (id: string, bytes: Buffer, type = "image/webp", query = "") =>
    p.send("PUT", `/api/projects/${id}/cover${query}`, {
      payload: bytes,
      headers: { "content-type": type },
    });
  const listed = async (id: string) =>
    ((await p.request("GET", "/api/projects")).json.projects as any[]).find(
      (project) => project.id === id,
    );

  test("keeps one for each project, gives it back by its etag, and the list names it", async () => {
    const project = await newProject(w);
    expect((await listed(project.id)).cover).toBeUndefined();
    expect((await listed(project.id)).durationMs).toBeUndefined();
    const picture = webp(2000);
    const kept = await put(project.id, picture, "image/webp", "?durationMs=90500");
    expect(kept.status).toBe(200);
    expect(kept.json).toEqual({ etag: etagOf(picture), at: expect.any(Number) });
    expect(await listed(project.id)).toMatchObject({
      cover: { etag: etagOf(picture), at: kept.json.at },
      durationMs: 90_500,
    });

    const given = await p.send("GET", `/api/projects/${project.id}/cover`);
    expect(given.status).toBe(200);
    expect(given.headers["content-type"]).toBe("image/webp");
    expect(given.headers["etag"]).toBe(`"${etagOf(picture)}"`);
    expect(given.headers["cache-control"]).toBe("private, no-cache");
    expect(given.headers["x-content-type-options"]).toBe("nosniff");
    // As a browser that has it asks: nothing comes again.
    const same = await p.send("GET", `/api/projects/${project.id}/cover`, {
      headers: { "if-none-match": `"${etagOf(picture)}"` },
    });
    expect(same.status).toBe(304);
    expect(same.headers["etag"]).toBe(`"${etagOf(picture)}"`);
    const changed = await p.send("GET", `/api/projects/${project.id}/cover`, {
      headers: { "if-none-match": `"old"` },
    });
    expect(changed.status).toBe(200);

    // Another one in its place, a minute later: a JPEG, without a duration.
    time += 60_000;
    const second = jpeg(500);
    const again = await put(project.id, second, "image/jpeg");
    expect(again.status).toBe(200);
    const now = await listed(project.id);
    expect(now.cover.etag).toBe(etagOf(second));
    expect(now.durationMs).toBeUndefined();
    const rows = await t.db
      .select()
      .from(projectCovers)
      .where(eq(projectCovers.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "image/jpeg", etag: etagOf(second), durationMs: null });
    expect(Buffer.compare(rows[0]!.bytes, second)).toBe(0);
  });

  test("only so large, only pictures of the kinds it takes, as they say they are", async () => {
    const project = await newProject(w);
    const largest = webp(COVER_BYTES);
    const tooLarge = await put(project.id, webp(COVER_BYTES + 2));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.json).toEqual({ error: "tooLarge" });
    for (const type of ["image/png", "image/svg+xml", "text/html", "application/octet-stream"]) {
      const refused = await put(project.id, webp(), type);
      expect(refused.status, type).toBe(415);
      expect(refused.json, type).toEqual({ error: "unsupported" });
    }
    const without = await p.send("PUT", `/api/projects/${project.id}/cover`);
    expect(without.status).toBe(415);
    // What says it is a picture and is not one.
    const notWebp = await put(project.id, jpeg(), "image/webp");
    expect(notWebp.status).toBe(400);
    expect(notWebp.json).toEqual({ error: "invalid" });
    const html = await put(
      project.id,
      Buffer.from("<html><script>1</script></html>"),
      "image/jpeg",
    );
    expect(html.status).toBe(400);
    const badDuration = await put(project.id, webp(), "image/webp", "?durationMs=-5");
    expect(badDuration.status).toBe(400);
    // None of that was kept, nor did it count as the one of this minute.
    expect(
      await t.db.select().from(projectCovers).where(eq(projectCovers.projectId, project.id)),
    ).toEqual([]);
    expect((await put(project.id, largest)).status).toBe(200);
  });

  test("one a minute of each project; another project has its own", async () => {
    const project = await newProject(w);
    const other = await newProject(w);
    expect((await put(project.id, webp(64, 1))).status).toBe(200);
    const second = await put(project.id, webp(64, 2));
    expect(second.status).toBe(429);
    expect(second.json).toEqual({ error: "busy" });
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    expect((await listed(project.id)).cover.etag).toBe(etagOf(webp(64, 1)));
    expect((await put(other.id, webp(64, 2))).status).toBe(200);
    // A minute on, it takes one again.
    time += 60_000;
    expect((await put(project.id, webp(64, 2))).status).toBe(200);
    expect((await listed(project.id)).cover.etag).toBe(etagOf(webp(64, 2)));
  });

  test("only the owner's, only from pages of this site, and only of a project that is there", async () => {
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    const refused = await put(theirs.id, webp());
    expect(refused.status).toBe(404);
    expect(refused.json).toEqual({ error: "notFound" });
    expect(
      await t.db.select().from(projectCovers).where(eq(projectCovers.projectId, theirs.id)),
    ).toEqual([]);
    // Theirs has one: not for this person to see.
    const q = await platform(someone, { hub });
    expect(
      (
        await q.send("PUT", `/api/projects/${theirs.id}/cover`, {
          payload: webp(),
          headers: { "content-type": "image/webp" },
        })
      ).status,
    ).toBe(200);
    expect((await p.send("GET", `/api/projects/${theirs.id}/cover`)).status).toBe(404);
    expect((await q.send("GET", `/api/projects/${theirs.id}/cover`)).status).toBe(200);
    // Not there at all, or no project id.
    expect((await put("no-such-project", webp())).status).toBe(404);
    expect((await p.send("GET", "/api/projects/no-such-project/cover")).status).toBe(404);
    expect((await put("a.b", webp())).status).toBe(404);
    // One without a cover yet.
    const mine = await newProject(w);
    expect((await p.send("GET", `/api/projects/${mine.id}/cover`)).json).toEqual({
      error: "notFound",
    });
    // From elsewhere, or signed out.
    const elsewhere = await p.send("PUT", `/api/projects/${mine.id}/cover`, {
      payload: webp(),
      headers: { "content-type": "image/webp" },
      fromHere: false,
    });
    expect(elsewhere.status).toBe(403);
    const signedOut = await p.send("GET", `/api/projects/${mine.id}/cover`, { signedIn: false });
    expect(signedOut.status).toBe(401);
    expect(
      await t.db.select().from(projectCovers).where(eq(projectCovers.projectId, mine.id)),
    ).toEqual([]);
  });

  test("one people chose stays, whatever the editor makes, until they take it away", async () => {
    const project = await newProject(w);
    expect((await put(project.id, webp(64, 1), "image/webp", "?durationMs=1000")).status).toBe(200);
    // Chosen right after: not held up by the one the editor sent a moment ago.
    const mine = jpeg(700);
    const chosen = await put(project.id, mine, "image/jpeg", "?chosen=1");
    expect(chosen.status).toBe(200);
    expect(chosen.json).toEqual({ etag: etagOf(mine), at: expect.any(Number), chosen: true });
    // Without a duration of its own it keeps the one there was.
    expect(await listed(project.id)).toMatchObject({
      cover: { etag: etagOf(mine), at: chosen.json.at, chosen: true },
      durationMs: 1000,
    });
    // One the editor makes later only says how long the timeline is now.
    time += 60_000;
    const made = await put(project.id, webp(64, 2), "image/webp", "?durationMs=2000");
    expect(made.status).toBe(200);
    expect(made.json).toEqual({ etag: etagOf(mine), at: chosen.json.at, chosen: true });
    expect(await listed(project.id)).toMatchObject({
      cover: { etag: etagOf(mine), at: chosen.json.at, chosen: true },
      durationMs: 2000,
    });
    const given = await p.send("GET", `/api/projects/${project.id}/cover`);
    expect(given.headers["content-type"]).toBe("image/jpeg");
    // Another chosen one takes its place.
    const next = webp(64, 3);
    expect((await put(project.id, next, "image/webp", "?chosen=1")).json.etag).toBe(etagOf(next));
    // Taken away: none, and the next one the editor makes is the cover again.
    expect((await p.send("DELETE", `/api/projects/${project.id}/cover`)).status).toBe(204);
    expect((await listed(project.id)).cover).toBeUndefined();
    expect((await p.send("DELETE", `/api/projects/${project.id}/cover`)).status).toBe(204);
    time += 60_000;
    const back = await put(project.id, webp(64, 4));
    expect(back.json).toEqual({ etag: etagOf(webp(64, 4)), at: expect.any(Number) });
    expect((await listed(project.id)).cover).toEqual({
      etag: etagOf(webp(64, 4)),
      at: back.json.at,
    });
    expect((await put(project.id, webp(), "image/webp", "?chosen=yes")).status).toBe(400);
  });

  test("says how long the timeline is without a picture, as often as the editor's covers", async () => {
    const project = await newProject(w);
    const patch = (id: string, query: string, options = {}) =>
      p.send("PATCH", `/api/projects/${id}/cover${query}`, options);
    // No cover yet: nothing to say it of. It counts all the same.
    expect((await patch(project.id, "?durationMs=5000")).status).toBe(404);
    time += 60_000;
    const mine = jpeg(700);
    const chosen = await put(project.id, mine, "image/jpeg", "?chosen=1&durationMs=1000");
    expect(chosen.status).toBe(200);
    expect((await patch(project.id, "?durationMs=5000")).status).toBe(204);
    expect(await listed(project.id)).toMatchObject({
      cover: { etag: etagOf(mine), chosen: true },
      durationMs: 5000,
    });
    // Counted as one the editor made: one a minute.
    expect((await patch(project.id, "?durationMs=6000")).status).toBe(429);
    expect((await put(project.id, webp())).status).toBe(429);
    time += 60_000;
    expect((await patch(project.id, "?durationMs=6000")).status).toBe(204);
    expect((await listed(project.id)).durationMs).toBe(6000);
    for (const bad of ["", "?durationMs=-1", "?durationMs=x"]) {
      time += 60_000;
      expect((await patch(project.id, bad)).status, bad).toBe(400);
    }
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    expect((await patch(theirs.id, "?durationMs=1")).status).toBe(404);
    expect((await patch(project.id, "?durationMs=1", { fromHere: false })).status).toBe(403);
  });

  test("people choose ten in ten minutes at most, and only of their own projects", async () => {
    const project = await newProject(w);
    for (let turn = 0; turn < 10; turn++)
      expect((await put(project.id, webp(64, turn), "image/webp", "?chosen=1")).status).toBe(200);
    const more = await put(project.id, webp(64, 11), "image/webp", "?chosen=1");
    expect(more.status).toBe(429);
    expect((await p.send("DELETE", `/api/projects/${project.id}/cover`)).status).toBe(429);
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    const refused = await p.send("DELETE", `/api/projects/${theirs.id}/cover`);
    expect(refused.status).toBe(404);
    const elsewhere = await p.send("DELETE", `/api/projects/${project.id}/cover`, {
      fromHere: false,
    });
    expect(elsewhere.status).toBe(403);
  });

  test("goes with its project, and none is kept of one that goes as it comes", async () => {
    const project = await newProject(w);
    expect((await put(project.id, webp())).status).toBe(200);
    expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(
      await t.db.select().from(projectCovers).where(eq(projectCovers.projectId, project.id)),
    ).toEqual([]);
    // A cover of a project that went is not kept: there is none to keep it for.
    time += 60_000;
    const late = await put(project.id, webp());
    expect(late.status).toBe(404);
    expect(
      await t.db.select().from(projectCovers).where(eq(projectCovers.projectId, project.id)),
    ).toEqual([]);

    // One that is being deleted as the cover comes: the cover waits, and finds it gone.
    const going = await newProject(w);
    const deleting = await connection(t);
    try {
      await deleting.query("begin");
      await deleting.query("select 1 from projects where id = $1 for update", [going.id]);
      const coming = put(going.id, webp());
      await untilHeldUp();
      await deleting.query("delete from projects where id = $1", [going.id]);
      await deleting.query("commit");
      const answer = await coming;
      expect(answer.status).toBe(404);
      expect(answer.json).toEqual({ error: "notFound" });
    } finally {
      await deleting.end();
    }
    expect(
      await t.db.select().from(projectCovers).where(eq(projectCovers.projectId, going.id)),
    ).toEqual([]);
  });

  /** Waits until a statement of this database waits for a lock, as one that is held up does. */
  const untilHeldUp = async () => {
    for (let turn = 0; turn < 300; turn++) {
      const waiting = await t.query(
        "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (waiting.rows[0].waiting > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("nothing waits for a lock");
  };
});
