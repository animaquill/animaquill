import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { userChats } from "../schema.ts";
import { SyncHub } from "../sync/hub.ts";
import { CHAT_BYTES_PER_USER, CHATS_PER_PROJECT } from "./chats.ts";
import { fixedLimits } from "../limits.ts";

/**
 * Conversations about projects of the platform that go with the account (me/chats.ts): written
 * whole over the revision they were read at, private to their person, only of their own projects.
 * On a real PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

describe.skipIf(!TEST_DATABASE)("conversations that go with an account, on a database", () => {
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
    // As the platform has it: a server of its own has no limit unless its settings say one.
    p = await platform(w, {
      hub,
      now: () => time,
      limits: fixedLimits({ "chat.history": CHAT_BYTES_PER_USER }),
    });
  });
  afterEach(() => hub.stop());

  const chat = (id: string, said: string, updatedAt = time) => ({
    id,
    project: "ignored",
    title: said,
    updatedAt,
    entries: [{ kind: "user", text: said }],
    model: { service: "s1", model: "m" },
  });
  const put = (project: string, body: unknown, q = p) =>
    q.send("PUT", `/api/me/chats/${project}/${(body as { chat: { id: string } }).chat.id}`, {
      payload: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  test("written, listed and read back; a second device writing over an old revision is told", async () => {
    const project = await newProject(w);
    const first = await put(project.id, {
      base: null,
      chat: chat("c1", "开场放慢"),
    });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ revision: 1 });
    const second = await put(project.id, {
      base: 1,
      chat: {
        ...chat("c1", "开场放慢"),
        entries: [{ kind: "user", text: "开场放慢" }, { kind: "assistant" }],
      },
    });
    expect(second.json).toEqual({ revision: 2 });
    // The other device read revision 1, and writes after: refused, nothing kept.
    const late = await put(project.id, {
      base: 1,
      chat: chat("c1", "另一台"),
    });
    expect(late.status).toBe(409);
    expect(late.json).toEqual({ error: "newer", revision: 2 });
    const list = await p.send("GET", `/api/me/chats?project=${project.id}`);
    expect(list.json).toEqual({
      chats: [
        {
          revision: 2,
          summary: { id: "c1", title: "开场放慢", updatedAt: time },
        },
      ],
    });
    const read = await p.send("GET", `/api/me/chats/${project.id}/c1`);
    expect(read.json.revision).toBe(2);
    expect(read.json.chat.entries).toHaveLength(2);
    expect(read.json.chat.project).toBeUndefined();
    expect((await p.send("DELETE", `/api/me/chats/${project.id}/c1`)).status).toBe(204);
    expect((await p.send("GET", `/api/me/chats/${project.id}/c1`)).status).toBe(404);
  });

  test("not from a page older than the oldest editor, which would write back without what it cannot read", async () => {
    const project = await newProject(w);
    const strict = await platform(w, {
      hub,
      now: () => time,
      switches: {
        deletesFrom: undefined,
        oldestEditor: "0.3.82",
      },
    });
    const body = JSON.stringify({ base: null, chat: chat("c1", "开场放慢") });
    const as = (editor?: string) =>
      strict.send("PUT", `/api/me/chats/${project.id}/c1`, {
        payload: body,
        headers: {
          "content-type": "application/json",
          ...(editor !== undefined && { "x-animaquill-editor": editor }),
        },
      });
    // A page of 0.3.81 says nothing of its version; one that says an older one is as old.
    for (const old of [undefined, "0.3.81"]) {
      const refused = await as(old);
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({ error: "outdated" });
    }
    expect((await strict.send("GET", `/api/me/chats/${project.id}/c1`)).status).toBe(404);
    expect((await as("0.3.82")).json).toEqual({ revision: 1 });
    expect((await as("dev")).status).toBe(409);
    expect((await as("dev")).json).toEqual({ error: "newer", revision: 1 });
  });

  test("what the editor showed as each message was sent goes with it, as written", async () => {
    // Another device reads the conversation whole: what aq_selection_read reads at "sent".
    const project = await newProject(w);
    const entries = [
      {
        role: "user",
        text: "把这两个放慢",
        at: 1,
        task: "chat-t1",
        selection: {
          timeline: "main",
          playhead: "12.5",
          clips: ["clip_title", "clip_logo"],
          transition: { clip: "clip_title", edge: "exit" },
        },
      },
    ];
    await put(project.id, { base: null, chat: { ...chat("c1", "把这两个放慢"), entries } });
    const read = await p.send("GET", `/api/me/chats/${project.id}/c1`);
    expect(read.json.chat.entries).toEqual(entries);
  });

  test("private to the person, and only of their own projects", async () => {
    const project = await newProject(w);
    await put(project.id, { base: null, chat: chat("c1", "我的") });
    const someone = await world(t.db);
    const q = await platform(someone, { hub, now: () => time });
    expect((await q.send("GET", `/api/me/chats?project=${project.id}`)).status).toBe(404);
    expect((await q.send("GET", `/api/me/chats/${project.id}/c1`)).status).toBe(404);
    expect((await put(project.id, { base: null, chat: chat("c2", "别人的") }, q)).status).toBe(404);
    expect((await q.send("DELETE", `/api/me/chats/${project.id}/c1`)).status).toBe(204);
    expect((await p.send("GET", `/api/me/chats/${project.id}/c1`)).status).toBe(200);
    expect((await put("no-such-project", { base: null, chat: chat("c3", "x") })).status).toBe(404);
  });

  test("so many of a project, the oldest go; and they go with their project", async () => {
    const project = await newProject(w);
    for (let i = 0; i <= CHATS_PER_PROJECT; i += 1) {
      time += 1000;
      expect(
        (
          await put(project.id, {
            base: null,
            chat: chat(`c${i}`, `第${i}个`),
          })
        ).status,
      ).toBe(200);
    }
    const { chats } = (await p.send("GET", `/api/me/chats?project=${project.id}`)).json;
    expect(chats).toHaveLength(CHATS_PER_PROJECT);
    expect(chats.some((each: { summary: { id: string } }) => each.summary.id === "c0")).toBe(false);
    expect((await p.send("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
    expect(
      await t.db
        .select()
        .from(userChats)
        .where(and(eq(userChats.userId, w.userId))),
    ).toEqual([]);
  });

  test("the list stays small: a large field of a summary goes with the rest of the conversation", async () => {
    // Review CM5, F4.
    const project = await newProject(w);
    const large = { ...chat("c1", "x"), asking: "y".repeat(3_500_000) };
    expect((await put(project.id, { base: null, chat: large })).status).toBe(200);
    const list = await p.send("GET", `/api/me/chats?project=${project.id}`);
    expect(JSON.stringify(list.json).length).toBeLessThan(100_000);
    expect(list.json.chats[0].summary).toEqual({
      id: "c1",
      title: "x",
      updatedAt: time,
    });
    // Reading it gives all of it.
    expect((await p.send("GET", `/api/me/chats/${project.id}/c1`)).json.chat.asking).toHaveLength(
      3_500_000,
    );
  });

  test("the list says what the editor keeps for it: the model by its name, how much AI changed", async () => {
    const project = await newProject(w);
    const kept = {
      ...chat("c1", "开场放慢"),
      changes: 3,
      asking: true,
      modelName: "Claude Fable 5",
    };
    expect((await put(project.id, { base: null, chat: kept })).status).toBe(200);
    const list = await p.send("GET", `/api/me/chats?project=${project.id}`);
    expect(list.json.chats[0].summary).toEqual({
      id: "c1",
      title: "开场放慢",
      updatedAt: time,
      changes: 3,
      asking: true,
      modelName: "Claude Fable 5",
    });
    // The model it uses goes with the rest of the conversation, as before.
    const read = (await p.send("GET", `/api/me/chats/${project.id}/c1`)).json.chat;
    expect(read.model).toEqual({ service: "s1", model: "m" });
    expect(read.modelName).toBe("Claude Fable 5");
  });

  test("all of a person's together, so much at most", async () => {
    const project = await newProject(w);
    await t.db.insert(userChats).values({
      userId: w.userId,
      projectId: project.id,
      chatId: "huge",
      revision: 1,
      summary: { id: "huge", title: "x", updatedAt: time },
      body: {},
      size: CHAT_BYTES_PER_USER - 100,
      updatedAt: new Date(time - 1000),
    });
    expect((await put(project.id, { base: null, chat: chat("c1", "x") })).status).toBe(413);
    // Without that limit, it goes.
    const open = await platform(w, { hub, now: () => time });
    expect((await put(project.id, { base: null, chat: chat("c1", "x") }, open)).status).toBe(200);
  });

  test("not what it should be, or too large", async () => {
    const project = await newProject(w);
    expect((await put(project.id, { base: "1", chat: chat("c1", "x") })).status).toBe(400);
    expect(
      (
        await p.send("PUT", `/api/me/chats/${project.id}/c1`, {
          payload: JSON.stringify({ base: null, chat: chat("other", "x") }),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(400);
    const large = {
      ...chat("c1", "x"),
      entries: [{ text: "x".repeat(4 * 1024 * 1024) }],
    };
    expect((await put(project.id, { base: null, chat: large })).status).toBe(413);
    expect(
      (
        await p.send("PUT", `/api/me/chats/${project.id}/c1`, {
          payload: JSON.stringify({ base: null, chat: chat("c1", "x") }),
          headers: { "content-type": "application/json" },
          fromHere: false,
        })
      ).status,
    ).toBe(403);
  });
});
