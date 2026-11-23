import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { installChosen } from "./folder-support.ts";
import { editorReady, expect, tab, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * Making a new project, on the real sites through the gateway (docs/design/start-and-cloud.md, 3):
 * a project of the platform in one press, platform first, with its repository, kept in this browser
 * and opened; a name that is taken, before anything is made; giving up, which leaves nothing on the
 * platform; a browser that cannot open folders, which can only make projects of the platform and
 * signs in first; and a project only in this browser from before, which says that it is not safe.
 * The API with its database, the worker and a fake GitHub, see scripts/e2e-edge. Each test is a
 * GitHub user of its own. Pictures go to the output of each test, for people to look at.
 */

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

const userParam = (user: GitHubUser) => `user=${user.id}.${user.login}`;

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "create test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

/** This container has no network but the computer's own: the page says it is on one. */
const ON_A_NETWORK = () => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => true,
    configurable: true,
  });
};

/** A browser that cannot open folders on the computer, as Firefox and Safari: by its interface. */
const NO_FOLDERS = () => {
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
};

const newDialog = (page: Page) => page.locator("dialog[data-create-phase]");
const step = (page: Page, id: string) => newDialog(page).locator(`[data-step="${id}"]`);
const repositoryName = (page: Page) => newDialog(page).getByRole("textbox", { name: "仓库名" });
const submit = (page: Page) => newDialog(page).getByRole("button", { name: /^(新建|再试一次)$/ });
const cloudStatus = (page: Page) => page.locator("footer [data-cloud-level]");
const accountMenu = (page: Page, user: GitHubUser) =>
  page.locator("header").getByRole("button", { name: `账号：${user.login}` });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const api = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const response = await fetch(path);
    return (await response.json()) as any;
  }, path);

const makeRepo = async (request: APIRequestContext, user: GitHubUser, name: string) => {
  const response = await request.post(`${GITHUB}/_fake/repo?${userParam(user)}&name=${name}`);
  expect(response.ok()).toBe(true);
};

/**
 * A page as people get it, with the GitHub App on a new account and not signed in yet: no tests'
 * projects in the browser. `folders`: whether the browser can open folders on the computer.
 */
async function freshPage(
  browser: Browser,
  request: APIRequestContext,
  { folders }: { readonly folders: boolean },
) {
  const user = someone();
  expect((await request.post(`${GITHUB}/_fake/install?${userParam(user)}`)).ok()).toBe(true);
  const context: BrowserContext = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);
  const page = await context.newPage();
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await page.addInitScript(ON_A_NETWORK);
  if (folders) await installChosen(page);
  else await page.addInitScript(NO_FOLDERS);
  await page.goto("/");
  await editorReady(page);
  return { user, context, page, problems };
}

/** Signs in for the first time from the title bar. */
async function signUp(page: Page, user: GitHubUser) {
  await entrySignIn(page).click();
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(accountMenu(page, user)).toBeVisible();
}

/** Takes out of `problems` what a test meant to happen: the browser logs every answer that says no. */
const meant = (problems: string[], pattern: RegExp) => {
  const kept = problems.filter((problem) => !pattern.test(problem));
  problems.splice(0, problems.length, ...kept);
};

