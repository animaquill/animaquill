import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { projectGroups, projectMarks, userAiSettings, userChats, userPrefs } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";

/**
 * Which cloud features go with the account is up to each device: the platform keeps no switches,
 * refuses nothing by them, and takes nothing away. A person who turned something off for all their
 * devices before 0.3.72 (the columns of `user_prefs` and `user_ai_settings.enabled` that nothing
 * reads any more) is taken as anyone. On a real PostgreSQL. Needs AQ_TEST_DATABASE, see
 * vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE)("the cloud features of an account, of each device", () => {
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

  const putChat = (project: string, id: string, q = p) =>
    q.send("PUT", `/api/me/chats/${project}/${id}`, {
      payload: JSON.stringify({
        base: null,
        chat: {
          id,
          title: "对话",
          updatedAt: time,
          entries: [{ kind: "user", text: "你好" }],
        },
      }),
      headers: { "content-type": "application/json" },
    });
  const organize = (body: Record<string, unknown>, q = p, account = w.userId) =>
    q.request("POST", "/api/organizer", { now: time, account, ...body });
  /** As a person who turned everything off for all their devices before 0.3.72 had it. */
  const offAsBefore = async () => {
    await t.db
      .insert(userPrefs)
      .values({
        userId: w.userId,
        organizerSync: false,
        organizerEpoch: 1,
        chatsSync: false,
        chatsEpoch: 1,
      })
      .onConflictDoUpdate({
        target: userPrefs.userId,
        set: { organizerSync: false, chatsSync: false },
      });
    await t.db
      .insert(userAiSettings)
      .values({ userId: w.userId, enabled: false })
      .onConflictDoUpdate({
        target: userAiSettings.userId,
        set: { enabled: false },
      });
  };

  test("there are no switches on the platform to read or change, nor a way to turn the AI settings off", async () => {
    expect((await p.send("GET", "/api/me/cloud")).status).toBe(404);
    expect(
      (
        await p.request("POST", "/api/me/cloud", {
          account: w.userId,
          chats: false,
        })
      ).status,
    ).toBe(404);
    expect((await p.send("DELETE", `/api/me/ai-settings?account=${w.userId}`)).status).toBe(404);
  });

  test("turned off for all devices before: the stars, groups and conversations are taken and kept as ever", async () => {
    await offAsBefore();
    const project = await newProject(w);
    const done = await organize({
      groups: [{ id: "g1", name: "工作", at: time - 10 }],
      marks: [{ project: project.id, star: { starred: true, at: time - 5 } }],
    });
    expect(done.status).toBe(200);
    expect((await p.request("GET", "/api/organizer")).status).toBe(200);
    expect((await putChat(project.id, "c1")).status).toBe(200);
    const listed = await p.send("GET", `/api/me/chats?project=${project.id}`);
    expect(listed.status).toBe(200);
    // Nothing says a copy went: nothing goes but what people take away.
    expect(listed.json).not.toHaveProperty("epoch");
    expect((await p.send("GET", `/api/me/chats/${project.id}/c1`)).json).not.toHaveProperty(
      "epoch",
    );
    expect(
      await t.db.select().from(projectMarks).where(eq(projectMarks.userId, w.userId)),
    ).toHaveLength(1);
    expect(
      await t.db.select().from(projectGroups).where(eq(projectGroups.ownerId, w.userId)),
    ).toHaveLength(1);
    expect(await t.db.select().from(userChats).where(eq(userChats.userId, w.userId))).toHaveLength(
      1,
    );
  });

  test("turned off for all devices before: the AI settings are taken without anything turning them on", async () => {
    await offAsBefore();
    const given = await p.request("POST", "/api/me/ai-settings", {
      now: time,
      account: w.userId,
      format: 3,
      entries: [{ name: "field:autoTitle", at: time, value: true }],
      keys: [
        {
          service: "s1",
          at: time,
          secret: { key: "sk-1", baseUrl: "https://gw.example" },
        },
      ],
    });
    expect(given.status).toBe(200);
    const read = await p.request("GET", "/api/me/ai-settings");
    expect(read.json.entries["field:autoTitle"]).toMatchObject({
      value: true,
    });
    expect(read.json.keys.s1).toMatchObject({
      secret: { key: "sk-1", baseUrl: "https://gw.example" },
    });
    // Said for pages of before 0.3.72 only: on, whatever.
    expect(read.json.enabled).toBe(true);
  });
});
