import type { Page } from "@playwright/test";
import { dialog, footer, installChosen, privateText } from "./folder-support.ts";
import {
  cardMenu,
  openCard,
  projectCard,
  projectList,
  showView,
  sidebar,
  statusOf,
} from "./start-support.ts";
import {
  chooseFromMenu,
  createProject,
  devPageOnly,
  editorReady,
  expect,
  tab,
  test,
} from "./support.ts";

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

const chooseFrom = chooseFromMenu;

const close = (page: Page) => chooseFrom(page, "文件", "关闭项目");

/** How many changes the projects of this browser have in their logs. */
const updatesIn = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("aq-offline-animaquill");
        open.onsuccess = () => {
          const request = open.result.transaction("updates").objectStore("updates").count();
          request.onsuccess = () => {
            open.result.close();
            resolve(request.result);
          };
        };
      }),
  );

/** A new project in a folder of its name, in that place, in the offline mode, through the dialog. */
async function newInFolder(page: Page, name: string, place: string) {
  await page.evaluate((chosen) => {
    window.chosenFolder = chosen;
  }, place);
  await sidebar(page).getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await dialog(page)
    .getByRole("button", { name: /^(选择|更改)…$/ })
    .click();
  await expect(dialog(page).locator("[data-place]")).toHaveText(place);
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
}

const names = (page: Page, list = "项目") =>
  projectList(page, list).locator("li[data-project]").locator("[data-card-name]").allInnerTexts();

