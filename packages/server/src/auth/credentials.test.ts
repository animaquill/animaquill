import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { buildApp, type Platform } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { Accounts, SignedIn } from "./accounts.ts";
import { HOSTED_CREDENTIALS, type SessionCredentials } from "./credentials.ts";

/**
 * How a browser shows its session (credentials.ts): the cookies of a site of its own are what they
 * always were, and a deployment that takes the session some other way has every route and the
 * WebSocket of syncing go by that, with nothing of the hosted cookies.
 */

const ORIGIN = "https://editor.example.com";
const SESSION = "a-session-of-ada-0123456789abcdef";

describe("the credentials of a site of its own", () => {
  test("are the cookies as before: __Host-, HttpOnly, Secure, SameSite=Lax", () => {
    const value = "abcdefghijklmnop";
    expect(HOSTED_CREDENTIALS.setCookie("session", value, 90.7)).toBe(
      `__Host-aq_session=${value}; Path=/; Max-Age=90; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(HOSTED_CREDENTIALS.setCookie("login", value, 600)).toBe(
      `__Host-aq_login=${value}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(HOSTED_CREDENTIALS.setCookie("signup", value, 1)).toBe(
      `__Host-aq_signup=${value}; Path=/; Max-Age=1; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(HOSTED_CREDENTIALS.setCookie("install", value, 3600)).toBe(
      `__Host-aq_install=${value}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`,
    );
    for (const [which, name] of [
      ["session", "__Host-aq_session"],
      ["login", "__Host-aq_login"],
      ["signup", "__Host-aq_signup"],
      ["install", "__Host-aq_install"],
    ] as const)
      expect(HOSTED_CREDENTIALS.clearCookie(which)).toBe(
        `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
      );
    expect(HOSTED_CREDENTIALS.socketProtocol).toBeUndefined();
  });

  test("take the session from __Host-aq_session only, and only a value of ours", () => {
    const of = (cookie?: string) =>
      HOSTED_CREDENTIALS.sessionOf({ headers: cookie === undefined ? {} : { cookie } });
    expect(of(`__Host-aq_session=${SESSION}`)).toBe(SESSION);
    expect(
      of(`other=1; __Host-aq_session=${SESSION}; __Host-aq_session=second-one-0123456789`),
    ).toBe(SESSION);
    expect(of()).toBeUndefined();
    // Without the prefix any site under the domain could have set it.
    expect(of(`aq_session=${SESSION}`)).toBeUndefined();
    expect(of("__Host-aq_session=short")).toBeUndefined();
    expect(of(`__Host-aq_session=${SESSION}%00`)).toBeUndefined();
    expect(
      HOSTED_CREDENTIALS.cookieOf({ headers: { cookie: "__Host-aq_install=L2E" } }, "install"),
    ).toBe("L2E");
  });
});

describe("a deployment with credentials of its own", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  /** Takes the session from a header, with a key in it besides, as the backend of a machine may. */
  const BOUND: SessionCredentials = {
    sessionOf: ({ headers }) => {
      const offered = headers["sec-websocket-protocol"];
      const said =
        typeof offered === "string"
          ? offered
              .split(",")
              .map((part) => part.trim())
              .find((part) => part.startsWith("aq-test."))
              ?.slice("aq-test.".length)
          : headers["x-test-session"];
      return typeof said === "string" && said === `${SESSION}` ? SESSION : undefined;
    },
    cookieOf: () => undefined,
    setCookie: (which, value, seconds) => `test_${which}=${value}; Max-Age=${Math.floor(seconds)}`,
    clearCookie: (which) => `test_${which}=; Max-Age=0`,
    socketProtocol: (offered) => (offered.has("animaquill.v1") ? "animaquill.v1" : false),
  };

  const make = () => {
    const signedIn: SignedIn = {
      userId: "0190a000-0000-7000-8000-000000000001",
      kind: "local",
      githubId: null,
      login: "本机",
      avatarUrl: null,
      installed: false,
      renewed: true,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    };
    const ended: string[] = [];
    const accounts = {
      session: async (id: string) => (id === SESSION ? signedIn : undefined),
      logout: async (id: string) => void ended.push(id),
    } as unknown as Accounts;
    const platform: Platform = {
      checkDatabase: async () => true,
      ready: () => true,
      accounts: () => accounts,
      credentials: BOUND,
    };
    const config = loadConfig({ AQ_VERSION: "test", PUBLIC_ORIGIN: ORIGIN }, () => undefined);
    const app = buildApp(config, platform, false);
    apps.push(app);
    return { app, ended };
  };

  test("says who is signed in by them, and gives and takes its own cookie", async () => {
    const { app, ended } = make();
    const asked = await app.inject({
      url: "/api/auth/session",
      headers: { "x-test-session": SESSION },
    });
    expect(asked.json()).toMatchObject({ status: "signedIn", user: { login: "本机" } });
    expect(asked.headers["set-cookie"]).toMatch(/^test_session=a-session-of-ada-/);
    // The cookie of a site of its own is nothing here.
    const hosted = await app.inject({
      url: "/api/auth/session",
      headers: { cookie: `__Host-aq_session=${SESSION}` },
    });
    expect(hosted.json()).toEqual({ status: "signedOut" });
    // A route of the editor that needs someone signed in, and signing out.
    expect(
      (
        await app.inject({
          url: "/api/me/storage",
          headers: { cookie: `__Host-aq_session=${SESSION}` },
        })
      ).statusCode,
    ).toBe(401);
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { "x-test-session": SESSION, origin: ORIGIN, "x-animaquill": "1" },
    });
    expect(out.statusCode).toBe(204);
    expect(out.headers["set-cookie"]).toBe("test_session=; Max-Age=0");
    expect(ended).toEqual([SESSION]);
  });

  test("the WebSocket of syncing takes them from Sec-WebSocket-Protocol, and answers with theirs", async () => {
    const { app } = make();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const open = (protocols: string[]) =>
      new Promise<{ protocol: string; code: number } | { error: string }>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sync`, protocols, {
          headers: { origin: ORIGIN },
        });
        let protocol = "";
        socket.on("open", () => (protocol = socket.protocol));
        socket.on("close", (code) => resolve({ protocol, code }));
        socket.on("error", (error) => resolve({ error: error.message }));
      });
    // Signed in by what came in the subprotocols: no hub here, so not ready, which it says after
    // taking the connection with the subprotocol it chose.
    const bound = await open(["animaquill.v1", `aq-test.${SESSION}`]);
    expect(bound).toEqual({ protocol: "animaquill.v1", code: 4503 });
    // Without the subprotocol it answers with, no WebSocket comes of it.
    expect(await open([`aq-test.${SESSION}`])).toMatchObject({ error: expect.any(String) });
  });
});
