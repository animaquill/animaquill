import { eq } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { sessions } from "../schema.ts";
import { clock, quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { mergeWorld, type MergeWorld } from "../test/merge-support.ts";
import { platform, type Platform } from "../test/platform-support.ts";
import { listenForPeople, notifyPerson, PersonEvents } from "./events.ts";

/**
 * What changed of a person's list, said to their pages at once (`GET /api/me/events`): through
 * PostgreSQL, from whatever process changes it, to every stream of that person, and nobody else;
 * a stream that says something now and then, ends once its session does, and of which a person has
 * so many at most. On a real PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

/** A stream as a browser reads it: what came, as it comes. */
class Stream {
  readonly text: string[] = [];
  ended = false;
  readonly #controller = new AbortController();
  readonly response: Promise<Response>;
  constructor(url: string, headers: Record<string, string>) {
    this.response = fetch(url, { headers, signal: this.#controller.signal });
    void this.response
      .then(async (response) => {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const read = await reader?.read();
          if (!read || read.done) break;
          this.text.push(decoder.decode(read.value));
        }
      })
      .catch(() => {})
      .finally(() => {
        this.ended = true;
      });
  }
  get said(): string {
    return this.text.join("");
  }
  /** How many times it said that the list changed. */
  get changes(): number {
    return this.said.split(`data: {"t":"projects"}`).length - 1;
  }
  close() {
    this.#controller.abort();
  }
}

const until = async (what: () => boolean, label: string, ms = 5000) => {
  for (const started = Date.now(); !what();) {
    if (Date.now() - started > ms) throw new Error(`no ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe.skipIf(!TEST_DATABASE)("what changed of a person's list, as it changes", () => {
  let t: TestDatabase;
  let w: World;
  let m: MergeWorld;
  let p: Platform;
  let events: PersonEvents;
  let listening: ReturnType<typeof listenForPeople>;
  let address: string;
  const streams: Stream[] = [];
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db, clock(new Date()));
    m = await mergeWorld(w);
    events = new PersonEvents({ perPerson: 3 });
    p = await platform(w, { hub: m.hub, events });
    listening = listenForPeople(t.db, events, quiet, { retryMs: 50 });
    await listening.ready;
    await p.app.listen({ port: 0, host: "127.0.0.1" });
    address = `http://127.0.0.1:${(p.app.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await listening.stop();
    await p.app.close();
  });

  const open = (session = p.sessionId, headers: Record<string, string> = {}) => {
    const stream = new Stream(`${address}/api/me/events`, {
      cookie: `${SESSION_COOKIE}=${session}`,
      "sec-fetch-site": "same-origin",
      ...headers,
    });
    streams.push(stream);
    return stream;
  };
  const ready = (stream: Stream) => until(() => stream.said.includes("event: ready"), "ready");

  test("tells every page of the person once their list changes, and nobody else's", async () => {
    const a = open();
    const b = open();
    const other = await world(t.db, w.time);
    const theirs = await platform(other, { hub: m.hub, events });
    const c = open(theirs.sessionId);
    await Promise.all([a, b, c].map(ready));
    const response = await a.response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(a.said).toMatch(/^retry: \d+\n/);

    // Renamed on the start page of another computer.
    const renamed = await p.request("PUT", `/api/projects/${m.project}/name`, { name: "宣传片" });
    expect(renamed.status).toBe(200);
    await until(() => a.changes === 1 && b.changes === 1, "a change");
    // Organised: a star.
    const starred = await p.request("POST", "/api/organizer", {
      now: Date.now(),
      account: w.userId,
      marks: [{ project: m.project, star: { starred: true, at: Date.now() } }],
    });
    expect(starred.status).toBe(200);
    await until(() => a.changes === 2 && b.changes === 2, "a second change");
    // Renamed in the editor: the list says the new name too.
    await m.window.change({ type: "project.rename", params: { name: "又改了" } });
    await until(() => a.changes === 3, "a third change");
    // Taken away.
    m.window.peer.connection.close();
    await m.hub.idle();
    expect(await m.hub.remove(m.project, w.userId, { discard: true })).toBe("removed");
    await until(() => a.changes === 4, "a fourth change");
    expect(c.changes).toBe(0);
  });

  test("hears what another process says, and tells everyone where it may have missed some", async () => {
    const a = open();
    await ready(a);
    await t.db.transaction(async (tx) => notifyPerson(tx, [w.userId, w.userId]));
    await until(() => a.changes === 1, "a change of another process");
    // What is not committed is never said.
    await t.db
      .transaction(async (tx) => {
        await notifyPerson(tx, [w.userId]);
        throw new Error("rolled back");
      })
      .catch(() => {});
    events.missed();
    await until(() => a.changes === 2, "what was missed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.changes).toBe(2);
  });

  test("so many of a person at once, and only from pages of this site, signed in", async () => {
    const all = [open(), open(), open()];
    await Promise.all(all.map(ready));
    const more = open();
    expect((await more.response).status).toBe(429);
    all[0]!.close();
    await until(() => events.size === 2, "the closed one gone");
    expect((await open().response).status).toBe(200);
    expect((await open(p.sessionId, { "sec-fetch-site": "cross-site" }).response).status).toBe(403);
    expect((await open("not-a-session-0123456789012345678901234567890").response).status).toBe(401);
  });

  test("ends once its session does, after a while in any case, and with the server", async () => {
    await listening.stop();
    await p.app.close();
    events = new PersonEvents({ heartbeatMs: 50, streamMs: 2000 });
    p = await platform(w, { hub: m.hub, events });
    listening = listenForPeople(t.db, events, quiet, { retryMs: 50 });
    await p.app.listen({ port: 0, host: "127.0.0.1" });
    address = `http://127.0.0.1:${(p.app.server.address() as AddressInfo).port}`;
    const a = open();
    await ready(a);
    // Says something now and then.
    await until(() => a.said.includes(": \n\n"), "a heartbeat");
    const lasting = open();
    await ready(lasting);
    await t.db.delete(sessions).where(eq(sessions.userId, w.userId));
    // The next heartbeat finds the session gone.
    await until(() => a.ended && lasting.ended, "the end of a signed-out stream");
    expect(events.size).toBe(0);
    expect((await open().response).status).toBe(401);
  });

  test("ends after a while, and as the server stops", async () => {
    await listening.stop();
    await p.app.close();
    events = new PersonEvents({ streamMs: 300 });
    p = await platform(w, { hub: m.hub, events });
    listening = listenForPeople(t.db, events, quiet, { retryMs: 50 });
    await p.app.listen({ port: 0, host: "127.0.0.1" });
    address = `http://127.0.0.1:${(p.app.server.address() as AddressInfo).port}`;
    const a = open();
    await ready(a);
    await until(() => a.ended, "the end of a long stream");
    const b = open();
    await ready(b);
    const closing = p.app.close();
    await until(() => b.ended, "the end as the server stops");
    await closing;
  });
});
