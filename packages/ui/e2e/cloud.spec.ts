import type { BrowserContext, Page } from "@playwright/test";
import { dialog, footer, installChosen } from "./folder-support.ts";
import {
  cardMenu,
  cardMenuItems,
  openCard,
  projectCard,
  showView,
  sidebar,
  statusOf,
} from "./start-support.ts";
import { createProject, devPageOnly, editorReady, expect, tab, test } from "./support.ts";

/**
 * The start page, the dialog that connects a project, and the panel of the platform, as people go
 * through them (the design of the start page of AnimaQuill Cloud, 2 to 5). The development page
 * has a platform in the tab for it with `?account=fake&cloud=fake`, see dev/cloud.ts, which a test
 * sets up through `window.aqCloud`; the real one is tested where it is, in AnimaQuill Cloud.
 * Pictures of every state go to the output of each test, for people to look at.
 */

devPageOnly("a platform in the tab, with ?cloud=fake");
test.use({
  withProject: false,
  // For the tests with projects in folders, see folder-support.ts: a file has one browser.
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

const ADDRESS = "/?account=fake&cloud=fake";

interface Lab {
  platform: {
    projects: Map<string, { name: string; head: number }>;
    removed: string[];
    faults: { unreachable?: boolean; silent: boolean };
    drop(): void;
    workingCopy(id: string): { getState(): { manifest: { name: string } } };
  };
  repositories: {
    choices: unknown[];
    taken: Set<string>;
    linkMs: number;
    archiveMs: number;
    refuseLink: string | undefined;
    statuses: Map<string, { repository?: { fullName: string } }>;
    pause(project: string, reason: string, more?: object): void;
    archived(project: string, at?: number): void;
  };
  seed(name: string, options?: { repository?: string; ago?: number; listed?: object }): string;
}

/**
 * Runs `work` in the page with what the development page has for setting the platform up. It
 * goes there as its text: nothing of this file is there with it but `lab` and `arg`.
 */
const withLab = <T, A = undefined>(
  page: Page,
  work: (lab: Lab, arg: A) => T,
  arg?: A,
): Promise<T> =>
  page.evaluate(`(${work.toString()})(window.aqCloud, ${JSON.stringify(arg)})`) as Promise<T>;

/** Opens the page as somebody who is signed in, or not, with or without the GitHub App. */
async function arrive(page: Page, who: { signedIn?: boolean; installed?: boolean } = {}) {
  const state = { signedIn: who.signedIn ?? true, installed: who.installed ?? true };
  await page.addInitScript((kept) => {
    if (window !== window.top) return;
    if (sessionStorage.getItem("animaquill.fakeAccount") === null)
      sessionStorage.setItem("animaquill.fakeAccount", JSON.stringify(kept));
  }, state);
  await page.goto(ADDRESS);
  await editorReady(page);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const cloudStatus = (page: Page) => footer(page).locator("[data-cloud-level]");
const panel = (page: Page) => page.getByRole("dialog", { name: /^云端 · / });
const row = (page: Page, id: string) => panel(page).locator(`[data-cloud-row="${id}"]`);
const connectDialog = (page: Page) => page.locator("dialog[data-connect-phase]");
const step = (page: Page, id: string) => connectDialog(page).locator(`[data-step="${id}"]`);
/** How the start page has the list of the platform: "ready", "signedOut", "unreadable"… */
const cloudList = (page: Page) => page.locator("[data-cloud-list]").first();

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

async function renameTo(page: Page, name: string) {
  await chooseFrom(page, "文件", "重命名项目");
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
}

/** A new project in a folder of that name, the way people make one: see `installChosen`. */
async function newInFolder(page: Page, name: string, folder: string) {
  await page.evaluate((chosen) => {
    window.chosenFolder = chosen;
  }, folder);
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.getByRole("radio", { name: /^本地项目/ }).check();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
}

/** Connects the open project through the dialog, with a new repository of this name. */
async function connect(page: Page, repository: string) {
  await chooseFrom(page, "文件", "云端…");
  const connecting = connectDialog(page);
  await connecting.getByRole("textbox", { name: "仓库名" }).fill(repository);
  await connecting.getByRole("button", { name: "连接到云端" }).click();
  await expect(connecting).toHaveAttribute("data-connect-phase", "done");
  await connecting.getByRole("button", { name: "完成" }).click();
  await expect(connecting).toHaveCount(0);
  await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
}

test.describe("the start page", () => {
  test("says how to get to the projects of the platform while nobody is signed in", async ({
    page,
  }) => {
    await arrive(page, { signedIn: false });
    await expect(cloudList(page)).toHaveAttribute("data-cloud-list", "signedOut");
    // This browser cannot write folders: the platform is all there is.
    await expect(
      page.getByRole("main").getByText("登录后使用，或者换用 Edge、Chrome。"),
    ).toBeVisible();
    await shot(page, "start-signed-out");
    // Signing in from there comes back with the list, and nothing on it yet.
    await page.getByRole("main").getByRole("button", { name: "登录", exact: true }).click();
    await expect(cloudList(page)).toHaveAttribute("data-cloud-list", "ready");
    await expect(page.getByRole("region", { name: "欢迎使用 AnimaQuill" })).toBeVisible();
  });

  test("opens a project of the platform as it is, keeps it in step, and takes it out of the browser again", async ({
    page,
  }) => {
    await arrive(page);
    const seeded = await withLab(page, (lab) => {
      const first = lab.seed("片头动画", { repository: "opening", ago: 2 * 24 * 3_600_000 });
      lab.seed("半截的", { ago: 3_600_000 });
      return first;
    });
    await chooseFrom(page, "文件", "打开云端的项目…");
    await expect(statusOf(page, "片头动画")).toHaveText(/^云端 · 这台电脑还没打开过.*2 天前/);
    await expect(statusOf(page, "半截的")).toHaveText(/^云端 · 还差一步：选仓库/);

    await openCard(page, "片头动画");
    await expect(page).toHaveTitle("片头动画 - AnimaQuill");
    await expect(cloudStatus(page)).toHaveText("云端项目");
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    // The panel says that it has no folder here, and has no "disconnect".
    await cloudStatus(page).click();
    await expect(row(page, "repository")).toContainText("octo/opening（私有）");
    await expect(row(page, "local")).toContainText("没有文件夹，项目放在这个浏览器里");
    await expect(panel(page).getByRole("button", { name: "从这个浏览器移除…" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "断开云端…" })).toHaveCount(0);
    await shot(page, "panel-direct");
    await page.keyboard.press("Escape");

    // A change gets to the platform.
    await renameTo(page, "片头动画 第二版");
    await expect
      .poll(() =>
        withLab(
          page,
          (lab, project) => lab.platform.workingCopy(project).getState().manifest.name,
          seeded,
        ),
      )
      .toBe("片头动画 第二版");

    // Back on the start page it shows once, as opened here, and goes out of the browser again.
    await chooseFrom(page, "文件", "关闭项目");
    await expect(statusOf(page, "片头动画 第二版")).toHaveText(/^云端 · 只在这个浏览器里/);
    // Once: it is a project of the platform, not one of this browser as well.
    await expect(projectCard(page, "片头动画 第二版")).toHaveCount(1);
    await expect(page.locator('main li[data-kind="onlyHere"]')).toHaveCount(0);
    await cardMenu(page, "片头动画 第二版", "从这个浏览器移除…");
    const asked = dialog(page);
    await expect(asked).toContainText("只移除这个浏览器里的这一份，云端的项目不受影响");
    await asked.getByRole("button", { name: "移除", exact: true }).click();
    await expect(
      page.getByText("已从这个浏览器移除“片头动画 第二版”。云端的项目还在。"),
    ).toBeVisible();
    await expect(statusOf(page, "片头动画 第二版")).toHaveText(/^云端 · 这台电脑还没打开过/);

    // One without a repository can be deleted there, after people read what goes and what stays.
    await cardMenu(page, "半截的", "删除云端项目…");
    const deleting = page.getByRole("dialog", { name: "删除云端项目“半截的”？" });
    await expect(deleting).toContainText("它还没有仓库，所以云端之外没有存档");
    await expect(deleting).toContainText("这台电脑上的文件夹和浏览器里的那一份不会动");
    await shot(page, "start-delete-cloud");
    await deleting.getByRole("button", { name: "删除云端项目" }).click();
    await expect(projectCard(page, "半截的")).toHaveCount(0);
    expect(await withLab(page, (lab) => lab.platform.removed.length)).toBe(1);
  });

  test("asks before it takes a copy with changes that are only here out of the browser", async ({
    page,
  }) => {
    await arrive(page);
    await withLab(page, (lab) => lab.seed("年会视频", { repository: "annual" }));
    await chooseFrom(page, "文件", "打开云端的项目…");
    await openCard(page, "年会视频");
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    // The platform stops answering, and people go on.
    await withLab(page, ({ platform }) => {
      platform.faults.silent = true;
      platform.drop();
    });
    await renameTo(page, "年会视频 改过");
    await expect(page).toHaveTitle("年会视频 改过 - AnimaQuill");
    await chooseFrom(page, "文件", "关闭项目");

    await expect(statusOf(page, "年会视频 改过")).toHaveText(/^云端 · 有改动还没同步/);
    await cardMenu(page, "年会视频 改过", "从这个浏览器移除…");
    const asked = page.getByRole("dialog", { name: /还有内容只在这个浏览器里$/ });
    await expect(asked).toContainText("有 1 个改动还没同步到云端。现在移除，这些内容就没有了。");
    await expect(asked.getByRole("button", { name: "打开项目让它同步" })).toBeVisible();
    await expect(asked.getByRole("button", { name: "仍然移除" })).toBeVisible();
    await shot(page, "start-remove-unsynced");
    await asked.getByRole("button", { name: "取消" }).click();
    // It stays, with what is only here.
    await expect(statusOf(page, "年会视频 改过")).toHaveText(/^云端 · 有改动还没同步/);
  });

  test("lists what this browser has where the platform's list cannot be read", async ({ page }) => {
    await arrive(page);
    await withLab(page, (lab) => lab.seed("年会视频", { repository: "annual" }));
    await chooseFrom(page, "文件", "打开云端的项目…");
    await openCard(page, "年会视频");
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    await withLab(page, (lab) => {
      lab.platform.faults.unreachable = true;
    });
    await chooseFrom(page, "文件", "关闭项目");
    await expect(cloudList(page)).toHaveAttribute("data-cloud-list", "unreadable");
    await expect(page.getByText(/云端的项目列表读不出来.*列表不是最新的。/)).toBeVisible();
    await expect(statusOf(page, "年会视频")).toHaveText(/^云端 · 只在这个浏览器里/);
    await shot(page, "start-unreadable");
    // It opens without the platform, and reads the list again when asked.
    await withLab(page, (lab) => {
      lab.platform.faults.unreachable = false;
    });
    await page.getByRole("main").getByRole("button", { name: "再读一次" }).click();
    await expect(cloudList(page)).toHaveAttribute("data-cloud-list", "ready");
  });
});

test.describe("the start page, with projects in folders", () => {
  test.use({ folders: true });

  test("has the projects of this computer and those of the platform side by side, each once", async ({
    page,
  }) => {
    await installChosen(page);
    await arrive(page);
    await newInFolder(page, "产品介绍", "intro");
    await expect(cloudStatus(page)).toHaveText("仅本机");
    await chooseFrom(page, "文件", "关闭项目");
    await newInFolder(page, "原子是什么", "atom");
    // The name of the folder is what the repository is called at first.
    await cloudStatus(page).click();
    await expect(connectDialog(page).getByRole("textbox", { name: "仓库名" })).toHaveValue("atom");
    await connectDialog(page).getByRole("button", { name: "连接到云端" }).click();
    await expect(connectDialog(page)).toHaveAttribute("data-connect-phase", "done");
    await connectDialog(page).getByRole("button", { name: "完成" }).click();
    await expect(cloudStatus(page)).toHaveText("已同步");
    // In a folder of its own there is nowhere to move it.
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "移到文件夹…" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "云端…" })).toBeVisible();
    await page.keyboard.press("Escape");

    await withLab(page, (lab) => {
      lab.seed("片头动画", { repository: "opening", ago: 2 * 24 * 3_600_000 });
      lab.seed("年会视频", { repository: "annual", ago: 5 * 3_600_000 });
    });
    await chooseFrom(page, "文件", "关闭项目");
    await showView(page, "全部项目");
    await expect(page.getByRole("main").locator("li[data-project]")).toHaveCount(4);
    await expect(statusOf(page, "原子是什么")).toHaveText(/^云端 · 文件夹也有一份/);
    await expect(statusOf(page, "产品介绍")).toHaveText(/^本地 · intro/);
    // The one that is a folder here shows as that, and once.
    await expect(projectCard(page, "原子是什么")).toHaveCount(1);
    await page.getByRole("group", { name: "筛选" }).getByRole("button", { name: "云端" }).click();
    await expect(page.getByRole("main").locator("li[data-project]")).toHaveCount(3);
    expect(await cardMenuItems(page, "片头动画")).toContain("关联文件夹…");
    await shot(page, "start-cloud-filter");

    // In a narrow window the side bar is on top, and nothing is cut off.
    await page.setViewportSize({ width: 520, height: 900 });
    const [bar, view] = await Promise.all([
      sidebar(page).boundingBox(),
      page.getByRole("main").boundingBox(),
    ]);
    expect(view!.y).toBeGreaterThan(bar!.y + bar!.height - 1);
    expect(view!.x + view!.width).toBeLessThanOrEqual(520);
    await shot(page, "start-narrow");
    await page.setViewportSize({ width: 1440, height: 900 });

    // Linking one with a folder makes it a project of this computer that syncs.
    await page.evaluate(() => {
      window.chosenFolder = "opening";
    });
    await cardMenu(page, "片头动画", "关联文件夹…");
    const moved = page.getByRole("dialog", { name: "已移到文件夹" });
    await expect(moved).toBeVisible({ timeout: 15_000 });
    await moved.getByRole("button").last().click();
    await expect(page).toHaveTitle("片头动画 - AnimaQuill");
    await expect(cloudStatus(page)).toHaveText("已同步");
    await chooseFrom(page, "文件", "关闭项目");
    await expect(statusOf(page, "片头动画")).toHaveText(/^云端 · 文件夹也有一份/);
    await expect(projectCard(page, "片头动画")).toHaveCount(1);
  });
});

