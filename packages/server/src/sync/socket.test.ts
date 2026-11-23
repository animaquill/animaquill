import type { AddressInfo } from "node:net";
import { ProjectStore } from "@animaquill/core";
import {
  Reassembler,
  SYNC_CLOSE,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  encodeSyncMessage,
  framesOf,
  readSyncServerMessage,
  type SyncServerMessage,
} from "@animaquill/host/sync";
import { createProject } from "@animaquill/schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { someone } from "../test/sync-support.ts";
import { buildApp } from "../app.ts";
import type { Accounts } from "../auth/accounts.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { loadConfig } from "../config.ts";
import { SyncHub } from "./hub.ts";
import { heartbeat, type Pinged } from "./socket.ts";

/**
 * The WebSocket of syncing as browsers reach it: only from the editor's own site, only signed in,
 * and only the protocol. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const ORIGIN = "https://editor.example.com";
const SESSION = "a-session-of-ada-0123456789abcdef";
/** A session that ends a moment after it was looked up, as when its person is disabled then. */
const FLEETING = "a-session-that-ends-as-it-opens-0123";
const quiet = { info() {}, warn() {}, error() {} };

describe.skipIf(!TEST_DATABASE)("the WebSocket of syncing", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  let url: string;
  let hub: SyncHub;
  let userId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    userId = (await someone(database.db)).userId;
    hub = new SyncHub({ db: database.db, log: quiet });
    // Only what the socket asks of accounts: who a session is.
    let fleeting = 0;
    const accounts = {
      session: async (id: string) =>
        id === SESSION || (id === FLEETING && fleeting++ === 0) ? { userId } : undefined,
    } as unknown as Accounts;
    const config = loadConfig({ AQ_VERSION: "test", PUBLIC_ORIGIN: ORIGIN }, () => undefined);
    app = buildApp(
      config,
      {
        checkDatabase: async () => true,
        ready: () => true,
        accounts: () => accounts,
        sync: () => hub,
        db: () => database.db,
      },
      false,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/api/sync`;
  });
  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  /** A WebSocket as a browser opens one, and what came of it. */
  const open = (
    headers: Record<string, string>,
    path = url,
  ): Promise<{
    socket: WebSocket;
    status?: number | undefined;
    closed: Promise<{ code: number }>;
    messages: SyncServerMessage[];
  }> =>
    new Promise((resolve) => {
      const socket = new WebSocket(path, { headers });
      const messages: SyncServerMessage[] = [];
      const closed = new Promise<{ code: number }>((settle) => {
        socket.on("close", (code) => settle({ code }));
      });
      const frames = new Reassembler(SYNC_LIMITS.state);
      socket.on("message", (data) => {
        const whole = frames.take(new Uint8Array(data as Buffer));
        if (whole === "more") return;
        const message = whole && readSyncServerMessage(whole);
        if (message) messages.push(message);
      });
      socket.on("unexpected-response", (_request, response) => {
        resolve({ socket, status: response.statusCode, closed, messages });
        socket.terminate();
      });
      socket.on("open", () => resolve({ socket, closed, messages }));
      socket.on("error", () => {});
    });

  const signedIn = { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${SESSION}` };

  test("is only for the editor's own site", async () => {
    const elsewhere = await open({ origin: "https://example.com", cookie: signedIn.cookie });
    expect(elsewhere.status).toBe(403);
    const none = await open({ cookie: signedIn.cookie });
    expect(none.status).toBe(403);
  });

  test("closes at once for someone who is not signed in, saying so", async () => {
    const nobody = await open({ origin: ORIGIN });
    expect((await nobody.closed).code).toBe(SYNC_CLOSE.signedOut);
    const wrong = await open({
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=not-a-session-of-anyone-at-all`,
    });
    expect((await wrong.closed).code).toBe(SYNC_CLOSE.signedOut);
  });

  test("closes one whose session ended while it opened, which nothing else would close yet", async () => {
    const connection = await open({ origin: ORIGIN, cookie: `${SESSION_COOKIE}=${FLEETING}` });
    expect(connection.status).toBeUndefined();
    expect((await connection.closed).code).toBe(SYNC_CLOSE.signedOut);
  });

  test("is no WebSocket anywhere else", async () => {
    const elsewhere = await open(signedIn, url.replace("/api/sync", "/api/other"));
    expect(elsewhere.status).toBe(404);
  });

  test("syncs for the owner, and lists the project for them", async () => {
    const connection = await open(signedIn);
    const store = ProjectStore.create(createProject({ name: "从网络来" }));
    connection.socket.send(
      encodeSyncMessage({
        t: "hello",
        v: SYNC_PROTOCOL,
        project: "socket-test-project",
        after: 0,
        device: "d1",
        window: "w1",
        editor: "test",
        create: { name: "从网络来", projectId: store.getState().manifest.id },
        payload: store.encodeState(),
      }),
    );
    for (let turn = 0; turn < 500 && connection.messages.length < 2; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(connection.messages).toMatchObject([
      { t: "welcome", head: 1, reset: false },
      { t: "synced", head: 1 },
    ]);
    connection.socket.close();

    const listed = await app.inject({
      url: "/api/projects",
      headers: { cookie: signedIn.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      projects: [{ id: "socket-test-project", name: "从网络来" }],
    });
    const nobody = await app.inject({ url: "/api/projects" });
    expect(nobody.statusCode).toBe(401);
  });

  test("takes a change in parts, and no frame larger than a part", async () => {
    const connection = await open(signedIn);
    const store = ProjectStore.create(createProject({ name: "分开发" }));
    const updates: Uint8Array[] = [];
    store.onLocalUpdate((update) => updates.push(update));
    const send = (message: Parameters<typeof framesOf>[0]) => {
      for (const frame of framesOf(message)) connection.socket.send(frame);
    };
    send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: "socket-parts-project",
      after: 0,
      device: "d1",
      window: "w1",
      editor: "test",
      create: { name: "分开发", projectId: store.getState().manifest.id },
      payload: store.encodeState(),
    });
    store.execute({
      type: "file.write",
      params: { path: "code/large.js", text: "x".repeat(3 * SYNC_LIMITS.part) },
    });
    send({
      t: "push",
      id: 1,
      kind: "user",
      base: 1,
      at: Date.now(),
      window: "w1",
      behind: false,
      payload: updates[0] as Uint8Array,
    });
    for (let turn = 0; turn < 1000 && !connection.messages.some((m) => m.t === "ack"); turn++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(connection.messages.find((message) => message.t === "ack")).toMatchObject({ seq: 2 });
    // One frame as large as the whole change is more than the socket takes.
    connection.socket.send(new Uint8Array(SYNC_LIMITS.part * 2));
    expect((await connection.closed).code).toBe(1009);
  });

  test("takes only binary messages", async () => {
    const connection = await open(signedIn);
    connection.socket.send("hello");
    expect((await connection.closed).code).toBe(SYNC_CLOSE.protocol);
  });
});

describe("the heartbeat of syncing", () => {
  const socket = (bufferedAmount = 0) => ({
    bufferedAmount,
    pings: 0,
    terminated: false,
    ping() {
      this.pings += 1;
    },
    terminate() {
      this.terminated = true;
    },
  });

  test("lets go of what did not answer, unless it still takes in what it was sent", () => {
    const alive = new WeakSet<Pinged>();
    const left = new WeakMap<Pinged, number>();
    const answers = socket();
    const silent = socket();
    const slow = socket(3_000_000);
    const stuck = socket(3_000_000);
    const all = [answers, silent, slow, stuck];
    for (const each of all) alive.add(each);
    heartbeat(all, alive, left);
    expect(all.map((each) => each.pings)).toEqual([1, 1, 1, 1]);
    // Half a minute on: one answered, the slow one took in a megabyte, the stuck one nothing.
    alive.add(answers);
    slow.bufferedAmount = 2_000_000;
    heartbeat(all, alive, left);
    expect(all.map((each) => each.terminated)).toEqual([false, true, false, true]);
    // Once everything is through, the slow one has to answer like any other.
    slow.bufferedAmount = 0;
    heartbeat([answers, slow], alive, left);
    expect(slow.terminated).toBe(true);
  });
});
