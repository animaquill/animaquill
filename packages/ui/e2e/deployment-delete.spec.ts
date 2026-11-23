import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { installChosen } from "./folder-support.ts";
import { cardMenu, openCard, projectCard, statusOf } from "./start-support.ts";
import { editorReady, expect, test } from "./support.ts";
import { createOnline, entrySignIn } from "./online-support.ts";

/**
 * Deleting a project of the platform that is saved to a repository, saving one as a project of
 * this computer, and one whose repository cannot be used, on the real sites through the gateway,
 * with the API, the worker and the fake GitHub, see scripts/e2e-edge and
 * docs/design/start-and-cloud.md 4.3, 5 and 5.1. The switches of the release are on in there
 * (oss/packages/server/src/switches.ts): editors hear that a project was deleted, or cannot be edited, and the
 * platform says when it takes such a project away. Pictures go to the output of each test, for
 * people to look at.
 */

const EDITOR = "https://app.animaquill.com";
const GITHUB = "http://127.0.0.1:8400";
/** What run.sh gives the API, which webhooks are signed with. */
const WEBHOOK_SECRET = "deployment-test-secret";
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
/** What the repository's status says while changes wait to be archived: nothing that stands out. */
const PENDING = "GitHub 仓库待同步";
/** The line of a card that says it, whatever else it says after. */
const PENDING_LINE = /^待同步/;

interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

const someone = (): GitHubUser => {
  const id = randomInt(1_000_000, 2_000_000_000);
  return { id, login: `user-${id}` };
};

const userParam = (user: GitHubUser) => `user=${user.id}.${user.login}`;

const signedInToGitHub = (context: BrowserContext, user: GitHubUser) =>
  context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "delete test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

/** A browser here says it is offline from the start: the test says it is on a network. */
const ON_A_NETWORK = () => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => true,
    configurable: true,
  });
};

const signInButton = (page: Page) => entrySignIn(page);
const accountMenu = (page: Page, user: GitHubUser) =>
  page.locator("header").getByRole("button", { name: `账号：${user.login}` });

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

async function renameTo(page: Page, name: string) {
  await chooseFrom(page, "文件", "重命名项目");
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
}

const cloudStatus = (page: Page) => page.locator("footer [data-cloud-level]");
/** The status of the repository on GitHub: "已同步", "待同步", or what went wrong. */
const githubStatus = (page: Page) => page.locator("footer [data-github]");
const panel = (page: Page) => page.getByRole("dialog", { name: /^在线 · / });
const readOnlyBar = (page: Page) => page.locator("[data-read-only]");
const row = (page: Page, id: string) => panel(page).locator(`[data-cloud-row="${id}"]`);
const action = (page: Page, id: string) => panel(page).locator(`[data-cloud-action="${id}"]`);

async function openPanel(page: Page) {
  if (!(await panel(page).isVisible())) await cloudStatus(page).click();
  await expect(panel(page)).toBeVisible();
  return panel(page);
}

/** A picture of the page, in the output of the test. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** A call of the API from the page, with its session, as the editor makes them. */
const api = (page: Page, path: string, method = "GET") =>
  page.evaluate(
    async ({ path, method }) => {
      const response = await fetch(path, {
        method,
        ...(method !== "GET" && { headers: { "x-animaquill": "1" } }),
      });
      return {
        status: response.status,
        json: (await response.json().catch(() => null)) as any,
      };
    },
    { path, method },
  );

/** Takes out of `problems` what a test meant to happen: the browser logs every answer that says no. */
const meant = (problems: string[], pattern: RegExp) => {
  const kept = problems.filter((problem) => !pattern.test(problem));
  problems.splice(0, problems.length, ...kept);
};

/** Signs in for the first time, with the GitHub App on the account already. */
async function signUp(page: Page, context: BrowserContext, request: APIRequestContext) {
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const user = someone();
  expect((await request.post(`${GITHUB}/_fake/install?${userParam(user)}`)).ok()).toBe(true);
  await signedInToGitHub(context, user);
  await page.addInitScript(ON_A_NETWORK);
  await signInButton(page).click();
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(accountMenu(page, user)).toBeVisible();
  return user;
}

/**
 * Connects the open project into a new repository of this name, and waits for its first archive.
 * Resolves to the project's id on the platform and the repository's number.
 */
async function connect(page: Page, repository: string) {
  await createOnline(page, repository);
  await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
  await expect
    .poll(async () => (await api(page, "/api/projects")).json.projects[0]?.archive?.behind, {
      timeout: 60_000,
    })
    .toBe(false);
  const id = (await api(page, "/api/projects")).json.projects[0].id as string;
  const repo = (await api(page, `/api/projects/${id}/repository`)).json.repository.id as number;
  return { id, repo };
}

