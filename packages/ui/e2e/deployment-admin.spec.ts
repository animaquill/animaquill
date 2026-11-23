import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * The admin site on the real sites, through the gateway (docs/design/phase6-plan.md 3.7): going in,
 * which starts on the admin site and goes through the editor's, its API on a site of its own, and
 * none of it on the editor's. These tests ask its API with the browser's cookies from outside the
 * page, as the pages do from inside it; the pages themselves are deployment-admin-pages.spec.ts. Each
 * test is a GitHub user of its own, see scripts/e2e-edge.
 */

const EDITOR = "https://app.animaquill.com";
const ADMIN = "https://admin.animaquill.com";
const GITHUB = "http://127.0.0.1:8400";
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

const someone = (): GitHubUser => {
  const id = randomInt(1_000_000, 2_000_000_000);
  return { id, login: `user-${id}` };
};

const signedInToGitHub = (context: BrowserContext, user: GitHubUser) =>
  context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);

/** The command line of the server, as whoever runs it uses it. */
const command = (...args: string[]) =>
  execFileSync("node", ["/work/apps/api/src/admin.ts", ...args], { encoding: "utf8" });

const newInvite = () => {
  const code = /邀请码：(\S+)/.exec(command("invite", "create", "--note", "admin test"))?.[1];
  if (!code) throw new Error("no invite code");
  return code;
};

/** The first sign-in, with an invite code, back in the editor. */
async function signUp(page: Page, user: GitHubUser) {
  await entrySignIn(page).click();
  await expect(page).toHaveURL(`${EDITOR}/signup.html`);
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(
    page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
  ).toBeVisible();
}

