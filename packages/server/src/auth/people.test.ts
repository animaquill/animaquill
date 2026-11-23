import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "node:crypto";
import { buildApp } from "../app.ts";
import { loadConfig } from "../config.ts";
import { sessions, signups, users } from "../schema.ts";
import { FakeGitHub, type FakeUser } from "../test/fake-github.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { SESSION_COOKIE, SIGNUP_COOKIE } from "./cookies.ts";
import { REQUEST_HEADER } from "./guard.ts";
import { allowList, NOBODY_NEW, type PeoplePolicy } from "./people.ts";
import { setUpAccounts } from "./setup.ts";

/**
 * Who gets an account as they first sign in through GitHub, by the policy of people the server is
 * given (people.ts): nobody new without one, those on the list with `allowList`, and whoever has an
 * account whatever the policy says. End to end through the routes, with the fake GitHub, on a real
 * PostgreSQL. Needs AQ_TEST_DATABASE, see vitest.config.ts.
 */

const ORIGIN = "https://editor.example.com";
const GITHUB = "https://github.test";
const MASTER_KEY = `1:${randomBytes(32).toString("base64")}`;
const ADA: FakeUser = { id: 70_000_101, login: "Ada" };
const BOB: FakeUser = { id: 70_000_102, login: "bob" };

const env = {
  PUBLIC_ORIGIN: ORIGIN,
  GITHUB_APP_ID: "1000001",
  GITHUB_APP_SLUG: "the-app",
  GITHUB_CLIENT_ID: "Iv1.a1b2c3d4e5f60718",
  GITHUB_CLIENT_SECRET: "client-secret-value",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_URL: GITHUB,
  GITHUB_API_URL: `${GITHUB}/api`,
  PLATFORM_MASTER_KEY: MASTER_KEY,
};

type App = ReturnType<typeof buildApp>;

/** A browser: its cookies, and the way through the site and GitHub, following redirects. */
class Browser {
  readonly cookies = new Map<string, string>();
  readonly app: App;
  readonly github: FakeGitHub;
  readonly user: FakeUser;
  constructor(app: App, github: FakeGitHub, user: FakeUser) {
    this.app = app;
    this.github = github;
    this.user = user;
  }

  async site(method: "GET" | "POST", path: string, payload?: unknown) {
    const response = await this.app.inject({
      method,
      url: path,
      headers: {
        ...(this.cookies.size > 0 && {
          cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        }),
        ...(method === "POST" && {
          origin: ORIGIN,
          [REQUEST_HEADER]: "1",
          "content-type": "application/json",
        }),
      },
      ...(payload !== undefined && { payload: JSON.stringify(payload) }),
    });
    const set = response.headers["set-cookie"];
    for (const cookie of set === undefined ? [] : Array.isArray(set) ? set : [String(set)]) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      if (/Max-Age=0\b/.test(cookie)) this.cookies.delete(pair.slice(0, at));
      else this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }

  /** Signs in from the start, through GitHub and back: the page of the editor it ends on. */
  async signIn(): Promise<string> {
    let url = new URL("/api/auth/github/start?returnTo=%2F", ORIGIN);
    for (let hop = 0; hop < 12; hop++) {
      let location: string | null;
      if (url.origin === ORIGIN) {
        if (!url.pathname.startsWith("/api/")) return url.pathname + url.search;
        location = (await this.site("GET", url.pathname + url.search)).headers.location as string;
      } else {
        location = (await this.github.handle(new Request(url), this.user)).headers.get("location");
      }
      if (!location) throw new Error(`${url.href} sent nowhere`);
      url = new URL(location, url);
    }
    throw new Error("too many redirects");
  }

  async session() {
    return (await this.site("GET", "/api/auth/session")).json() as { status: string };
  }
}

