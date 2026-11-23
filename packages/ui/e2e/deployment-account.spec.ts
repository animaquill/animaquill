import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * Signing in on the real sites, through the gateway: the editor's account menu, the API with its
 * database, and a fake GitHub in place of github.com (oss/packages/server/src/test/fake-github-server.ts, which
 * behaves the way docs/research/github-app.md found GitHub to). Each test is a GitHub user of its
 * own, so that they can run side by side. See scripts/e2e-edge.
 */

const EDITOR = "https://app.animaquill.com";
const GITHUB = "http://127.0.0.1:8400";
/** A picture of one pixel, for GitHub's pictures of accounts, which are out of reach in here. */
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

/** Who is signed in to "GitHub" in this browser, and whether they say no when asked. */
const signedInToGitHub = (context: BrowserContext, user: GitHubUser, { deny = false } = {}) =>
  context.addCookies([
    { name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB },
    ...(deny ? [{ name: "fake_deny", value: "1", url: GITHUB }] : []),
  ]);

/** A new invite code from the admin command, the way whoever runs the server makes one. */
const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "deployment test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

const header = (page: Page) => page.locator("header");
const signInButton = (page: Page) => entrySignIn(page);
const accountMenu = (page: Page, user: GitHubUser) =>
  header(page).getByRole("button", { name: `账号：${user.login}` });
const menuItem = (page: Page, name: string) =>
  page.getByRole("menu").getByRole("menuitem", { name });

/** The first sign-in, with an invite code, back in the editor. */
async function signUp(page: Page, user: GitHubUser, code: string) {
  await signInButton(page).click();
  await expect(page).toHaveURL(`${EDITOR}/signup.html`);
  await expect(page.getByText(user.login, { exact: true })).toBeVisible();
  await page.getByLabel("邀请码").fill(code);
  await page.getByRole("button", { name: "继续" }).click();
  await expect(accountMenu(page, user)).toBeVisible();
}

test.describe("signing in", () => {
  // The entry page: nothing of the editor before anybody signed in or chose the offline mode.
  test.use({ withProject: false });

  test.beforeEach(async ({ page }) => {
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
  });

  test("the first time asks for an invite code, turns a wrong one away, and comes to the start page of the online mode", async ({
    page,
    context,
    problems,
  }) => {
    const user = someone();
    await signedInToGitHub(context, user);
    const code = newInvite();
    await expect(page.getByTestId("entry")).toBeVisible();
    await signInButton(page).click();

    await expect(page).toHaveURL(`${EDITOR}/signup.html`);
    await expect(page.getByText(user.login, { exact: true })).toBeVisible();
    await page.getByLabel("邀请码").fill("AAAA-BBBB-CCCC-DDDD");
    await page.getByRole("button", { name: "继续" }).click();
    await expect(page.getByRole("alert")).toContainText("邀请码不对");
    // The browser notes the 400 of the wrong code as a failed load: that one is meant.
    const meant = problems.filter((problem) => /status of 400/.test(problem));
    expect(meant).toHaveLength(1);
    problems.splice(0, problems.length, ...problems.filter((problem) => !meant.includes(problem)));

    await page.getByLabel("邀请码").fill(code.toLowerCase());
    await page.getByRole("button", { name: "继续" }).click();
    await expect(accountMenu(page, user)).toBeVisible();
    // Without the App on the account: the notice says what it is for, with the way to install it.
    await expect(page.getByText(`已登录：${user.login}。要把项目存到 GitHub`)).toBeVisible();
    // The start page of the online mode, with an address that says nothing more about signing in.
    await expect(page.getByTestId("entry")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("signIn")).toBe(false);
    // The picture shows, which the editor's policy allows.
    await expect(accountMenu(page, user).locator("img")).toBeVisible();

    const cookies = await context.cookies(EDITOR);
    expect(cookies.find((cookie) => cookie.name === "__Host-aq_session")).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    });
    const names = cookies.map((cookie) => cookie.name);
    expect(names).not.toContain("__Host-aq_login");
    expect(names).not.toContain("__Host-aq_signup");
  });

  test("someone with an account signs in without a code, and signs out, back to the entry page", async ({
    page,
    context,
  }) => {
    const user = someone();
    await signedInToGitHub(context, user);
    await signUp(page, user, newInvite());

    await accountMenu(page, user).click();
    await expect(menuItem(page, `账号：${user.login}`)).toBeDisabled();
    await menuItem(page, "退出登录").click();
    await expect(page.getByTestId("entry")).toBeVisible();
    await expect(signInButton(page)).toBeVisible();

    await signInButton(page).click();
    await expect(accountMenu(page, user)).toBeVisible();
    expect(page.url()).not.toContain("signup");
  });

  test("without the App, the menu takes people to install it, and back", async ({
    page,
    context,
  }) => {
    const user = someone();
    await signedInToGitHub(context, user);
    await signUp(page, user, newInvite());

    await accountMenu(page, user).click();
    await menuItem(page, "GitHub App：去安装").click();
    // GitHub comes back from installing without a state; a sign-in of the platform's own follows.
    await expect(page.getByText(`已登录：${user.login}`, { exact: true })).toBeVisible();
    await accountMenu(page, user).click();
    await expect(menuItem(page, "GitHub App：已安装")).toBeDisabled();
  });

  test("saying no on GitHub leaves people signed out, at the entry page", async ({
    page,
    context,
  }) => {
    await signedInToGitHub(context, someone(), { deny: true });
    await signInButton(page).click();
    await expect(page.getByText("登录取消了。")).toBeVisible();
    await expect(signInButton(page)).toBeVisible();
  });
});
