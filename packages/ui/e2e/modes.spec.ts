import type { Page } from "@playwright/test";
import { footer, installChosen, privateText, putPrivate } from "./folder-support.ts";
import { projectCard, sidebar } from "./start-support.ts";
import { devPageOnly, editorReady, expect, tab, test } from "./support.ts";

/**
 * The two modes (docs/design/online-offline.md of AnimaQuill Cloud, 1 and 2): the entry page of a
 * site with a backend, the offline mode, which asks nothing of the backend, and the online one,
 * where projects are the platform's and folders only copies. The development page has a backend
 * with `?account=fake&cloud=fake`, see dev/account.ts and dev/cloud.ts. Pictures go to the output.
 */

devPageOnly("a backend in the tab, with ?account=fake&cloud=fake");
test.use({ withProject: false });

const ADDRESS = "/?account=fake&cloud=fake";
const entry = (page: Page) => page.getByTestId("entry");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** Comes to the site as somebody who is signed in there, or not. */
async function arrive(page: Page, signedIn: boolean, address = ADDRESS) {
  await page.addInitScript(
    (kept) => {
      if (window !== window.top) return;
      if (sessionStorage.getItem("animaquill.fakeAccount") === null)
        sessionStorage.setItem("animaquill.fakeAccount", JSON.stringify(kept));
    },
    { signedIn, installed: true },
  );
  await page.goto(address);
}

/** The requests the page sends to the backend, from now on. */
function backendRequests(page: Page): string[] {
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api")) asked.push(url.pathname);
  });
  return asked;
}

test.describe("the entry page", () => {
  test("has signing in and the offline mode, and remembers the offline mode", async ({ page }) => {
    await arrive(page, false);
    await expect(entry(page).getByRole("button", { name: "用 GitHub 登录" })).toBeVisible();
    const offline = entry(page).getByRole("button", { name: "不登录，使用离线模式" });
    await expect(offline).toBeVisible();
    await expect(entry(page)).toContainText("不连服务器。");
    await shot(page, "entry");
    await offline.click();
    await editorReady(page);
    await expect(page).toHaveURL(/\/offline\?account=fake&cloud=fake$/);
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByTestId("start-offline")).toContainText("离线模式");
    // A reload stays offline, and so does the site next time.
    await page.reload();
    await editorReady(page);
    await expect(page).toHaveURL(/\/offline/);
    await page.goto(ADDRESS);
    await editorReady(page);
    await expect(page).toHaveURL(/\/offline/);
    await expect(entry(page)).toHaveCount(0);
  });

  test("signs in and comes back to the link of a project of the online mode", async ({ page }) => {
    await arrive(page, false, "/p/p-wanted?account=fake&cloud=fake");
    // Even where people chose the offline mode before: a link of the online mode asks to sign in.
    await expect(entry(page)).toBeVisible();
    const back = page.waitForURL(/\/p\/p-wanted\?account=fake&cloud=fake$/, {
      waitUntil: "commit",
    });
    await entry(page).getByRole("button", { name: "用 GitHub 登录" }).click();
    await back;
    await editorReady(page);
    // The platform of the tab has no such project: people hear that it is not there.
    await expect(page.getByRole("button", { name: /^账号：octo/ }).first()).toBeVisible();
  });
});

test.describe("the offline mode", () => {
  test("asks nothing of the backend, whatever people do", async ({ page }) => {
    const asked = backendRequests(page);
    await arrive(page, true, "/offline?account=fake&cloud=fake");
    await editorReady(page);
    await expect(page.getByRole("button", { name: "账号：octo" })).toHaveCount(0);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    await page.getByRole("textbox", { name: "项目名称" }).fill("离线的");
    await page.keyboard.press("Enter");
    await expect(tab(page, "preview")).toBeVisible();
    await expect(page).toHaveURL(/\/offline\/p\//);
    await page.reload();
    await editorReady(page);
    await expect(tab(page, "preview")).toBeVisible();
    await expect(page).toHaveTitle("离线的 - AnimaQuill");
    await page.getByTestId("title-settings").click();
    await page.keyboard.press("Escape");
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "关闭项目", exact: true }).click();
    await expect(projectCard(page, "离线的")).toBeVisible();
    expect(asked).toEqual([]);
  });

  test("keeps a project of a browser that cannot write folders in it, saying so", async ({
    page,
  }) => {
    // People did not hear about it before, unlike in the other tests.
    await page.addInitScript(() => {
      if (window === window.top)
        localStorage.removeItem("aq-offline-animaquill.offline.browserProjects");
    });
    await page.goto("/offline");
    await editorReady(page);
    await expect(page.getByRole("button", { name: /^新建项目/ }).last()).toContainText(
      "项目存在这个浏览器里",
    );
    await page.getByRole("button", { name: "新建项目" }).first().click();
    await page.getByRole("textbox", { name: "项目名称" }).fill("浏览器里的");
    await page.keyboard.press("Enter");
    const told = page.getByRole("dialog", { name: "项目会存在这个浏览器里" });
    await expect(told).toContainText("清理浏览器数据时会丢");
    await told.getByRole("button", { name: "知道了" }).click();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByRole("button", { name: /只在浏览器里$/ })).toBeVisible();
    // The second time people are not told again.
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "关闭项目", exact: true }).click();
    await expect(projectCard(page, "浏览器里的")).toContainText("只在浏览器里");
  });

  test("has what needs the online mode grey, and a sign-in for it", async ({ page }) => {
    await arrive(page, false, "/offline?account=fake&cloud=fake");
    await editorReady(page);
    const storage = sidebar(page).getByRole("button", { name: "存储空间" });
    await expect(storage).toHaveAttribute("aria-disabled", "true");
    await expect(storage).toHaveAttribute("title", "登录后可用");
    await shot(page, "offline-start");
    // Grey as what cannot be used now, and still something to press.
    await storage.click({ force: true });
    const asked = page.getByRole("dialog", { name: "这需要登录" });
    await expect(asked).toContainText("“存储空间”要登录后才能用");
    await shot(page, "offline-needs-online");
    await asked.getByRole("button", { name: "登录" }).click();
    await editorReady(page);
    await expect(page).not.toHaveURL(/\/offline/);
    await expect(page.getByRole("button", { name: /^账号：octo/ }).first()).toBeVisible();
  });
});