test.describe("making a new project", () => {
  test.use({ withProject: false });

  test("makes a project of the platform in one press, with a new repository, portrait and in Chinese", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const { user, context, page, problems } = await freshPage(browser, request, { folders: true });
    await signUp(page, user);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const making = newDialog(page);
    await expect(making).toHaveAccessibleName("新建项目");
    // Signed in: a project of the platform, the only kind there is.
    await expect(making.getByRole("radio", { name: /^在线项目/ })).toHaveCount(0);
    await expect(making.getByRole("radio", { name: /^离线项目/ })).toHaveCount(0);
    await expect(making.getByText("同时放一份在这台电脑的文件夹里")).toHaveCount(0);
    await shot(page, "new-choice");

    await making.getByRole("textbox", { name: "项目名称" }).fill("原子是什么");
    await making.getByRole("combobox", { name: "画幅" }).selectOption("portrait");
    // The repository is called after the project, in pinyin.
    await expect(repositoryName(page)).toHaveValue("yuan-zi-shi-shen-me");
    await expect(making.getByText("这个名字可以用")).toBeVisible();
    await shot(page, "new-cloud-choose");
    expect((await api(page, "/api/projects")).projects).toEqual([]);

    await submit(page).click();
    await expect(step(page, "upload")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(step(page, "repository")).toHaveAttribute("data-state", "done", {
      timeout: 30_000,
    });
    await expect(making).toHaveAttribute("data-create-phase", /archiving|done/, {
      timeout: 30_000,
    });
    await shot(page, "new-cloud-steps");
    await expect(making).toHaveAttribute("data-create-phase", "done", { timeout: 60_000 });
    await expect(making.getByText("在线项目已经建好，第一次存档也完成了。")).toBeVisible();
    await shot(page, "new-cloud-done");
    await making.getByRole("button", { name: "完成" }).click();
    await expect(making).toHaveCount(0);

    // Open, kept in this browser, syncing, in the shape people chose.
    await expect(page).toHaveTitle("原子是什么 - AnimaQuill");
    await expect(tab(page, "preview")).toBeVisible();
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    await expect(cloudStatus(page)).toHaveText("已同步");
    await expect(page.getByLabel("项目分辨率：1080×1920")).toBeVisible();
    const [listed] = (await api(page, "/api/projects")).projects as {
      name: string;
      repository?: { fullName: string };
    }[];
    expect(listed).toMatchObject({
      name: "原子是什么",
      repository: { fullName: `${user.login}/yuan-zi-shi-shen-me` },
    });
    expect(problems).toEqual([]);
    await context.close();
  });

  test("says when the name of the repository is taken, and makes nothing", async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const { user, context, page, problems } = await freshPage(browser, request, { folders: true });
    await signUp(page, user);
    await makeRepo(request, user, "taken-one");
    await page.getByRole("button", { name: "新建项目" }).first().click();
    await newDialog(page).getByRole("textbox", { name: "项目名称" }).fill("Taken One");
    // A name people did not type moves on to one that is free.
    await expect(repositoryName(page)).toHaveValue("taken-one-2");
    await repositoryName(page).fill("taken-one");
    await expect(
      newDialog(page).getByText("你的 GitHub 上已经有叫这个名字的仓库了，换一个名字。"),
    ).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await shot(page, "new-name-taken");
    expect((await api(page, "/api/projects")).projects).toEqual([]);
    expect(problems).toEqual([]);
    await context.close();
  });

  test("takes back what it made where people give up after a step stopped", async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const { user, context, page, problems } = await freshPage(browser, request, { folders: true });
    await signUp(page, user);
    await page.route("**/api/projects/*/repository", (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const making = newDialog(page);
    await making.getByRole("textbox", { name: "项目名称" }).fill("放弃的");
    await repositoryName(page).fill(`given-up-${user.id}`);
    await expect(making.getByText("这个名字可以用")).toBeVisible();
    await submit(page).click();
    await expect(step(page, "upload")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
    await expect(step(page, "repository")).toHaveAttribute("data-state", "failed");
    await expect(making.getByRole("alert")).toHaveText("暂时连不上服务器或 GitHub，稍后再试。");
    await expect(submit(page)).toHaveText("再试一次");
    await shot(page, "new-failed");
    expect((await api(page, "/api/projects")).projects).toHaveLength(1);

    await making.getByRole("button", { name: "取消" }).click();
    await expect(making).toHaveCount(0);
    expect((await api(page, "/api/projects")).projects).toEqual([]);
    // Nothing of it in this browser either: still the start page, with nothing on it.
    await expect(page.getByRole("button", { name: "新建项目" }).first()).toBeVisible();
    meant(problems, /Failed to load resource|ERR_FAILED/);
    expect(problems).toEqual([]);
    await context.close();
  });

  test("makes projects of the platform in a browser that cannot open folders just the same, after signing in", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const { user, context, page, problems } = await freshPage(browser, request, { folders: false });
    // The entry page: nothing to make before signing in or choosing the offline mode.
    await expect(page.getByTestId("entry")).toBeVisible();
    await shot(page, "firefox-entry");
    await signUp(page, user);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const making = newDialog(page);
    await expect(making.getByText("同时放一份在这台电脑的文件夹里")).toHaveCount(0);
    await making.getByRole("textbox", { name: "项目名称" }).fill("火狐里的");
    await making.getByRole("combobox", { name: "画幅" }).selectOption("square");
    await expect(repositoryName(page)).toHaveValue("huo-hu-li-de");
    await expect(newDialog(page).getByText("这个名字可以用")).toBeVisible();
    await shot(page, "firefox-new-signed-in");
    await submit(page).click();
    await expect(newDialog(page)).toHaveAttribute("data-create-phase", /archiving|done/, {
      timeout: 60_000,
    });
    await newDialog(page)
      .getByRole("button", { name: /^(关闭|完成)$/ })
      .click();
    await expect(page).toHaveTitle("火狐里的 - AnimaQuill");
    await expect(page.getByLabel("项目分辨率：1080×1080")).toBeVisible();
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    expect((await api(page, "/api/projects")).projects).toHaveLength(1);
    expect(problems).toEqual([]);
    await context.close();
  });
});
