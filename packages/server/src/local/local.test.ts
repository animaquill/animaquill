import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { OWNER_ONLY } from "../access.ts";
import { buildApp } from "../app.ts";
import {
  BINDING_HEADER,
  bindingOf,
  bindingSecretOf,
  localCredentials,
} from "../auth/local-credentials.ts";
import { setUpAccounts } from "../auth/setup.ts";
import { sessions, users } from "../schema.ts";
import { hashOf } from "../seal.ts";
import { loadConfig } from "../config.ts";
import type { SyncHub } from "../sync/hub.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { localRoutes } from "./routes.ts";
import { OneTimeTokens, TOKEN_MS } from "./tokens.ts";

/**
 * The backend of `npx animaquill` as a browser and the command line reach it (design O4 of
 * AnimaQuill Cloud, section 7): a token for a session once, the cookie and its key of binding both
 * or nothing, the editor's `Host` only, and the admin routes for the command line only.
 */

const EDITOR = "http://animaquill.localhost:7651";
const HOST = "animaquill.localhost:7651";
const SECRET = bindingSecretOf(randomBytes(32));

describe("the one-time tokens", () => {
  test("work once, for ten minutes, and nothing else does", () => {
    let now = 1000;
    const tokens = new OneTimeTokens(() => now);
    const first = tokens.issue();
    const second = tokens.issue();
    expect(tokens.take(first)).toBe(true);
    expect(tokens.take(first)).toBe(false);
    expect(tokens.take("x".repeat(43))).toBe(false);
    expect(tokens.take(undefined)).toBe(false);
    expect(tokens.take(42)).toBe(false);
    now += TOKEN_MS;
    expect(tokens.take(second)).toBe(false);
  });

  test("say when each is gone: taken, too old, or made way for a newer one", () => {
    let now = 1000;
    const tokens = new OneTimeTokens(() => now);
    const gone: string[] = [];
    const taken = tokens.issue(() => gone.push("taken"));
    tokens.issue(() => gone.push("old"));
    expect(tokens.take("x".repeat(43))).toBe(false);
    expect(gone).toEqual([]);
    tokens.take(taken);
    expect(gone).toEqual(["taken"]);
    now += TOKEN_MS;
    tokens.issue();
    expect(gone).toEqual(["taken", "old"]);
    const crowd = new OneTimeTokens();
    crowd.issue(() => gone.push("first"));
    for (let index = 0; index < 32; index++) crowd.issue();
    expect(gone).toEqual(["taken", "old", "first"]);
  });

  test("keep 32 waiting at the most, the oldest going first", () => {
    const tokens = new OneTimeTokens();
    const all = Array.from({ length: 33 }, () => tokens.issue());
    expect(tokens.take(all[0])).toBe(false);
    expect(tokens.take(all[1])).toBe(true);
    expect(tokens.take(all[32])).toBe(true);
  });
});