/** Hands what the fake GitHub says about a repository to the platform, as GitHub does. */
async function deliver(request: APIRequestContext, repo: number) {
  const deliveries = (await (
    await request.post(`${GITHUB}/_fake/deliveries?repo=${repo}&secret=${WEBHOOK_SECRET}`)
  ).json()) as { body: string; headers: Record<string, string> }[];
  for (const delivery of deliveries) {
    const answer = await request.post(`${EDITOR}/api/github/webhook`, {
      headers: delivery.headers,
      data: delivery.body,
    });
    expect(answer.status()).toBeLessThan(300);
  }
}

/** What the default branch of a repository on the fake GitHub has. */
const filesOn = async (request: APIRequestContext, repo: number) =>
  (await (await request.get(`${GITHUB}/_fake/files?repo=${repo}`)).json()) as Record<
    string,
    string
  >;

/** A browser of its own, signed in as the same person, on the start page. */
async function anotherBrowser(browser: Browser, user: GitHubUser, { folders = false } = {}) {
  const context = await browser.newContext({
    baseURL: EDITOR,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  await signedInToGitHub(context, user);
  await context.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await page.addInitScript(ON_A_NETWORK);
  if (folders) await installChosen(page);
  await page.goto("/");
  await editorReady(page);
  await signInButton(page).click();
  await expect(accountMenu(page, user)).toBeVisible();
  return { context, page, problems };
}

test.describe("deleting a project of the platform that is saved to a repository", () => {
  // The entry page, then the start page of the online mode: projects are made there.
  test.use({ withProject: false });

  test("saves first, then deletes, the copy here goes, the repository stays, and another computer that has it open hears so", async ({
    page,
    context,
    request,
    browser,
    problems,
  }) => {
    test.setTimeout(300_000);
    const user = await signUp(page, context, request);
    const { id, repo } = await connect(page, `delete-${user.id}`);

    // Another computer has it open.
    const other = await anotherBrowser(browser, user);
    try {
      await openCard(other.page, "测试项目");
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "online");

      // A change: the platform has it, its repository not yet: on its way, nothing stands out.
      await renameTo(page, "删除前的名字");
      await expect(githubStatus(page)).toHaveText(PENDING, { timeout: 30_000 });
      await expect(githubStatus(page)).toHaveAttribute("data-github", "pending");
      await expect(cloudStatus(page)).toHaveText("已同步");
      await shot(page, "s1-status-pending");
      await openPanel(page);
      await expect(row(page, "archive").getByRole("status")).toContainText("有新改动");
      await shot(page, "r4-unsaved-panel");
      // ...and once it is saved, that is gone.
      await action(page, "archiveNow").click();
      await expect(row(page, "archive").getByRole("status")).toHaveText("刚刚存过", {
        timeout: 100_000,
      });
      await page.keyboard.press("Escape");
      await expect(cloudStatus(page)).toHaveText("已同步");
      await expect(githubStatus(page)).toHaveText("GitHub 仓库已同步");
      await shot(page, "r4-unsaved-gone");

      // Another change, and the card says it too.
      await renameTo(page, "最后的名字");
      await expect(other.page).toHaveTitle("最后的名字 - AnimaQuill");
      await expect
        .poll(async () => (await api(page, "/api/projects")).json.projects[0].archive.behind)
        .toBe(true);
      await chooseFrom(page, "文件", "关闭项目");
      await expect(statusOf(page, "最后的名字")).toHaveText(PENDING_LINE);
      await expect(statusOf(page, "最后的名字")).toHaveAttribute("data-tone", "plain");
      await shot(page, "r4-card-unsaved");

      // Deleting it says what goes and what stays, and nobody types its name.
      await cardMenu(page, "最后的名字", "删除项目…");
      const deleting = page.getByRole("dialog", {
        name: "删除在线项目“最后的名字”？",
      });
      await expect(deleting).toContainText(`GitHub 仓库 ${user.login}/delete-${user.id} 留着`);
      await expect(deleting).toContainText("这个浏览器里的那一份会清掉");
      await expect(deleting).toContainText("删除之前先把最新的改动存进 GitHub");
      await expect(deleting.getByRole("textbox")).toHaveCount(0);
      await shot(page, "r4-delete-confirm");
      await deleting.getByRole("button", { name: "删除在线项目" }).click();
      await expect(
        page.getByText("已删除在线项目“最后的名字”。这个浏览器里的那一份已清掉。"),
      ).toBeVisible({ timeout: 120_000 });
      await shot(page, "r4-delete-done");
      // Saved first: the repository has the last change, and stays as it is.
      expect(JSON.parse((await filesOn(request, repo))["animaquill.json"] ?? "{}").name).toBe(
        "最后的名字",
      );
      expect((await api(page, "/api/projects")).json.projects).toEqual([]);
      expect((await api(page, `/api/projects/${id}/repository`)).status).toBe(404);
      await expect(projectCard(page, "最后的名字")).toHaveCount(0);

      // The other computer hears it, and keeps its copy as one of that browser only.
      await expect(other.page.getByText(/这个项目已经在别处删除/)).toBeVisible({
        timeout: 60_000,
      });
      await expect(cloudStatus(other.page)).toHaveText("只在浏览器里");
      await shot(other.page, "r4-deleted-elsewhere");
      await chooseFrom(other.page, "文件", "关闭项目");
      await expect(statusOf(other.page, "最后的名字")).toHaveText(/^只在浏览器里/);
      meant(other.problems, /Failed to load resource|WebSocket/);
      expect(other.problems).toEqual([]);
    } finally {
      await other.context.close();
    }
    meant(problems, /Failed to load resource/);
  });

  test("asks before deleting what cannot be saved to the repository, and does only where people say so", async ({
    page,
    context,
    request,
    problems,
  }) => {
    test.setTimeout(300_000);
    const user = await signUp(page, context, request);
    const { repo } = await connect(page, `readonly-${user.id}`);
    // The repository is archived on GitHub: nothing can be written to it any more.
    expect((await request.post(`${GITHUB}/_fake/archived?repo=${repo}&archived=1`)).ok()).toBe(
      true,
    );
    await renameTo(page, "存不进去的");
    await chooseFrom(page, "文件", "关闭项目");
    await cardMenu(page, "存不进去的", "删除项目…");
    await page
      .getByRole("dialog", { name: "删除在线项目“存不进去的”？" })
      .getByRole("button", { name: "删除在线项目" })
      .click();
    const asking = page.getByRole("dialog", {
      name: "删除在线项目“存不进去的”？",
    });
    await expect(asking).toContainText("最新的改动没能存进 GitHub", {
      timeout: 150_000,
    });
    await expect(
      asking.getByRole("button", {
        name: "仍然删除（最后的改动不会进 GitHub）",
      }),
    ).toBeVisible();
    await shot(page, "r4-delete-not-saved");
    // People wait: nothing goes.
    await asking.getByRole("button", { name: "取消" }).click();
    expect((await api(page, "/api/projects")).json.projects).toHaveLength(1);
    await expect(projectCard(page, "存不进去的")).toHaveCount(1);
    // People let go of the last change: it goes as it is.
    await cardMenu(page, "存不进去的", "删除项目…");
    await page
      .getByRole("dialog", { name: "删除在线项目“存不进去的”？" })
      .getByRole("button", { name: "删除在线项目" })
      .click();
    await page
      .getByRole("dialog", { name: "删除在线项目“存不进去的”？" })
      .getByRole("button", { name: "仍然删除（最后的改动不会进 GitHub）" })
      .click({ timeout: 150_000 });
    await expect(page.getByText(/^已删除在线项目“存不进去的”。/)).toBeVisible({
      timeout: 60_000,
    });
    expect((await api(page, "/api/projects")).json.projects).toEqual([]);
    expect(JSON.parse((await filesOn(request, repo))["animaquill.json"] ?? "{}").name).not.toBe(
      "存不进去的",
    );
    meant(problems, /Failed to load resource/);
  });
});

test.describe("a project of the platform whose repository cannot be used", () => {
  test.use({ withProject: false });

  test("cannot be edited, says why and until when, goes on once the repository is back, and is deleted as it is", async ({
    page,
    context,
    request,
    browser,
    problems,
  }) => {
    test.setTimeout(300_000);
    const user = await signUp(page, context, request);
    const { repo } = await connect(page, `gone-${user.id}`);
    const other = await anotherBrowser(browser, user);
    try {
      // Taken out of what the App may reach, on GitHub.
      expect((await request.post(`${GITHUB}/_fake/unselect?repo=${repo}`)).ok()).toBe(true);
      await deliver(request, repo);

      // The project open here cannot be edited from now on: why, how long, and the ways out.
      await expect(readOnlyBar(page)).toContainText("AnimaQuill 不能再访问这个仓库", {
        timeout: 60_000,
      });
      await expect(githubStatus(page)).toHaveText("GitHub 仓库AnimaQuill 不能再访问这个仓库");
      await expect(githubStatus(page)).toHaveAttribute("data-github", "error");
      await shot(page, "r4-readonly-editor");
      // Its properties say so, and nothing in them can be changed.
      await chooseFrom(page, "文件", "重命名项目");
      await expect(page.getByRole("textbox", { name: "项目名称" })).toBeDisabled();
      await expect(page.getByTestId("project-properties-locked")).toContainText(
        "AnimaQuill 不能再访问这个仓库",
      );
      await page.keyboard.press("Escape");
      await expect(page).toHaveTitle("测试项目 - AnimaQuill");
      await readOnlyBar(page).getByRole("button", { name: "看看能做什么…" }).click();
      await expect(panel(page)).toBeVisible();
      await expect(row(page, "repository").getByRole("status")).toContainText(
        "AnimaQuill 不能再访问这个仓库",
      );
      for (const way of ["reauthorize", "switchRepository", "recheck"])
        await expect(row(page, "repository").locator(`[data-cloud-action="${way}"]`)).toBeVisible();
      await expect(action(page, "deleteCloud")).toBeVisible();
      await shot(page, "r4-readonly-panel");
      await page.keyboard.press("Escape");

      // Another computer: the card says why, and a click says what helps.
      await other.page.reload();
      await editorReady(other.page);
      await expect(statusOf(other.page, "测试项目")).toHaveText(/^AnimaQuill 不能再访问这个仓库/);
      await shot(other.page, "r4-card-unusable");
      await openCard(other.page, "测试项目");
      const about = other.page.getByRole("dialog", {
        name: "“测试项目”现在不能打开编辑",
      });
      await expect(about).toContainText(
        "在 GitHub 上把这个仓库加回 AnimaQuill 的授权范围，或者换一个仓库。",
      );
      await shot(other.page, "r4-card-unusable-about");
      await other.page.keyboard.press("Escape");

      // Back on GitHub: once asked again, it can be edited again here.
      expect((await request.post(`${GITHUB}/_fake/select?repo=${repo}`)).ok()).toBe(true);
      await deliver(request, repo);
      await openPanel(page);
      await row(page, "repository").locator('[data-cloud-action="recheck"]').click();
      await expect(readOnlyBar(page)).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByText("仓库能用了，项目可以接着编辑。")).toBeVisible();
      await renameTo(page, "又能改了");
      await expect(page).toHaveTitle("又能改了 - AnimaQuill");
      await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online", {
        timeout: 30_000,
      });
      await expect
        .poll(async () => (await api(page, "/api/projects")).json.projects[0].name)
        .toBe("又能改了");

      // Gone again, and deleted as it is: nothing to save first.
      expect((await request.post(`${GITHUB}/_fake/unselect?repo=${repo}`)).ok()).toBe(true);
      await deliver(request, repo);
      await expect(readOnlyBar(page)).toBeVisible({ timeout: 60_000 });
      await openPanel(page);
      await action(page, "deleteCloud").click();
      const deleting = page.getByRole("dialog", {
        name: "删除在线项目“又能改了”？",
      });
      await expect(deleting).toContainText(
        "AnimaQuill 不能再访问这个仓库。服务器上的这份和清单里的这一项会删掉，GitHub 那边什么都不动。",
      );
      // The rename is on the platform and not in the repository: people hear that it goes with it.
      await expect(deleting).toContainText(
        "服务器上还有改动没存进 GitHub，删除后服务器上的这份就没有了。想留下可以先“保存到文件夹”。",
      );
      await expect(deleting).toContainText("这个浏览器里的那一份留下，以后只在这个浏览器里。");
      await shot(page, "r4-delete-unusable-confirm");
      await deleting.getByRole("button", { name: "删除在线项目" }).click();
      await expect(
        page.getByText(/^已删除在线项目“又能改了”。这个浏览器里的那一份留下了/),
      ).toBeVisible({
        timeout: 60_000,
      });
      expect((await api(page, "/api/projects")).json.projects).toEqual([]);
      // Nothing else may have what it had: it stays, open, as a project of this browser only.
      await expect(readOnlyBar(page)).toHaveCount(0);
      await expect(cloudStatus(page)).toHaveText("只在浏览器里");
      await expect(page).toHaveTitle("又能改了 - AnimaQuill");
      await shot(page, "r4-delete-unusable-kept");
      meant(other.problems, /Failed to load resource|WebSocket/);
      expect(other.problems).toEqual([]);
    } finally {
      await other.context.close();
    }
    meant(problems, /Failed to load resource|WebSocket/);
  });
});