/** What every answer of the admin site has, besides what every site has. */
const expectAdminHeaders = (headers: Record<string, string>, what: string) => {
  expect(headers["content-security-policy"], what).toBe(
    "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  expect(headers["cross-origin-resource-policy"], what).toBe("same-origin");
  expect(headers["x-frame-options"], what).toBe("DENY");
  expect(headers["strict-transport-security"], what).toBeTruthy();
  expect(headers["x-content-type-options"], what).toBe("nosniff");
  expect(headers["referrer-policy"], what).toBe("no-referrer");
};

/** Takes out of `problems` what a test meant to happen, and says how many there were. */
const meant = (problems: string[], pattern: RegExp) => {
  const found = problems.filter((problem) => pattern.test(problem));
  problems.splice(0, problems.length, ...problems.filter((problem) => !found.includes(problem)));
  return found.length;
};

/**
 * What the admin site's pages will ask of its API, with the browser's cookies and what such a page
 * sends along, see apps/api/src/auth/guard.ts.
 */
const ask = async (page: Page, path: string, method = "GET", body?: unknown) => {
  const response = await page.context().request.fetch(`${ADMIN}${path}`, {
    method,
    headers: method === "GET" ? {} : { origin: ADMIN, "x-animaquill": "1" },
    ...(body !== undefined && { data: body }),
  });
  const text = await response.text();
  return { status: response.status(), body: text ? JSON.parse(text) : undefined };
};

interface Action {
  readonly action: string;
  readonly admin: { readonly login: string } | null;
  readonly detail: Record<string, unknown>;
}

/**
 * What the record of the admin site has of one person, done by them or to them: the other tests
 * share the database, and their invite codes come from the command line, which is in there too.
 */
const actionsOf = async (page: Page, user: GitHubUser) =>
  ((await ask(page, "/api/admin/actions?limit=200")).body.actions as Action[])
    .filter((each) => each.admin?.login === user.login || each.detail["login"] === user.login)
    .map((each) => each.action);

test.describe("the admin site", () => {
  // The entry page: nobody is signed in to the editor until a test says so.
  test.use({ withProject: false });

  test.beforeEach(async ({ page }) => {
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
  });

  test("an admin goes in, with the headers of the admin site, and its API answers there and nowhere else", async ({
    page,
    context,
    request,
    problems,
  }) => {
    const user = someone();
    await signedInToGitHub(context, user);
    await signUp(page, user);
    expect(command("role", "grant", user.login)).toContain("现在是管理员了");

    const landed = await page.goto(`${ADMIN}/api/admin/sign-in?to=%2F`);
    expect(page.url()).toBe(`${ADMIN}/`);
    expect(landed?.status()).toBe(200);
    expectAdminHeaders(landed!.headers(), "the page");
    // What tied the way in to this browser is gone with it.
    expect((await context.cookies(ADMIN)).map(({ name }) => name)).not.toContain(
      "__Host-aq_admin_state",
    );
    const cookie = (await context.cookies(ADMIN)).find(({ name }) => name === "__Host-aq_admin");
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    expect((await context.cookies(EDITOR)).map(({ name }) => name)).not.toContain(
      "__Host-aq_admin",
    );

    expect(await ask(page, "/api/admin/session")).toMatchObject({
      status: 200,
      body: { user: { login: user.login } },
    });
    expect(await ask(page, "/api/admin/overview")).toMatchObject({
      status: 200,
      body: { version: "dev", database: { ok: true } },
    });
    const made = await ask(page, "/api/admin/invites", "POST", { note: "from the edge" });
    expect(made.status).toBe(201);
    expect(made.body.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(await actionsOf(page, user)).toEqual(["invite.create", "signIn", "role.grant"]);

    // The editor's site has none of it: the gateway says so, before the API could.
    for (const path of [
      "/api/admin/session",
      "/api/admin/overview",
      "/api/admin",
      "/api/admin/claim?code=x",
    ]) {
      const response = await request.get(`${EDITOR}${path}`);
      expect(response.status(), path).toBe(404);
      expect(response.headers()["content-type"] ?? "", path).not.toContain("json");
    }
    const posted = await request.post(`${EDITOR}/api/admin/invites`, {
      headers: { origin: ADMIN, "x-animaquill": "1" },
    });
    expect(posted.status()).toBe(404);
    // And the admin site has nothing but its own: no page in place of the rest of the API either.
    for (const path of [
      "/api/health",
      "/api/auth/session",
      "/api/auth/admin",
      "/api/projects",
      "/api/admin",
    ])
      expect((await request.get(`${ADMIN}${path}`)).status(), path).toBe(404);
    // Its answers have the headers every site has, and nobody signed in hears where to go.
    const outside = await request.get(`${ADMIN}/api/admin/session`);
    expect(outside.status()).toBe(401);
    expect(await outside.json()).toEqual({
      error: "signedOut",
      signIn: `${ADMIN}/api/admin/sign-in`,
    });
    expectAdminHeaders(outside.headers(), "the API");
    expect(outside.headers()["cache-control"]).toBe("no-store");

    // Signing out of the admin site, and the editor stays signed in.
    expect((await ask(page, "/api/admin/logout", "POST")).status).toBe(204);
    expect((await ask(page, "/api/admin/session")).status).toBe(401);
    expect((await context.cookies(ADMIN)).map(({ name }) => name)).not.toContain("__Host-aq_admin");
    await page.goto(EDITOR);
    await expect(
      page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
    ).toBeVisible();
    // The browser notes the 401 the page hears after signing out, if it asks by then.
    meant(problems, /status of 401/);
  });

  test("the editor's pages cannot change anything there, though browsers take both for one site", async ({
    page,
    context,
    problems,
  }) => {
    const user = someone();
    await signedInToGitHub(context, user);
    await signUp(page, user);
    command("role", "grant", user.login);
    await page.goto(`${ADMIN}/api/admin/sign-in?to=%2F`);
    expect(page.url()).toBe(`${ADMIN}/`);

    // The editor's page, which may reach any https address, with the admin cookie in the browser.
    await page.goto(EDITOR);
    await expect(
      page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
    ).toBeVisible();
    const tried = await page.evaluate(async (admin) => {
      const said: string[] = [];
      // With the header the browser asks the admin site first, which does not say yes.
      try {
        await fetch(`${admin}/api/admin/invites`, {
          method: "POST",
          credentials: "include",
          headers: { "x-animaquill": "1", "content-type": "application/json" },
          body: "{}",
        });
        said.push("went through");
      } catch {
        said.push("stopped");
      }
      // Without, it goes, cookie and all, and is turned away for where it comes from. What comes
      // back the browser does not even hand to the page: Cross-Origin-Resource-Policy.
      try {
        await fetch(`${admin}/api/admin/invites`, {
          method: "POST",
          credentials: "include",
          mode: "no-cors",
        });
        said.push("answered");
      } catch {
        said.push("withheld");
      }
      return said;
    }, ADMIN);
    expect(tried).toEqual(["stopped", "withheld"]);

    // Had either gone through, it would be there as theirs.
    expect(await actionsOf(page, user)).toEqual(["signIn", "role.grant"]);
    // The browser notes the preflight it stopped, and the answer it withheld (or its 403).
    meant(problems, /status of 403|blocked by CORS policy|ERR_FAILED|ERR_BLOCKED_BY_RESPONSE/);
  });

  test("someone who is no admin is sent back without a way in", async ({
    page,
    context,
    problems,
  }) => {
    const user = someone();
    await signedInToGitHub(context, user);
    await signUp(page, user);
    // Straight to the editor's site, as a link could: sent to start on the admin site, and back.
    await page.goto(`${EDITOR}/api/auth/admin?to=%2Fusers`);
    // The page says why, and takes it out of its address.
    await expect(page.getByText("这个账号不是管理员")).toBeVisible();
    expect(page.url()).toBe(`${ADMIN}/users`);
    await expect(page.getByRole("link", { name: "进入后台" })).toBeVisible();
    expect((await context.cookies(ADMIN)).map(({ name }) => name)).not.toContain("__Host-aq_admin");
    expect((await ask(page, "/api/admin/session")).status).toBe(401);
    meant(problems, /status of 40[14]/);
  });
});
