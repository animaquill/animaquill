import {
  accountAgents,
  type AgentRoom,
  type AgentRoomEvents,
  type PersonEventsAccess,
  type PostedMail,
} from "@animaquill/host/agents-account";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { newProject, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { SyncHub } from "../sync/hub.ts";
import { listenForAgents } from "./agents.ts";
import { PersonEvents } from "./events.ts";

/**
 * The editor's side of what the conversations of a project say to each other online
 * (agents-account.ts of the host) against the server's (me/agents.ts), as two windows of one person
 * have it, with what the server says at once going to them over the person's stream: one has a
 * conversation and the other waits; a message for it goes to the one that has it, once; what came of
 * it goes back to the sender; the one that waits has it once the other lets go of it or its page
 * goes, with the messages that one had not read; the count of turns nobody was there for is of both.
 * On a real PostgreSQL. Needs AQ_TEST_DATABASE.
 */

const until = async (what: () => boolean, label: string, ms = 5000) => {
  for (const started = Date.now(); !what();) {
    if (Date.now() - started > ms) throw new Error(`no ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** What a window was told, as it was told. */
class Told implements AgentRoomEvents {
  readonly said: string[] = [];
  readonly owned = (id: string, waited: boolean) => void this.said.push(`owned ${id} ${waited}`);
  readonly mail = (to: string) => void this.said.push(`mail ${to}`);
  readonly budget = () => void this.said.push("budget");
  readonly queued = (id: string) => void this.said.push(`queued ${id}`);
  readonly wanted = (id: string, take: boolean) => void this.said.push(`wanted ${id} ${take}`);
  readonly gone = (id: string) => void this.said.push(`gone ${id}`);
  readonly resumed = () => void this.said.push("resumed");
  has(what: string) {
    return this.said.includes(what);
  }
}

describe.skipIf(!TEST_DATABASE)("the windows of a person, online, through the server", () => {
  let t: TestDatabase;
  let w: World;
  let p: Platform;
  let hub: SyncHub;
  let events: PersonEvents;
  let listening: ReturnType<typeof listenForAgents>;
  const rooms: AgentRoom[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    hub = new SyncHub({ db: t.db, log: quiet });
    events = new PersonEvents();
    p = await platform(w, { hub, events });
    listening = listenForAgents(t.db, events, quiet);
    await listening.ready;
  });
  afterEach(async () => {
    for (const room of rooms.splice(0)) room.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await listening.stop();
    hub.stop();
  });

  /** The page's requests, as they go to the server. */
  const fetchOf =
    (q: Platform): typeof fetch =>
    async (input, init) => {
      const url = new URL(String(input), "https://editor.example.com");
      const method = (init?.method ?? "GET") as "GET" | "POST" | "PUT";
      const answer = await q.send(method, `${url.pathname}${url.search}`, {
        ...(typeof init?.body === "string" && {
          payload: init.body,
          headers: { "content-type": "application/json" },
        }),
      });
      return new Response(answer.status === 204 ? null : JSON.stringify(answer.json ?? null), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    };

  /** The person's stream, as a page hears it. */
  const streamOf = (userId: string): PersonEventsAccess => ({
    watch(_changed, live, agents) {
      const stop = events.add(
        userId,
        () => {},
        () => {},
        (data) => agents?.(JSON.parse(data)),
      );
      queueMicrotask(() => live?.(true));
      return () => stop?.();
    },
  });

  /** A window of the person with the project open; and how its page goes and comes back. */
  const windowOf = (project: string) => {
    const told = new Told();
    let hide = () => {};
    let show = () => {};
    const post = accountAgents({
      api: (path) => `/api${path}`,
      fetch: fetchOf(p),
      events: streamOf(w.userId),
      projectOf: async (key) => (key === "here" ? project : undefined),
      listenPageHide: (listener) => {
        hide = listener;
        return () => {};
      },
      listenPageShow: (listener) => {
        show = listener;
        return () => {};
      },
    });
    expect(post.reach).toBe("account");
    const room = post.enter("here", told);
    rooms.push(room);
    return { room, told, hide: () => hide(), show: () => show() };
  };

  const mail = (to: string, text: string): PostedMail => {
    const id = `m-${Math.random().toString(36).slice(2)}`;
    const at = Date.now();
    return {
      id,
      to,
      from: "chat-a",
      text,
      at,
      left: false,
      body: { id, from: { id: "chat-a", name: "A", kind: "chat" }, text, at },
    };
  };

  test("one has it, the other waits; a message goes to the one that has it, once, and what came of it back", async () => {
    const project = await newProject(w);
    const a = windowOf(project.id);
    const b = windowOf(project.id);
    a.room.serve(["chat-b"]);
    await until(() => a.told.has("owned chat-b false"), "A has it");
    expect(a.room.owns("chat-b")).toBe(true);
    b.room.serve(["chat-b"]);
    await until(() => b.told.has("queued chat-b"), "B waits");
    expect(b.room.owns("chat-b")).toBe(false);
    expect(await b.room.held("chat-b")).toBe(true);
    // B sends: A hears at once, takes it; B takes none, and hears what came of it.
    const sent = mail("chat-b", "配乐还会换吗？");
    const answer = b.room.outcome(sent.id, 3000);
    expect(await b.room.post(sent, { most: 50, repeatMs: 60_000 })).toBe("posted");
    expect(await b.room.post({ ...sent, id: "m-again" }, { most: 50, repeatMs: 60_000 })).toBe(
      "repeat",
    );
    await until(() => a.told.has("mail chat-b"), "A told of it");
    const [taken, none] = await Promise.all([a.room.claim("chat-b"), b.room.claim("chat-b")]);
    expect(taken.map((each) => each.text)).toEqual(["配乐还会换吗？"]);
    expect(none).toEqual([]);
    expect(await a.room.claim("chat-b")).toEqual([]);
    a.room.answer(sent.id, { sent: "turn" });
    expect(await answer).toEqual({ sent: "turn" });
    // What A says of it, B lists; A lists nothing of its own.
    await a.room.publish([
      {
        id: "chat-b",
        card: { kind: "chat", name: "B", state: "idle", changed: [], accepts: "yes" },
      },
    ]);
    const listed = await b.room.roster(true);
    expect(listed).toEqual([]);
    const c = windowOf(project.id);
    expect((await c.room.roster(true)).map(({ id, live }) => [id, live])).toEqual([
      ["chat-b", true],
    ]);
    // B asks for it, A lets go of it for B, and waits for it again after B.
    b.room.want("chat-b", true);
    await until(() => a.told.has("wanted chat-b true"), "A told B wants it");
    expect(b.told.has("wanted chat-b true")).toBe(false);
    a.room.yieldTo("chat-b");
    await until(() => b.told.has("owned chat-b true"), "B has it");
    await until(() => a.told.has("queued chat-b"), "A waits");
    expect(a.room.owns("chat-b")).toBe(false);
    // What A took and did not read waits for B, which has it now.
    await a.room.back(taken.map((each) => each.id));
    const again = await b.room.claim("chat-b");
    expect(again.map((each) => [each.text, each.left])).toEqual([["配乐还会换吗？", true]]);
  });

  test("the page of the one that has it goes: the other has it, with what that one took and did not read; what it read goes", async () => {
    const project = await newProject(w);
    const a = windowOf(project.id);
    const b = windowOf(project.id);
    a.room.serve(["chat-b"]);
    await until(() => a.told.has("owned chat-b false"), "A has it");
    b.room.serve(["chat-b"]);
    await until(() => b.told.has("queued chat-b"), "B waits");
    await b.room.post(mail("chat-b", "读过的"), { most: 50, repeatMs: 0 });
    await b.room.post(mail("chat-b", "没读的"), { most: 50, repeatMs: 0 });
    const taken = await a.room.claim("chat-b");
    expect(taken).toHaveLength(2);
    a.room.read([taken.find((each) => each.text === "读过的")!.id]);
    a.hide();
    await until(() => b.told.has("owned chat-b true"), "B has it");
    const left = await b.room.claim("chat-b");
    expect(left.map((each) => [each.text, each.left])).toEqual([["没读的", true]]);
    // A comes back from the browser's cache: it waits for it again, after B, and is told so.
    a.show();
    expect(a.told.has("resumed")).toBe(true);
    await until(
      () => a.told.said.filter((each) => each === "queued chat-b").length === 1,
      "A waits",
    );
  });

  test("one held right away only where none has it; deleted, the one that has it hears it; the count is of all windows", async () => {
    const project = await newProject(w);
    const a = windowOf(project.id);
    const b = windowOf(project.id);
    expect(await a.room.tryServe("chat-c")).toBe(true);
    await until(() => a.told.has("owned chat-c false"), "A has it");
    expect(await b.room.tryServe("chat-c")).toBe(false);
    b.room.gone("chat-c");
    await until(() => a.told.has("gone chat-c"), "A hears it went");
    expect(b.told.has("gone chat-c")).toBe(false);
    await b.room.watch("chat-c", "chat-a", Date.now() + 1000);
    expect(await a.room.watchers("chat-c")).toEqual([
      { watcher: "chat-a", until: expect.any(Number) },
    ]);
    await b.room.forget("chat-c");
    a.room.budget.add(2);
    await until(() => b.told.has("budget"), "B hears the count");
    expect(b.room.budget.get()).toBe(2);
    expect(a.told.has("budget")).toBe(false);
    b.room.budget.reset();
    await until(() => a.told.has("budget"), "A hears it went back");
    expect(a.room.budget.get()).toBe(0);
  });

  test("a project of this browser not on the platform: nothing is had, nothing sent, nothing breaks", async () => {
    const told = new Told();
    const post = accountAgents({
      api: (path) => `/api${path}`,
      fetch: fetchOf(p),
      events: streamOf(w.userId),
      projectOf: async () => undefined,
      listenPageHide: () => () => {},
      listenPageShow: () => () => {},
    });
    const room = post.enter("folder", told);
    rooms.push(room);
    room.serve(["chat-b"]);
    expect(await room.tryServe("chat-c")).toBe(false);
    await expect(room.post(mail("chat-b", "x"), { most: 50, repeatMs: 0 })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(told.said).toEqual([]);
  });
});
