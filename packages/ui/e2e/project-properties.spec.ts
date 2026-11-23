import type { Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { footer, nameIn, openDropped, projectOnDisk, text } from "./folder-support.ts";
import { openCard, projectCard } from "./start-support.ts";
import { content, devPageOnly, editorReady, expect, tab, test } from "./support.ts";

/**
 * The project properties (docs/design/settings-and-properties.md of AnimaQuill Cloud, 5 and step
 * S-B): the example project as a folder, so that every group has something to show and what changes
 * can be read in the folder; a project of the platform in a folder and one only in this browser;
 * and no project at all. Pictures of each group and dialog go to the output of the tests.
 */

test.use({
  folders: true,
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

const props = (page: Page) => page.getByTestId("project-properties");
const groups = (page: Page) => props(page).getByRole("navigation", { name: "项目属性的分组" });
const current = (page: Page) => groups(page).locator('[aria-current="page"]');
const statusName = (page: Page, name: string) =>
  footer(page).getByRole("button", { name, exact: true });
const confirmDialog = (page: Page) => page.locator("dialog[open]");
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

async function goTo(page: Page, group: string) {
  await groups(page).getByRole("button", { name: group, exact: true }).click();
  await expect(current(page)).toHaveText(group);
}

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

async function palette(page: Page, words: string) {
  await page.keyboard.press("Control+Shift+KeyP");
  await page.getByRole("combobox", { name: "命令面板" }).fill(words);
  await page.keyboard.press("Enter");
}

/** The example project, dropped in as a folder, with what the folder has of it. */
async function example(page: Page): Promise<string> {
  const disk = projectOnDisk();
  await openDropped(page, disk);
  return disk;
}

const GROUPS = [
  "常规",
  "画面和帧率",
  "声音",
  "时间轴",
  "语言和版本",
  "封面",
  "字体",
  "关联的库",
  "给 AI 的说明",
  "存放和同步",
] as const;

test.describe("the project properties of a project folder", () => {
  test("open from the name in the status bar, the file menu, the palette and their key, with nine groups", async ({
    page,
  }) => {
    await example(page);
    // The name opens them: no box to rename it in.
    await statusName(page, "原子是什么").click();
    await expect(props(page)).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(props(page).getByTestId("project-properties-name")).toHaveText("· 原子是什么");
    await expect(groups(page).getByRole("button")).toHaveText([...GROUPS]);
    for (const [index, group] of GROUPS.entries()) {
      await goTo(page, group);
      await expect(props(page).getByRole("heading", { name: group, level: 2 })).toBeVisible();
      await shot(page, `B${index + 1}-${group}`);
    }
    await page.keyboard.press("Escape");
    await expect(props(page)).toBeHidden();
    // Where they were last, from each way in.
    for (const open of [
      () => chooseFrom(page, "文件", "项目属性…"),
      () => palette(page, "项目属性…"),
      () => page.keyboard.press("Control+Alt+Comma"),
    ]) {
      await open();
      await expect(props(page)).toBeVisible();
      await expect(current(page)).toHaveText("存放和同步");
      await page.keyboard.press("Escape");
      await expect(props(page)).toBeHidden();
    }
    await palette(page, "项目属性：语言和版本");
    await expect(current(page)).toHaveText("语言和版本");
    await page.keyboard.press("Escape");
  });

  test("rename the project as “重命名项目” did, in the folder, and undo takes it back", async ({
    page,
  }) => {
    const disk = await example(page);
    await chooseFrom(page, "文件", "重命名项目");
    const name = props(page).getByRole("textbox", { name: "项目名称" });
    await expect(name).toBeFocused();
    await page.keyboard.type("原子的故事");
    // Esc takes back what was typed first, and only then closes.
    await page.keyboard.press("Escape");
    await expect(name).toHaveValue("原子是什么");
    await name.fill("原子的故事");
    await name.press("Enter");
    await expect(statusName(page, "原子的故事")).toBeVisible();
    await expect(props(page).getByTestId("project-properties-name")).toHaveText("· 原子的故事");
    await expect.poll(() => nameIn(disk), { timeout: 10_000 }).toBe("原子的故事");
    // A name that is empty does not go in, and says so.
    await name.fill("  ");
    await name.press("Enter");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await name.press("Escape");
    // Undo while they are open, from outside of a box to type in.
    await props(page).getByRole("heading", { name: "常规", level: 2 }).click();
    await page.keyboard.press("Control+KeyZ");
    await expect(statusName(page, "原子是什么")).toBeVisible();
    await expect(name).toHaveValue("原子是什么");
    // The description, as one more step.
    const description = props(page).getByRole("textbox", { name: "说明" });
    await description.fill("讲原子的一条片子");
    await description.press("Control+Enter");
    await expect
      .poll(() => JSON.parse(text(disk, "animaquill.json")).description, { timeout: 10_000 })
      .toBe("讲原子的一条片子");
    await page.keyboard.press("Escape");
    // The start page has the new name too.
    await statusName(page, "原子是什么").click();
    await props(page).getByRole("textbox", { name: "项目名称" }).fill("换了名字的原子");
    await props(page).getByRole("textbox", { name: "项目名称" }).press("Enter");
    await page.keyboard.press("Escape");
    await chooseFrom(page, "文件", "关闭项目");
    const card = projectCard(page, "换了名字的原子");
    await expect(card).toBeVisible();
    // The description shows over the cover while the pointer is on the card.
    const described = card.locator("[data-card-description]");
    await expect(described).toHaveText("讲原子的一条片子");
    await expect(described).toHaveCSS("opacity", "0");
    await card.hover();
    await expect(described).toHaveCSS("opacity", "1");
    await shot(page, "B-start-card-description");
  });

  test("change the frame rate once people read what it comes to, and nothing moves", async ({
    page,
  }) => {
    const disk = await example(page);
    const timeline = text(disk, "timelines/main/timeline.json");
    await statusName(page, "原子是什么").click();
    await goTo(page, "画面和帧率");
    await props(page).getByRole("combobox", { name: "剪辑帧率" }).selectOption("25");
    const asking = confirmDialog(page);
    await expect(asking.getByRole("heading")).toHaveText("把帧率从 30 改成 25？");
    await expect(asking).toContainText("一个都不会移动");
    await expect(asking).toContainText("时间码按 25 帧显示：0:12/15 会变成 0:12/12");
    await expect(asking).toContainText(/有 \d+ 处时间不在 25 帧的格子上/);
    await expect(
      asking.getByRole("combobox", { name: "母版画幅“YouTube 横屏”的导出帧率" }),
    ).toHaveValue("along");
    await shot(page, "B-fps-confirm");
    await asking.getByRole("button", { name: "改成 25" }).click();
    await expect(footer(page).getByRole("button", { name: "项目帧率" })).toHaveText("25 帧");
    await expect
      .poll(() => JSON.parse(text(disk, "animaquill.json")).fps, { timeout: 10_000 })
      .toBe("25");
    expect(JSON.parse(text(disk, "animaquill.json")).formats[0].fps).toBe("25");
    // Every time is as it was: the file of the timeline did not change at all.
    expect(text(disk, "timelines/main/timeline.json")).toBe(timeline);
    // What is off the frames of 25 is listed as problems, which no export stops for.
    await page.keyboard.press("Escape");
    await tab(page, "problems").click();
    await expect(content(page, "problems")).toContainText("不在 25 帧的格子上");
  });

  test("take a colour as soon as it is picked, also when Esc closes them right after", async ({
    page,
  }) => {
    const disk = await example(page);
    await statusName(page, "原子是什么").click();
    await goTo(page, "画面和帧率");
    await props(page).locator('input[type="color"][aria-label="背景色"]').fill("#112233");
    await page.keyboard.press("Escape");
    await expect(props(page)).toBeHidden();
    await expect
      .poll(() => JSON.parse(text(disk, "timelines/main/timeline.json")).background, {
        timeout: 10_000,
      })
      .toBe("#112233");
    expect(JSON.parse(text(disk, "timelines/highlight/timeline.json")).background).toBe("#112233");
  });

  test("show the frame before and after a master of another shape, and add a format instead", async ({
    page,
  }) => {
    const disk = await example(page);
    await statusName(page, "原子是什么").click();
    await goTo(page, "画面和帧率");
    await props(page).getByRole("button", { name: "改画幅“YouTube 横屏”" }).click();
    const editor = props(page).getByTestId("format-editor");
    await editor.getByRole("textbox", { name: "宽（像素）" }).fill("1080");
    await editor.getByRole("textbox", { name: "高（像素）" }).fill("1920");
    await editor.getByRole("button", { name: "保存" }).click();
    const asking = confirmDialog(page);
    await expect(asking.getByRole("heading")).toHaveText("把母版从 16:9 改成 9:16？");
    await expect(asking.getByRole("img")).toHaveCount(2, { timeout: 20_000 });
    await expect(asking).toContainText("加一个画幅更好");
    await shot(page, "B-ratio-confirm");
    await asking.getByRole("button", { name: "加一个画幅（母版不动）" }).click();
    await expect
      .poll(() => JSON.parse(text(disk, "animaquill.json")).formats.length, { timeout: 10_000 })
      .toBe(3);
    expect(JSON.parse(text(disk, "animaquill.json")).formats[0]).toMatchObject({
      width: 1920,
      height: 1080,
    });
  });

  test("list what goes with a language before it goes", async ({ page }) => {
    const disk = await example(page);
    await statusName(page, "原子是什么").click();
    await goTo(page, "语言和版本");
    await props(page).getByRole("button", { name: "删掉语言“English”" }).click();
    const asking = confirmDialog(page);
    await expect(asking).toContainText("locales/en.json");
    await expect(asking).toContainText("timelines/main/overrides/language.en.json");
    await expect(asking).toContainText("timelines/main/overrides/version.en.vertical.json");
    await shot(page, "B-language-remove");
    await asking.getByRole("button", { name: "删掉" }).click();
    await expect
      .poll(() => existsSync(join(disk, "locales/en.json")), { timeout: 10_000 })
      .toBe(false);
    // And back, as one step.
    await props(page).getByRole("heading", { name: "语言和版本", level: 2 }).click();
    await page.keyboard.press("Control+KeyZ");
    await expect
      .poll(() => existsSync(join(disk, "locales/en.json")), { timeout: 10_000 })
      .toBe(true);
  });

  test("lock the project with a tag: every field is read-only and says why", async ({ page }) => {
    await example(page);
    await statusName(page, "原子是什么").click();
    await props(page).getByRole("button", { name: "加标签" }).click();
    const naming = confirmDialog(page);
    await naming.getByRole("textbox").fill("已交付");
    await naming.getByRole("button", { name: "加标签" }).click();
    const tag = props(page).locator('[data-tag="已交付"]');
    await tag.getByRole("checkbox").click();
    const asking = confirmDialog(page);
    await expect(asking).toContainText("锁定后整个项目只读，你和 AI 都改不了");
    await asking.getByRole("button", { name: "锁定" }).click();
    await expect(props(page).getByTestId("project-properties-locked")).toContainText("锁定标签");
    await expect(props(page).getByRole("textbox", { name: "项目名称" })).toBeDisabled();
    await expect(props(page).getByRole("textbox", { name: "说明" })).toBeDisabled();
    await shot(page, "B-locked");
    await goTo(page, "画面和帧率");
    await expect(props(page).getByRole("combobox", { name: "剪辑帧率" })).toBeDisabled();
    await expect(props(page).getByRole("button", { name: "改画幅“YouTube 横屏”" })).toBeDisabled();
    // The way out is right there.
    await props(page).getByRole("button", { name: "去标签" }).click();
    await tag.getByRole("checkbox").click();
    await confirmDialog(page).getByRole("button", { name: "去掉锁定" }).click();
    await expect(props(page).getByTestId("project-properties-locked")).toHaveCount(0);
    await expect(props(page).getByRole("textbox", { name: "项目名称" })).toBeEnabled();
  });

  test("go one level at a time in a narrow window, also with the back button", async ({ page }) => {
    await example(page);
    await page.setViewportSize({ width: 390, height: 800 });
    await statusName(page, "原子是什么").click();
    await expect(groups(page)).toBeVisible();
    await shot(page, "B-narrow-groups");
    await groups(page).getByRole("button", { name: "画面和帧率" }).click();
    await expect(groups(page)).toHaveCount(0);
    await expect(props(page).getByRole("heading", { name: "画面和帧率", level: 2 })).toBeVisible();
    await shot(page, "B-narrow");
    await props(page).getByTestId("project-properties-back").click();
    await expect(groups(page)).toBeVisible();
    await groups(page).getByRole("button", { name: "封面" }).click();
    await page.goBack();
    await expect(groups(page)).toBeVisible();
    await page.goBack();
    await expect(props(page)).toBeHidden();
  });
});

test.describe("without a project", () => {
  test("say where new assets go: only on this computer offline, the repository grey until signed in", async ({
    page,
  }) => {
    await example(page);
    await statusName(page, "原子是什么").click();
    await goTo(page, "存放和同步");
    const choice = props(page).getByRole("combobox", { name: "默认存储空间" });
    await expect(choice).toHaveValue("local");
    await expect(choice.locator('option[value="lfs"]')).toBeDisabled();
    await expect(choice.locator('option[value="lfs"]')).toHaveText(
      "GitHub 大文件存储（登录后可用）",
    );
    await expect(props(page)).toContainText("素材放在项目文件夹里。");
    // Offline nothing is uploaded: no line of where the assets are.
    await expect(props(page).getByTestId("project-assets")).toHaveCount(0);
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await shot(page, `default-storage-offline-${scheme}`);
    }
  });

  test("have no way in", async ({ page }) => {
    await page.keyboard.press("Control+Alt+Comma");
    await expect(props(page)).toHaveCount(0);
    await page.keyboard.press("Control+Shift+KeyP");
    await page.getByRole("combobox", { name: "命令面板" }).fill("项目属性");
    await expect(page.getByRole("option", { name: /项目属性/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "项目属性…" })).toHaveCount(0);
  });
});

test.describe("the project properties of projects of the platform", () => {
  devPageOnly("a platform in the tab, with ?cloud=fake");

  const ADDRESS = "/?account=fake&cloud=fake";

  async function arrive(page: Page) {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      if (sessionStorage.getItem("animaquill.fakeAccount") === null)
        sessionStorage.setItem(
          "animaquill.fakeAccount",
          JSON.stringify({ signedIn: true, installed: true }),
        );
    });
    await page.goto(ADDRESS);
    await editorReady(page);
  }

  test("say where a project of the platform is", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page);
    // One of the platform, opened.
    await page.evaluate(() => {
      (window as unknown as { aqCloud: { seed(name: string, more: object): string } }).aqCloud.seed(
        "片头动画",
        { repository: "opening" },
      );
    });
    await chooseFrom(page, "文件", "打开在线项目…");
    await openCard(page, "片头动画");
    await expect(page).toHaveTitle("片头动画 - AnimaQuill");
    await statusName(page, "片头动画").click();
    await goTo(page, "存放和同步");
    const storage = props(page).getByTestId("project-properties-storage");
    await expect(storage).toContainText("在线项目");
    await expect(storage).toContainText("octo/opening");
    await expect(storage).toContainText("保存到文件夹…");
    // Nothing of a folder that the project could be tied to: that is gone.
    await expect(storage).not.toContainText("关联");
    await shot(page, "B-storage-cloud-browser");
    // Its description goes to the platform, and comes back with its list on the start page.
    await goTo(page, "常规");
    const description = props(page).getByRole("textbox", { name: "说明" });
    await description.fill("在线项目的说明");
    await description.press("Control+Enter");
    await page.keyboard.press("Escape");
    await chooseFrom(page, "文件", "关闭项目");
    const card = projectCard(page, "片头动画");
    await card.hover();
    await expect(card.locator("[data-card-description]")).toHaveText("在线项目的说明");
  });
});
