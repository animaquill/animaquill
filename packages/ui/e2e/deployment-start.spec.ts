import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { installChosen } from "./folder-support.ts";
import {
  cardMenu,
  cardMenuItems,
  openCard,
  projectCard,
  showView,
  sidebar,
  statusOf,
} from "./start-support.ts";
import { editorReady, expect, test } from "./support.ts";
import { createOnline, entrySignIn } from "./online-support.ts";

/**
 * The start page, "作品墙", with the projects of the platform on it, on the real sites through the
 * gateway (docs/design/start-and-cloud.md, 6): what it says while nobody is signed in and in a
 * browser without folders, the views and cards once someone is, organising projects, a project of
 * the platform opened as it is in another browser and kept in step, linked with a folder, taken out
 * of the browser again, and one without a repository deleted. The API with its database, the worker
 * and a fake GitHub, see scripts/e2e-edge. Each test is a GitHub user of its own. Pictures go to the
 * output of each test, for people to look at.
 */

const EDITOR = "https://app.animaquill.com";
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

const signedInToGitHub = (context: BrowserContext, user: GitHubUser) =>
  context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "start page test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

/**
 * What a browser on a network says about it. This container has no network but the computer's own,
 * and a browser there says it is offline from the start, so the test says it instead, see
 * deployment-sync.spec.ts.
 */
const ON_A_NETWORK = () => {
  let online = true;
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => online,
    configurable: true,
  });
  (window as unknown as { aqOnline: (next: boolean) => void }).aqOnline = (next) => {
    online = next;
    dispatchEvent(new Event(next ? "online" : "offline"));
  };
};

/** The network of a browser goes away, or comes back, as the browser finds out. */
async function setNetwork(context: BrowserContext, page: Page, online: boolean) {
  await context.setOffline(!online);
  await page.evaluate(
    (next) => (window as unknown as { aqOnline: (next: boolean) => void }).aqOnline(next),
    online,
  );
}

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
/** How the start page has the list of the platform: "ready", "signedOut", "unreadable"… */
const cloudList = (page: Page) => page.locator("[data-cloud-list]").first();
const cards = (page: Page) => page.getByRole("main").locator("li[data-project]");

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** A call of the API from the page, with its session, as the editor makes them. */
const api = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const response = await fetch(path);
    return (await response.json()) as any;
  }, path);

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
  // From the way back from signing in on.
  await page.addInitScript(ON_A_NETWORK);
  await signInButton(page).click();
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(accountMenu(page, user)).toBeVisible();
  return user;
}

/** What a card says of a project of the platform with changes that are not in its repository. */
/** What a card says of a project of the platform with changes that are not in its repository yet. */
const PENDING = /^待同步/;

/**
 * A browser of its own, signed in to GitHub as the same person and to the platform, on the start
 * page. With `folders` it can write folders, which a test "chooses" from the private storage of
 * the site, see folder-support.ts; otherwise projects stay in the browser, as in the other tests.
 */
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