describe("the credentials of this machine", () => {
  const credentials = localCredentials(SECRET);
  const session = "a-session-of-this-machine-0123456789";
  const key = bindingOf(SECRET, session);

  test("take the cookie and its key together, never one of them alone", () => {
    const of = (headers: Record<string, string>) => credentials.sessionOf({ headers });
    expect(of({ cookie: `aq_local=${session}`, [BINDING_HEADER]: key })).toBe(session);
    expect(of({ cookie: `aq_local=${session}` })).toBeUndefined();
    expect(of({ [BINDING_HEADER]: key })).toBeUndefined();
    // The key of another session, or of another backend, is not this one's.
    expect(
      of({
        cookie: `aq_local=${session}`,
        [BINDING_HEADER]: bindingOf(SECRET, "another-one-0123456789"),
      }),
    ).toBeUndefined();
    expect(
      of({
        cookie: `aq_local=${session}`,
        [BINDING_HEADER]: bindingOf(bindingSecretOf(randomBytes(32)), session),
      }),
    ).toBeUndefined();
    // The cookie of a site of its own is nothing here.
    expect(of({ cookie: `__Host-aq_session=${session}`, [BINDING_HEADER]: key })).toBeUndefined();
    // A WebSocket brings the key among its subprotocols.
    expect(
      of({
        cookie: `aq_local=${session}`,
        "sec-websocket-protocol": `animaquill.v1, animaquill.binding.${key}`,
      }),
    ).toBe(session);
    expect(
      of({ cookie: `aq_local=${session}`, "sec-websocket-protocol": "animaquill.v1" }),
    ).toBeUndefined();
  });

  test("give a cookie without Secure or a prefix, Strict, that no script reads", () => {
    expect(credentials.setCookie("session", "abcdefghijklmnop", 30 * 86_400)).toBe(
      "aq_local=abcdefghijklmnop; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict",
    );
    expect(credentials.clearCookie("session")).toBe(
      "aq_local=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict",
    );
    expect(credentials.socketProtocol?.(new Set(["animaquill.v1", "x"]))).toBe("animaquill.v1");
    expect(credentials.socketProtocol?.(new Set(["x"]))).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE)("the routes of this machine", () => {
  let t: TestDatabase;
  let app: ReturnType<typeof buildApp>;
  const tokens = new OneTimeTokens();
  const ADMIN = randomBytes(32).toString("base64url");
  let opened = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    const config = {
      ...loadConfig(
        {
          AQ_VERSION: "test",
          PUBLIC_ORIGIN: EDITOR,
          PLATFORM_MASTER_KEY: `1:${randomBytes(32).toString("base64")}`,
        },
        () => undefined,
      ),
      trustedProxies: [],
    };
    const setup = setUpAccounts(config, t.db, { withoutGitHub: true });
    const hub = {
      access: OWNER_ONLY,
      open: () => {
        opened += 1;
        return { receive() {}, closed() {} };
      },
      stop() {},
      closeSession() {},
      closeUser() {},
    } as unknown as SyncHub;
    app = buildApp(
      config,
      {
        checkDatabase: async () => true,
        ready: () => true,
        accounts: () => setup.accounts,
        credentials: localCredentials(SECRET),
        sync: () => hub,
        db: () => t.db,
        extend: localRoutes({
          editor: EDITOR,
          tokens,
          bindingSecret: SECRET,
          adminKey: ADMIN,
          instance: "the-instance",
          version: "test",
          server: {
            state: async () => ({
              version: "test",
              dataDir: "/d",
              database: { kind: "given" },
              old: [],
            }),
            keySaved: async () => true,
            masterKey: async () => "1:key\n",
            removeOld: async () => "notFound",
          },
        }),
      },
      false,
    );
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  const fromPage = { host: HOST, origin: EDITOR, "x-animaquill": "1" };
  const exchange = (token: unknown, headers: Record<string, string> = fromPage) =>
    app.inject({
      method: "POST",
      url: "/api/local/session",
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify({ token }),
    });
  const signIn = async () => {
    const answer = await exchange(tokens.issue());
    expect(answer.statusCode).toBe(200);
    const cookie = String(answer.headers["set-cookie"]).split(";")[0]!;
    return { cookie, binding: (answer.json() as { binding: string }).binding };
  };

  test("the state of the server is the person of this machine's, by who they are, and nobody else's", async () => {
    const { cookie, binding } = await signIn();
    const state = (headers: Record<string, string>) =>
      app.inject({ method: "GET", url: "/api/local/server", headers: { host: HOST, ...headers } });
    expect((await state({ cookie, [BINDING_HEADER]: binding })).statusCode).toBe(200);
    // Somebody who came through GitHub, as one of a list of people will (O4e), with a session of
    // their own: not this.
    const [person] = await t.db
      .insert(users)
      .values({ kind: "github", githubId: 91_000_001, login: "someone" })
      .returning({ id: users.id });
    const theirs = "a-session-of-someone-through-github-0123";
    await t.db.insert(sessions).values({
      idHash: hashOf(theirs),
      userId: person!.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const other = { cookie: `aq_local=${theirs}`, [BINDING_HEADER]: bindingOf(SECRET, theirs) };
    expect((await state(other)).statusCode).toBe(403);
    const key = await app.inject({
      method: "POST",
      url: "/api/local/server/master-key",
      headers: { ...fromPage, ...other },
    });
    expect(key.statusCode).toBe(403);
    expect(key.body).not.toContain("1:key");
  });

  test("a token gives a session once, for the person of this machine", async () => {
    const token = tokens.issue();
    const answer = await exchange(token);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["set-cookie"]).toMatch(
      /^aq_local=[A-Za-z0-9_-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict$/,
    );
    const { binding } = answer.json() as { binding: string };
    const cookie = String(answer.headers["set-cookie"]).split(";")[0]!;
    const asked = await app.inject({
      url: "/api/auth/session",
      headers: { host: HOST, cookie, [BINDING_HEADER]: binding },
    });
    expect(asked.json()).toMatchObject({ status: "signedIn", user: { login: "本机" } });
    expect((await exchange(token)).statusCode).toBe(401);
  });

  test("a token from elsewhere, or without the header of the page, gives nothing", async () => {
    const token = tokens.issue();
    expect((await exchange(token, { host: HOST, "x-animaquill": "1" })).statusCode).toBe(403);
    expect(
      (
        await exchange(token, {
          host: HOST,
          origin: "http://animaquill-scene-1.localhost:7651",
          "x-animaquill": "1",
        })
      ).statusCode,
    ).toBe(403);
    expect((await exchange(token, { host: HOST, origin: EDITOR })).statusCode).toBe(403);
    // Still there for the page it was for.
    expect((await exchange(token)).statusCode).toBe(200);
  });

  test("only the cookie with its key reads anything; another Host gets 421", async () => {
    const { cookie, binding } = await signIn();
    const read = (headers: Record<string, string>) =>
      app.inject({ url: "/api/me/storage", headers: { host: HOST, ...headers } });
    expect((await read({ cookie, [BINDING_HEADER]: binding })).statusCode).not.toBe(401);
    expect((await read({ cookie })).statusCode).toBe(401);
    expect((await read({ [BINDING_HEADER]: binding })).statusCode).toBe(401);
    for (const host of [
      "localhost:7651",
      "127.0.0.1:7651",
      "evil.example:7651",
      "animaquill.localhost:7652",
    ])
      expect((await read({ host, cookie, [BINDING_HEADER]: binding })).statusCode).toBe(421);
  });

  test("the admin routes take the admin key, and nothing from a page", async () => {
    const admin = (url: string, headers: Record<string, string>, method: "GET" | "POST" = "GET") =>
      app.inject({ method, url, headers: { host: HOST, ...headers } });
    const bearer = { authorization: `Bearer ${ADMIN}` };
    const ping = await admin("/api/local/admin/ping", bearer);
    expect(ping.json()).toEqual({ instance: "the-instance", version: "test" });
    expect((await admin("/api/local/admin/ping", {})).statusCode).toBe(401);
    expect(
      (await admin("/api/local/admin/ping", { authorization: "Bearer nope" })).statusCode,
    ).toBe(401);
    expect((await admin("/api/local/admin/ping", { ...bearer, origin: EDITOR })).statusCode).toBe(
      403,
    );
    expect(
      (await admin("/api/local/admin/open", { ...bearer, origin: "null" }, "POST")).statusCode,
    ).toBe(403);
    const open = await admin("/api/local/admin/open", bearer, "POST");
    const { url } = open.json() as { url: string };
    expect(url).toMatch(/^http:\/\/animaquill\.localhost:7651\/#aq-token=[A-Za-z0-9_-]{43}$/);
    expect((await exchange(url.split("#aq-token=")[1])).statusCode).toBe(200);
  });

  test("the WebSocket of syncing needs the key among its subprotocols", async () => {
    const { cookie, binding } = await signIn();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const open = (protocols: string[], headers: Record<string, string> = {}) =>
      new Promise<{ protocol: string; code: number } | { error: string }>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sync`, protocols, {
          headers: { origin: EDITOR, host: HOST, cookie, ...headers },
        });
        let protocol = "";
        socket.on("open", () => {
          protocol = socket.protocol;
          setTimeout(() => socket.close(1000), 200);
        });
        socket.on("close", (code) => resolve({ protocol, code }));
        socket.on("error", (error) => resolve({ error: error.message }));
      });
    const before = opened;
    expect(await open(["animaquill.v1", `animaquill.binding.${binding}`])).toEqual({
      protocol: "animaquill.v1",
      code: 1000,
    });
    expect(opened).toBe(before + 1);
    // Without the key: signed out. Without the subprotocol it answers with: no WebSocket.
    expect(await open(["animaquill.v1"])).toMatchObject({ code: 4401 });
    expect(await open([`animaquill.binding.${binding}`])).toMatchObject({
      error: expect.any(String),
    });
    expect(
      await open(["animaquill.v1", `animaquill.binding.${binding}`], {
        origin: "http://animaquill-scene-1.localhost:7651",
      }),
    ).toMatchObject({ error: expect.any(String) });
    expect(opened).toBe(before + 1);
  });
});
