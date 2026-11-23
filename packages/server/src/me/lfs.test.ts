import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { linkTo, newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { lfsObjects, projects } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { lfsChangesOf } from "./lfs.ts";

/**
 * What a person has in the large file storage of GitHub through the platform, and how they go about
 * it (me/lfs.ts): by repository, what they said they know, once, and which projects put new assets
 * there by themselves; one person's never touch another's. On a real PostgreSQL. Needs
 * AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe("what a request gives", () => {
  test("all of it as it should be, or nothing", () => {
    const ok = { account: "u", acknowledged: true };
    expect(lfsChangesOf(ok)).toEqual(ok);
    expect(lfsChangesOf({ account: "u" })).toEqual({ account: "u" });
    // The switch of before, from a page that did not reload yet: left out, the rest as ever.
    expect(lfsChangesOf({ ...ok, auto: { project: "p1", on: true } })).toEqual(ok);
    for (const wrong of [
      { ...ok, account: "" },
      { ...ok, acknowledged: false },
      { ...ok, other: 1 },
      null,
      [],
    ])
      expect(lfsChangesOf(wrong), JSON.stringify(wrong)).toBeUndefined();
  });
});

describe.skipIf(!TEST_DATABASE)("the large file storage of an account, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let hub: SyncHub;
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
    time = 1_800_000_000_000;
    p = await platform(w, { hub, now: () => time });
  });
  afterEach(() => hub.stop());

  const read = async (q = p) => (await q.request("GET", "/api/me/lfs")).json;
  const change = (body: Record<string, unknown>, q = p, account = w.userId) =>
    q.request("POST", "/api/me/lfs", { account, ...body });

  test("by repository, the largest first, with the project each is of; nothing said yet", async () => {
    expect(await read()).toEqual({ account: w.userId, repositories: [] });
    const small = await newProject(w);
    const large = await newProject(w);
    const none = await newProject(w);
    const smallRepo = w.github.addRepo(w.person, { name: "small", select: true });
    const largeRepo = w.github.addRepo(w.person, { name: "large", select: true });
    const noneRepo = w.github.addRepo(w.person, { name: "none", select: true });
    await linkTo(w, small.id, smallRepo);
    await linkTo(w, large.id, largeRepo);
    await linkTo(w, none.id, noneRepo);
    await t.db.update(projects).set({ name: "大的" }).where(eq(projects.id, large.id));
    await t.db.insert(lfsObjects).values([
      { repoId: smallRepo.id, oid: "a".repeat(64), size: 10 },
      { repoId: largeRepo.id, oid: "b".repeat(64), size: 1000 },
      { repoId: largeRepo.id, oid: "c".repeat(64), size: 2000 },
      // Of somebody else's repository.
      { repoId: 987_654_321, oid: "d".repeat(64), size: 5 },
    ]);
    const found = await read();
    expect(found.repositories).toEqual([
      {
        repo: largeRepo.id,
        fullName: `${w.person.login}/large`,
        url: `https://github.com/${w.person.login}/large`,
        project: { id: large.id, name: "大的" },
        files: 2,
        bytes: 3000,
      },
      expect.objectContaining({ repo: smallRepo.id, files: 1, bytes: 10 }),
    ]);
    // Somebody else sees none of it.
    const other = await world(t.db);
    const theirs = await platform(other, { hub, now: () => time });
    expect((await read(theirs)).repositories).toEqual([]);
  });

  test("said once, kept as the first time, on every computer; another account cannot say it", async () => {
    const first = await change({ acknowledged: true });
    expect(first.status).toBe(200);
    expect(first.json.acknowledgedAt).toBe(time);
    time += 60_000;
    expect((await change({ acknowledged: true })).json.acknowledgedAt).toBe(time - 60_000);
    expect((await read()).acknowledgedAt).toBe(time - 60_000);
    const elsewhere = await change({ acknowledged: true }, p, "someone-else");
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.json).toEqual({ error: "otherAccount" });
  });

  test("where new assets go is the project's: the platform takes no switch for it any more", async () => {
    const mine = await newProject(w);
    const old = await change({ acknowledged: true, auto: { project: mine.id, on: true } });
    expect(old.status).toBe(200);
    expect(old.json.acknowledgedAt).toBeDefined();
    expect((await read()).auto).toBeUndefined();
  });
});
