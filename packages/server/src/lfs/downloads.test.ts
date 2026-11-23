import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newProject, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { lfsWorld, oidOf, type LfsWorld } from "../test/lfs-support.ts";
import { logged } from "../app.ts";
import type { SignedIn } from "../auth/accounts.ts";
import { lfsObjects } from "../schema.ts";
import { changeSetting } from "../settings.ts";
import { LFS_DOWNLOADS_SETTING } from "./downloads.ts";

/**
 * Files of assets out of Git LFS as the editor of another computer gets them: through the HTTP API,
 * on a real PostgreSQL and the fake GitHub, whose addresses say nothing of CORS, as GitHub's do
 * not. Only for whoever may read the project, only of its repository, only what the storage has of
 * the object as large as it is said to be, a piece at a time from where it is asked for; addresses
 * and oids stay out of answers and the log. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const CHUNK = 1024;
const HERE = { "x-animaquill": "1", "sec-fetch-site": "same-origin" };

describe.skipIf(!TEST_DATABASE)("downloads out of Git LFS through the API, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let l: LfsWorld;
  /** What the downloads logged. */
  let lines: string[];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    lines = [];
    const note = (...args: unknown[]) => void lines.push(JSON.stringify(args));
    l = await lfsWorld(w, {
      limits: { chunkBytes: CHUNK, fileBytes: 64 * CHUNK },
      downloadLimits: { mostBytes: 4 * CHUNK, bytesPerGb: 10 * CHUNK },
      downloadLog: { info: note, warn: note, error: note },
    });
  });
  afterEach(() => {
    l.done();
  });

  /** A file in the repository of a project, as another computer put it there. */
  const stored = async (size = 6 * CHUNK) => {
    const { project, repo } = await l.linked();
    const data = randomBytes(size);
    await l.upload(project.id, data);
    return { project, repo, data };
  };

  /** All of an object, piece by piece from `from`, as the editor gets it. */
  const all = async (project: string, data: Buffer, from = 0) => {
    const pieces: Buffer[] = [];
    let at = from;
    while (at < data.length) {
      const got = await l.download(project, data, `bytes=${at}-`);
      expect(got.status).toBe(206);
      pieces.push(got.body);
      at += got.body.length;
    }
    return Buffer.concat(pieces);
  };

  test("an object of the project's repository comes as it is, a piece at a time, and nothing else of it", async () => {
    const { project, data } = await stored();
    const looked = await l.lookup(project.id, [{ oid: oidOf(data), size: data.length }]);
    expect(looked.status).toBe(200);
    expect(looked.json).toEqual({
      objects: [{ oid: oidOf(data), state: "ready" }],
    });

    const first = await l.download(project.id, data, "bytes=0-");
    expect(first.status).toBe(206);
    // No more than a piece holds.
    expect(first.body.length).toBe(4 * CHUNK);
    expect(first.headers["content-range"]).toBe(`bytes 0-${4 * CHUNK - 1}/${data.length}`);
    expect(first.headers["content-length"]).toBe(String(4 * CHUNK));
    expect(first.headers["content-type"]).toBe("application/octet-stream");
    expect(first.headers["content-disposition"]).toBe("attachment");
    expect(first.headers["cache-control"]).toBe("no-store, no-transform");
    expect(first.headers["content-security-policy"]).toContain("sandbox");
    // Nothing the storage said of it besides.
    expect(
      Object.keys(first.headers).filter((name) => /amz|etag|last-modified/i.test(name)),
    ).toEqual([]);

    // From where it got: as after a page that went in the middle.
    const rest = await l.download(project.id, data, `bytes=${4 * CHUNK}-`);
    expect(rest.headers["content-range"]).toBe(
      `bytes ${4 * CHUNK}-${data.length - 1}/${data.length}`,
    );
    expect(Buffer.concat([first.body, rest.body]).equals(data)).toBe(true);
    expect(w.github.ranges.slice(-2)).toEqual([0, 4 * CHUNK]);
    // The address was asked for once: kept for the second piece.
    expect(w.github.calls.filter((call) => call === "POST lfs/batch download").length).toBe(1);

    // A part of it, and a part that is none.
    const middle = await l.download(project.id, data, "bytes=10-19");
    expect(middle.body.equals(data.subarray(10, 20))).toBe(true);
    const beyond = await l.download(project.id, data, `bytes=${data.length}-`);
    expect(beyond.status).toBe(416);
  });

  test("a storage that takes no ranges: only the piece goes, and only it counts; a HEAD asks nothing", async () => {
    const { project, data } = await stored(6 * CHUNK);
    w.github.faults.lfsNoRanges = true;
    const got = await l.download(project.id, data, "bytes=0-");
    expect(got.status).toBe(206);
    expect(got.body.equals(data.subarray(0, 4 * CHUNK))).toBe(true);
    expect(l.downloads.countedFor(w.userId)).toBe(4 * CHUNK);
    // Not from its start, it does not come at all.
    expect((await l.download(project.id, data, `bytes=${CHUNK}-`)).status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(l.downloads.passing).toBe(0);
    const asked = w.github.calls.length;
    const head = await l.p.app.inject({
      method: "HEAD",
      url: `/api/projects/${project.id}/lfs/objects/${oidOf(data)}?size=${data.length}`,
      headers: { "x-animaquill": "1" },
    });
    expect(head.statusCode).toBe(404);
    expect(w.github.calls.length).toBe(asked);
  });

  test("only whoever may read the project, only from pages of this site, only of its repository", async () => {
    const { project, data } = await stored(2 * CHUNK);
    const object = [{ oid: oidOf(data), size: data.length }];
    // Signed out.
    const anonymous = await l.p.sendRaw(
      "GET",
      `/api/projects/${project.id}/lfs/objects/${oidOf(data)}?size=${data.length}`,
      { signedIn: false, headers: HERE },
    );
    expect(anonymous.status).toBe(401);
    // A link of another site, or a page of it, without the header of our pages.
    expect((await l.download(project.id, data, "bytes=0-", {})).status).toBe(403);
    expect(
      (
        await l.download(project.id, data, "bytes=0-", {
          ...HERE,
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(403);
    const elsewhere = await l.p.send("POST", `/api/projects/${project.id}/lfs/lookup`, {
      payload: JSON.stringify({ objects: object }),
      headers: { "content-type": "application/json" },
      fromHere: false,
    });
    expect(elsewhere.status).toBe(403);

    // Somebody else's project, linked to the very repository that has the file: as if it were not
    // there, for the lookup and for the bytes. Members come later.
    const someone = await world(t.db);
    const theirs = await lfsWorld(someone);
    try {
      const other = await theirs.linked();
      expect((await l.lookup(other.project.id, object)).json).toEqual({
        error: "notFound",
      });
      expect((await l.download(other.project.id, data)).status).toBe(404);
      // Their own project reaches only their own repository, where the file is not.
      expect((await theirs.lookup(other.project.id, object)).json).toEqual({
        objects: [{ oid: oidOf(data), state: "missing" }],
      });
      expect((await theirs.download(other.project.id, data)).json).toEqual({
        error: "missing",
      });
    } finally {
      theirs.done();
    }

    // Not linked to a repository.
    const loose = await newProject(w);
    expect((await l.lookup(loose.id, object)).json).toEqual({
      error: "notLinked",
    });
    expect((await l.download(loose.id, data)).json).toEqual({
      error: "notLinked",
    });

    // What is no object.
    const wrong = await l.p.sendRaw("GET", `/api/projects/${project.id}/lfs/objects/ABC?size=1`, {
      headers: HERE,
    });
    expect(wrong.status).toBe(400);
    const tooMany = await l.lookup(
      project.id,
      Array.from({ length: 101 }, () => ({
        oid: oidOf(randomBytes(8)),
        size: 8,
      })),
    );
    expect(tooMany.status).toBe(400);
  });

  test("a lookup says what each object is: there, coming, missing, or another size", async () => {
    const { project, repo, data } = await stored(2 * CHUNK);
    // On its way from another computer: half of it is there.
    const coming = randomBytes(4 * CHUNK);
    const begun = await l.begin(project.id, coming);
    await l.piece(begun.json.id, 0, coming.subarray(0, CHUNK));
    const missing = randomBytes(100);
    // The storage has it, and the platform knows it in another size.
    const other = randomBytes(300);
    w.github.addLfsObject(repo.id, other);
    await t.db.insert(lfsObjects).values({ repoId: repo.id, oid: oidOf(other), size: 999 });
    const looked = await l.lookup(project.id, [
      { oid: oidOf(data), size: data.length },
      { oid: oidOf(coming), size: coming.length },
      { oid: oidOf(missing), size: missing.length },
      { oid: oidOf(other), size: 300 },
      // Asked twice: answered twice.
      { oid: oidOf(data), size: data.length },
    ]);
    expect(looked.json).toEqual({
      objects: [
        { oid: oidOf(data), state: "ready" },
        {
          oid: oidOf(coming),
          state: "uploading",
          received: CHUNK,
          size: coming.length,
        },
        { oid: oidOf(missing), state: "missing" },
        { oid: oidOf(other), state: "changed" },
        { oid: oidOf(data), state: "ready" },
      ],
    });
    expect((await l.download(project.id, missing)).status).toBe(410);
  });

  test("what the storage has in another size than asked for does not come", async () => {
    const { project, data } = await stored(2 * CHUNK);
    // A storage that goes by the oid alone gives what it has, which is not of that size.
    w.github.faults.lfsAnySize = true;
    const got = await l.download(project.id, {
      oid: oidOf(data),
      size: data.length + 1,
    });
    expect(got.json).toEqual({ error: "changed" });
  });

  test("an address that runs out early is asked for again, once; a broken one fails the piece", async () => {
    const { project, data } = await stored(2 * CHUNK);
    w.github.faults.lfsExpireDownloads = 1;
    expect((await all(project.id, data)).equals(data)).toBe(true);
    expect(w.github.calls.filter((call) => call === "POST lfs/batch download").length).toBe(2);
    // The connection to the storage breaks halfway: the piece ends short, and the next goes on.
    w.github.faults.lfsCutDownloads = 1;
    const cut = await l.download(project.id, data, "bytes=0-").catch(() => undefined);
    expect(cut === undefined || cut.body.length < 2 * CHUNK).toBe(true);
    expect((await all(project.id, data)).equals(data)).toBe(true);
    expect(l.downloads.passing).toBe(0);
  });

  test("GitHub's traffic used up, or the repository gone, is said as such", async () => {
    const { project, repo, data } = await stored(2 * CHUNK);
    const object = [{ oid: oidOf(data), size: data.length }];
    w.github.faults.lfsDownloadQuota = true;
    expect((await l.lookup(project.id, object)).json).toMatchObject({
      error: "githubQuota",
    });
    w.github.faults.lfsDownloadQuota = false;
    w.github.deleteRepo(repo.id);
    expect((await l.lookup(project.id, object)).json).toMatchObject({
      error: "gone",
    });
  });

  test("so many pieces of one person at once, and so many bytes a day, as admins set it", async () => {
    const { project, data } = await stored(4 * CHUNK);
    const user = { userId: w.userId } as SignedIn;
    const object = { oid: oidOf(data), size: data.length };
    const open = await Promise.all(
      Array.from({ length: 4 }, () =>
        l.downloads.piece(user, project.id, object, { start: 0, end: 9 }),
      ),
    );
    expect(l.downloads.passing).toBe(4);
    const fifth = await l.download(project.id, data, "bytes=0-");
    expect(fifth.status).toBe(429);
    expect(fifth.json).toEqual({ error: "busy" });
    expect(fifth.headers["retry-after"]).toBeDefined();
    // Taken or given up, a piece lets go of its place.
    for (const piece of open) piece.body.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(l.downloads.passing).toBe(0);

    // A "GB" of these tests is 10 KiB: a day gives 1 of them, which 40 bytes leave unused.
    await changeSetting(t.db, LFS_DOWNLOADS_SETTING, { dailyGb: 1 }, { adminId: null });
    expect((await all(project.id, data)).equals(data)).toBe(true);
    expect((await all(project.id, data)).equals(data)).toBe(true);
    let refused;
    for (let round = 0; round < 3 && !refused; round++) {
      const got = await l.download(project.id, data, "bytes=0-");
      if (got.status !== 206) refused = got;
    }
    expect(refused?.status).toBe(429);
    expect(refused?.json).toEqual({ error: "busy", detail: "daily" });
    // The next day, again.
    w.time.later(24 * 3600_000);
    expect((await l.download(project.id, data, "bytes=0-")).status).toBe(206);
  });

  test("neither addresses nor oids go to the log", async () => {
    const { project, repo, data } = await stored(2 * CHUNK);
    await all(project.id, data);
    w.github.deleteRepo(repo.id);
    await l.download(project.id, data);
    w.time.later(24 * 3600_000);
    const later = await stored(CHUNK);
    await all(later.project.id, later.data);
    const said = lines.join("\n");
    expect(said).toContain("downloads through the platform");
    expect(said).not.toContain(oidOf(data));
    expect(said).not.toMatch(/_lfs|sig=|https?:/);
    // Nor the address of a request for one.
    const url = `/api/projects/${project.id}/lfs/objects/${oidOf(data)}?size=1`;
    expect(logged({ method: "GET", url, host: "app", ip: "1.2.3.4" }).url).toBe(
      `/api/projects/${project.id}/lfs/objects/…`,
    );
  });
});
