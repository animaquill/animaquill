import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * The pages of cloud AI on the admin site (apps/admin, docs/design/phase6-plan.md 3.7) on the real
 * sites, through the gateway, with its policy: the settings of AI, the servers, the tasks, and what
 * one person may. There is no runner in here: what a runner does, the tests do with the runner's API,
 * as one would. The other pages of the admin site are deployment-admin-pages.spec.ts. Each test is a
 * GitHub user of its own, see scripts/e2e-edge. The pictures go to test-results/admin-ai.
 */

const EDITOR = "https://app.animaquill.com";
const ADMIN = "https://admin.animaquill.com";
const GITHUB = "http://127.0.0.1:8400";
const SHOTS = "test-results/admin-ai";
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
  const code = /邀请码：(\S+)/.exec(command("invite", "create", "--note", "admin ai test"))?.[1];
  if (!code) throw new Error("no invite code");
  return code;
};

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

/** Someone new, signed in to the editor, made an admin on the server, and into the admin site. */
async function goIn(page: Page, context: BrowserContext) {
  const user = someone();
  await signedInToGitHub(context, user);
  await signUp(page, user);
  expect(command("role", "grant", user.login)).toContain("现在是管理员了");
  await page.goto(`${ADMIN}/`);
  await page.getByRole("link", { name: "进入后台" }).click();
  await expect(page).toHaveURL(`${ADMIN}/`);
  await expect(page.getByRole("heading", { name: "概览" })).toBeVisible();
  return user;
}

const go = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "后台的页面" })
    .getByRole("link", { name, exact: true })
    .click();

/** What the admin site's pages ask of its API, with what such a page sends along. */
const ask = async (page: Page, path: string, method = "GET", body?: unknown) => {
  const response = await page.context().request.fetch(`${ADMIN}/api/admin${path}`, {
    method,
    headers: method === "GET" ? {} : { origin: ADMIN, "x-animaquill": "1" },
    ...(body !== undefined && { data: body }),
  });
  const text = await response.text();
  return { status: response.status(), body: text ? JSON.parse(text) : undefined };
};

/** What a runner says to the platform, through the gateway, as a runner on another machine does. */
const runner = async (page: Page, path: string, body: unknown, credential?: string) => {
  const response = await page.context().request.post(`${EDITOR}/api/runner${path}`, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
    data: body,
  });
  expect(response.status(), path).toBe(200);
  return response.json();
};

/** The rows of the record about something, the newest first. */
const recordOf = (page: Page, ...texts: string[]) => {
  let rows = page.locator("table.actions tbody tr");
  for (const text of texts) rows = rows.filter({ hasText: text });
  return rows;
};

const serverRow = (page: Page, name: string) => page.locator(`tr[data-server="${name}"]`);
const newServerName = () => `t-${randomInt(1_000_000, 2_000_000_000)}`;