test.describe("connecting a project", () => {
  test("takes people through signing in and the GitHub App, and comes back to where they were", async ({
    page,
  }) => {
    await arrive(page, { signedIn: false, installed: false });
    await createProject(page);
    await expect(cloudStatus(page)).toHaveText("只在浏览器里");
    await cloudStatus(page).hover();
    await expect(page.getByText(/这个项目只在浏览器里，不安全/)).toBeVisible();
    await shot(page, "panel-local");
    await chooseFrom(page, "文件", "云端…");

    const connecting = connectDialog(page);
    await expect(connecting).toHaveAccessibleName("把“测试项目”连接到云端");
    await expect(connecting.getByText("要先登录。登录时页面会离开一下")).toBeVisible();
    await expect(connecting.getByRole("button", { name: "连接到云端" })).toHaveCount(0);
    await shot(page, "connect-sign-in");
    await connecting.getByRole("button", { name: "登录", exact: true }).click();

    // Back from signing in, in the same dialog: the App is next.
    await expect(connectDialog(page).getByText(/要先在你的 GitHub 账号上安装/)).toBeVisible();
    await expect(connectDialog(page).getByText(/只授权选定的仓库/)).toBeVisible();
    await shot(page, "connect-install-app");
    await connectDialog(page).getByRole("button", { name: "去安装…" }).click();

    // ...and back again, with the repository to choose.
    const name = connectDialog(page).getByRole("textbox", { name: "仓库名" });
    await expect(name).toHaveValue("animaquill-project");
    await expect(connectDialog(page).getByText("这个名字可以用")).toBeVisible();
    await expect(connectDialog(page).getByRole("button", { name: "连接到云端" })).toBeEnabled();
    await shot(page, "connect-choose");
    // Giving up before anything was made leaves nothing behind.
    await connectDialog(page).getByRole("button", { name: "取消" }).click();
    await expect(cloudStatus(page)).toHaveText("只在浏览器里");
    expect(await withLab(page, (lab) => lab.platform.projects.size)).toBe(0);
  });

  test("says before people go on that a name is taken, and whose a repository is", async ({
    page,
  }) => {
    await arrive(page);
    const other = await withLab(page, (lab) => {
      const id = lab.seed("片头动画", { repository: "opening" });
      lab.repositories.taken.add("animaquill-project");
      lab.repositories.choices = [
        {
          id: 1,
          owner: "octo",
          name: "empty-one",
          fullName: "octo/empty-one",
          private: true,
          pushable: true,
          empty: true,
          archived: false,
          linked: false,
        },
        {
          id: 2,
          owner: "octo",
          name: "notes",
          fullName: "octo/notes",
          private: true,
          pushable: true,
          empty: false,
          archived: false,
          linked: false,
        },
        {
          id: 501,
          owner: "octo",
          name: "opening",
          fullName: "octo/opening",
          private: true,
          pushable: true,
          empty: false,
          archived: false,
          linked: true,
          linkedProject: { id, name: "片头动画" },
        },
        {
          id: 4,
          owner: "octo",
          name: "old-site",
          fullName: "octo/old-site",
          private: true,
          pushable: true,
          empty: false,
          archived: true,
          linked: false,
        },
        {
          id: 5,
          owner: "octo",
          name: "public-one",
          fullName: "octo/public-one",
          private: false,
          pushable: true,
          empty: true,
          archived: false,
          linked: false,
        },
      ];
      return id;
    });
    await createProject(page);
    await chooseFrom(page, "文件", "云端…");
    const connecting = connectDialog(page);
    const name = connecting.getByRole("textbox", { name: "仓库名" });
    // The name the dialog put there is taken: it moves on to one that is free, and says so.
    await expect(name).toHaveValue("animaquill-project-2");
    await expect(
      connecting.getByText("你的 GitHub 上已经有同名的仓库，所以换成了这个名字"),
    ).toBeVisible();
    // One people type stays as they typed it, with what is wrong.
    await name.fill("opening");
    await expect(
      connecting.getByText("你的 GitHub 上已经有叫这个名字的仓库了，换一个名字。"),
    ).toBeVisible();
    await expect(connecting.getByRole("button", { name: "连接到云端" })).toBeDisabled();
    await shot(page, "connect-name-taken");

    await connecting.getByRole("radio", { name: "用已有的仓库" }).check();
    const list = connecting.getByRole("radiogroup", { name: "授权范围里的仓库" });
    const choice = (repository: string) => list.locator(`[data-repository="octo/${repository}"]`);
    await expect(choice("opening")).toContainText("已经是云端项目“片头动画”的仓库");
    await expect(choice("opening").getByRole("radio")).toBeDisabled();
    await expect(choice("old-site")).toContainText("在 GitHub 上已归档，只能读");
    await expect(
      connecting.getByText("只列出你个人账号下的仓库，组织的仓库暂时不支持。"),
    ).toBeVisible();
    await choice("notes").getByRole("radio").check();
    await expect(
      connecting.getByText(/这个仓库可以用 · 这个仓库里已有的其他文件不会动。/),
    ).toBeVisible();
    await shot(page, "connect-linked-elsewhere");
    await choice("public-one").getByRole("radio").check();
    await expect(
      connecting.getByText("这是公开仓库，任何人都能看到存进去的文档和代码。"),
    ).toBeVisible();
    await expect(connecting.getByRole("button", { name: "连接到云端" })).toBeDisabled();

    // The way out for the one that is another project's: that project.
    await choice("opening").getByRole("button", { name: "打开那个项目" }).click();
    await expect(connectDialog(page)).toHaveCount(0);
    await expect(page).toHaveTitle("片头动画 - AnimaQuill");
    await expect(cloudStatus(page)).toHaveText("云端项目");
    // Nothing was made for the project they left.
    expect(await withLab(page, (lab) => [...lab.platform.projects.keys()])).toEqual([other]);
  });

  test("goes through its three steps on one press, and says so", async ({ page }) => {
    await arrive(page);
    await withLab(page, ({ repositories }) => {
      repositories.linkMs = 2500;
      repositories.archiveMs = 2500;
    });
    await createProject(page);
    await chooseFrom(page, "文件", "云端…");
    const connecting = connectDialog(page);
    await connecting.getByRole("textbox", { name: "仓库名" }).fill("my-film");
    await expect(connecting.getByText("会建在你的 GitHub 账号下：octo/my-film")).toBeVisible();
    await connecting.getByRole("button", { name: "连接到云端" }).click();

    await expect(step(page, "upload")).toHaveAttribute("data-state", "done");
    await expect(step(page, "repository")).toHaveAttribute("data-state", "running");
    await expect(step(page, "repository")).toContainText("新建仓库");
    await expect(step(page, "archive")).toHaveAttribute("data-state", "waiting");
    await expect(connecting.getByRole("textbox", { name: "仓库名" })).toBeDisabled();
    await shot(page, "connect-working");

    // With its repository the project is connected: the dialog can close while the archive runs.
    await expect(connecting).toHaveAttribute("data-connect-phase", "archiving");
    await expect(step(page, "archive")).toHaveAttribute("data-state", "running");
    await expect(connecting.getByText(/项目已经连上云端。第一次存档正在进行/)).toBeVisible();
    await expect(connecting.getByRole("button", { name: "关闭" })).toBeVisible();
    await expect(connecting).toHaveAttribute("data-connect-phase", "done");
    await expect(connecting.getByText("已连接到云端，第一次存档也完成了。")).toBeVisible();
    await shot(page, "connect-done");
    await connecting.getByRole("button", { name: "完成" }).click();
    // A project without a folder is one of the platform from then on, kept in this browser.
    await expect(cloudStatus(page)).toHaveText("云端项目");
    await expect(cloudStatus(page)).toHaveAttribute("data-archive", "ready");
  });

  test("stops at the step that failed, tries again, and takes back what it made when people give up", async ({
    page,
  }) => {
    await arrive(page);
    await withLab(page, (lab) => {
      lab.repositories.refuseLink = "unavailable";
    });
    await createProject(page);
    await chooseFrom(page, "文件", "云端…");
    const connecting = connectDialog(page);
    await connecting.getByRole("textbox", { name: "仓库名" }).fill("my-film");
    await connecting.getByRole("button", { name: "连接到云端" }).click();
    await expect(step(page, "upload")).toHaveAttribute("data-state", "done");
    await expect(step(page, "repository")).toHaveAttribute("data-state", "failed");
    await expect(connecting.getByRole("alert")).toHaveText("暂时连不上平台或 GitHub，稍后再试。");
    await expect(connecting.getByRole("button", { name: "再试一次" })).toBeEnabled();
    await shot(page, "connect-failed");
    expect(await withLab(page, (lab) => lab.platform.projects.size)).toBe(1);

    // Giving up now takes the project off the platform again: nothing is left halfway.
    await connecting.getByRole("button", { name: "取消" }).click();
    await expect(connecting).toHaveCount(0);
    await expect(cloudStatus(page)).toHaveText("只在浏览器里");
    expect(
      await withLab(page, ({ platform }) => [platform.projects.size, platform.removed.length]),
    ).toEqual([0, 1]);

    // Another try gets there.
    await connect(page, "my-film");
    expect(
      await withLab(
        page,
        (lab) => [...lab.repositories.statuses.values()][0]?.repository?.fullName,
      ),
    ).toBe("octo/my-film");
  });

  test("only asks for the repository of a project that is on the platform without one", async ({
    page,
  }) => {
    await arrive(page);
    await withLab(page, (lab) => lab.seed("旧的云端项目"));
    await chooseFrom(page, "文件", "打开云端的项目…");
    await openCard(page, "旧的云端项目");
    await expect(cloudStatus(page)).toHaveText("要处理");
    await cloudStatus(page).click();
    await expect(row(page, "repository")).toContainText("还差一步：选仓库");
    await row(page, "repository").getByRole("button", { name: "选仓库…" }).click();

    const connecting = connectDialog(page);
    await expect(connecting).toHaveAccessibleName("给“旧的云端项目”选仓库");
    await expect(connecting.getByText("这个项目已经在云端，还差一步")).toBeVisible();
    await connecting.getByRole("textbox", { name: "仓库名" }).fill("old-one");
    await shot(page, "connect-repository-only");
    await connecting.getByRole("button", { name: "存进这个仓库" }).click();
    // Only the two steps that are missing.
    await expect(step(page, "upload")).toHaveCount(0);
    await expect(connecting).toHaveAttribute("data-connect-phase", "done");
    await connecting.getByRole("button", { name: "完成" }).click();
    await expect(cloudStatus(page)).toHaveText("云端项目");
    // Closing the dialog before that would have taken nothing away.
    expect(await withLab(page, (lab) => lab.platform.removed)).toEqual([]);
  });
});

