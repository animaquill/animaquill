import type { Page } from "@playwright/test";
import { dialog, footer, installChosen, privateText } from "./folder-support.ts";
import {
  cardMenu,
  filterTo,
  openCard,
  projectCard,
  projectList,
  showView,
  sidebar,
  statusOf,
} from "./start-support.ts";
import { createProject, devPageOnly, editorReady, expect, tab, test } from "./support.ts";

/**
 * The start page, "作品墙" (the design of the start page of AnimaQuill Cloud, 6): the views of the
 * side bar, the cards and what they offer, organising projects, and how it is in each browser and
 * for whoever is signed in or not. The development page has a platform in the tab for it with
 * `?account=fake&cloud=fake`, see dev/cloud.ts. Pictures of every state go to the output of each
 * test, for people to look at.
 */

devPageOnly("a platform in the tab, with ?cloud=fake");
test.use({
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

const CLOUD = "/?account=fake&cloud=fake";

interface Lab {
  seed(name: string, options?: { repository?: string; ago?: number }): string;
}

const withLab = <T, A = undefined>(page: Page, work: (lab: Lab, arg: A) => T, arg?: A) =>
  page.evaluate(`(${work.toString()})(window.aqCloud, ${JSON.stringify(arg)})`) as Promise<T>;

/** Opens the page as somebody who is signed in, or not, with a platform or without. */
async function arrive(page: Page, { signedIn = true, cloud = true } = {}) {
  await page.addInitScript(
    (kept) => {
      if (window !== window.top) return;
      if (sessionStorage.getItem("animaquill.fakeAccount") === null)
        sessionStorage.setItem("animaquill.fakeAccount", JSON.stringify(kept));
    },
    { signedIn, installed: true },
  );
  await page.goto(cloud ? CLOUD : "/");
  await editorReady(page);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

const close = (page: Page) => chooseFrom(page, "文件", "关闭项目");

/** How many changes the projects of this browser have in their logs. */
const updatesIn = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("animaquill");
        open.onsuccess = () => {
          const request = open.result.transaction("updates").objectStore("updates").count();
          request.onsuccess = () => {
            open.result.close();
            resolve(request.result);
          };
        };
      }),
  );

/** A new project in a folder of that name, through the dialog, as people make one. */
async function newInFolder(page: Page, name: string, folder: string) {
  await page.evaluate((chosen) => {
    window.chosenFolder = chosen;
  }, folder);
  await sidebar(page).getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.getByRole("radio", { name: /^本地项目/ }).check();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
}

/** Connects the open project through the dialog, with a new repository of this name. */
async function connect(page: Page, repository: string) {
  await chooseFrom(page, "文件", "云端…");
  const connecting = page.locator("dialog[data-connect-phase]");
  await connecting.getByRole("textbox", { name: "仓库名" }).fill(repository);
  await connecting.getByRole("button", { name: "连接到云端" }).click();
  await expect(connecting).toHaveAttribute("data-connect-phase", "done");
  await connecting.getByRole("button", { name: "完成" }).click();
  await expect(footer(page).locator("[data-cloud-level]")).toHaveAttribute("data-cloud", "online");
}

const names = (page: Page, list = "项目") =>
  projectList(page, list).locator("li[data-project]").locator("[data-card-name]").allInnerTexts();