test.describe("the start page of the online mode", () => {
  test("shows them as a wall, which people search, sort and organise", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page);
    await withLab(page, (lab) => {
      lab.seed("产品发布短片", { repository: "launch" });
      lab.seed("年会开场", { repository: "annual", ago: 3 * 24 * 3_600_000 });
      lab.seed("教程：关键帧入门", { repository: "keyframes" });
      lab.seed("旅行 Vlog 第 3 集", { repository: "travel-vlog" });
    });
    await chooseFrom(page, "文件", "打开在线项目…");
    await showView(page, "全部项目");
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await openCard(page, "产品发布短片");
    await expect(page).toHaveTitle("产品发布短片 - AnimaQuill");
    await close(page);

    // What was opened here, the last first; nothing else is "recent".
    await expect(sidebar(page).getByRole("button", { name: "最近打开" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect.poll(() => names(page)).toEqual(["产品发布短片"]);
    // Nothing of where a project is, and a line with the repository.
    await expect(statusOf(page, "产品发布短片")).toHaveText(/^octo\/launch/);
    // Recent has no sort of its own.
    await expect(page.getByRole("button", { name: /^排序：/ })).toHaveCount(0);
    await projectCard(page, "产品发布短片")
      .getByRole("button", { name: "收藏“产品发布短片”" })
      .click();
    await expect(sidebar(page).getByRole("button", { name: /^收藏/ })).toHaveText("收藏1");
    await shot(page, "01-recent");

    await showView(page, "全部项目");
    await expect(projectList(page).locator("li[data-project]")).toHaveCount(4);
    await shot(page, "02-all");
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
      .toEqual(["产品发布短片", "教程：关键帧入门", "旅行 Vlog 第 3 集", "年会开场"]);
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

    // Only what works now: the same for what was opened here and what was not.
    const menuOf = async (name: string) => {
      await projectCard(page, name)
        .getByRole("button", { name: `“${name}”的更多操作` })
        .click();
      return page.getByRole("menu").getByRole("menuitem").allInnerTexts();
    };
    expect(await menuOf("产品发布短片")).toEqual([
      "打开",
      "重命名…",
      "取消收藏",
      "移到分组…",
      "设置封面…",
      "保存到文件夹…",
      "在 GitHub 上打开",
      "删除项目…",
    ]);
    await shot(page, "05-menu");
    await page.keyboard.press("Escape");
    expect(await menuOf("年会开场")).toEqual([
      "打开",
      "收藏",
      "移到分组…",
      "设置封面…",
      "保存到文件夹…",
      "在 GitHub 上打开",
      "删除项目…",
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
    await projectCard(page, "产品发布短片").locator("a").first().dragTo(work);
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
      .toEqual(["年会开场", "产品发布短片"].toSorted());
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
    await expect(projectList(page).locator("li[data-project]")).toHaveCount(4);
  });

  test("welcomes people with nothing yet, and lists their projects there", async ({ page }) => {
    await arrive(page);
    const welcome = page.getByRole("region", { name: "欢迎使用 AnimaQuill" });
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole("button", { name: /^新建项目/ })).toBeEnabled();
    await expect(welcome.getByRole("button", { name: /^新建在线项目/ })).toHaveCount(0);
    await expect(welcome.getByRole("button", { name: /^新建离线项目/ })).toHaveCount(0);
    await shot(page, "07-empty");

    // Another computer: what is on the platform shows under it, and is no project lost.
    await withLab(page, (lab) => {
      lab.seed("产品发布短片", { repository: "launch" });
      lab.seed("年会开场", { repository: "annual", ago: 26 * 3_600_000 });
    });
    // As the menu asks for them; the page reads the list again then.
    await chooseFrom(page, "文件", "打开在线项目…");
    await expect.poll(() => names(page)).toEqual(["产品发布短片", "年会开场"]);
    await showView(page, "最近打开");
    await expect(welcome).toBeVisible();
    await expect.poll(() => names(page, "你的在线项目")).toEqual(["产品发布短片", "年会开场"]);
    await shot(page, "08-cloud-not-opened-here");
    await openCard(page, "年会开场");
    await expect(page).toHaveTitle("年会开场 - AnimaQuill");
  });

  test("is the same in a narrow window, with the side bar on top", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await arrive(page);
    await withLab(page, (lab) => {
      lab.seed("产品发布短片", { repository: "launch" });
      lab.seed("年会开场", { repository: "annual" });
    });
    await chooseFrom(page, "文件", "打开在线项目…");
    await showView(page, "全部项目");
    await expect(projectCard(page, "年会开场")).toBeVisible();
    const bar = await sidebar(page).boundingBox();
    const main = await page.getByRole("main").boundingBox();
    expect(bar && main && bar.y + bar.height <= main.y + 1).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await shot(page, "14-narrow");
  });
});

test.describe("the start page of the offline mode, with folders", () => {
  test.use({ folders: true });

  test("opens a card in this tab with a click, and in a new one with Ctrl", async ({
    page,
    context,
  }) => {
    await installChosen(page);
    await arrive(page, { cloud: false });
    await newInFolder(page, "课程片头", "intro");
    await close(page);
    const link = projectCard(page, "课程片头").getByRole("link");
    await expect(link).toHaveAttribute("href", /\/offline\/p\//);
    const opening = context.waitForEvent("page");
    await link.click({ modifiers: ["ControlOrMeta"] });
    const other = await opening;
    await editorReady(other);
    // The new tab has the project in its address; this one stays on the start page.
    expect(new URL(other.url()).pathname).toMatch(/^\/offline\/p\//);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("最近打开");
    await other.close();
    // With the keyboard, as any link.
    await link.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveTitle("课程片头 - AnimaQuill");
  });

  test("renames a folder from its card, which the folder gets once it opens", async ({ page }) => {
    await installChosen(page);
    await arrive(page, { cloud: false });
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
      .poll(
        async () =>
          JSON.parse((await privateText(page, "intro/课程片头/animaquill.json")) ?? "{}").name,
      )
      .toBe("课程片头 第二版");
  });
});

test.describe("the start page of the offline mode, where the editor runs on this computer", () => {
  test.use({ folders: true });

  test("has only projects of this computer, and no account", async ({ page }) => {
    await installChosen(page);
    await arrive(page, { cloud: false });
    await expect(page.getByRole("button", { name: /^新建在线项目/ })).toHaveCount(0);
    await shot(page, "12-local-empty");
    await sidebar(page).getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("textbox", { name: "项目名称" }).fill("课程片头");
    await page.keyboard.press("Enter");
    await expect(tab(page, "preview")).toBeVisible();
    await close(page);
    await expect(projectCard(page, "课程片头")).toBeVisible();
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await shot(page, "12-local");
  });
});

test.describe("the start page in a browser without folders", () => {
  test("on this computer, says to use Edge or Chrome, and still opens what this browser has", async ({
    page,
  }) => {
    await arrive(page, { cloud: false });
    await createProject(page, "旧项目");
    await close(page);
    await expect(page.getByRole("button", { name: /^新建项目/ }).last()).toContainText(
      "项目存在这个浏览器里",
    );
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
    // The lock is in the log of the project before the project is let go: a rename asks the log,
    // and on a slow runner (CI) it came first and found nothing locked.
    await expect.poll(() => updatesIn(page), { timeout: 20_000 }).toBeGreaterThan(before + 1);
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