test.describe("making a new project", () => {
  const making = (page: Page) => page.locator("dialog[data-create-phase]");

  test("makes one of the platform in one press, in the shape people chose, its repository in pinyin", async ({
    page,
  }) => {
    await arrive(page);
    await page.getByRole("button", { name: "新建项目" }).click();
    const box = making(page);
    await expect(box).toHaveAccessibleName("新建项目");
    await box.getByRole("radio", { name: /^云端项目/ }).check();
    await box.getByRole("textbox", { name: "项目名称" }).fill("原子是什么");
    await box.getByRole("combobox", { name: "画幅" }).selectOption("portrait");
    await expect(box.getByRole("textbox", { name: "仓库名" })).toHaveValue("yuan-zi-shi-shen-me");
    await expect(box.getByText("这个名字可以用")).toBeVisible();
    await shot(page, "new-cloud");
    await box.getByRole("button", { name: "新建", exact: true }).click();
    await expect(box).toHaveAttribute("data-create-phase", /archiving|done/);
    await expect(box.locator('[data-step="place"]')).toHaveAttribute("data-state", "done");
    await shot(page, "new-cloud-steps");
    await box.getByRole("button", { name: /^(关闭|完成)$/ }).click();
    await expect(page).toHaveTitle("原子是什么 - AnimaQuill");
    await expect(cloudStatus(page)).toHaveText("云端项目");
    await expect(page.getByLabel("项目分辨率：1080×1920")).toBeVisible();
    expect(
      await withLab(page, ({ platform }) =>
        [...platform.projects.values()].map((each) => each.name),
      ),
    ).toEqual(["原子是什么"]);
  });

  test("custom size, checked as the format says", async ({ page }) => {
    await arrive(page);
    await page.getByRole("button", { name: "新建项目" }).click();
    const box = making(page);
    await box.getByRole("combobox", { name: "画幅" }).selectOption("custom");
    await box.getByRole("textbox", { name: "宽" }).fill("0");
    await expect(box.getByText("宽和高要填正整数（像素）。")).toBeVisible();
    await expect(box.getByRole("button", { name: "新建", exact: true })).toBeDisabled();
    await box.getByRole("textbox", { name: "宽" }).fill("1280");
    await box.getByRole("textbox", { name: "高" }).fill("720");
    await box.getByRole("combobox", { name: "帧率" }).selectOption("60");
    await shot(page, "new-custom");
    // The kind for tests, which people never see: a project in this browser.
    await box.getByRole("button", { name: "新建", exact: true }).click();
    await expect(page.getByLabel("项目分辨率：1280×720")).toBeVisible();
    await expect(footer(page).getByText("60 帧")).toBeVisible();
  });
});

