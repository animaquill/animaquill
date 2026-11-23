import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { projectGroups, projectMarks } from "../schema.ts";
import { SyncHub } from "./hub.ts";
import { ORGANIZER_CHANGES } from "./routes.ts";
import {
  changesOf,
  DELETED_GROUPS_KEPT,
  GROUPS_PER_USER,
  groupNameOf,
  timeOf,
} from "./organize.ts";

/**
 * How people organise their projects on the start page, kept by the platform (sync/organize.ts):
 * groups and the marks of projects, each field by the later change, of the person only. On a real
 * PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe("what a request gives", () => {
  test("names of groups: trimmed, 1 to 60 characters, no control characters", () => {
    expect(groupNameOf("  工作 ")).toBe("工作");
    expect(groupNameOf("字".repeat(60))).toBe("字".repeat(60));
    // Characters, not units of UTF-16.
    expect(groupNameOf("😀".repeat(60))).toBe("😀".repeat(60));
    for (const no of ["", "   ", "字".repeat(61), "a\nb", "a\u0000", "a\u200bb", 5, undefined])
      expect(groupNameOf(no), String(no)).toBeUndefined();
  });

  test("all of it as it should be, or nothing", () => {
    expect(changesOf({ account: "u" })).toEqual({ account: "u", groups: [], marks: [] });
    const ok = {
      account: "u",
      now: 5,
      groups: [
        { id: "g-1", name: "工作", at: 1 },
        { id: "g_2", deleted: true, at: 2 },
      ],
      marks: [
        { project: "p1", star: { starred: true, at: 3 } },
        { project: "p2", group: { id: null, at: 4 } },
        { project: "p3", group: { id: "g-1", at: 4 }, star: { starred: false, at: 4 } },
      ],
    };
    expect(changesOf(ok)).toEqual(ok);
    // A name no group can have is answered on its own: the rest goes on.
    expect(
      changesOf({
        account: "u",
        groups: [
          { id: "a", name: "A\tB", at: 1 },
          { id: "b", name: "", at: 1 },
        ],
      }),
    ).toEqual({
      account: "u",
      groups: [
        { id: "a", at: 1, invalid: true },
        { id: "b", at: 1, invalid: true },
      ],
      marks: [],
    });
    for (const without of [null, [], {}, { account: "" }, { account: 5 }])
      expect(changesOf(without), JSON.stringify(without)).toBeUndefined();
    for (const wrong of [
      { now: -1 },
      { now: "1" },
      { groups: {} },
      { groups: [{ id: "a b", name: "x", at: 1 }] },
      { groups: [{ id: "a", name: 5, at: 1 }] },
      { groups: [{ id: "a", name: "x", at: -1 }] },
      { groups: [{ id: "a", name: "x", at: Number.NaN }] },
      { groups: [{ id: "a", name: "x", at: 1, deleted: false }] },
      { marks: [{ project: "p1" }] },
      { marks: [{ project: "../p", star: { starred: true, at: 1 } }] },
      { marks: [{ project: "p", star: { starred: 1, at: 1 } }] },
      { marks: [{ project: "p", group: { id: "a b", at: 1 } }] },
      { marks: [{ project: "p", group: { at: 1 } }] },
      { groups: Array.from({ length: 201 }, (_, i) => ({ id: `g${i}`, name: `${i}`, at: 1 })) },
    ]) {
      const bad = { account: "u", ...wrong };
      expect(changesOf(bad), JSON.stringify(bad)?.slice(0, 80)).toBeUndefined();
    }
  });

  test("times by the platform's clock: as far off as the editor's clock, never later than now", () => {
    // The editor's clock is an hour ahead: what it says happened a minute ago did, by this one.
    const now = 1_800_000_000_000;
    const ahead = now + 3600_000;
    expect(timeOf(ahead - 60_000, ahead, now).getTime()).toBe(now - 60_000);
    // ...an hour behind, the same.
    const behind = now - 3600_000;
    expect(timeOf(behind - 60_000, behind, now).getTime()).toBe(now - 60_000);
    // What says it happened after it was sent did not.
    expect(timeOf(ahead + 3600_000, ahead, now).getTime()).toBe(now);
    // Without its clock, as it is.
    expect(timeOf(now - 5, undefined, now).getTime()).toBe(now - 5);
  });
});

describe.skipIf(!TEST_DATABASE)("how projects are organised, on a database", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let hub: SyncHub;
  /** The platform's clock. */
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
  afterEach(() => {
    hub.stop();
  });

  /** Changes, sent with the platform's own time unless said. */
  const change = (body: Record<string, unknown>, via = p, account = w.userId) =>
    via.request("POST", "/api/organizer", { now: time, account, ...body });
  const read = async (via = p) => (await via.request("GET", "/api/organizer")).json;

  test("keeps groups and marks, and gives them back with what time it is", async () => {
    const project = await newProject(w);
    expect(await read()).toEqual({ now: time, account: w.userId, groups: [], marks: [] });
    const done = await change({
      groups: [{ id: "g1", name: " 工作 ", at: time - 10 }],
      marks: [
        {
          project: project.id,
          star: { starred: true, at: time - 5 },
          group: { id: "g1", at: time - 5 },
        },
      ],
    });
    expect(done.status).toBe(200);
    const state = {
      account: w.userId,
      groups: [{ id: "g1", name: "工作", at: time - 10 }],
      marks: [
        {
          project: project.id,
          star: { starred: true, at: time - 5 },
          group: { id: "g1", at: time - 5 },
        },
      ],
    };
    expect(done.json).toEqual({
      now: time,
      groups: ["kept"],
      marks: [{ project: project.id, star: "kept", group: "kept" }],
      state,
    });
    expect(await read()).toEqual({ now: time, ...state });
  });

  test("each field by the later change: the star and the group of a project, on their own", async () => {
    const project = await newProject(w);
    await change({ groups: [{ id: "g1", name: "工作", at: time - 100 }] });
    // One computer starred it at 20, another moved it at 30 from what it had at 10: both stay.
    await change({ marks: [{ project: project.id, star: { starred: true, at: time - 20 } }] });
    const later = await change({
      marks: [
        {
          project: project.id,
          star: { starred: false, at: time - 90 },
          group: { id: "g1", at: time - 10 },
        },
      ],
    });
    expect(later.json.marks).toEqual([{ project: project.id, star: "older", group: "kept" }]);
    expect(later.json.state.marks).toEqual([
      {
        project: project.id,
        star: { starred: true, at: time - 20 },
        group: { id: "g1", at: time - 10 },
      },
    ]);
    // Out of its group before that: older.
    const older = await change({
      marks: [{ project: project.id, group: { id: null, at: time - 15 } }],
    });
    expect(older.json.marks).toEqual([{ project: project.id, group: "older" }]);
    // At the same time as what is there: kept, as a second try of the same change is.
    const again = await change({
      marks: [{ project: project.id, group: { id: "g1", at: time - 10 } }],
    });
    expect(again.json.marks).toEqual([{ project: project.id, group: "kept" }]);
    const out = await change({
      marks: [{ project: project.id, group: { id: null, at: time - 1 } }],
    });
    expect(out.json.state.marks[0].group).toEqual({ id: null, at: time - 1 });
  });

  test("when a project was last opened: the latest any computer said, apart from the rest", async () => {
    const project = await newProject(w);
    await change({ marks: [{ project: project.id, star: { starred: true, at: time - 50 } }] });
    const opened = await change({ marks: [{ project: project.id, opened: { at: time - 20 } }] });
    expect(opened.json.marks).toEqual([{ project: project.id, opened: "kept" }]);
    // Another computer that opened it before that says so late: the later stays.
    const before = await change({ marks: [{ project: project.id, opened: { at: time - 30 } }] });
    expect(before.json.marks).toEqual([{ project: project.id, opened: "older" }]);
    expect((await read()).marks).toEqual([
      { project: project.id, star: { starred: true, at: time - 50 }, opened: time - 20 },
    ]);
    // Only a time, as the rest is.
    expect(changesOf({ account: "u", marks: [{ project: "p", opened: { at: -1 } }] })).toBe(
      undefined,
    );
    expect(changesOf({ account: "u", marks: [{ project: "p", opened: 5 }] })).toBeUndefined();
  });

  test("groups by the later change; taken away stays, and a later rename brings it back", async () => {
    const project = await newProject(w);
    await change({ groups: [{ id: "g1", name: "工作", at: time - 100 }] });
    await change({ marks: [{ project: project.id, group: { id: "g1", at: time - 90 } }] });
    // Renamed at 50, taken away at 40 elsewhere: the rename is later, the group stays.
    await change({ groups: [{ id: "g1", name: "频道", at: time - 50 }] });
    const stale = await change({ groups: [{ id: "g1", deleted: true, at: time - 60 }] });
    expect(stale.json.groups).toEqual(["older"]);
    expect(stale.json.state.groups).toEqual([{ id: "g1", name: "频道", at: time - 50 }]);
    // Taken away later: it stays, as such, and the project says it is in it still.
    const gone = await change({ groups: [{ id: "g1", deleted: true, at: time - 40 }] });
    expect(gone.json.groups).toEqual(["kept"]);
    expect(gone.json.state).toEqual({
      account: w.userId,
      groups: [{ id: "g1", name: "频道", at: time - 40, deleted: true }],
      marks: [{ project: project.id, group: { id: "g1", at: time - 90 } }],
    });
    // A rename from before that does not bring it back; one after it does, with what was in it.
    expect(
      (await change({ groups: [{ id: "g1", name: "旧", at: time - 45 }] })).json.groups,
    ).toEqual(["older"]);
    // At the same time: taking away wins.
    expect(
      (await change({ groups: [{ id: "g1", name: "旧", at: time - 40 }] })).json.groups,
    ).toEqual(["older"]);
    const back = await change({ groups: [{ id: "g1", name: "回来", at: time - 30 }] });
    expect(back.json.groups).toEqual(["kept"]);
    expect(back.json.state.groups).toEqual([{ id: "g1", name: "回来", at: time - 30 }]);
    // Taking away what was never there: missing.
    expect(
      (await change({ groups: [{ id: "nope", deleted: true, at: time }] })).json.groups,
    ).toEqual(["missing"]);
  });

  test("one name once, whatever the case or width: the second is told which has it", async () => {
    await change({ groups: [{ id: "g1", name: "Work", at: time - 100 }] });
    const same = await change({
      groups: [
        { id: "g2", name: " ｗｏｒｋ ", at: time - 50 },
        { id: "g3", name: "Other", at: time - 50 },
      ],
    });
    expect(same.json.groups).toEqual([{ taken: "g1" }, "kept"]);
    // Nor a rename into it.
    expect(
      (await change({ groups: [{ id: "g3", name: "WORK", at: time - 10 }] })).json.groups,
    ).toEqual([{ taken: "g1" }]);
    // Once that one is taken away, the name is free; bringing that one back is not then.
    await change({ groups: [{ id: "g1", deleted: true, at: time - 5 }] });
    expect(
      (await change({ groups: [{ id: "g3", name: "work", at: time - 4 }] })).json.groups,
    ).toEqual(["kept"]);
    expect(
      (await change({ groups: [{ id: "g1", name: "Work", at: time - 3 }] })).json.groups,
    ).toEqual([{ taken: "g3" }]);
  });

  test("a project in a group that was taken away, or in none that is there", async () => {
    const project = await newProject(w);
    await change({ groups: [{ id: "g1", name: "工作", at: time - 100 }] });
    await change({ groups: [{ id: "g1", deleted: true, at: time - 50 }] });
    // Put into it later on a computer that did not know: kept, and it is in none, as the group
    // is taken away.
    const into = await change({
      marks: [{ project: project.id, group: { id: "g1", at: time - 10 } }],
    });
    expect(into.json.marks).toEqual([{ project: project.id, group: "kept" }]);
    expect(into.json.state.marks).toEqual([
      { project: project.id, group: { id: "g1", at: time - 10 } },
    ]);
    // One the person never had, also not one of somebody else's: none to be in.
    const someone = await world(t.db);
    const q = await platform(someone, { hub, now: () => time });
    await change({ groups: [{ id: "theirs", name: "别人的", at: time - 10 }] }, q, someone.userId);
    const unknown = await change({
      marks: [
        {
          project: project.id,
          group: { id: "theirs", at: time },
          star: { starred: true, at: time },
        },
      ],
    });
    expect(unknown.json.marks).toEqual([{ project: project.id, star: "kept", group: "noGroup" }]);
    expect(unknown.json.state.marks[0].group).toEqual({ id: "g1", at: time - 10 });
  });

  test("only the person's own: projects of somebody else, or none, are missing", async () => {
    const someone = await world(t.db);
    const theirs = await newProject(someone);
    const mine = await newProject(w);
    const q = await platform(someone, { hub, now: () => time });
    await change({ groups: [{ id: "g1", name: "我的", at: time }] });
    // The same id is another group of another person.
    expect(
      (await change({ groups: [{ id: "g1", name: "他的", at: time }] }, q, someone.userId)).json
        .groups,
    ).toEqual(["kept"]);
    const refused = await change({
      marks: [
        { project: theirs.id, star: { starred: true, at: time } },
        { project: "no-such-project", star: { starred: true, at: time } },
        { project: mine.id, star: { starred: true, at: time } },
      ],
    });
    expect(refused.json.marks).toEqual([
      { project: theirs.id, missing: true },
      { project: "no-such-project", missing: true },
      { project: mine.id, star: "kept" },
    ]);
    expect(await read()).toMatchObject({
      groups: [{ id: "g1", name: "我的" }],
      marks: [{ project: mine.id }],
    });
    expect(await read(q)).toMatchObject({ groups: [{ id: "g1", name: "他的" }], marks: [] });
    // From elsewhere, or signed out.
    const elsewhere = await p.send("POST", "/api/organizer", {
      payload: JSON.stringify({ groups: [] }),
      headers: { "content-type": "application/json" },
      fromHere: false,
    });
    expect(elsewhere.status).toBe(403);
    expect((await p.send("GET", "/api/organizer", { signedIn: false })).status).toBe(401);
    // Anything not as it should be: nothing is kept.
    const bad = await change({
      groups: [{ id: "g9", name: "新", at: time }],
      marks: [{ project: mine.id }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({ error: "invalid" });
    expect((await read()).groups).toHaveLength(1);
  });

  test("marks go with their project", async () => {
    const project = await newProject(w);
    await change({ marks: [{ project: project.id, star: { starred: true, at: time } }] });
    expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(
      await t.db.select().from(projectMarks).where(eq(projectMarks.projectId, project.id)),
    ).toEqual([]);
    expect((await read()).marks).toEqual([]);
    // Given again from a computer that did not hear of it: missing.
    expect(
      (await change({ marks: [{ project: project.id, star: { starred: false, at: time } }] })).json
        .marks,
    ).toEqual([{ project: project.id, missing: true }]);
  });

  test("so many groups, and so many taken away", async () => {
    const many = Array.from({ length: GROUPS_PER_USER }, (_, i) => ({
      id: `g${i}`,
      name: `分组 ${i}`,
      at: time - 1000,
    }));
    expect((await change({ groups: many })).json.groups).toEqual(many.map(() => "kept"));
    const more = await change({ groups: [{ id: "more", name: "再一个", at: time }] });
    expect(more.json.groups).toEqual(["tooMany"]);
    // One taken away makes room; bringing it back does not, once another took it.
    await change({ groups: [{ id: "g0", deleted: true, at: time - 900 }] });
    expect(
      (await change({ groups: [{ id: "more", name: "再一个", at: time }] })).json.groups,
    ).toEqual(["kept"]);
    expect(
      (await change({ groups: [{ id: "g0", name: "分组 0", at: time }] })).json.groups,
    ).toEqual(["tooMany"]);
  });

  test("lets go of the oldest groups taken away, and projects in them are in none", async () => {
    const project = await newProject(w);
    // As many taken away as are kept, and one more.
    for (let from = 0; from <= DELETED_GROUPS_KEPT; from += 200) {
      const some = Array.from(
        { length: Math.min(200, DELETED_GROUPS_KEPT + 1 - from) },
        (_, i) => from + i,
      );
      await change({
        groups: some.map((i) => ({ id: `d${i}`, name: `删 ${i}`, at: time - 10_000 + i })),
      });
      await change({
        groups: some.map((i) => ({ id: `d${i}`, deleted: true, at: time - 5000 + i })),
      });
    }
    await change({ marks: [{ project: project.id, group: { id: "d0", at: time - 100 } }] });
    // A new one has the oldest go.
    await change({ groups: [{ id: "new", name: "新", at: time }] });
    const rows = await t.db.select().from(projectGroups).where(eq(projectGroups.ownerId, w.userId));
    expect(rows.filter((row) => row.deleted)).toHaveLength(DELETED_GROUPS_KEPT);
    expect(rows.some((row) => row.id === "d0")).toBe(false);
    expect((await read()).marks).toEqual([
      { project: project.id, group: { id: null, at: time - 100 } },
    ]);
  }, 60_000);

  test("times of an editor whose clock is off are taken by the platform's", async () => {
    const project = await newProject(w);
    // Its clock is a day ahead: starred a minute ago, by its clock.
    const ahead = time + 24 * 3600_000;
    await p.request("POST", "/api/organizer", {
      account: w.userId,
      now: ahead,
      marks: [{ project: project.id, star: { starred: true, at: ahead - 60_000 } }],
    });
    // Another computer, whose clock is right, took the star away half a minute ago: later.
    const right = await change({
      marks: [{ project: project.id, star: { starred: false, at: time - 30_000 } }],
    });
    expect(right.json.marks).toEqual([{ project: project.id, star: "kept" }]);
    expect(right.json.state.marks[0].star).toEqual({ starred: false, at: time - 30_000 });
  });

  // Another window signed out and in as somebody else; this one still takes the person before to
  // be signed in. Nothing is kept: the page asks who is signed in again.
  test("changes of another account than the session's: none is kept", async () => {
    const someone = await world(t.db);
    const project = await newProject(w);
    const other = await change(
      {
        groups: [{ id: "g1", name: "别人的", at: time }],
        marks: [{ project: project.id, star: { starred: true, at: time } }],
      },
      p,
      someone.userId,
    );
    expect(other.status).toBe(409);
    expect(other.json).toEqual({ error: "otherAccount" });
    expect(await read()).toMatchObject({ account: w.userId, groups: [], marks: [] });
  });

  test("a name no group can have is answered on its own, and the rest is kept", async () => {
    const project = await newProject(w);
    const answer = await change({
      groups: [
        { id: "tab", name: "A\tB", at: time },
        { id: "wide", name: "工作\u200b", at: time },
        { id: "fine", name: "工作", at: time },
      ],
      marks: [{ project: project.id, star: { starred: true, at: time } }],
    });
    expect(answer.status).toBe(200);
    expect(answer.json.groups).toEqual(["invalid", "invalid", "kept"]);
    expect(answer.json.marks).toEqual([{ project: project.id, star: "kept" }]);
    expect(answer.json.state.groups).toEqual([{ id: "fine", name: "工作", at: time }]);
  });

  test("changes are counted one by one, as many in ten minutes as a person makes", async () => {
    const batch = (from: number) =>
      Array.from({ length: 200 }, (_, i) => ({
        id: `g${(from + i) % 150}`,
        name: `分组 ${(from + i) % 150}`,
        at: time + from + i,
      }));
    let status = 200;
    let sent = 0;
    while (status === 200 && sent < ORGANIZER_CHANGES + 400) {
      status = (await change({ groups: batch(sent) })).status;
      if (status === 200) sent += 200;
    }
    expect(status).toBe(429);
    expect(sent).toBe(ORGANIZER_CHANGES - (ORGANIZER_CHANGES % 200));
    // Ten minutes on, again.
    time += 10 * 60_000;
    expect((await change({ groups: batch(0) })).status).toBe(200);
  }, 120_000);

  test("is limited, as other requests are", async () => {
    let answer = 200;
    for (let i = 0; i < 400 && answer !== 429; i += 1)
      answer = (await p.request("GET", "/api/organizer")).status;
    expect(answer).toBe(429);
  });
});
