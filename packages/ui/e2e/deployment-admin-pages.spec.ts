import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * The pages of the admin site (apps/admin) on the real sites, through the gateway, with its policy:
 * going in from the editor, the overview, people, invite codes, the record, and going out. Its API on
 * its own is deployment-admin.spec.ts. Each test is a GitHub user of its own, see scripts/e2e-edge.
 * The pictures go to test-results/admin-pages, for people to look at.
 */

const EDITOR = "https://app.animaquill.com";
const ADMIN = "https://admin.animaquill.com";
const GITHUB = "http://127.0.0.1:8400";
const SHOTS = "test-results/admin-pages";
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
  const code = /邀请码：(\S+)/.exec(command("invite", "create", "--note", "admin pages test"))?.[1];
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

/** Takes out of `problems` what a test meant to happen. */
const meant = (problems: string[], pattern: RegExp) => {
  problems.splice(0, problems.length, ...problems.filter((problem) => !pattern.test(problem)));
};

/**
 * Every violation of a policy in the browser, on every page, as the page itself hears of it: the
 * console does not show all of them.
 */
async function watchPolicies(context: BrowserContext) {
  const violations: string[] = [];
  await context.exposeBinding("aqPolicyViolation", (_source, text: string) => {
    violations.push(text);
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void (
        window as unknown as { aqPolicyViolation: (text: string) => Promise<void> }
      ).aqPolicyViolation(`${location.href}: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

/** Signed out of the admin site: the way in, and nothing of what is behind it. */
async function expectOnlyTheWayIn(page: Page) {
  const wayIn = page.getByRole("link", { name: "进入后台" });
  await expect(wayIn).toBeVisible();
  await expect(page.getByRole("navigation", { name: "后台的页面" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "退出" })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(0);
  return wayIn;
}

/** Someone new, signed in to the editor, made an admin on the server, and into the admin site. */
async function goIn(page: Page, context: BrowserContext) {
  const user = someone();
  await signedInToGitHub(context, user);
  await signUp(page, user);
  expect(command("role", "grant", user.login)).toContain("现在是管理员了");
  await page.goto(`${ADMIN}/`);
  await (await expectOnlyTheWayIn(page)).click();
  await expect(page).toHaveURL(`${ADMIN}/`);
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
  return user;
}

const go = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "后台的页面" }).getByRole("link", { name }).click();

const userRow = (page: Page, login: string) => page.locator(`tr[data-login="${login}"]`);

async function search(page: Page, login: string) {
  await page.getByRole("searchbox", { name: "按登录名搜索" }).fill(login);
  await page.getByRole("button", { name: "搜索" }).click();
  await expect(page.getByText(`登录名包含“${login}”的账号`)).toBeVisible();
}

/** The rows of the record about something, the newest first. */
const recordOf = (page: Page, ...texts: string[]) => {
  let rows = page.locator("table.actions tbody tr");
  for (const text of texts) rows = rows.filter({ hasText: text });
  return rows;
};

test.describe("the pages of the admin site", () => {
  test.use({ withProject: false });

  test.beforeEach(async ({ page }) => {
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
  });

  test("nobody signed in sees only the way in; an admin goes in from the editor to the overview, and out", async ({
    page,
    context,
    problems,
  }) => {
    const violations = await watchPolicies(context);
    const user = someone();
    await signedInToGitHub(context, user);
    await signUp(page, user);
    command("role", "grant", user.login);

    // Not signed in to the admin site yet, on any of its pages: only the way in, back to that page.
    await page.goto(`${ADMIN}/users`);
    const wayIn = await expectOnlyTheWayIn(page);
    expect(await wayIn.getAttribute("href")).toBe("/api/admin/sign-in?to=%2Fusers");
    await page.goto(`${ADMIN}/`);
    await expectOnlyTheWayIn(page);
    await shot(page, "signed-out");

    // In, through the editor, which this browser signed in to just now.
    await page.getByRole("link", { name: "进入后台" }).click();
    await expect(page).toHaveURL(`${ADMIN}/`);
    await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
    await expect(page.getByRole("article", { name: "版本" })).toContainText("dev");
    await expect(page.getByRole("article", { name: "数据库" })).toContainText("正常");
    await expect(page.getByRole("article", { name: "磁盘" })).toContainText("已用");
    await expect(page.getByRole("article", { name: "内存" })).toContainText("已用");
    await expect(page.getByRole("article", { name: "用户" })).toContainText("管理员");
    await expect(page.getByRole("article", { name: "项目" })).toContainText("共占用");
    await expect(page.getByRole("article", { name: "在线连接" })).toContainText("打开着的项目");
    const me = page.getByLabel("当前管理员");
    await expect(me).toContainText(user.login);
    await expect(me).toContainText("到期");
    await shot(page, "overview");

    // A page of the app by its address, and through the history of the browser.
    await page.goto(`${ADMIN}/invites`);
    await expect(page.getByRole("heading", { name: "邀请码", exact: true })).toBeVisible();
    await go(page, "操作记录");
    await expect(page).toHaveURL(`${ADMIN}/actions`);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "邀请码", exact: true })).toBeVisible();

    // Out, and out it stays.
    await page.getByRole("button", { name: "退出" }).click();
    await expect(page.getByText("已退出后台。")).toBeVisible();
    await expectOnlyTheWayIn(page);
    expect((await context.cookies(ADMIN)).map(({ name }) => name)).not.toContain("__Host-aq_admin");
    await page.reload();
    await expectOnlyTheWayIn(page);
    // The editor stays signed in.
    await page.goto(EDITOR);
    await expect(
      page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
    ).toBeVisible();

    // What the browser notes of the API saying nobody is signed in.
    meant(problems, /status of 401/);
    expect(violations).toEqual([]);
  });

  test("an admin finds someone, disables them, which signs them out of the editor, and enables them again", async ({
    page,
    context,
    browser,
    problems,
  }) => {
    const violations = await watchPolicies(context);
    // Someone else, signed in to the editor in a browser of their own, and an admin as well.
    const other = someone();
    const theirs = await browser.newContext({
      baseURL: EDITOR,
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
    });
    await signedInToGitHub(theirs, other);
    await theirs.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
    await theirs.addInitScript(() => {
      if (window !== window.top) return;
      try {
        localStorage.setItem("animaquill.projectsInBrowser", "yes");
      } catch {}
    });
    const theirPage = await theirs.newPage();
    await theirPage.goto("/");
    await signUp(theirPage, other);
    command("role", "grant", other.login);
    const theirSession = async () =>
      (
        (await (await theirs.request.get(`${EDITOR}/api/auth/session`)).json()) as {
          status: string;
        }
      ).status;
    expect(await theirSession()).not.toBe("signedOut");

    const admin = await goIn(page, context);
    await go(page, "用户");
    await expect(page).toHaveURL(`${ADMIN}/users`);
    await expect(userRow(page, admin.login)).toBeVisible();
    await shot(page, "users");

    // Not themselves: the button says no, and why.
    await search(page, admin.login);
    const mine = userRow(page, admin.login);
    await expect(mine.getByRole("button", { name: "停用" })).toBeDisabled();
    await expect(mine).toContainText("不能停用自己");
    await expect(mine.getByRole("button", { name: "停用" })).toHaveAccessibleDescription(
      /不能停用自己/,
    );

    // The other one, by their login.
    await search(page, other.login);
    await expect(page.locator("table.users tbody tr")).toHaveCount(1);
    const row = userRow(page, other.login);
    await expect(row).toContainText("正常");
    await expect(row).toContainText("管理员");

    // Disabling asks first, with a reason.
    await row.getByRole("button", { name: "停用" }).click();
    const asking = page.getByRole("dialog", { name: `停用 ${other.login}？` });
    await expect(asking).toBeVisible();
    const disable = asking.getByRole("button", { name: "停用" });
    await expect(disable).toBeDisabled();
    await asking.getByLabel("原因").fill("页面测试：先停用");
    await expect(disable).toBeEnabled();
    await shot(page, "disable-confirm");
    await disable.click();
    await expect(asking).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(`已停用 ${other.login}。`);
    await expect(row).toContainText("已停用");
    await expect(row).toContainText("页面测试：先停用");
    // Their editor is signed out.
    expect(await theirSession()).toBe("signedOut");

    // Enabling asks too, and says the admin site comes back with it.
    await row.getByRole("button", { name: "恢复" }).click();
    const enabling = page.getByRole("dialog", { name: `恢复 ${other.login}？` });
    await expect(enabling).toContainText("会同时恢复他的后台权限");
    await shot(page, "enable-confirm");
    await enabling.getByRole("button", { name: "恢复" }).click();
    await expect(enabling).toHaveCount(0);
    await expect(row).toContainText("正常");

    // Signing them out everywhere asks first as well; saying no changes nothing.
    await row.getByRole("button", { name: "退出所有设备" }).click();
    const out = page.getByRole("dialog", { name: `让 ${other.login} 退出所有设备？` });
    await out.getByRole("button", { name: "取消" }).click();
    await expect(out).toHaveCount(0);

    // On a phone: the rows are cards, and nothing is wider than the screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row.getByRole("button", { name: "恢复" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "停用" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await shot(page, "users-narrow");
    await page.setViewportSize({ width: 1440, height: 900 });

    // The record has all of it: who, what, to whom, and the command line for what it did.
    await go(page, "操作记录");
    await expect(recordOf(page, other.login, "停用账号", admin.login)).toContainText(
      "原因：页面测试：先停用",
    );
    await expect(recordOf(page, other.login, "恢复账号", admin.login)).toHaveCount(1);
    await expect(recordOf(page, other.login, "授予管理员")).toContainText("命令行");
    await expect(recordOf(page, "进入后台", admin.login)).toHaveCount(1);

    await theirs.close();
    meant(problems, /status of 401/);
    expect(violations).toEqual([]);
  });

  test("an invite code is made and shown once, and revoked; the record has both", async ({
    page,
    context,
    problems,
  }) => {
    const violations = await watchPolicies(context);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ADMIN });
    const admin = await goIn(page, context);
    await go(page, "邀请码");
    const note = `给 ${admin.login} 的朋友`;
    const form = page.getByRole("form", { name: "新建邀请码" });
    await form.getByLabel("备注").fill(note);
    await form.getByLabel("可用次数").fill("2");
    await form.getByLabel("有效天数").fill("7");
    await form.getByRole("button", { name: "新建邀请码" }).click();

    const shown = page.getByRole("dialog", { name: "邀请码已生成" });
    await expect(shown).toBeVisible();
    const code = (await shown.getByLabel("邀请码", { exact: true }).textContent()) ?? "";
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    await expect(shown).toContainText("关掉就看不到了");
    await shown.getByRole("button", { name: "复制" }).click();
    await expect(shown.getByRole("button", { name: "已复制" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await shot(page, "invite-created");
    await shown.getByRole("button", { name: "我已保存，关闭" }).click();
    await expect(shown).toHaveCount(0);
    // Nowhere any more, not even after asking again.
    await expect(page.getByText(code)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "邀请码", exact: true })).toBeVisible();

    const row = page.locator("table.invites tbody tr").filter({ hasText: note });
    await expect(row).toContainText("可用");
    await expect(row).toContainText("0 / 2");
    await expect(page.getByText(code)).toHaveCount(0);

    await row.getByRole("button", { name: "作废" }).click();
    const asking = page.getByRole("dialog", { name: "作废这个邀请码？" });
    await expect(asking).toContainText(note);
    await asking.getByRole("button", { name: "作废" }).click();
    await expect(asking).toHaveCount(0);
    await expect(row).toContainText("已作废");
    await expect(row.getByRole("button", { name: "作废" })).toHaveCount(0);

    await go(page, "操作记录");
    await expect(recordOf(page, "新建邀请码", note, admin.login)).toContainText("可用 2 次");
    await expect(recordOf(page, "作废邀请码", note, admin.login)).toHaveCount(1);
    await expect(recordOf(page, "授予管理员", admin.login)).toContainText("命令行");
    await shot(page, "actions");
    // Nothing secret in the record either.
    await expect(page.getByText(code)).toHaveCount(0);

    meant(problems, /status of 401/);
    expect(violations).toEqual([]);
  });
});
