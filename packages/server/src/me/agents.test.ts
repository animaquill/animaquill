import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { ANYONE } from "../access.ts";
import { agentCards, agentHolds, agentMail, agentWatches, agentWindows } from "../schema.ts";
import { newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { SyncHub } from "../sync/hub.ts";
import {
  AWAY_MS,
  cleanUpAgents,
  listenForAgents,
  MAIL_MS,
  MOST_WAITING,
  MOST_MAIL_PER_PERSON,
  MOST_TARGETS,
  MOST_WINDOWS,
  postMail,
  REPEAT_MS,
  SENDS_PER_MINUTE,
  WINDOW_MS,
} from "./agents.ts";
import { PersonEvents } from "./events.ts";

/**
 * What the conversations of a person's project, in their windows anywhere, say to each other
 * (me/agents.ts): one window at a time has one, the others wait in turn and have it once it goes;
 * a message is taken by one window only, also when two ask at once, and comes back where that
 * window goes; nothing of one person is ever another's, also where they may read the same project;
 * limits; what lasts a while only goes. On a real PostgreSQL. Needs AQ_TEST_DATABASE.
 */

describe.skipIf(!TEST_DATABASE)("what the conversations of a project say to each other", () => {
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

  /** A request as a page sends it; what it says, also where that is nothing. */
  const ask = (q: Platform, method: "GET" | "POST" | "PUT", url: string, body?: unknown) =>
    q.send(method, url, {
      ...(body !== undefined && {
        payload: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    });
  const at = (project: string, path: string) => `/api/me/projects/${project}/agents${path}`;
  const serve = (
    project: string,
    window: string,
    ids: readonly string[],
    cards?: readonly { id: string; card: unknown }[],
    q = p,
  ) => ask(q, "PUT", at(project, `/windows/${window}`), { serve: ids, ...(cards && { cards }) });
  const mail = (to: string, text: string, id = `m-${Math.random().toString(36).slice(2)}`) => ({
    mail: {
      id,
      to,
      from: "chat-a",
      text,
      at: time,
      left: false,
      body: { id, from: { id: "chat-a", name: "A", kind: "chat" }, text, at: time },
    },
    most: MOST_WAITING,
    repeatMs: REPEAT_MS,
  });
  const post = (project: string, body: unknown, q = p) =>
    ask(q, "POST", at(project, "/mail"), body);
  const claim = (project: string, window: string, agent: string, q = p) =>
    ask(q, "POST", at(project, `/windows/${window}/claim`), { agent });
  const card = (state: string, name = "B") => ({
    kind: "chat",
    name,
    state,
    changed: [],
    accepts: "yes",
  });

  test("one window has one; another waits, and has it once the first goes, with what that one took and did not read", async () => {
    const project = await newProject(w);
    const first = await serve(
      project.id,
      "w-1",
      ["chat-b"],
      [{ id: "chat-b", card: card("idle") }],
    );
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ owned: ["chat-b"], waits: [], mail: [] });
    const second = await serve(project.id, "w-2", ["chat-b"]);
    expect(second.json).toMatchObject({ owned: [], waits: ["chat-b"] });
    // Two messages: the first window is told there are some, and takes them, once.
    expect((await post(project.id, mail("chat-b", "配乐还会换吗？"))).json).toEqual({
      result: "posted",
    });
    expect((await post(project.id, mail("chat-b", "开场的配乐呢？"))).json).toEqual({
      result: "posted",
    });
    expect((await serve(project.id, "w-1", ["chat-b"])).json.mail).toEqual(["chat-b"]);
    // The one that waits takes none: it does not have it.
    expect((await claim(project.id, "w-2", "chat-b")).json).toEqual({ mail: [] });
    const [taken, again] = await Promise.all([
      claim(project.id, "w-1", "chat-b"),
      claim(project.id, "w-1", "chat-b"),
    ]);
    const all = [...taken.json.mail, ...again.json.mail];
    expect(all.map((each: { text: string }) => each.text).toSorted()).toEqual(
      ["开场的配乐呢？", "配乐还会换吗？"].toSorted(),
    );
    expect(all[0]).toMatchObject({ to: "chat-b", from: "chat-a", left: false });
    // It read the first, then went: that one goes, the other waits for whoever has it next, left.
    const read = all.find((each: { text: string }) => each.text === "配乐还会换吗？").id;
    expect(
      (
        await ask(p, "POST", at(project.id, "/windows/w-1/leave"), {
          read: [read],
          keepCards: true,
        })
      ).status,
    ).toBe(204);
    const next = await serve(project.id, "w-2", ["chat-b"]);
    expect(next.json).toMatchObject({ owned: ["chat-b"], waits: [], mail: ["chat-b"] });
    const later = await claim(project.id, "w-2", "chat-b");
    expect(
      later.json.mail.map((each: { text: string; left: boolean }) => [each.text, each.left]),
    ).toEqual([["开场的配乐呢？", true]]);
    // What the first said of it stays, as one whose window went, until the second says it.
    const roster = await ask(p, "GET", at(project.id, ""));
    expect(roster.json.agents).toEqual([
      { id: "chat-b", card: card("idle"), live: true, at: time },
    ]);
  });

  test("a window that stops saying it is there is gone after a while: another has what it had, and the messages it took", async () => {
    const project = await newProject(w);
    await serve(project.id, "w-1", ["chat-b"]);
    await post(project.id, mail("chat-b", "还在吗"));
    expect((await claim(project.id, "w-1", "chat-b")).json.mail).toHaveLength(1);
    expect((await serve(project.id, "w-2", ["chat-b"])).json.waits).toEqual(["chat-b"]);
    time += WINDOW_MS - 1000;
    // The second says it is there; the first does not.
    expect((await serve(project.id, "w-2", ["chat-b"])).json.waits).toEqual(["chat-b"]);
    time += 2000;
    const now = await serve(project.id, "w-2", ["chat-b"]);
    expect(now.json).toMatchObject({ owned: ["chat-b"], mail: ["chat-b"] });
    expect(
      (await claim(project.id, "w-2", "chat-b")).json.mail.map((m: { text: string }) => m.text),
    ).toEqual(["还在吗"]);
    // Nor does the first take them back: it is not there.
    expect((await claim(project.id, "w-1", "chat-b")).json.mail).toEqual([]);
  });

  test("one held right away only where nobody has it; let go of for the one that waits, which waits again after it", async () => {
    const project = await newProject(w);
    const hold = (window: string, agent: string) =>
      ask(p, "POST", at(project.id, `/windows/${window}/hold`), { agent });
    const give = (window: string, agent: string) =>
      ask(p, "POST", at(project.id, `/windows/${window}/yield`), { agent });
    expect((await hold("w-1", "chat-b")).json).toEqual({ owned: true });
    expect((await hold("w-2", "chat-b")).json).toEqual({ owned: false });
    // Nobody waits: it stays.
    expect((await give("w-1", "chat-b")).json).toEqual({ owned: true });
    expect((await serve(project.id, "w-2", ["chat-b"])).json.waits).toEqual(["chat-b"]);
    expect((await give("w-1", "chat-b")).json).toEqual({ owned: false });
    expect((await serve(project.id, "w-2", ["chat-b"])).json.owned).toEqual(["chat-b"]);
    expect((await serve(project.id, "w-1", ["chat-b"])).json.waits).toEqual(["chat-b"]);
    // Asked about by anyone: which are had.
    expect((await ask(p, "GET", at(project.id, ""))).json.held).toEqual(["chat-b"]);
    // The second lets go of it: the first has it again.
    await serve(project.id, "w-2", []);
    expect((await serve(project.id, "w-1", ["chat-b"])).json.owned).toEqual(["chat-b"]);
  });

  test("the same words from the same one go once within the while; 50 wait for one at most; a message the size of the tools", async () => {
    const project = await newProject(w);
    expect((await post(project.id, mail("chat-b", "同一句"))).json.result).toBe("posted");
    expect((await post(project.id, mail("chat-b", "同一句"))).json.result).toBe("repeat");
    time += REPEAT_MS + 1;
    expect((await post(project.id, mail("chat-b", "同一句"))).json.result).toBe("posted");
    // The same message again (sent again, as the network broke) is posted once.
    const once = mail("chat-b", "只一次", "m-once");
    expect((await post(project.id, once)).json.result).toBe("posted");
    expect((await post(project.id, once)).json.result).toBe("posted");
    for (let index = 3; index < MOST_WAITING; index++) {
      time += 1000;
      expect((await post(project.id, mail("chat-b", `第 ${index} 句`))).json.result).toBe("posted");
    }
    time += 1000;
    expect((await post(project.id, mail("chat-b", "第 51 句"))).json.result).toBe("full");
    // Of another, which has room.
    expect((await post(project.id, mail("chat-c", "给 C"))).json.result).toBe("posted");
    expect((await post(project.id, mail("chat-c", "x".repeat(4001)))).status).toBe(413);
    // What the sender asks for is never more than the server takes.
    const many = { ...mail("chat-d", "多"), most: 10_000, repeatMs: 10 * 60_000 };
    expect((await post(project.id, many)).json.result).toBe("posted");
    const rows = await t.db
      .select({ to: agentMail.toAgent })
      .from(agentMail)
      .where(eq(agentMail.projectId, project.id));
    expect(rows.filter((row) => row.to === "chat-b")).toHaveLength(MOST_WAITING);
  });

  test("a person sends so many a minute at most; has so many windows of a project; cards of a size", async () => {
    const project = await newProject(w);
    for (let index = 0; index < SENDS_PER_MINUTE; index++)
      expect((await post(project.id, mail(`chat-${index % 40}`, `第 ${index} 句`))).status).toBe(
        200,
      );
    const over = await post(project.id, mail("chat-x", "多一句"));
    expect(over.status).toBe(429);
    expect(over.headers["retry-after"]).toBeDefined();
    time += 60_001;
    expect((await post(project.id, mail("chat-x", "多一句"))).status).toBe(200);
    for (let index = 0; index < MOST_WINDOWS; index++)
      expect((await serve(project.id, `w-${index}`, [])).status).toBe(200);
    expect((await serve(project.id, "w-more", [])).status).toBe(429);
    // Once one went, another is there in its place.
    await ask(p, "POST", at(project.id, "/windows/w-0/leave"), {});
    expect((await serve(project.id, "w-more", [])).status).toBe(200);
    const large = { ...card("idle"), name: "x".repeat(5000) };
    expect(
      (await serve(project.id, "w-more", ["chat-b"], [{ id: "chat-b", card: large }])).status,
    ).toBe(413);
    expect((await serve(project.id, "w-1", ["a b"])).status).toBe(400);
    expect((await serve(project.id, "bad window!", [])).status).toBe(400);
  });

  test("of someone else's project nothing is there; where others may read it, what each says of their conversations stays their own", async () => {
    const project = await newProject(w);
    await serve(
      project.id,
      "w-1",
      ["chat-b"],
      [{ id: "chat-b", card: card("running", "我的对话") }],
    );
    await post(project.id, mail("chat-b", "私事"));
    await ask(p, "POST", at(project.id, "/watch"), {
      target: "chat-b",
      watcher: "chat-a",
      until: time + 1000,
    });
    const someone = await world(t.db);
    const other = await platform(someone, { hub, now: () => time });
    const routes = [
      () => serve(project.id, "w-9", ["chat-b"], undefined, other),
      () => ask(other, "GET", at(project.id, "")),
      () => post(project.id, mail("chat-b", "冒充"), other),
      () => claim(project.id, "w-1", "chat-b", other),
      () => ask(other, "POST", at(project.id, "/windows/w-1/leave"), {}),
      () => ask(other, "POST", at(project.id, "/windows/w-1/hold"), { agent: "chat-b" }),
      () => ask(other, "POST", at(project.id, "/windows/w-1/yield"), { agent: "chat-b" }),
      () => ask(other, "POST", at(project.id, "/windows/w-1/done"), { ids: ["x"] }),
      () => ask(other, "POST", at(project.id, "/windows/w-1/back"), { ids: ["x"] }),
      () =>
        ask(other, "POST", at(project.id, "/signal"), {
          window: "w-1",
          kind: "gone",
          id: "chat-b",
        }),
      () =>
        ask(other, "POST", at(project.id, "/watch"), {
          target: "chat-b",
          watcher: "x",
          until: time,
        }),
      () => ask(other, "POST", at(project.id, "/watchers"), { target: "chat-b" }),
      () => ask(other, "POST", at(project.id, "/forget"), { agent: "chat-b" }),
      () => ask(other, "POST", at(project.id, "/budget"), { add: 1 }),
    ];
    for (const route of routes) expect((await route()).json).toEqual({ error: "notFound" });
    // Where anyone may read the project: they get in, and find only their own.
    const open = await platform(someone, { hub, now: () => time, access: ANYONE });
    expect((await ask(open, "GET", at(project.id, ""))).json).toEqual({ agents: [], held: [] });
    // The same id and window as the owner's: of their own, and the owner's are as they were.
    expect((await serve(project.id, "w-1", ["chat-b"], undefined, open)).json).toMatchObject({
      owned: ["chat-b"],
      mail: [],
    });
    expect((await claim(project.id, "w-1", "chat-b", open)).json.mail).toEqual([]);
    await ask(open, "POST", at(project.id, "/windows/w-1/done"), { ids: [] });
    await ask(open, "POST", at(project.id, "/forget"), { agent: "chat-b" });
    expect(
      (await ask(open, "POST", at(project.id, "/watchers"), { target: "chat-b" })).json,
    ).toEqual({
      watchers: [],
    });
    await ask(open, "POST", at(project.id, "/windows/w-1/leave"), {});
    expect((await post(project.id, mail("chat-b", "给自己的"), open)).json.result).toBe("posted");
    // The owner's: all there.
    expect((await serve(project.id, "w-1", ["chat-b"])).json).toMatchObject({
      owned: ["chat-b"],
      mail: ["chat-b"],
    });
    expect(
      (await claim(project.id, "w-1", "chat-b")).json.mail.map((m: { text: string }) => m.text),
    ).toEqual(["私事"]);
    expect((await ask(p, "GET", at(project.id, ""))).json.agents[0].card.name).toBe("我的对话");
    expect((await ask(p, "POST", at(project.id, "/watchers"), { target: "chat-b" })).json).toEqual({
      watchers: [{ watcher: "chat-a", until: time + 1000 }],
    });
    // And each row has its person.
    const owners = await t.db
      .select({ user: agentMail.userId, text: agentMail.text })
      .from(agentMail)
      .where(eq(agentMail.projectId, project.id));
    expect(owners).toEqual(
      expect.arrayContaining([
        { user: w.userId, text: "私事" },
        { user: someone.userId, text: "给自己的" },
      ]),
    );
  });

  test("what is said goes to the person's own pages, of the project, and nobody else's", async () => {
    const project = await newProject(w);
    const events = new PersonEvents();
    const heard: string[] = [];
    const others: string[] = [];
    const someone = await world(t.db);
    events.add(
      w.userId,
      () => {},
      () => {},
      (data) => heard.push(data),
    );
    events.add(
      someone.userId,
      () => {},
      () => {},
      (data) => others.push(data),
    );
    const listening = listenForAgents(t.db, events, quiet);
    try {
      await listening.ready;
      // What it says as it begins to listen.
      await new Promise((resolve) => setTimeout(resolve, 50));
      heard.length = 0;
      others.length = 0;
      await postMail(
        t.db,
        { userId: w.userId, project: project.id },
        {
          id: "m-1",
          to: "chat-b",
          from: "chat-a",
          text: "你好",
          at: time,
          left: false,
          body: {},
          most: 50,
          repeatMs: 0,
        },
        new Date(time),
      );
      await ask(p, "POST", at(project.id, "/signal"), {
        window: "w-1",
        kind: "want",
        id: "chat-b",
        take: true,
      });
      for (let tries = 0; heard.length < 2 && tries < 200; tries++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(heard.map((each) => JSON.parse(each))).toEqual([
        { p: project.id, k: "mail", to: "chat-b" },
        { p: project.id, k: "want", w: "w-1", id: "chat-b", take: true },
      ]);
      expect(others).toEqual([]);
      // Missed: every page asks again.
      events.agentsMissed();
      expect(JSON.parse(heard.at(-1) ?? "")).toEqual({ k: "missed" });
    } finally {
      await listening.stop();
    }
  });

  test("signals of a size and a kind only; answers of a size", async () => {
    const project = await newProject(w);
    const signal = (body: unknown) => ask(p, "POST", at(project.id, "/signal"), body);
    expect(
      (await signal({ window: "w-1", kind: "answer", mail: "m-1", outcome: { sent: "turn" } }))
        .status,
    ).toBe(204);
    expect(
      (await signal({ window: "w-1", kind: "answer", mail: "m-1", outcome: "x".repeat(2000) }))
        .status,
    ).toBe(400);
    expect((await signal({ window: "w-1", kind: "owned", id: "chat-b" })).status).toBe(400);
    expect((await signal({ kind: "gone", id: "chat-b" })).status).toBe(400);
    expect((await signal({ window: "w-1", kind: "want", id: "chat-b" })).status).toBe(400);
  });

  test("who waits to be told; one deleted takes all of it along; the count of turns nobody was there for", async () => {
    const project = await newProject(w);
    const watch = (watcher: string, until: number) =>
      ask(p, "POST", at(project.id, "/watch"), { target: "chat-b", watcher, until });
    await watch("chat-a", time + 1000);
    // Not beyond 12 hours, whatever is asked.
    await watch("chat-c", time + 10 * AWAY_MS);
    const taken = await ask(p, "POST", at(project.id, "/watchers"), { target: "chat-b" });
    expect(taken.json.watchers).toEqual(
      expect.arrayContaining([
        { watcher: "chat-a", until: time + 1000 },
        { watcher: "chat-c", until: time + AWAY_MS },
      ]),
    );
    expect(
      (await ask(p, "POST", at(project.id, "/watchers"), { target: "chat-b" })).json.watchers,
    ).toEqual([]);
    for (let index = 0; index < 60; index++) await watch(`chat-${index}`, time + 1000 + index);
    expect(
      await t.db.select().from(agentWatches).where(eq(agentWatches.projectId, project.id)),
    ).toHaveLength(50);

    await serve(project.id, "w-1", ["chat-b"], [{ id: "chat-b", card: card("idle") }]);
    await post(project.id, mail("chat-b", "删前"));
    await watch("chat-a", time + 1000);
    await ask(p, "POST", at(project.id, "/forget"), { agent: "chat-b" });
    expect(await t.db.select().from(agentMail).where(eq(agentMail.projectId, project.id))).toEqual(
      [],
    );
    expect(
      await t.db.select().from(agentCards).where(eq(agentCards.projectId, project.id)),
    ).toEqual([]);
    expect(
      await t.db.select().from(agentWatches).where(eq(agentWatches.projectId, project.id)),
    ).toEqual([]);

    const budget = (body: unknown) => ask(p, "POST", at(project.id, "/budget"), body);
    expect((await budget({ add: 3 })).json).toEqual({ count: 3, at: time });
    time += 1000;
    expect((await budget({ add: 2 })).json).toEqual({ count: 5, at: time });
    expect((await serve(project.id, "w-1", [])).json.budget).toEqual({ count: 5, at: time });
    expect((await budget({ reset: true })).json.count).toBe(0);
    await budget({ add: 4 });
    time += AWAY_MS + 1;
    expect((await budget({ add: 1 })).json.count).toBe(1);
    expect((await budget({ add: 0 })).status).toBe(400);
    expect((await budget({ add: 1000 })).status).toBe(400);
  });

  test("what lasts a while only goes after it: windows, messages of a week, watches, cards of 12 hours", async () => {
    const project = await newProject(w);
    await serve(project.id, "w-1", ["chat-b"], [{ id: "chat-b", card: card("idle") }]);
    await post(project.id, mail("chat-b", "一周"));
    await ask(p, "POST", at(project.id, "/watch"), {
      target: "chat-b",
      watcher: "chat-a",
      until: time + 1000,
    });
    const of = (table: typeof agentWindows | typeof agentMail | typeof agentHolds) =>
      t.db.select({ project: table.projectId }).from(table).where(eq(table.projectId, project.id));
    // Nothing yet.
    await cleanUpAgents(t.db, new Date(time));
    expect(await of(agentWindows)).toHaveLength(1);
    expect(await of(agentMail)).toHaveLength(1);
    // The window, an hour after it went, and what it had; the watch past its time.
    const done = await cleanUpAgents(t.db, new Date(time + 2 * WINDOW_MS + 1000));
    expect(done.windows).toBeGreaterThanOrEqual(1);
    expect(await of(agentWindows)).toEqual([]);
    expect(await of(agentHolds)).toEqual([]);
    expect(
      await t.db.select().from(agentWatches).where(eq(agentWatches.projectId, project.id)),
    ).toEqual([]);
    expect(await of(agentMail)).toHaveLength(1);
    expect(
      await t.db.select().from(agentCards).where(eq(agentCards.projectId, project.id)),
    ).toHaveLength(1);
    // The card of one whose window went, after 12 hours; the message after its week.
    await cleanUpAgents(t.db, new Date(time + AWAY_MS + 1));
    expect(
      await t.db.select().from(agentCards).where(eq(agentCards.projectId, project.id)),
    ).toEqual([]);
    expect(await of(agentMail)).toHaveLength(1);
    await cleanUpAgents(t.db, new Date(time + MAIL_MS));
    expect(await of(agentMail)).toEqual([]);
    // And a message past its week is taken by nobody, before that.
    await serve(project.id, "w-2", ["chat-c"]);
    await post(project.id, mail("chat-c", "旧的"));
    time += MAIL_MS;
    await serve(project.id, "w-2", ["chat-c"]);
    expect((await claim(project.id, "w-2", "chat-c")).json.mail).toEqual([]);
    expect(
      await t.db
        .select()
        .from(agentMail)
        .where(and(eq(agentMail.projectId, project.id), eq(agentMail.toAgent, "chat-c"))),
    ).toEqual([]);
  });

  test("a card that cannot be kept is refused alone: the rest of what the window said is kept, and the window stays", async () => {
    const project = await newProject(w);
    // The database refuses this one only, as it would a card it cannot hold.
    await t.db.execute(
      sql`alter table ${agentCards} add constraint agent_cards_test_refuse check (agent_id <> 'chat-bad')`,
    );
    try {
      const said = await serve(
        project.id,
        "w-1",
        ["chat-a", "chat-bad", "chat-b"],
        [
          { id: "chat-a", card: card("idle") },
          { id: "chat-bad", card: card("idle") },
          { id: "chat-b", card: card("idle") },
        ],
      );
      expect(said.status).toBe(200);
      expect(said.json.refused).toEqual(["chat-bad"]);
      expect(said.json.owned).toEqual(["chat-a", "chat-bad", "chat-b"]);
      const kept = await t.db
        .select({ agent: agentCards.agentId })
        .from(agentCards)
        .where(eq(agentCards.projectId, project.id));
      expect(kept.map((row) => row.agent).toSorted()).toEqual(["chat-a", "chat-b"]);
    } finally {
      await t.db.execute(sql`alter table ${agentCards} drop constraint agent_cards_test_refuse`);
    }
  });

  test("NUL and halves of an emoji in what is sent: kept without them, nothing refused, the window stays", async () => {
    const project = await newProject(w);
    const named = { ...card("idle"), name: "a\u0000b\ud83d", changed: ["x\u0000"] };
    const said = await serve(project.id, "w-1", ["chat-b"], [{ id: "chat-b", card: named }]);
    expect(said.status).toBe(200);
    expect(said.json.refused).toBeUndefined();
    // Said again as the window does: also now.
    expect(
      (await serve(project.id, "w-1", ["chat-b"], [{ id: "chat-b", card: named }])).json.owned,
    ).toEqual(["chat-b"]);
    const roster = await ask(p, "GET", at(project.id, ""));
    expect(roster.json.agents[0].card).toMatchObject({ name: "ab\ufffd", changed: ["x"] });
    const text = "开场\u0000的配乐\ud83d";
    const sent = await post(project.id, {
      ...mail("chat-b", text),
      mail: { ...mail("chat-b", text).mail, body: { text, from: { name: "A\u0000" } } },
    });
    expect(sent.json).toEqual({ result: "posted" });
    const [taken] = (await claim(project.id, "w-1", "chat-b")).json.mail;
    expect(taken.text).toBe("开场的配乐\ufffd");
    expect(taken.body).toMatchObject({ text: "开场的配乐\ufffd", from: { name: "A" } });
    const signal = await ask(p, "POST", at(project.id, "/signal"), {
      window: "w-1",
      kind: "answer",
      mail: "m-1",
      outcome: { said: "\u0000\udc00" },
    });
    expect(signal.status).toBe(204);
  });

  test("a leave of before the page came back, that comes late, does nothing; nor one of a window that never was", async () => {
    const project = await newProject(w);
    expect((await serve(project.id, "w-1", ["chat-b"])).json.owned).toEqual(["chat-b"]);
    await serve(project.id, "w-2", ["chat-b"]);
    // The page went (as its first time), and came back (its second) before its leave came.
    const back = await ask(p, "PUT", at(project.id, "/windows/w-1"), {
      serve: ["chat-b"],
      again: true,
      generation: 1,
    });
    expect(back.json.owned).toEqual(["chat-b"]);
    const late = await ask(p, "POST", at(project.id, "/windows/w-1/leave"), {
      keepCards: true,
      generation: 0,
    });
    expect(late.status).toBe(204);
    expect((await serve(project.id, "w-1", ["chat-b"])).json.owned).toEqual(["chat-b"]);
    expect((await serve(project.id, "w-2", ["chat-b"])).json.waits).toEqual(["chat-b"]);
    // Its leave of now goes as it should.
    await ask(p, "POST", at(project.id, "/windows/w-1/leave"), { generation: 1 });
    expect((await serve(project.id, "w-2", ["chat-b"])).json.owned).toEqual(["chat-b"]);
    // A leave of no window keeps nothing of it.
    await ask(p, "POST", at(project.id, "/windows/w-none/leave"), {});
    const rows = await t.db
      .select()
      .from(agentWindows)
      .where(and(eq(agentWindows.projectId, project.id), eq(agentWindows.windowId, "w-none")));
    expect(rows).toEqual([]);
  });

  test("what a window took for one goes back as it lets go of it, gives it over, or is taken over: the next takes it at once; what it read goes", async () => {
    const project = await newProject(w);
    const texts = async (window: string) =>
      (await claim(project.id, window, "chat-b")).json.mail.map((m: { text: string }) => m.text);
    // Given over.
    await serve(project.id, "w-1", ["chat-b"]);
    await serve(project.id, "w-2", ["chat-b"]);
    await post(project.id, mail("chat-b", "读过的", "m-read"));
    await post(project.id, mail("chat-b", "没读的", "m-unread"));
    expect(await texts("w-1")).toHaveLength(2);
    expect(
      (
        await ask(p, "POST", at(project.id, "/windows/w-1/yield"), {
          agent: "chat-b",
          read: ["m-read"],
        })
      ).json,
    ).toEqual({ owned: false });
    expect((await serve(project.id, "w-2", ["chat-b"])).json).toMatchObject({
      owned: ["chat-b"],
      mail: ["chat-b"],
    });
    expect(await texts("w-2")).toEqual(["没读的"]);
    // Let go of: the window that waits takes it.
    await ask(p, "POST", at(project.id, "/windows/w-2/leave"), { keepCards: true });
    await serve(project.id, "w-1", ["chat-b"]);
    expect(await texts("w-1")).toEqual(["没读的"]);
    await serve(project.id, "w-3", ["chat-b"]);
    await serve(project.id, "w-1", []);
    expect(await texts("w-3")).toEqual(["没读的"]);
    // Taken over from a window that went quiet: also once that one comes back.
    await serve(project.id, "w-4", ["chat-b"]);
    time += WINDOW_MS + 1000;
    await serve(project.id, "w-4", ["chat-b"]);
    await serve(project.id, "w-3", []);
    expect(await texts("w-4")).toEqual(["没读的"]);
  });

  test("so many waited on in a project at most, the first to end go; so many messages of a person in all at most", async () => {
    const project = await newProject(w);
    for (let index = 0; index <= MOST_TARGETS; index++)
      await ask(p, "POST", at(project.id, "/watch"), {
        target: `chat-${index}`,
        watcher: "chat-a",
        until: time + 1000 + index,
      });
    const targets = await t.db
      .selectDistinct({ target: agentWatches.target })
      .from(agentWatches)
      .where(eq(agentWatches.projectId, project.id));
    expect(targets).toHaveLength(MOST_TARGETS);
    expect(targets.map((row) => row.target)).not.toContain("chat-0");
    // Of another project of the person's, as many as all may have.
    const other = await newProject(w);
    await t.db.execute(sql`
      insert into agent_mail (user_id, project_id, mail_id, to_agent, from_agent, text, body, "left", sent_at, created_at, expires_at)
      select ${w.userId}, ${other.id}, 'm-' || n, 'chat-' || (n % 100), 'chat-a', 'x', '{}'::jsonb, false, 1,
        ${new Date(time)}, ${new Date(time + MAIL_MS)}
      from generate_series(1, ${MOST_MAIL_PER_PERSON}) as n`);
    expect((await post(project.id, mail("chat-b", "再一封"))).json.result).toBe("full");
  });
});