test.describe("the start page, with the projects of the platform", () => {
  // The entry page, then the start page of the online mode: projects are made there.
  test.use({ withProject: false });

  test("lists the projects of the platform, each once, to organise", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(150_000);
    const user = await signUp(page, context, request);
    const repository = `start-${user.id}`;
    await createOnline(page, repository, "连上服务器的");
    await chooseFrom(page, "文件", "关闭项目");
    await createOnline(page, `second-${user.id}`, "第二个");
    await chooseFrom(page, "文件", "关闭项目");

    await expect(cloudList(page)).toHaveAttribute("data-cloud-list", "ready");
    await expect(cards(page)).toHaveCount(2);
    // The repository once the first archive is there (on its way before, which says so), and
    // nothing of where the project is.
    await expect(statusOf(page, "连上服务器的")).toHaveText(
      new RegExp(`^(${user.login}/${repository}|待同步)`),
    );
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await shot(page, "start-signed-in");
    // Only what works now. "在 GitHub 上打开" only goes to an https address, which the fake GitHub
    // here has not.
    expect(await cardMenuItems(page, "连上服务器的")).toEqual([
      "打开",
      "重命名…",
      "收藏",
      "移到分组…",
      "设置封面…",
      "保存到文件夹…",
      "删除项目…",
    ]);

    // Stars and a group, kept in this browser.
    await projectCard(page, "连上服务器的")
      .getByRole("button", { name: "收藏“连上服务器的”" })
      .click();
    await showView(page, "收藏");
    await expect(cards(page)).toHaveCount(1);
    await sidebar(page).getByRole("button", { name: "新建分组" }).click();
    await sidebar(page).getByRole("textbox", { name: "分组名称" }).fill("频道");
    await page.keyboard.press("Enter");
    await showView(page, "全部项目");
    await cardMenu(page, "第二个", "移到分组…");
    await page.getByRole("menuitemradio", { name: "频道" }).click();
    await showView(page, "频道");
    await expect(cards(page)).toHaveCount(1);
    await shot(page, "start-group");
    // Renamed from its card, which the platform gets.
    await showView(page, "全部项目");
    await page
      .getByRole("group", { name: "显示方式" })
      .getByRole("button", { name: "列表" })
      .click();
    await expect(
      page.getByRole("main").getByText(`${user.login}/${repository}`).first(),
    ).toBeVisible();
    await shot(page, "start-list");
    await cardMenu(page, "连上服务器的", "重命名…");
    await page.getByRole("textbox", { name: "“连上服务器的”的新名字" }).fill("从卡片改的");
    await page.keyboard.press("Enter");
    await expect(projectCard(page, "从卡片改的")).toBeVisible();
    // On the platform at once, without opening it: nothing waits to be sent from here.
    await expect
      .poll(
        async () => ((await api(page, "/api/projects")).projects as { name: string }[])[0]?.name,
      )
      .toBe("从卡片改的");
    await expect(statusOf(page, "从卡片改的")).not.toHaveText(/有改动还没同步/);
    await openCard(page, "从卡片改的");
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud-level", "ok");
    await expect(page).toHaveTitle("从卡片改的 - AnimaQuill");
    await chooseFrom(page, "文件", "关闭项目");

    // In a narrow window the side bar is on top.
    await page.setViewportSize({ width: 390, height: 844 });
    const bar = await sidebar(page).boundingBox();
    const view = await page.getByRole("main").boundingBox();
    expect(view!.y).toBeGreaterThan(bar!.y + bar!.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await shot(page, "start-narrow");
  });

  test("opens one as it is in another browser, keeps both in step, and catches up what changed offline", async ({
    page,
    context,
    request,
    browser,
  }) => {
    test.setTimeout(180_000);
    const user = await signUp(page, context, request);
    await createOnline(page, `direct-${user.id}`);

    const other = await anotherBrowser(browser, user);
    try {
      // Another computer: the project was opened on the first one, which "最近打开" says here too.
      await expect(other.page.getByRole("region", { name: "欢迎使用 AnimaQuill" })).toHaveCount(0);
      // Its repository, and "待同步" for as long as that has not the last change.
      await expect(statusOf(other.page, "测试项目")).toHaveText(
        new RegExp(`^(${user.login}/direct-${user.id}|待同步)`),
      );
      await shot(other.page, "start-cloud-not-opened-here");
      await openCard(other.page, "测试项目");
      await expect(other.page).toHaveTitle("测试项目 - AnimaQuill");
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "online");
      await expect(cloudStatus(other.page)).toHaveText("已同步");

      // As they happen, both ways.
      await renameTo(page, "第一个名字");
      await expect(other.page).toHaveTitle("第一个名字 - AnimaQuill");
      await renameTo(other.page, "第二个名字");
      await expect(page).toHaveTitle("第二个名字 - AnimaQuill");

      // A change made without a network is only in this browser: taking the copy away asks first.
      await setNetwork(other.context, other.page, false);
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "offline");
      await renameTo(other.page, "离线时的名字");
      await expect(cloudStatus(other.page)).toHaveText("离线");
      await chooseFrom(other.page, "文件", "关闭项目");
      // The list cannot be read now: what this browser has is there, and opens.
      await expect(cloudList(other.page)).toHaveAttribute("data-cloud-list", "unreadable");
      await expect(statusOf(other.page, "离线时的名字")).toHaveText(/^有改动还没同步/);
      await other.page.screenshot({
        path: test.info().outputPath("start-unreadable.png"),
      });
      // Opened again once there is a network, it syncs.
      await setNetwork(other.context, other.page, true);
      await openCard(other.page, "离线时的名字");
      await expect(other.page).toHaveTitle("离线时的名字 - AnimaQuill");
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "online");
      await expect(page).toHaveTitle("离线时的名字 - AnimaQuill");

      // With everything on the platform it goes, and the project of the platform stays. The
      // platform has the renames, which its repository does not have yet: the card says so.
      await chooseFrom(other.page, "文件", "关闭项目");
      await expect(statusOf(other.page, "离线时的名字")).toHaveText(PENDING);

      // The first browser goes on with it.
      await renameTo(page, "还在服务器");
      await other.page.reload();
      await expect(statusOf(other.page, "还在服务器")).toHaveText(PENDING);
      // Without a network the browser logs what it could not load: that was meant.
      meant(other.problems, /ERR_INTERNET_DISCONNECTED|Failed to load resource|WebSocket/);
      expect(other.problems).toEqual([]);
    } finally {
      await other.context.close();
    }
  });
});
