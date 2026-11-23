import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import {
  ADMIN_COOKIE,
  clearCookie,
  ourValue,
  readCookies,
  SESSION_COOKIE,
  setCookie,
} from "./cookies.ts";
import { fromThisSite, REQUEST_HEADER } from "./guard.ts";
import { RateLimit } from "./limits.ts";
import { safeReturnTo, withOutcome } from "./return-to.ts";
import { describeUserAgent } from "./user-agent.ts";

const ORIGIN = "https://editor.example.com";

describe("where a sign-in goes back to", () => {
  test("is a page of this site, with its query, without its fragment", () => {
    expect(safeReturnTo("/?project=abc", ORIGIN)).toBe("/?project=abc");
    expect(safeReturnTo("/index.html?project=abc#here", ORIGIN)).toBe("/index.html?project=abc");
    expect(safeReturnTo("/?project=%E4%B8%AD", ORIGIN)).toBe("/?project=%E4%B8%AD");
  });

  test("is never another site, another scheme, or the API", () => {
    for (const value of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "\\\\evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
      "evil.example",
      "",
      "/api/auth/logout",
      "/api/../api/auth/logout",
      `/${"a".repeat(2001)}`,
      undefined,
      ["/"],
      42,
    ])
      expect(safeReturnTo(value, ORIGIN), String(value)).toBe("/");
  });

  test("is the way into the admin site only when that way itself started the sign-in", () => {
    expect(safeReturnTo("/api/auth/admin?to=%2Fusers", ORIGIN)).toBe("/");
    expect(safeReturnTo("/api/auth/admin?to=%2Fusers", ORIGIN, { handoff: true })).toBe(
      "/api/auth/admin?to=%2Fusers",
    );
    expect(safeReturnTo("/api/auth/logout", ORIGIN, { handoff: true })).toBe("/");
    expect(safeReturnTo("/api/auth/admin/x", ORIGIN, { handoff: true })).toBe("/");
    expect(withOutcome("/api/auth/admin?to=%2Fusers&signIn=failed", "ok", ORIGIN)).toBe(
      "/api/auth/admin?to=%2Fusers&signIn=ok",
    );
    expect(withOutcome("/api/auth/github/start", "ok", ORIGIN)).toBe("/?signIn=ok");
  });

  test("gets how the sign-in ended, in place of any it had", () => {
    expect(withOutcome("/?project=abc", "ok", ORIGIN)).toBe("/?project=abc&signIn=ok");
    expect(withOutcome("/?signIn=failed&project=abc", "ok", ORIGIN)).toBe(
      "/?project=abc&signIn=ok",
    );
    expect(withOutcome("//evil.example/", "failed", ORIGIN)).toBe("/?signIn=failed");
  });
});

describe("the cookies", () => {
  test("are only for this site, over HTTPS, out of reach of scripts, and come back from GitHub", () => {
    const cookie = setCookie(SESSION_COOKIE, "a".repeat(43), 2592000);
    expect(cookie).toBe(
      `__Host-aq_session=${"a".repeat(43)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(clearCookie(SESSION_COOKIE)).toMatch(/^__Host-aq_session=; Path=\/; Max-Age=0;/);
    // The admin site's, which nothing elsewhere needs to bring along.
    expect(setCookie(ADMIN_COOKIE, "a".repeat(43), 43200, "Strict")).toBe(
      `__Host-aq_admin=${"a".repeat(43)}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(clearCookie(ADMIN_COOKIE, "Strict")).toMatch(
      /Max-Age=0; HttpOnly; Secure; SameSite=Strict$/,
    );
    expect(() => setCookie(SESSION_COOKIE, "a;b", 1)).toThrow();
  });

  test("are read the first of each name, and only values of ours count", () => {
    const jar = readCookies(`a=1; ${SESSION_COOKIE}=${"x".repeat(43)}; a=2; broken; =x`);
    expect(jar).toEqual({ a: "1", [SESSION_COOKIE]: "x".repeat(43) });
    expect(ourValue(jar[SESSION_COOKIE])).toBe("x".repeat(43));
    for (const value of [undefined, "", "short", "has space in it here", `${"x".repeat(40)}%00`])
      expect(ourValue(value)).toBeUndefined();
  });
});

describe("requests that change something", () => {
  const make = () => {
    const app = Fastify();
    app.post("/change", { preHandler: fromThisSite(ORIGIN) }, async () => ({ done: true }));
    return app;
  };
  const post = (headers: Record<string, string>) =>
    make().inject({ method: "POST", url: "/change", headers });

  test("are taken from pages of this site that say so", async () => {
    const response = await post({ origin: ORIGIN, [REQUEST_HEADER]: "1" });
    expect(response.statusCode).toBe(200);
  });

  test("are turned away from anywhere else, or without the header", async () => {
    for (const headers of [
      { [REQUEST_HEADER]: "1" },
      { origin: "https://evil.example", [REQUEST_HEADER]: "1" },
      { origin: "null", [REQUEST_HEADER]: "1" },
      { origin: `${ORIGIN}.evil.example`, [REQUEST_HEADER]: "1" },
      { origin: "http://editor.example.com", [REQUEST_HEADER]: "1" },
      { origin: ORIGIN },
      { origin: ORIGIN, [REQUEST_HEADER]: "0" },
    ])
      expect((await post(headers)).statusCode, JSON.stringify(headers)).toBe(403);
  });
});

describe("rate limits", () => {
  test("let so many through in a window, each key on its own, and start over after it", () => {
    let now = 0;
    const limit = new RateLimit(3, 1000, () => now);
    expect([1, 2, 3, 4].map(() => limit.take("a"))).toEqual([true, true, true, false]);
    expect(limit.take("b")).toBe(true);
    expect(limit.retryAfter("a")).toBe(1);
    now = 999;
    expect(limit.take("a")).toBe(false);
    now = 1000;
    expect(limit.take("a")).toBe(true);
  });
});

describe("what a session says about its browser", () => {
  test("is the browser and the system, and nothing more", () => {
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0",
      ),
    ).toBe("Edge 157, Windows");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 157, Linux");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15",
      ),
    ).toBe("Safari 19, macOS");
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
      ),
    ).toBe("Firefox 150, Windows");
    expect(describeUserAgent(undefined)).toBeNull();
    expect(describeUserAgent("curl/8.0")).toBeNull();
  });
});