test.describe("the pages of cloud AI on the admin site", () => {
  test.use({ withProject: false });

  test.beforeEach(async ({ page }) => {
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
  });

  test("the settings of AI: what a change changes is shown and asked, it reads back the same, and a page that is out of date is told to refresh", async ({
    page,
    context,
    problems,
  }) => {
    const violations = await watchPolicies(context);
    const admin = await goIn(page, context);
    const before = (await ask(page, "/ai/settings")).body;
    const at = before.settings;

    // The overview has the switch, and what runs and waits.
    const figure = page.getByRole("article", { name: "云端 AI" });
    await expect(figure).toContainText(at.enabled ? "开" : "关");
    await expect(figure).toContainText("运行中");
    await expect(figure).toContainText("本月用时");

    await go(page, "AI 设置");
    await expect(page).toHaveURL(`${ADMIN}/ai`);
    await expect(page.getByRole("heading", { name: "AI 设置" })).toBeVisible();
    await expect(
      page.getByText("关掉总开关时，排队的任务马上取消，正在跑的任务也会停下"),
    ).toBeVisible();
    await expect(page.getByText("内存超过 2 GB 的按倍数算")).toBeVisible();
    const tasks = page.getByLabel("同时几个任务", { exact: true });
    const monthly = page.getByLabel("每月额度（AI 用时）");
    await expect(tasks).toHaveValue(String(at.userTasks));
    await expect(page.getByRole("button", { name: "保存…" })).toBeDisabled();

    // Something it does not take is said at once, and nothing goes.
    await tasks.fill("0");
    await expect(page.getByText("范围是 1 到 100 个。")).toBeVisible();
    await expect(page.getByRole("button", { name: "保存…" })).toBeDisabled();

    const userTasks = at.userTasks >= 100 ? 99 : at.userTasks + 1;
    const hours = at.monthlyMinutes === 30 * 60 ? 31 : 30;
    await tasks.fill(String(userTasks));
    await monthly.fill(String(hours));
    await expect(page.getByText("改了 2 项，还没保存。")).toBeVisible();
    await shot(page, "ai-settings");
    await page.getByRole("button", { name: "保存…" }).click();
    const asking = page.getByRole("dialog", { name: "保存 AI 设置的这些改动？" });
    const changes = asking.getByRole("list", { name: "改动" });
    await expect(changes.getByRole("listitem")).toHaveCount(2);
    await expect(changes).toContainText(`同时几个任务：${at.userTasks} 个 → ${userTasks} 个`);
    await expect(changes).toContainText(`每月额度（AI 用时）：`);
    await expect(changes).toContainText(`→ ${hours} 小时`);
    await shot(page, "ai-settings-confirm");
    await asking.getByRole("button", { name: "确认保存" }).click();
    await expect(asking).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(
      `已保存，现在是第 ${before.version + 1} 版。`,
    );

    // As the platform has it, and as the page shows it again.
    const after = (await ask(page, "/ai/settings")).body;
    expect(after.version).toBe(before.version + 1);
    expect(after.settings).toEqual({ ...at, userTasks, monthlyMinutes: hours * 60 });
    await page.reload();
    await expect(page.getByLabel("同时几个任务", { exact: true })).toHaveValue(String(userTasks));
    await expect(page.getByLabel("每月额度（AI 用时）")).toHaveValue(String(hours));
    await expect(page.getByText(`第 ${after.version} 版`)).toBeVisible();

    // Someone else changes them meanwhile: this page's change is not written, and it says why.
    await page.getByLabel("等追问的时长").fill(String(after.settings.idleMinutes + 1));
    const elsewhere = await ask(page, "/ai/settings", "PUT", {
      idleMinutes: after.settings.idleMinutes + 2,
      version: after.version,
    });
    expect(elsewhere.status).toBe(200);
    await page.getByRole("button", { name: "保存…" }).click();
    await page
      .getByRole("dialog", { name: "保存 AI 设置的这些改动？" })
      .getByRole("button", { name: "确认保存" })
      .click();
    const stale = page.getByRole("alert").filter({ hasText: "被别人改过了" });
    await expect(stale).toContainText(`现在是第 ${after.version + 1} 版`);
    await expect(stale).toContainText("你的修改没有保存");
    await shot(page, "ai-settings-conflict");
    expect((await ask(page, "/ai/settings")).body.settings.idleMinutes).toBe(
      after.settings.idleMinutes + 2,
    );
    await stale.getByRole("button", { name: "刷新" }).click();
    await expect(stale).toHaveCount(0);
    await expect(page.getByLabel("等追问的时长")).toHaveValue(
      String(after.settings.idleMinutes + 2),
    );

    // The record says who changed them to what.
    await go(page, "操作记录");
    await expect(recordOf(page, "修改设置", "AI 设置", admin.login).first()).toContainText(
      `每人同时 ${userTasks} 个`,
    );

    // As they were, for whatever runs after this.
    expect((await ask(page, "/ai/settings", "PUT", at)).status).toBe(200);
    meant(problems, /status of (401|409)/);
    expect(violations).toEqual([]);
  });

  test("servers: a new one shows its code once, a self-test without a runner waits in the queue, disabling asks first, and deleting one whose runner holds a task asks twice", async ({
    page,
    context,
    problems,
  }) => {
    const violations = await watchPolicies(context);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ADMIN });
    const admin = await goIn(page, context);
    await go(page, "服务器");
    await expect(page.getByRole("heading", { name: "服务器", exact: true })).toBeVisible();

    const name = newServerName();
    const form = page.getByRole("form", { name: "添加远程服务器" });
    await form.getByLabel("名字").fill(name);
    await form.getByLabel("同时几个任务").fill("3");
    await form.getByLabel("内存").fill("6");
    await form.getByLabel("CPU").fill("2.5");
    await form.getByRole("button", { name: "添加服务器" }).click();

    const shown = page.getByRole("dialog", { name: `服务器 ${name} 已添加` });
    await expect(shown).toBeVisible();
    const code = (await shown.getByLabel("登记码", { exact: true }).textContent()) ?? "";
    expect(code).toMatch(/^aqe_[A-Za-z0-9_-]{32,}$/);
    await expect(shown).toContainText("只显示这一次");
    await shown.getByRole("button", { name: "复制" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await shot(page, "server-code");
    await shown.getByRole("button", { name: "我已保存，关闭" }).click();
    await expect(shown).toHaveCount(0);
    await expect(page.getByText(code)).toHaveCount(0);
    await page.reload();
    const row = serverRow(page, name);
    await expect(row).toContainText("还没登记");
    await expect(row).toContainText("同时 3 个");
    await expect(row).toContainText("内存 6 GB，CPU 2.5 核");
    await expect(row).toContainText("runner 还没报告");
    await expect(page.getByText(code)).toHaveCount(0);
    expect(JSON.stringify((await ask(page, "/servers")).body)).not.toContain(code);

    // A self-test, with no runner: it waits, and says so, and nothing turns for ever.
    await row.getByRole("button", { name: "运行自检" }).click();
    const testing = page.getByRole("dialog", { name: `在 ${name} 上运行自检？` });
    await expect(testing).toContainText("现在不在线");
    await testing.getByRole("button", { name: "运行自检" }).click();
    await expect(testing).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("在排队：排队第 1 位");
    const selftest = row.locator('td[data-label="最近一次自检"]');
    await expect(selftest).toContainText("排队中");
    await expect(selftest).toContainText("排队第 1 位，没有能接手的服务器在线");
    // The page looks again by itself while it waits, and is done each time.
    await page.waitForTimeout(6000);
    await expect(selftest).toContainText("排队中");
    await expect(page.getByRole("button", { name: "刷新" })).toBeEnabled();
    await expect(page.getByText("正在读取…")).toHaveCount(0);
    await shot(page, "servers");

    // Its runner enrolls, with what it says of itself, and takes the self-test.
    const { credential } = await runner(page, "/enroll", {
      code,
      facts: {
        runtime: { name: "runsc-aq", version: "release-20261102.0", gvisor: true },
        ready: false,
        problems: ["the image of pi is not here"],
      },
    });
    const work = await runner(page, "/poll", { tasks: [], wait: false }, credential);
    const taskId: string = work.assign[0].task;
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(row).toContainText("在线");
    // Self-tests are not what the server runs for people.
    await expect(row.locator('td[data-label="正在跑"]')).toContainText("0 个");
    await expect(selftest).toContainText("已分配");
    const facts = row.locator('td[data-label="环境"]');
    await expect(facts).toContainText("不就绪");
    await expect(facts).toContainText("gVisor release-20261102.0");
    await expect(facts).toContainText("the image of pi is not here");
    await shot(page, "servers-runner");

    // Disabling asks first; no is no.
    await row.getByRole("button", { name: "停用" }).click();
    let disabling = page.getByRole("dialog", { name: `停用服务器 ${name}？` });
    await expect(disabling).toContainText("正在跑的任务会停下（现在有 1 个）");
    await disabling.getByRole("button", { name: "取消" }).click();
    await expect(disabling).toHaveCount(0);
    await expect(row.locator('td[data-label="状态"]')).toContainText("启用");
    await row.getByRole("button", { name: "停用" }).click();
    disabling = page.getByRole("dialog", { name: `停用服务器 ${name}？` });
    await disabling.getByRole("button", { name: "停用" }).click();
    await expect(disabling).toHaveCount(0);
    await expect(row.locator('td[data-label="状态"]')).toContainText("已停用");
    // Its runner is gone and does not let go of the self-test: it is still on the server.
    await expect(selftest).toContainText("停止中");

    // Deleting it asks, and then, as it holds a task, asks again, with its name.
    await row.getByRole("button", { name: "删除" }).click();
    const first = page.getByRole("dialog", { name: `删除服务器 ${name}？` });
    await expect(first).toContainText("还有 1 个任务没停下");
    await first.getByRole("button", { name: "继续强制删除…" }).click();
    const second = page.getByRole("dialog", { name: `强制删除服务器 ${name}？` });
    await expect(second).toContainText("上面的任务会结束");
    const force = second.getByRole("button", { name: "强制删除" });
    await expect(force).toBeDisabled();
    await second.getByLabel(`输入服务器的名字 ${name} 确认`).fill("not it");
    await expect(force).toBeDisabled();
    await second.getByLabel(`输入服务器的名字 ${name} 确认`).fill(name);
    await shot(page, "server-force-delete");
    await force.click();
    await expect(second).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(`已强制删除服务器 ${name}`);
    await expect(row).toHaveCount(0);

    // Its self-tests went with it (apps/api/src/admin/ai.ts, `deleteServer`), the one it held too.
    await go(page, "任务");
    await expect(page.getByRole("heading", { name: "任务", exact: true })).toBeVisible();
    await expect(page.locator("table.tasks, p.muted").first()).toBeVisible();
    await expect(page.locator(`tr[data-task="${taskId}"]`)).toHaveCount(0);

    await go(page, "操作记录");
    await expect(recordOf(page, "添加服务器", name, admin.login)).toContainText("同时 3 个");
    await expect(recordOf(page, "运行自检", name, admin.login)).toHaveCount(1);
    await expect(recordOf(page, "修改服务器", name, admin.login)).toContainText("已停用");
    await expect(recordOf(page, "删除服务器", name, admin.login)).toContainText(
      "强制删除，结束 1 个任务",
    );
    await expect(page.getByText(code)).toHaveCount(0);

    meant(problems, /status of 401/);
    expect(violations).toEqual([]);
  });

  test("tasks: one that waits is found by its state and stopped, after asking", async ({
    page,
    context,
    problems,
  }) => {
    const violations = await watchPolicies(context);
    const admin = await goIn(page, context);
    // A task that waits, as the platform makes them: a self-test of a server with no runner.
    const name = newServerName();
    const made = await ask(page, "/servers", "POST", {
      name,
      maxTasks: 1,
      memoryMb: 4096,
      cpus: 2,
    });
    expect(made.status).toBe(201);
    const started = await ask(page, `/servers/${made.body.server.id}/selftest`, "POST");
    expect(started.status).toBe(201);
    const taskId: string = started.body.task;

    await go(page, "任务");
    await expect(page.getByRole("heading", { name: "任务", exact: true })).toBeVisible();
    const filters = page.getByRole("group", { name: "按状态筛选" });
    await filters.getByRole("button", { name: "排队" }).click();
    await expect(filters.getByRole("button", { name: "排队" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const row = page.locator(`tr[data-task="${taskId}"]`);
    await expect(row).toContainText("排队中");
    await expect(row).toContainText(admin.login);
    await expect(row).toContainText("自检");
    await expect(row).toContainText(name);
    await expect(row).toContainText("512 MB");
    await expect(row).toContainText("还没开始");
    await expect(row).toContainText("排队第 1 位");
    await shot(page, "tasks");
    // Not among those that run.
    await filters.getByRole("button", { name: "运行" }).click();
    await expect(filters.getByRole("button", { name: "运行" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(row).toHaveCount(0);
    await filters.getByRole("button", { name: "排队" }).click();

    await row.getByRole("button", { name: "停止" }).click();
    const asking = page.getByRole("dialog", { name: "停止这个任务？" });
    await expect(asking).toContainText("排队的任务直接取消");
    await shot(page, "task-stop-confirm");
    await asking.getByRole("button", { name: "停止" }).click();
    await expect(asking).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("已取消这个排队的任务");
    await expect(row).toHaveCount(0);
    await filters.getByRole("button", { name: "结束" }).click();
    await expect(row).toContainText("已停止");
    await expect(row).toContainText("管理员停止");
    await expect(row.getByRole("button", { name: "停止" })).toHaveCount(0);

    await go(page, "操作记录");
    await expect(recordOf(page, "停止任务", admin.login)).toContainText("排队的直接取消");

    // Gone again, server and all.
    expect(
      (await ask(page, `/servers/${made.body.server.id}`, "PATCH", { state: "disabled" })).status,
    ).toBe(200);
    expect((await ask(page, `/servers/${made.body.server.id}`, "DELETE")).status).toBe(204);
    meant(problems, /status of 401/);
    expect(violations).toEqual([]);
  });

  test("a person is let in to cloud AI from the users page, with what they may and used", async ({
    page,
    context,
    browser,
    problems,
  }) => {
    const violations = await watchPolicies(context);
    // Someone else, with an account of their own.
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
    const theirPage = await theirs.newPage();
    await theirPage.goto("/");
    await signUp(theirPage, other);
    await theirs.close();

    const admin = await goIn(page, context);
    const everyone = (await ask(page, "/ai/settings")).body.settings;
    await go(page, "用户");
    await page.getByRole("searchbox", { name: "按登录名搜索" }).fill(other.login);
    await page.getByRole("button", { name: "搜索" }).click();
    const row = page.locator(`tr[data-login="${other.login}"]`);
    const ai = row.locator('td[data-label="AI"]');
    await expect(ai).toContainText("按全体设置");
    await expect(ai).toContainText("本月 0 分钟");

    await row.getByRole("button", { name: "AI 设置" }).click();
    const dialog = page.getByRole("dialog", { name: `${other.login} 的 AI 设置` });
    await expect(dialog).toContainText(
      everyone.access === "granted" ? "不能用（没有开通）" : "现在：能用",
    );
    await expect(dialog).toContainText("本月 AI 用时 0 分钟");
    await expect(dialog).toContainText("正在跑 0 个任务");
    const confirm = dialog.getByRole("button", { name: "确认修改" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel("能不能用").selectOption("allow");
    await dialog.getByLabel("同时几个任务").fill("2");
    await dialog.getByLabel("每月额度（AI 用时）").fill("5");
    await dialog.getByLabel("备注（给管理员看）").fill("内测");
    const changes = dialog.getByRole("list", { name: "改动" });
    await expect(changes).toContainText("能不能用：按全体设置 → 开通");
    await expect(changes).toContainText("同时几个任务：按全体 → 2 个");
    await expect(changes).toContainText("每月额度（AI 用时）：按全体 → 5 小时");
    await shot(page, "user-ai");
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(`已修改 ${other.login} 的 AI 设置。`);
    await expect(ai).toContainText("开通");

    // Read back, as the platform has it.
    await row.getByRole("button", { name: "AI 设置" }).click();
    const again = page.getByRole("dialog", { name: `${other.login} 的 AI 设置` });
    await expect(again).toContainText(everyone.enabled ? "现在：能用" : "总开关关着");
    await expect(again).toContainText("同时 2 个");
    await expect(again).toContainText("额度 5 小时");
    await expect(again.getByLabel("能不能用")).toHaveValue("allow");
    await expect(again.getByLabel("同时几个任务")).toHaveValue("2");
    await expect(again.getByLabel("单个任务的内存上限")).toHaveValue("");
    await again.getByRole("button", { name: "取消" }).click();

    await go(page, "操作记录");
    await expect(recordOf(page, "修改用户的 AI 设置", other.login, admin.login)).toContainText(
      "能不能用：开通，同时 2 个，每月 5 小时，备注：内测",
    );

    meant(problems, /status of 401/);
    expect(violations).toEqual([]);
  });
});