test.describe("the start page with projects of this computer and of the platform", () => {
  test.use({ folders: true });

  test("shows them as a wall, which people filter, search, sort and organise", async ({ page }) => {
    test.setTimeout(120_000);
    await installChosen(page);
    await arrive(page);
    await newInFolder(page, "课程片头", "intro");
    await close(page);
    await newInFolder(page, "旅行 Vlog 第 3 集", "vlog");
    await connect(page, "travel-vlog");
    await close(page);
    await withLab(page, (lab) => {
      lab.seed("产品发布短片", { repository: "launch" });
      lab.seed("年会开场", { repository: "annual", ago: 3 * 24 * 3_600_000 });
      lab.seed("教程：关键帧入门", { repository: "keyframes" });
    });
    await showView(page, "全部项目");
    await openCard(page, "产品发布短片");
    await expect(page).toHaveTitle("产品发布短片 - AnimaQuill");
    await close(page);

    // What was opened here, the last first; nothing else is "recent".
    await expect(sidebar(page).getByRole("button", { name: "最近打开" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect.poll(() => names(page)).toEqual(["产品发布短片", "旅行 Vlog 第 3 集", "课程片头"]);
    await expect(statusOf(page, "课程片头")).toHaveText(/^本地 · intro/);
    await expect(statusOf(page, "旅行 Vlog 第 3 集")).toHaveText(/^云端 · 文件夹也有一份/);
    await expect(statusOf(page, "产品发布短片")).toHaveText(/^云端 · 只在这个浏览器里/);
    // Recent has no sort of its own.
    await expect(page.getByRole("button", { name: /^排序：/ })).toHaveCount(0);
    await projectCard(page, "旅行 Vlog 第 3 集")
      .getByRole("button", { name: "收藏“旅行 Vlog 第 3 集”" })
      .click();
    await expect(sidebar(page).getByRole("button", { name: /^收藏/ })).toHaveText("收藏1");
    await shot(page, "01-recent");

    // Everything, those only on the platform too.
    await showView(page, "全部项目");
    await expect(projectList(page).locator("li[data-project]")).toHaveCount(5);
    await expect(statusOf(page, "年会开场")).toHaveText(/^云端 · 这台电脑还没打开过/);
    await shot(page, "02-all");
    await filterTo(page, "云端");
    await expect
      .poll(async () => (await names(page)).toSorted())
      .toEqual(["产品发布短片", "年会开场", "教程：关键帧入门", "旅行 Vlog 第 3 集"].toSorted());
    await shot(page, "03-cloud");
    await filterTo(page, "本地");
    await expect.poll(() => names(page)).toEqual(["课程片头"]);
    await filterTo(page, "全部");
    await page.getByRole("searchbox", { name: "搜索项目" }).fill("vlog");
    await expect.poll(() => names(page)).toEqual(["旅行 Vlog 第 3 集"]);
    await page.getByRole("searchbox", { name: "搜索项目" }).fill("没有这个");
    await expect(page.getByText("没有名字里有“没有这个”的项目。")).toBeVisible();
    await page.getByRole("searchbox", { name: "搜索项目" }).fill("");

    // By name, as a list, which this view keeps.
    await page.getByRole("button", { name: /^排序：/ }).click();
    await page.getByRole("menuitemradio", { name: "按名称" }).click();
    await expect
      .poll(() => names(page))
      .toEqual(["产品发布短片", "教程：关键帧入门", "课程片头", "旅行 Vlog 第 3 集", "年会开场"]);
    await page
      .getByRole("group", { name: "显示方式" })
      .getByRole("button", { name: "列表" })
      .click();
    await expect(projectList(page)).toHaveCount(1);
    await shot(page, "04-list");
    await showView(page, "最近打开");
    await expect(
      page.getByRole("group", { name: "显示方式" }).getByRole("button", { name: "卡片" }),
    ).toHaveAttribute("aria-pressed", "true");
    await showView(page, "全部项目");
    await expect(
      page.getByRole("group", { name: "显示方式" }).getByRole("button", { name: "列表" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("group", { name: "显示方式" })
      .getByRole("button", { name: "卡片" })
      .click();

    // Only what works now, by kind.
    const menuOf = async (name: string) => {
      await projectCard(page, name)
        .getByRole("button", { name: `“${name}”的更多操作` })
        .click();
      const items = await page.getByRole("menu").getByRole("menuitem").allInnerTexts();
      return items;
    };
    expect(await menuOf("产品发布短片")).toEqual([
      "打开",
      "重命名…",
      "收藏",
      "移到分组…",
      "关联文件夹…",
      "在 GitHub 上打开",
      "从这个浏览器移除…",
    ]);
    await shot(page, "05-menu");
    await page.keyboard.press("Escape");
    expect(await menuOf("年会开场")).toEqual([
      "打开",
      "收藏",
      "移到分组…",
      "关联文件夹…",
      "在 GitHub 上打开",
    ]);
    await page.keyboard.press("Escape");
    expect(await menuOf("课程片头")).toEqual([
      "打开",
      "重命名…",
      "收藏",
      "移到分组…",
      "连接到云端…",
      "从列表移除",
    ]);
    await page.keyboard.press("Escape");
    expect(await menuOf("旅行 Vlog 第 3 集")).toEqual([
      "打开",
      "重命名…",
      "取消收藏",
      "移到分组…",
      "断开云端…",
      "在 GitHub 上打开",
      "从列表移除",
    ]);
    await page.keyboard.press("Escape");

    // A group, which cards go into by dragging, or from their menu.
    await sidebar(page).getByRole("button", { name: "新建分组" }).click();
    await sidebar(page).getByRole("textbox", { name: "分组名称" }).fill("工作");
    await shot(page, "06a-new-group");
    await page.keyboard.press("Enter");
    const work = sidebar(page).getByRole("button", { name: /^工作\s*\d*$/ });
    await expect(work).toHaveText("工作0");
    await sidebar(page).getByRole("button", { name: "新建分组" }).click();
    await sidebar(page).getByRole("textbox", { name: "分组名称" }).fill("工作");
    await page.keyboard.press("Enter");
    await expect(sidebar(page).getByRole("alert")).toHaveText("已经有叫这个名字的分组了。");
    await page.keyboard.press("Escape");
    await projectCard(page, "课程片头").locator("a").first().dragTo(work);
    await expect(work).toHaveText("工作1");
    await cardMenu(page, "年会开场", "移到分组…");
    await page
      .getByRole("menu", { name: "把“年会开场”移到分组" })
      .getByRole("menuitemradio", { name: "工作" })
      .click();
    await expect(work).toHaveText("工作2");
    await showView(page, "工作");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("工作");
    await expect
      .poll(async () => (await names(page)).toSorted())
      .toEqual(["年会开场", "课程片头"].toSorted());
    await filterTo(page, "云端");
    await expect.poll(() => names(page)).toEqual(["年会开场"]);
    await filterTo(page, "全部");
    await shot(page, "06-group");

    // Taking the group away leaves its projects where they are.
    await sidebar(page).getByRole("button", { name: "分组“工作”的操作" }).click();
    await page.getByRole("menuitem", { name: "删除…" }).click();
    const deleting = page.getByRole("dialog", { name: "删除分组“工作”？" });
    await expect(deleting).toContainText("里面的项目不会被删除");
    await deleting.getByRole("button", { name: "删除分组" }).click();
    await expect(work).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("最近打开");
    await showView(page, "全部项目");
    await expect(projectList(page).locator("li[data-project]")).toHaveCount(5);
  });

  test("opens a card in this tab with a click, and in a new one with Ctrl", async ({
    page,
    context,
  }) => {
    await installChosen(page);
    await arrive(page);
    await newInFolder(page, "课程片头", "intro");
    await close(page);
    const link = projectCard(page, "课程片头").getByRole("link");
    await expect(link).toHaveAttribute("href", /[?&]project=/);
    const opening = context.waitForEvent("page");
    await link.click({ modifiers: ["ControlOrMeta"] });
    const other = await opening;
    await editorReady(other);
    // The new tab has the project in its address; this one stays on the start page.
    expect(new URL(other.url()).searchParams.get("project")).toBeTruthy();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("最近打开");
    await other.close();
    // With the keyboard, as any link.
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveTitle("课程片头 - AnimaQuill");
  });

  test("renames a folder from its card, which the folder gets once it opens", async ({ page }) => {
    await installChosen(page);
    await arrive(page);
    await newInFolder(page, "课程片头", "intro");
    await close(page);
    await cardMenu(page, "课程片头", "重命名…");
    const field = page.getByRole("textbox", { name: "“课程片头”的新名字" });
    await field.fill("课程片头 第二版");
    await field.press("Enter");
    await expect(projectCard(page, "课程片头 第二版")).toBeVisible();
    await openCard(page, "课程片头 第二版");
    await expect(page).toHaveTitle("课程片头 第二版 - AnimaQuill");
    await expect
      .poll(async () => JSON.parse((await privateText(page, "intro/animaquill.json")) ?? "{}").name)
      .toBe("课程片头 第二版");
  });

  test("welcomes people with nothing yet, and lists their projects of the platform there", async ({
    page,
  }) => {
    await arrive(page);
    const welcome = page.getByRole("region", { name: "欢迎使用 AnimaQuill" });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole("button", { name: /^新建云端项目/ })).toBeEnabled();
    await expect(welcome.getByRole("button", { name: /^新建本地项目/ })).toBeEnabled();
    await expect(welcome.getByRole("button", { name: /^打开文件夹/ })).toBeEnabled();
    await shot(page, "07-empty");

    // Another computer: what is on the platform shows under it, and is no project lost.
    await withLab(page, (lab) => {
      lab.seed("产品发布短片", { repository: "launch" });
      lab.seed("年会开场", { repository: "annual", ago: 26 * 3_600_000 });
    });
    // As the menu asks for them; the page reads the list again then.
    await chooseFrom(page, "文件", "打开云端的项目…");
    await expect.poll(() => names(page)).toEqual(["产品发布短片", "年会开场"]);
    await showView(page, "最近打开");
    await expect(welcome).toBeVisible();
    await expect.poll(() => names(page, "你的云端项目")).toEqual(["产品发布短片", "年会开场"]);
    await shot(page, "08-cloud-not-opened-here");
    await openCard(page, "年会开场");
    await expect(page).toHaveTitle("年会开场 - AnimaQuill");
  });

  test("makes a project of the platform from its card, with its dialog in the look of the page", async ({
    page,
  }) => {
    await arrive(page);
    await page.getByRole("button", { name: /^新建云端项目/ }).click();
    const making = page.locator("dialog[data-create-kind]");
    await expect(making).toHaveAttribute("data-create-kind", "cloud");
    await expect(making.getByRole("radio", { name: /^云端项目/ })).toBeChecked();
    await shot(page, "15-new-dialog");
    await making.getByRole("radio", { name: /^本地项目/ }).check();
    await expect(making).toHaveAttribute("data-create-kind", "local");
    await shot(page, "15-new-dialog-local");
  });

  test("says how to get to the projects of the platform while nobody is signed in", async ({
    page,
  }) => {
    await installChosen(page);
    await arrive(page, { signedIn: false });
    await newInFolder(page, "课程片头", "intro");
    await close(page);
    await expect(sidebar(page).getByText("登录后可以用云端项目")).toBeVisible();
    await shot(page, "09-signed-out");
    await filterTo(page, "云端");
    await expect(page.getByText("登录后可以打开你存在云端的项目。")).toBeVisible();
    await page.getByRole("main").getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("登录后可以打开你存在云端的项目。")).toHaveCount(0);
    await expect(sidebar(page).getByText("octo")).toBeVisible();
  });

  test("is the same in a narrow window, with the side bar on top", async ({ page }) => {
    await installChosen(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await arrive(page);
    await withLab(page, (lab) => {
      lab.seed("产品发布短片", { repository: "launch" });
    });
    await newInFolder(page, "课程片头", "intro");
    await close(page);
    const bar = await sidebar(page).boundingBox();
    const main = await page.getByRole("main").boundingBox();
    expect(bar && main && bar.y + bar.height <= main.y + 1).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await shot(page, "14-narrow");
    await showView(page, "全部项目");
    await shot(page, "14-narrow-all");
  });
});

test.describe("the start page where the editor runs on this computer", () => {
  test.use({ folders: true });

  test("has only projects of this computer, and no account", async ({ page }) => {
    await installChosen(page);
    await arrive(page, { cloud: false });
    await expect(page.getByRole("button", { name: /^新建云端项目/ })).toHaveCount(0);
    await shot(page, "12-local-empty");
    await sidebar(page).getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("textbox", { name: "项目名称" }).fill("课程片头");
    await page.keyboard.press("Enter");
    await expect(tab(page, "preview")).toBeVisible();
    await close(page);
    await expect(projectCard(page, "课程片头")).toBeVisible();
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await expect(sidebar(page).getByText("登录")).toHaveCount(0);
    await shot(page, "12-local");
  });
});

test.describe("the start page in a browser without folders", () => {
  test("asks people to sign in, or to switch browsers, and lists what this browser has", async ({
    page,
  }) => {
    await arrive(page, { signedIn: false });
    await expect(page.getByText("登录后使用，或者换用 Edge、Chrome。")).toBeVisible();
    await shot(page, "10-no-folders-signed-out");
    await page.getByRole("main").getByRole("button", { name: "登录", exact: true }).click();
    await expect(sidebar(page).getByText("这个浏览器不能打开文件夹，只能用云端项目")).toBeVisible();
    await expect(page.getByRole("button", { name: /^新建云端项目/ }).first()).toBeEnabled();
    const local = page.getByRole("button", { name: /^新建本地项目/ }).first();
    await expect(local).toBeDisabled();
    await expect(local).toContainText("这个浏览器不能打开电脑上的文件夹，请换用 Edge 或 Chrome。");
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await shot(page, "11-no-folders-signed-in");
  });

  test("on this computer, says to use Edge or Chrome, and still opens what this browser has", async ({
    page,
  }) => {
    await arrive(page, { cloud: false });
    await createProject(page, "旧项目");
    await close(page);
    await expect(
      page.getByText("这个浏览器不能打开电脑上的文件夹，本机版请用 Edge 或 Chrome。"),
    ).toBeVisible();
    await expect(statusOf(page, "旧项目")).toHaveText(/^只在浏览器里/);
    await shot(page, "13-local-no-folders");
    await openCard(page, "旧项目");
    await expect(page).toHaveTitle("旧项目 - AnimaQuill");
  });

  test("renames once, however the field is left, and says once why a locked one cannot be", async ({
    page,
  }) => {
    await arrive(page, { cloud: false });
    await createProject(page, "片头");
    await page.evaluate(() => (window as unknown as { aqSave: () => Promise<void> }).aqSave());
    const before = await updatesIn(page);
    await close(page);
    await cardMenu(page, "片头", "重命名…");
    const field = page.getByRole("textbox", { name: "“片头”的新名字" });
    await field.fill("开场");
    // Enter, and at once out of the field, while what Enter does is still being kept.
    await field.evaluate((element: HTMLInputElement) => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      element.blur();
    });
    await expect(projectCard(page, "开场")).toBeVisible();
    expect(await updatesIn(page)).toBe(before + 1);

    // Locked: nothing changes, and it says so once, where the name was typed.
    await openCard(page, "开场");
    await page.evaluate(() =>
      (window as unknown as { aqExecute: (call: unknown) => unknown }).aqExecute({
        type: "project.setTags",
        params: { tags: [{ name: "定稿", locked: true }] },
      }),
    );
    await page.evaluate(() => (window as unknown as { aqSave: () => Promise<void> }).aqSave());
    await close(page);
    await cardMenu(page, "开场", "重命名…");
    await page.getByRole("textbox", { name: "“开场”的新名字" }).fill("改不了");
    await page.keyboard.press("Enter");
    const locked = "这个项目锁定了，不能改名。打开项目解除锁定以后再改。";
    await expect(page.getByRole("alert").filter({ hasText: locked })).toHaveCount(1);
    await expect(page.getByText(locked)).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(projectCard(page, "开场")).toBeVisible();
  });

  test("renames a project from its card, also in a window that has it open", async ({
    page,
    context,
  }) => {
    await arrive(page, { cloud: false });
    await createProject(page, "片头");
    const other = await context.newPage();
    await other.goto(page.url());
    await editorReady(other);
    await expect(other).toHaveTitle("片头 - AnimaQuill");
    await close(page);
    await cardMenu(page, "片头", "重命名…");
    await page.getByRole("textbox", { name: "“片头”的新名字" }).fill("开场");
    await page.keyboard.press("Enter");
    await expect(projectCard(page, "开场")).toBeVisible();
    await expect(other).toHaveTitle("开场 - AnimaQuill");
    // Once in each, and the same.
    await chooseFrom(other, "文件", "关闭项目");
    await expect(projectCard(other, "开场")).toHaveCount(1);
    await openCard(page, "开场");
    await expect(page).toHaveTitle("开场 - AnimaQuill");
    // Escape keeps the name.
    await close(page);
    await cardMenu(page, "开场", "重命名…");
    await page.getByRole("textbox", { name: "“开场”的新名字" }).fill("不要了");
    await page.keyboard.press("Escape");
    await expect(projectCard(page, "开场")).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);
  });
});
