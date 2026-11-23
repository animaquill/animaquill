import { createHmac } from "node:crypto";
import { Writable } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { buildApp } from "./app.ts";
import type { Accounts } from "./auth/accounts.ts";
import { loadConfig } from "./config.ts";

const SECRET = "test-webhook-secret";

const make = ({ up = true, ready = true, secret = SECRET as string | null } = {}) => {
  const config = loadConfig(
    {
      AQ_VERSION: "0.5.0",
      ...(secret !== null && { GITHUB_WEBHOOK_SECRET: secret }),
    },
    () => undefined,
  );
  return buildApp(config, { checkDatabase: async () => up, ready: () => ready }, false);
};

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("/api/health", () => {
  test("is 200 when the database answers", async () => {
    const response = await make().inject({ url: "/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", version: "0.5.0" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("is 503 when it does not, or before the migrations ran", async () => {
    for (const app of [make({ up: false }), make({ ready: false })]) {
      const response = await app.inject({ url: "/api/health" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ status: "unavailable" });
    }
  });
});

describe("POST /api/github/webhook", () => {
  const body = '{"action":"created","installation":{"id":1}}';
  const post = (app: ReturnType<typeof make>, headers: Record<string, string>, payload = body) =>
    app.inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        ...headers,
      },
      payload,
    });

  test("takes a delivery signed with the secret", async () => {
    const response = await post(make(), { "x-hub-signature-256": sign(body) });
    expect(response.statusCode).toBe(204);
  });

  test("checks the bytes as sent, whatever their type", async () => {
    const spaced = '{ "action" : "created" }';
    const response = await post(
      make(),
      {
        "x-hub-signature-256": sign(spaced),
        "content-type": "application/x-www-form-urlencoded",
      },
      spaced,
    );
    expect(response.statusCode).toBe(204);
  });

  test("turns away a wrong signature, a changed body and none at all", async () => {
    for (const [headers, payload] of [
      [{ "x-hub-signature-256": sign(`${body} `) }, body],
      [{ "x-hub-signature-256": sign(body) }, `${body} `],
      [{}, body],
    ] as const) {
      const response = await post(make(), headers, payload);
      expect(response.statusCode).toBe(401);
    }
  });

  test("takes nothing without a secret set", async () => {
    const response = await post(make({ secret: null }), {
      "x-hub-signature-256": sign(body),
    });
    expect(response.statusCode).toBe(503);
  });

  test("other routes still parse JSON as usual", async () => {
    const response = await make().inject({
      method: "POST",
      url: "/api/health",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("signing in, without a database", () => {
  const accounts = () => {
    throw new Error("nothing here may need the database");
  };
  const app = (ready = false, onGitHubEvent?: () => Promise<void>) =>
    buildApp(
      loadConfig({ GITHUB_WEBHOOK_SECRET: SECRET }, () => undefined),
      {
        checkDatabase: async () => false,
        ready: () => ready,
        accounts,
        installUrl: () => "https://github.com/apps/animaquill/installations/new",
        ...(onGitHubEvent && { onGitHubEvent }),
      },
      false,
    );

  test("a browser with no session is signed out, which needs nothing but the request", async () => {
    const response = await app().inject({ url: "/api/auth/session" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "signedOut" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("one with a session hears that it cannot be told now", async () => {
    const response = await app().inject({
      url: "/api/auth/session",
      headers: { cookie: `__Host-aq_session=${"a".repeat(43)}` },
    });
    expect(response.statusCode).toBe(503);
  });

  test("signing in goes back to where it started, saying it cannot be done now", async () => {
    for (const path of ["/api/auth/github/start", "/api/auth/github/install"]) {
      const response = await app().inject({ url: `${path}?returnTo=%2F%3Fproject%3Dp` });
      expect(response.statusCode, path).toBe(303);
      expect(response.headers.location, path).toBe("/?project=p&signIn=unavailable");
    }
  });

  test("a webhook that cannot be taken in yet is a failed delivery, to be sent again", async () => {
    const body = '{"action":"created","installation":{"id":1}}';
    const response = await app(false, async () => {}).inject({
      method: "POST",
      url: "/api/github/webhook",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(500);
  });

  test("too many sign-ins from one address are told to wait", async () => {
    const limited = app();
    const codes: string[] = [];
    // Through the gateway, which is on this machine in here.
    const from = (address: string) => ({ headers: { "x-forwarded-for": address } });
    for (let index = 0; index < 31; index++) {
      const response = await limited.inject({
        url: "/api/auth/github/start",
        ...from("192.0.2.9"),
      });
      codes.push(String(response.headers.location));
    }
    expect(codes.slice(0, 30).every((code) => code === "/?signIn=unavailable")).toBe(true);
    expect(codes[30]).toBe("/?signIn=busy");
    // Another address is someone else.
    const other = await limited.inject({ url: "/api/auth/github/start", ...from("192.0.2.1") });
    expect(other.headers.location).toBe("/?signIn=unavailable");
  });
});

describe("whose turn a request takes", () => {
  const app = (env: Record<string, string> = {}) =>
    buildApp(
      loadConfig({ GITHUB_WEBHOOK_SECRET: SECRET, ...env }, () => undefined),
      { checkDatabase: async () => false, ready: () => false },
      false,
    );
  /** Starts a sign-in this many times; resolves to how many were told to wait. */
  const starts = async (
    to: ReturnType<typeof app>,
    times: number,
    from: { remoteAddress?: string; headers?: Record<string, string> },
  ) => {
    let busy = 0;
    for (let index = 0; index < times; index++) {
      const response = await to.inject({ url: "/api/auth/github/start", ...from });
      if (String(response.headers.location).includes("signIn=busy")) busy++;
    }
    return busy;
  };

  test("an address only the gateway can say: anyone else's X-Forwarded-For counts for nothing", async () => {
    const limited = app();
    // Someone connecting directly, who makes up a new address every time.
    let busy = 0;
    for (let index = 0; index < 31; index++) {
      const response = await limited.inject({
        url: "/api/auth/github/start",
        remoteAddress: "203.0.113.50",
        headers: { "x-forwarded-for": `198.51.100.${index}` },
      });
      if (String(response.headers.location).includes("signIn=busy")) busy++;
    }
    expect(busy).toBe(1);
  });

  test("through the gateway, each address on the internet has turns of its own", async () => {
    const limited = app();
    const from = (address: string) => ({ headers: { "x-forwarded-for": address } });
    expect(await starts(limited, 31, from("198.51.100.7"))).toBe(1);
    expect(await starts(limited, 1, from("198.51.100.8"))).toBe(0);
  });

  test("IPv6 counts by the /64, which is what one line has", async () => {
    const limited = app();
    const from = (address: string) => ({ headers: { "x-forwarded-for": address } });
    expect(await starts(limited, 30, from("2606:4700:4700::1111"))).toBe(0);
    expect(await starts(limited, 1, from("2606:4700:4700::2222"))).toBe(1);
    expect(await starts(limited, 1, from("2606:4700:4701::1"))).toBe(0);
  });

  test("everyone behind a Docker bridge, as IPv6 visitors are now, is not locked out by one of them", async () => {
    const limited = app();
    const bridge = { headers: { "x-forwarded-for": "172.18.0.1" } };
    expect(await starts(limited, 31, bridge)).toBe(0);
    // All of them together still have a ceiling, against a flood.
    expect(await starts(limited, 300, bridge)).toBeGreaterThan(0);
  });

  test("one of them with a session uses up the turns of that session, not everyone's", async () => {
    const limited = app();
    const session = (id: string) => ({
      headers: { "x-forwarded-for": "172.18.0.1", cookie: `__Host-aq_session=${id.repeat(43)}` },
    });
    expect(await starts(limited, 11, session("a"))).toBe(1);
    expect(await starts(limited, 1, session("b"))).toBe(0);
  });
});

describe("what goes wrong inside", () => {
  test("is an internal error to the browser, without a word of the query or what went into it", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const cause = Object.assign(new Error('relation "sessions" does not exist'), { code: "42P01" });
    const failing = {
      session: async () => {
        throw new DrizzleQueryError(
          'select "users"."id" from "sessions" where "id_hash" = $1',
          [Buffer.from("hash"), "ghu_not_to_be_seen"],
          cause,
        );
      },
    } as unknown as Accounts;
    const app = buildApp(
      loadConfig({}, () => undefined),
      { checkDatabase: async () => true, ready: () => true, accounts: () => failing },
      { level: "info", stream },
    );
    const response = await app.inject({
      url: "/api/auth/session",
      headers: { cookie: `__Host-aq_session=${"a".repeat(43)}` },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal" });
    const log = lines.join("");
    expect(log).toContain('relation \\"sessions\\" does not exist');
    expect(log).not.toMatch(/Failed query|select|ghu_not_to_be_seen|params/);
  });

  test("what the request got wrong is still said", async () => {
    const app = make();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Bad Request" });
  });
});