describe.skipIf(!TEST_DATABASE)("who gets an account, on a database", () => {
  let t: TestDatabase;
  let github: FakeGitHub;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    await t.query("truncate users, sessions, github_tokens, login_attempts, signups cascade");
    github = new FakeGitHub({ callbackUrl: `${ORIGIN}/api/auth/github/callback` });
  });

  const serverWith = (people?: PeoplePolicy) => {
    const config = loadConfig(env, () => undefined);
    const setup = setUpAccounts(config, t.db, {
      fetch: github.fetch,
      ...(people && { people }),
    });
    return buildApp(
      config,
      {
        checkDatabase: async () => true,
        ready: () => true,
        accounts: () => setup.accounts,
        installUrl: () => setup.installUrl,
        onGitHubEvent: (event, payload, delivery) => setup.onGitHubEvent(event, payload, delivery),
      },
      false,
    );
  };
  const accountOf = async (person: FakeUser) =>
    (await t.db.select().from(users).where(eq(users.githubId, person.id)))[0];

  test("without a policy, nobody new gets in, and no code is one", async () => {
    const app = serverWith();
    const ada = new Browser(app, github, ADA);
    expect(await ada.signIn()).toBe("/signup.html");
    expect(ada.cookies.has(SIGNUP_COOKIE)).toBe(true);
    const tried = await ada.site("POST", "/api/auth/signup", { code: "AAAA-BBBB-CCCC-DDDD" });
    expect(tried.statusCode).toBe(400);
    expect(await accountOf(ADA)).toBeUndefined();
    expect(await ada.session()).toEqual({ status: "signedOut" });
    // The same as saying so.
    const nobody = new Browser(serverWith(NOBODY_NEW), github, BOB);
    expect(await nobody.signIn()).toBe("/signup.html");
    expect(await accountOf(BOB)).toBeUndefined();
  });

  test("those on the list get in at once, by number or by login in any case; nobody else", async () => {
    for (const list of [[ADA.id], ["ada"], [" ADA "]]) {
      await t.query("truncate users, sessions, github_tokens, login_attempts, signups cascade");
      const app = serverWith(allowList(list));
      const ada = new Browser(app, github, ADA);
      expect(await ada.signIn(), JSON.stringify(list)).toBe("/?signIn=ok");
      expect(ada.cookies.has(SESSION_COOKIE)).toBe(true);
      expect(ada.cookies.has(SIGNUP_COOKIE)).toBe(false);
      expect(await ada.session()).toMatchObject({ status: "signedIn", user: { login: "Ada" } });
      const account = await accountOf(ADA);
      expect(account).toMatchObject({ login: "Ada", disabledAt: null });
      expect(
        await t.db.select().from(sessions).where(eq(sessions.userId, account!.id)),
      ).toHaveLength(1);
      expect(await t.db.select().from(signups)).toEqual([]);

      // Bob is not on it: he waits as without a list, and no code lets him in.
      const bob = new Browser(app, github, BOB);
      expect(await bob.signIn()).toBe("/signup.html");
      expect(
        (await bob.site("POST", "/api/auth/signup", { code: "AAAA-BBBB-CCCC-DDDD" })).statusCode,
      ).toBe(400);
      expect(await accountOf(BOB)).toBeUndefined();
    }
  });

  test("an account is the person's, whatever the list says now; a disabled one stays out", async () => {
    const ada = new Browser(serverWith(allowList([ADA.id])), github, ADA);
    expect(await ada.signIn()).toBe("/?signIn=ok");
    const account = await accountOf(ADA);
    // Signing in again, with Ada off the list: the account is there, and she gets in.
    const again = new Browser(serverWith(allowList([BOB.id])), github, ADA);
    expect(await again.signIn()).toBe("/?signIn=ok");
    expect((await accountOf(ADA))!.id).toBe(account!.id);
    expect(await t.db.select().from(users)).toHaveLength(1);
    // Disabled by whoever runs the server: on the list or not, no more.
    await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, account!.id));
    const disabled = new Browser(serverWith(allowList([ADA.id])), github, ADA);
    expect(await disabled.signIn()).toBe("/?signIn=disabled");
    expect(disabled.cookies.has(SESSION_COOKIE)).toBe(false);
  });

  test("two browsers of someone on the list at the same moment end up with one account", async () => {
    const app = serverWith(allowList([ADA.id]));
    const pages = await Promise.all([
      new Browser(app, github, ADA).signIn(),
      new Browser(app, github, ADA).signIn(),
    ]);
    expect(pages).toEqual(["/?signIn=ok", "/?signIn=ok"]);
    const all = await t.db.select().from(users);
    expect(all).toHaveLength(1);
    expect(await t.db.select().from(sessions).where(eq(sessions.userId, all[0]!.id))).toHaveLength(
      2,
    );
  });

  test("the list takes only what can be a GitHub account", () => {
    expect(() => allowList([0])).toThrow();
    expect(() => allowList([1.5])).toThrow();
    expect(() => allowList(["-ada"])).toThrow();
    expect(() => allowList(["ada lovelace"])).toThrow();
    expect(() => allowList(["a".repeat(40)])).toThrow();
    expect(() => allowList([1, "ada-l", "Ada2"])).not.toThrow();
  });
});