test.describe("the online mode", () => {
  test.use({ folders: true });

  /** A new project of the platform, made in the dialog. */
  async function newOnline(page: Page, name: string) {
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const box = page.locator("dialog[data-create-phase]");
    await box.getByRole("textbox", { name: "项目名称" }).fill(name);
    await box.getByRole("button", { name: "新建", exact: true }).click();
    await expect(box).toHaveAttribute("data-create-phase", /archiving|done/);
    await box.getByRole("button", { name: /^(关闭|完成)$/ }).click();
    await expect(tab(page, "preview")).toBeVisible();
  }

  test("makes, opens, and saves a copy to a folder that it replaces the next time", async ({
    page,
  }) => {
    await installChosen(page);
    await arrive(page, true);
    await editorReady(page);
    // No folders, no filters, no sign of where a project is.
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await expect(page.locator("[data-new]")).toHaveText([
      /^新建项目/,
      /^从仓库打开/,
      /^从文件夹导入/,
    ]);
    await shot(page, "online-start");
    await newOnline(page, "宣传片");
    await expect(page).toHaveURL(/\/p\//);
    await expect(footer(page).locator('[data-save-status="local"]')).toHaveCount(0);
    await expect(footer(page).locator('[data-save-status="sync"]')).toBeVisible();

    await page.evaluate(() => {
      window.chosenFolder = "导出/宣传片";
    });
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "保存到文件夹…", exact: true }).click();
    const done = page.getByRole("dialog", { name: "已保存到「宣传片」" });
    await expect(done).toContainText("这是一份复制，之后的改动不会自动写进去。");
    await expect(done.getByRole("button", { name: "在离线模式里打开" })).toBeVisible();
    await shot(page, "save-to-folder-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await shot(page, "save-to-folder-light");
    await page.emulateMedia({ colorScheme: "dark" });
    await done.getByRole("button", { name: "好" }).click();
    expect(await privateText(page, "导出/宣传片/animaquill.json")).toContain('"name": "宣传片"');

    // Something of people's own in the folder, and a file of the format the project does not have.
    await putPrivate(page, "导出/宣传片", {
      "笔记.txt": "people's own",
      "code/旧的.js": "from before\n",
    });
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "保存到文件夹…", exact: true }).click();
    const again = page.getByRole("dialog", { name: "保存「宣传片」" });
    await expect(again).toContainText("上次保存在文件夹「宣传片」");
    await expect(again).toContainText("别的文件不动");
    await shot(page, "save-to-folder-again");
    await again.getByRole("button", { name: "替换" }).click();
    await page
      .getByRole("dialog", { name: "已保存到「宣传片」" })
      .getByRole("button", { name: "好" })
      .click();
    expect(await privateText(page, "导出/宣传片/笔记.txt")).toBe("people's own");
    expect(await privateText(page, "导出/宣传片/code/旧的.js")).toBeUndefined();
  });

  test("keeps going online after a reload, and the mode in the address", async ({ page }) => {
    await arrive(page, true);
    await editorReady(page);
    await newOnline(page, "原子");
    const address = page.url();
    await page.reload();
    await editorReady(page);
    await expect(page).toHaveURL(address);
    await expect(tab(page, "preview")).toBeVisible();
    await expect(page).toHaveTitle("原子 - AnimaQuill");
  });

  test("goes to the offline mode without signing out, where nothing of it shows", async ({
    page,
  }) => {
    await arrive(page, true);
    await editorReady(page);
    await newOnline(page, "在线的");
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "关闭项目", exact: true }).click();
    await page
      .getByRole("button", { name: /^账号：octo/ })
      .first()
      .click();
    await page.getByRole("menuitem", { name: "切换到离线模式" }).click();
    await editorReady(page);
    await expect(page).toHaveURL(/\/offline/);
    await expect(projectCard(page, "在线的")).toHaveCount(0);
    // And back, signed in all along: the copy of the online mode is there again.
    await sidebar(page).getByRole("button", { name: "登录" }).click();
    await editorReady(page);
    await expect(page).not.toHaveURL(/\/offline/);
  });
});