test.describe("the panel of the platform", () => {
  test.use({ folders: true });

  /** A project in a folder, connected. */
  async function connected(page: Page) {
    await installChosen(page);
    await arrive(page);
    await newInFolder(page, "测试项目", "film");
    await connect(page, "my-film");
  }

  test("says how the repository, syncing and archiving are, and what there is to do", async ({
    page,
  }) => {
    await connected(page);
    await expect(cloudStatus(page)).toHaveText("已同步");
    await cloudStatus(page).click();
    await expect(panel(page)).toHaveAccessibleName("云端 · 测试项目");
    await expect(row(page, "archive").getByRole("status")).toHaveText("刚刚存过");
    await expect(row(page, "repository")).toContainText("octo/my-film（私有）");
    await expect(
      row(page, "repository").getByRole("link", { name: "在 GitHub 上打开" }),
    ).toHaveAttribute("href", "https://github.com/octo/my-film");
    await expect(row(page, "sync")).toContainText("在线，改动都已发送");
    await expect(row(page, "archive")).toContainText("刚刚存过");
    await expect(row(page, "local")).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "换一个仓库…" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "断开云端…" })).toBeVisible();
    await shot(page, "panel-synced");

    // A change since the archive shows as soon as the platform has it, not a minute later.
    await page.keyboard.press("Escape");
    await renameTo(page, "改过名字");
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText(/存过。有新改动，约 \d 分钟后再存/);

    // "现在存档" runs where people see it: the panel stays.
    await row(page, "archive").getByRole("button", { name: "现在存档" }).click();
    await expect(panel(page)).toBeVisible();
    await expect(row(page, "archive").getByRole("status")).toHaveText("刚刚存过");
    // Escape closes it, also after the button that was pressed went grey for a moment.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    // A press on the status opens the panel, and the next one closes it.
    await cloudStatus(page).click();
    await expect(panel(page)).toBeVisible();
    await cloudStatus(page).click();
    await expect(panel(page)).toHaveCount(0);
    await chooseFrom(page, "文件", "云端…");
    await expect(panel(page)).toBeVisible();

    // Disconnecting says where the project of the platform is from then on.
    await panel(page).getByRole("button", { name: "断开云端…" }).click();
    const asked = page.getByRole("dialog", { name: "断开云端？" });
    await expect(asked).toContainText("云端的项目还在，开始页上照样能看到");
    await shot(page, "panel-disconnect");
    await asked.getByRole("button", { name: "断开", exact: true }).click();
    await expect(cloudStatus(page)).toHaveText("仅本机");
    await chooseFrom(page, "文件", "关闭项目");
    // Its folder is a project of this computer; the one of the platform is there as well.
    await showView(page, "全部项目");
    await expect(
      page.locator('main li[data-kind="cloudRemote"]').filter({ hasText: "改过名字" }),
    ).toHaveCount(1);
    await page
      .getByRole("group", { name: "显示方式" })
      .getByRole("button", { name: "列表" })
      .click();
    await expect(page.locator('main li[data-kind="cloudRemote"]')).toContainText(
      "云端 · octo/my-film",
    );
  });

  test("says how many changes wait while there is no network", async ({ page, context }) => {
    await connected(page);
    await goOffline(context, page);
    await expect(cloudStatus(page)).toHaveText("离线");
    await renameTo(page, "离线时的名字");
    await expect(cloudStatus(page)).toHaveText("离线，1 个改动待发");
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "offline");
    await cloudStatus(page).click();
    await expect(row(page, "sync")).toContainText("离线，1 个改动待发，联网后自动发送");
    await shot(page, "panel-offline");
    await page.keyboard.press("Escape");
    await context.setOffline(false);
    await expect(cloudStatus(page)).toHaveText("已同步");
  });

  test("stands out where archiving paused, with why and what helps", async ({ page }) => {
    await connected(page);
    await withLab(page, (lab) => {
      const [project] = [...lab.platform.projects.keys()];
      lab.repositories.pause(project!, "protected", {
        detail: "Changes must be made through a pull request.",
      });
    });
    // The window comes back to the front: the editor looks again.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(cloudStatus(page)).toHaveText("要处理");
    await expect(cloudStatus(page)).toHaveAttribute("data-archive", "paused");
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("存档先停着：GitHub 不让存档写进这个仓库");
    await expect(row(page, "archive")).toContainText(
      "GitHub 的原话：Changes must be made through a pull request.",
    );
    await expect(row(page, "archive").getByRole("button", { name: "现在存档" })).toBeVisible();
    await expect(row(page, "sync")).toContainText("在线，改动都已发送");
    await shot(page, "panel-attention");
  });

  test("says how a repository is gone, and has the way out where it says so", async ({ page }) => {
    await connected(page);
    // Deleted on GitHub: another repository is the way out, right in the line about archiving.
    await withLab(page, (lab) => {
      const [project] = [...lab.platform.projects.keys()];
      lab.repositories.pause(project!, "gone", { gone: "deleted" });
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(cloudStatus(page)).toHaveText("要处理");
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("存档先停着：仓库在 GitHub 上被删除了");
    await expect(row(page, "archive")).toContainText("换一个仓库，项目会重新存一份进去");
    await expect(row(page, "archive").getByRole("button", { name: "换一个仓库…" })).toBeVisible();
    // Once, not again at the end.
    await expect(panel(page).getByRole("button", { name: "换一个仓库…" })).toHaveCount(1);
    await shot(page, "panel-gone-deleted");
    await page.keyboard.press("Escape");

    // Out of what the App may reach: putting it back is the way out, and archiving tries again.
    await withLab(page, (lab) => {
      const [project] = [...lab.platform.projects.keys()];
      lab.repositories.pause(project!, "gone", { gone: "unauthorized" });
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("存档先停着：AnimaQuill 不能再访问这个仓库");
    await expect(row(page, "archive").getByRole("button", { name: "现在存档" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "换一个仓库…" })).toHaveCount(1);
  });
});

/** The network goes away, as the browser finds out. */
async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
}

test.describe("where the editor is hosted on no platform", () => {
  test("the start page and the menu say nothing about one", async ({ page }) => {
    await page.goto("/");
    await editorReady(page);
    await expect(page.getByRole("button", { name: /^新建云端项目/ })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await createProject(page);
    await expect(footer(page).locator("[data-cloud-level]")).toHaveCount(0);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "云端…" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "打开云端的项目…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await chooseFrom(page, "文件", "关闭项目");
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByRole("link", { name: /^测试项目/ })).toBeVisible();
  });
});
