import type { Page } from "@playwright/test";
import {
  BLACK,
  addColor,
  clips,
  dragField,
  expectColor,
  field,
  goTo,
  keyButton,
  panel,
  placeImage,
  row,
  typeInto,
} from "./property-helpers.ts";
import { content, expect, tab, test } from "./support.ts";

const RED = [255, 0, 0] as const;

const bar = (page: Page) => page.getByRole("group", { name: "试改", exact: true });
const count = (page: Page) => bar(page).getByRole("status");
const button = (page: Page, name: string) => bar(page).getByRole("button", { name, exact: true });
const dialog = (page: Page) => page.getByRole("dialog");

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

/** A picture a quarter of the size, so that where it is can be told from the pixels. */
async function smallImage(page: Page) {
  await placeImage(page);
  await typeInto(field(page, "缩放"), "25");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);
  await expectColor(page, 960, 540, RED);
  await expectColor(page, 460, 540, BLACK);
}

/** The folders a test can choose, because it cannot operate the dialog for choosing one. */
const installFolder = (page: Page) =>
  page.addInitScript(() => {
    const open = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("chosen", { create: true });
    Object.assign(window, { showDirectoryPicker: open });
  });

const exportedTimeline = (page: Page) =>
  page.evaluate(async () => {
    let folder = await navigator.storage.getDirectory();
    for (const part of ["chosen", "测试项目", "timelines", "main"]) {
      folder = await folder.getDirectoryHandle(part);
    }
    const file = await folder.getFileHandle("timeline.json");
    return (await file.getFile()).text();
  });

test("a change shows in the picture and stays out of the project and of an export", async ({
  page,
}) => {
  await installFolder(page);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await smallImage(page);

  await typeInto(field(page, "位置 X"), "-500");
  await expect(count(page)).toHaveText("试改 1 处");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expect(field(page, "位置 X")).toHaveAttribute("data-tried", "true");
  await expect(row(page, "位置 Y").getByRole("spinbutton")).not.toHaveAttribute("data-tried");
  await expectColor(page, 460, 540, RED);
  await expectColor(page, 960, 540, BLACK);

  await chooseFrom(page, "文件", "另存一份…");
  await expect(dialog(page)).toContainText("有 1 处试改没有保存");
  await expect(dialog(page)).toContainText("不包括试改");
  await dialog(page).getByRole("button", { name: "导出已保存的内容" }).click();
  await expect(dialog(page).getByRole("heading", { name: "导出完成" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "关闭" }).click();
  const exported = await exportedTimeline(page);
  expect(exported).toContain("transform.scale");
  expect(exported).not.toContain("transform.x");
  await expect(count(page)).toHaveText("试改 1 处");
  await expectColor(page, 460, 540, RED);
});

test("exporting can save first, and cancelling does neither", async ({ page }) => {
  await installFolder(page);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");

  await chooseFrom(page, "文件", "另存一份…");
  await dialog(page).getByRole("button", { name: "取消" }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(count(page)).toHaveText("试改 1 处");

  await chooseFrom(page, "文件", "另存一份…");
  await dialog(page).getByRole("button", { name: "保存后导出" }).click();
  await expect(dialog(page).getByRole("heading", { name: "导出完成" })).toBeVisible();
  await dialog(page).getByRole("button", { name: "关闭" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect(await exportedTimeline(page)).toContain("transform.x");
});

test("saving is one step, whatever it took to get there, and it can be undone", async ({
  page,
}) => {
  await smallImage(page);
  await typeInto(field(page, "位置 X"), "-100");
  await typeInto(field(page, "位置 X"), "-500");
  await typeInto(field(page, "不透明度"), "50");
  await expect(count(page)).toHaveText("试改 2 处");
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);
  await expect(field(page, "位置 X")).not.toHaveAttribute("data-tried");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expectColor(page, 460, 540, [128, 0, 0], 3);

  await page.keyboard.press("Control+z");
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(field(page, "不透明度")).toHaveValue("100%");
  await expectColor(page, 960, 540, RED);
  await expect(bar(page)).toHaveCount(0);

  await page.keyboard.press("Control+Shift+z");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expect(field(page, "不透明度")).toHaveValue("50%");
  await expect(bar(page)).toHaveCount(0);
});

test("the button saves as well, and what is still being typed goes along", async ({ page }) => {
  await smallImage(page);
  await typeInto(field(page, "位置 Y"), "100");
  await button(page, "保存").click();
  await expect(bar(page)).toHaveCount(0);
  await expect(field(page, "位置 Y")).toHaveValue("100");

  const x = field(page, "位置 X");
  await x.click();
  await x.fill("-500");
  await page.keyboard.press("Control+s");
  await expectColor(page, 460, 640, RED);
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(x).toHaveValue("0");
  await expect(field(page, "位置 Y")).toHaveValue("100");
});

test("giving up goes back to what is saved, and undo finds it again", async ({ page }) => {
  await smallImage(page);
  await typeInto(field(page, "位置 X"), "-500");
  await typeInto(field(page, "不透明度"), "50");
  await button(page, "放弃").click();
  await expect(bar(page)).toHaveCount(0);
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(field(page, "不透明度")).toHaveValue("100%");
  await expectColor(page, 960, 540, RED);
  await expect(page.getByText("放弃了 2 处试改")).toBeVisible();

  await page.keyboard.press("Control+z");
  await expect(count(page)).toHaveText("试改 2 处");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expectColor(page, 460, 540, [128, 0, 0], 3);
});

test("right click gives up one property and leaves the others", async ({ page }) => {
  await smallImage(page);
  await typeInto(field(page, "位置 X"), "-500");
  await typeInto(field(page, "不透明度"), "50");

  await row(page, "不透明度").click({ button: "right", position: { x: 5, y: 5 } });
  await page.getByRole("menuitem", { name: "放弃这个属性的试改" }).click();
  await expect(count(page)).toHaveText("试改 1 处");
  await expect(field(page, "不透明度")).toHaveValue("100%");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expectColor(page, 460, 540, RED);
});

test("a row without anything being tried has no such menu", async ({ page }) => {
  await addColor(page);
  await row(page, "位置 X").click({ button: "right", position: { x: 5, y: 5 } });
  await expect(page.getByRole("menuitem", { name: "放弃这个属性的试改" })).toHaveCount(0);
});

test("undo goes through what was tried, in the order people worked in", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await typeInto(field(page, "位置 X"), "200");
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
  await expect(clips(page)).toHaveCount(2);

  // The second clip is the last thing that happened.
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(1);
  await expect(count(page)).toHaveText("试改 1 处");

  await clips(page).first().click({ force: true });
  await tab(page, "properties").click();
  await expect(field(page, "位置 X")).toHaveValue("200");
  await page.keyboard.press("Control+z");
  await expect(field(page, "位置 X")).toHaveValue("100");
  await page.keyboard.press("Control+z");
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(bar(page)).toHaveCount(0);
  await expect(clips(page)).toHaveCount(1);

  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+Shift+z");
  await expect(field(page, "位置 X")).toHaveValue("200");
});

test("the diamond and resetting go through it too", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await keyButton(page, "位置 X").click();
  await expect(row(page, "位置 X").getByRole("button", { name: "删除关键帧" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await goTo(page, "0:02/00");
  await typeInto(field(page, "位置 X"), "300");
  await goTo(page, "0:01/15");
  await expect(field(page, "位置 X")).toHaveValue("200");
  await expect(count(page)).toHaveText("试改 1 处");

  await row(page, "位置 X").getByRole("button", { name: "恢复默认" }).click();
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(bar(page)).toHaveCount(0);
});

test("keys that are being tried move the picture while it plays", async ({ page }) => {
  await smallImage(page);
  await goTo(page, "0:00/00");
  await typeInto(field(page, "位置 X"), "-700");
  await keyButton(page, "位置 X").click();
  await goTo(page, "0:01/00");
  await typeInto(field(page, "位置 X"), "700");
  await goTo(page, "0:00/00");
  await expectColor(page, 260, 540, RED);
  // Where it ends up, because a look at a moving picture can come too late.
  await page.keyboard.press("Space");
  await expectColor(page, 1660, 540, RED);
  await expectColor(page, 260, 540, BLACK);
  await page.keyboard.press("Space");
});

test("the way of fitting is tried like everything else", async ({ page }) => {
  await placeImage(page);
  await expectColor(page, 100, 540, BLACK);
  await panel(page).getByRole("combobox", { name: "适应方式" }).selectOption("cover");
  await expect(count(page)).toHaveText("试改 1 处");
  await expectColor(page, 100, 540, RED);
  await button(page, "放弃").click();
  await expectColor(page, 100, 540, BLACK);
  await page.keyboard.press("Control+z");
  await expectColor(page, 100, 540, RED);
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);
  await expectColor(page, 100, 540, RED);
});

test("a drag shows on the way, is one step, and Escape goes back to what was tried", async ({
  page,
}) => {
  await addColor(page);
  const x = field(page, "位置 X");
  await typeInto(x, "50");
  await dragField(page, x, 60);
  await expect.poll(async () => Number(await x.inputValue())).toBeGreaterThan(90);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(x).toHaveValue("50");

  await dragField(page, x, 60);
  await page.mouse.up();
  const landed = await x.inputValue();
  expect(Number(landed)).toBeGreaterThan(90);
  await page.keyboard.press("Control+z");
  await expect(x).toHaveValue("50");
  await page.keyboard.press("Control+Shift+z");
  await expect(x).toHaveValue(landed);
});

test("comes back after a reload, on top of what is saved", async ({ page }) => {
  await smallImage(page);
  await typeInto(field(page, "位置 X"), "-500");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.reload();

  await expect(count(page)).toHaveText("试改 1 处");
  await expect(page.getByText("接着上次的试改")).toBeVisible();
  await expectColor(page, 460, 540, RED);
  await expectColor(page, 960, 540, BLACK);

  await button(page, "对比").click();
  await expectColor(page, 960, 540, RED);
  await button(page, "对比").click();
  await button(page, "保存").click();
  await expect(bar(page)).toHaveCount(0);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await expectColor(page, 460, 540, RED);
  await expect(bar(page)).toHaveCount(0);
});

test("comes back after the page died, in the next window that opens the project", async ({
  page,
  context,
}) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await expect(count(page)).toHaveText("试改 1 处");
  const url = page.url();
  await page.close({ runBeforeUnload: false });
  const next = await context.newPage();
  await next.goto(url);
  await expect(count(next)).toHaveText("试改 1 处");
  await expect(next.getByText("接着上次的试改")).toBeVisible();
  await next.close();
});

test("gone after giving up, also after a reload", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await button(page, "放弃").click();
  await expect(bar(page)).toHaveCount(0);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(clips(page)).toHaveCount(1);
  await expect(bar(page)).toHaveCount(0);
});

test("the setting writes every change right away", async ({ page }) => {
  await addColor(page);
  await chooseFrom(page, "视图", "设置");
  await page.getByRole("checkbox", { name: /先试改再保存/ }).uncheck();
  await tab(page, "properties").click();

  await typeInto(field(page, "位置 X"), "100");
  await expect(field(page, "位置 X")).toHaveValue("100");
  await expect(bar(page)).toHaveCount(0);
  await expect(field(page, "位置 X")).not.toHaveAttribute("data-tried");
  await page.keyboard.press("Control+z");
  await expect(field(page, "位置 X")).toHaveValue("0");
  await page.keyboard.press("Control+Shift+z");
  await expect(field(page, "位置 X")).toHaveValue("100");

  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await tab(page, "settings").click();
  await expect(page.getByRole("checkbox", { name: /先试改再保存/ })).not.toBeChecked();
});

test("the setting waits for what is being tried, and says so", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await chooseFrom(page, "视图", "设置");
  await page.getByRole("checkbox", { name: /先试改再保存/ }).uncheck();
  await expect(page.getByText("还有 1 处试改，保存或放弃之后才生效")).toBeVisible();
  await tab(page, "properties").click();
  await typeInto(field(page, "位置 X"), "200");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);
  await typeInto(field(page, "位置 X"), "300");
  await expect(bar(page)).toHaveCount(0);
});

test("comparing switches the picture, and the tab goes along", async ({ page }) => {
  await smallImage(page);
  await typeInto(field(page, "位置 X"), "-500");
  await expectColor(page, 460, 540, RED);
  const showing = content(page, "preview").locator('div[role="status"]');
  await expect(showing).toHaveText("试改");

  await button(page, "对比").click();
  await expect(button(page, "对比")).toHaveAttribute("aria-pressed", "true");
  await expect(showing).toHaveText("已保存");
  await expectColor(page, 960, 540, RED);
  await expectColor(page, 460, 540, BLACK);
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(panel(page)).toContainText("正在看已保存的内容");
  await expect(field(page, "位置 X")).toHaveAttribute("readonly");

  await panel(page).getByRole("button", { name: "回到试改" }).click();
  await expect(button(page, "对比")).toHaveAttribute("aria-pressed", "false");
  await expectColor(page, 460, 540, RED);
  await expect(field(page, "位置 X")).toHaveValue("-500");
});

test("comparing works while the picture plays", async ({ page }) => {
  await smallImage(page);
  await typeInto(field(page, "位置 X"), "-500");
  await goTo(page, "0:00/00");
  // Long enough to look at it a few times on a slow machine.
  await tab(page, "timeline").click();
  const box = await clips(page).first().boundingBox();
  const [right, y] = [(box?.x ?? 0) + (box?.width ?? 0) - 2, (box?.y ?? 0) + 10];
  await page.mouse.move(right, y);
  await page.mouse.down();
  await page.mouse.move(right + (box?.width ?? 0) * 3, y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press("Space");
  await expect(content(page, "preview").getByRole("button", { name: "暂停" })).toBeVisible();
  await expectColor(page, 460, 540, RED);
  await button(page, "对比").click();
  await expectColor(page, 960, 540, RED);
  await expectColor(page, 460, 540, BLACK);
  await expect(content(page, "preview").getByRole("button", { name: "暂停" })).toBeVisible();
  await button(page, "对比").click();
  await expectColor(page, 460, 540, RED);
  await expect(content(page, "preview").getByRole("button", { name: "暂停" })).toBeVisible();
});

test("another window changing the same property is marked, and people still win", async ({
  page,
}) => {
  await smallImage(page);
  await typeInto(field(page, "位置 X"), "-500");
  await expect(row(page, "位置 X")).toBeVisible();

  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(tab(other, "preview")).toBeVisible();
  await tab(other, "timeline").click();
  await expect(clips(other)).toHaveCount(1);
  const box = await clips(other).first().boundingBox();
  await other.mouse.click((box?.x ?? 0) + 20, (box?.y ?? 0) + 10);
  await tab(other, "properties").click();
  await expect(field(other, "位置 X")).toHaveValue("0");
  await typeInto(field(other, "位置 X"), "500");
  await other.keyboard.press("Control+s");
  await expect(bar(other)).toHaveCount(0);
  await expectColor(other, 1460, 540, RED);

  await expect(panel(page).getByText("别人改过这里")).toBeVisible();
  await expect(bar(page)).toContainText("1 处别人改过");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expectColor(page, 460, 540, RED);
  await expectColor(page, 1460, 540, BLACK);

  await button(page, "对比").click();
  await expectColor(page, 1460, 540, RED);
  await button(page, "对比").click();

  await page.keyboard.press("Control+s");
  await expect(page.getByText("其中 1 处别人也改过")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await expect(panel(page).getByText("别人改过这里")).toHaveCount(0);
  await expectColor(page, 460, 540, RED);
  await expect(field(other, "位置 X")).toHaveValue("-500");
  await expectColor(other, 460, 540, RED);
  await other.close();
});

test("what one window tries stays out of another window, also after a reload", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await expect(count(page)).toHaveText("试改 1 处");
  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(tab(other, "preview")).toBeVisible();
  await expect(clips(other)).toHaveCount(1);
  await expect(bar(other)).toHaveCount(0);
  await other.close();
  await expect(count(page)).toHaveText("试改 1 处");
  await page.reload();
  await expect(count(page)).toHaveText("试改 1 处");
});

/** Selects a clip, the way people do: the list of clips is only for finding it. */
async function clickClip(page: Page, index = 0) {
  await tab(page, "timeline").click();
  const box = await clips(page).nth(index).boundingBox();
  await page.mouse.click((box?.x ?? 0) + 12, (box?.y ?? 0) + 10);
}

test("cutting takes it to both parts, deleting sets it aside, and undo brings it back", async ({
  page,
}) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await tab(page, "timeline").click();
  await goTo(page, "0:02/00");
  await page.keyboard.press("Control+k");
  await expect(clips(page)).toHaveCount(2);
  await expect(count(page)).toHaveText("试改 2 处");

  await clickClip(page, 1);
  await tab(page, "properties").click();
  await goTo(page, "0:03/00");
  await expect(field(page, "位置 X")).toHaveValue("100");

  await clickClip(page, 1);
  await page.keyboard.press("Delete");
  await expect(clips(page)).toHaveCount(1);
  await expect(page.getByText("1 处试改现在用不上")).toBeVisible();
  await expect(count(page)).toHaveText("试改 1 处");

  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(2);
  await expect(count(page)).toHaveText("试改 2 处");
  await expect(page.getByText("放着的 1 处试改回来了")).toBeVisible();
});

test("deleting a clip and taking that back keeps it all, also through a reload", async ({
  page,
}) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await typeInto(field(page, "不透明度"), "50");
  await expect(count(page)).toHaveText("试改 2 处");
  await clickClip(page);
  await page.keyboard.press("Delete");
  await expect(clips(page)).toHaveCount(0);
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(1);
  await expect(count(page)).toHaveText("试改 2 处");
  await page.reload();
  await expect(count(page)).toHaveText("试改 2 处");
  await clickClip(page);
  await tab(page, "properties").click();
  await goTo(page, "0:01/00");
  await expect(field(page, "位置 X")).toHaveValue("100");
});

test("what is set aside is not asked about, and giving up on everything clears it", async ({
  page,
}) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await clickClip(page);
  await page.keyboard.press("Delete");
  await expect(bar(page)).toHaveCount(0);
  await chooseFrom(page, "编辑", "放弃全部试改");
  await expect(page.getByText("放弃了 1 处试改")).toBeVisible();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(1);
  await expect(count(page)).toHaveText("试改 1 处");
});

test("moving a clip by cutting and pasting takes it along, and undo takes it back", async ({
  page,
}) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await expect(count(page)).toHaveText("试改 1 处");
  await clickClip(page);
  await page.keyboard.press("Control+x");
  await goTo(page, "0:20/00");
  await tab(page, "timeline").click();
  await page.keyboard.press("Control+v");
  await expect(clips(page)).toHaveCount(1);
  await expect(count(page)).toHaveText("试改 1 处");
  await expect(page.getByText("现在用不上")).toHaveCount(0);
  await tab(page, "properties").click();
  await goTo(page, "0:21/00");
  await expect(field(page, "位置 X")).toHaveValue("100");

  await page.keyboard.press("Control+z");
  await expect(count(page)).toHaveText("试改 1 处");
  await goTo(page, "0:01/00");
  await clickClip(page);
  await tab(page, "properties").click();
  await expect(field(page, "位置 X")).toHaveValue("100");
  await page.keyboard.press("Control+Shift+z");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);
  await goTo(page, "0:21/00");
  await clickClip(page);
  await tab(page, "properties").click();
  await expect(field(page, "位置 X")).toHaveValue("100");
});

test("going back past a cut and forward again leaves things on the part they were on", async ({
  page,
}) => {
  await addColor(page);
  await tab(page, "timeline").click();
  await goTo(page, "0:02/00");
  await page.keyboard.press("Control+k");
  await expect(clips(page)).toHaveCount(2);
  await clickClip(page, 0);
  await tab(page, "properties").click();
  await goTo(page, "0:01/00");
  await typeInto(field(page, "位置 X"), "100");
  await expect(count(page)).toHaveText("试改 1 处");

  await tab(page, "timeline").click();
  await page.keyboard.press("Control+z");
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(1);
  await page.keyboard.press("Control+Shift+z");
  await expect(clips(page)).toHaveCount(2);
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(count(page)).toHaveText("试改 1 处");

  await clickClip(page, 1);
  await tab(page, "properties").click();
  await goTo(page, "0:03/00");
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(field(page, "位置 X")).not.toHaveAttribute("data-tried");
});

test("going back past growing a clip and forward again brings every key back", async ({ page }) => {
  await addColor(page);
  await tab(page, "timeline").click();
  const first = await clips(page).first().boundingBox();
  if (!first) throw new Error("no clip");
  const y = first.y + 10;
  // Away from the start, to have room to grow past the start of its clock.
  await page.mouse.move(first.x + first.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2 + 300, y, { steps: 8 });
  await page.mouse.up();
  await goTo(page, "0:05/00");
  await clickClip(page);
  await tab(page, "properties").click();
  await keyButton(page, "位置 X").click();
  await expect(count(page)).toHaveText("试改 1 处");

  await tab(page, "timeline").click();
  const moved = await clips(page).first().boundingBox();
  if (!moved) throw new Error("no clip");
  await page.mouse.move(moved.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(moved.x - 200, y, { steps: 8 });
  await page.mouse.up();
  await goTo(page, "0:01/10");
  await tab(page, "properties").click();
  await typeInto(field(page, "位置 X"), "50");
  await expect(field(page, "位置 X")).toHaveValue("50");
  await expect(count(page)).toHaveText("试改 1 处");

  await tab(page, "timeline").click();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+Shift+z");
  await expect(count(page)).toHaveText("试改 1 处");
  await expect(page.getByText("现在用不上")).toHaveCount(0);
  await tab(page, "properties").click();
  await expect(field(page, "位置 X")).toHaveValue("50");
  await page.reload();
  await expect(count(page)).toHaveText("试改 1 处");
});

test("a window that gets reloaded finds its own, not what a closed window left", async ({
  page,
}) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await expect(count(page)).toHaveText("试改 1 处");

  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(tab(other, "preview")).toBeVisible();
  await clickClip(other);
  await tab(other, "properties").click();
  await goTo(other, "0:01/00");
  await typeInto(field(other, "位置 Y"), "200");
  await expect(count(other)).toHaveText("试改 1 处");

  // The first window is the last one to write, and then it gets closed.
  await typeInto(field(page, "位置 X"), "150");
  await expect(field(page, "位置 X")).toHaveValue("150");
  await page.close({ runBeforeUnload: false });

  await other.reload();
  await expect(count(other)).toHaveText("试改 1 处");
  await clickClip(other);
  await tab(other, "properties").click();
  await goTo(other, "0:01/00");
  await expect(field(other, "位置 Y")).toHaveValue("200");
  await expect(field(other, "位置 X")).toHaveValue("0");
  await other.close();
});

test("saving writes the project first, and only then what was kept goes away", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { seen });
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function transaction(
      this: IDBDatabase,
      ...args: Parameters<typeof original>
    ) {
      const made = original.apply(this, args);
      const name = [args[0]].flat().join("+");
      if (args[1] === "readwrite") {
        made.addEventListener("complete", () => seen.push(name));
      }
      return made;
    };
  });
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);
  const seen = () => page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  const place = (names: string[], part: string) => names.findIndex((name) => name.includes(part));
  await expect.poll(async () => place(await seen(), "trials")).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => place(await seen(), "updates")).toBeGreaterThanOrEqual(0);
  const order = await seen();
  expect(place(order, "updates")).toBeLessThan(place(order, "trials"));
});

/** What this browser keeps of what is being tried, by place. */
const keptRecords = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const opening = indexedDB.open("animaquill-trials");
        opening.addEventListener("error", () => reject(opening.error));
        opening.addEventListener("success", () => {
          const reading = opening.result.transaction("trials").objectStore("trials").getAll();
          reading.addEventListener("success", () => {
            opening.result.close();
            resolve(reading.result);
          });
        });
      }),
  );

test("what is set aside gets through saving, and through going back past where it started", async ({
  page,
}) => {
  await addColor(page);
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
  await expect(clips(page)).toHaveCount(2);
  await clickClip(page, 0);
  await tab(page, "properties").click();
  await goTo(page, "0:01/00");
  await typeInto(field(page, "位置 X"), "100");
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);
  await row(page, "位置 X").getByRole("button", { name: "恢复默认" }).click();
  await expect(count(page)).toHaveText("试改 1 处");
  await clickClip(page, 0);
  await page.keyboard.press("Delete");
  await expect(clips(page)).toHaveCount(1);
  await expect(page.getByText("1 处试改现在用不上")).toBeVisible();
  await expect.poll(async () => (await keptRecords(page)).length).toBe(1);

  await clickClip(page, 0);
  await tab(page, "properties").click();
  await goTo(page, "0:02/00");
  await typeInto(field(page, "位置 Y"), "50");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);

  await tab(page, "timeline").click();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(2);
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("Control+Shift+z");
  await expect(clips(page)).toHaveCount(1);
  await expect.poll(async () => (await keptRecords(page)).length).toBe(1);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(2);
  await expect(count(page)).toHaveText("试改 1 处");
});

test("keys that move in another window leave what is tried here as it is", async ({ page }) => {
  await addColor(page);
  await keyButton(page, "不透明度").click();
  await expect(count(page)).toHaveText("试改 1 处");
  await page.keyboard.press("Control+s");
  await expect(bar(page)).toHaveCount(0);

  const other = await page.context().newPage();
  await other.goto(page.url());
  await expect(tab(other, "preview")).toBeVisible();
  await clickClip(other);
  await tab(other, "properties").click();

  await goTo(page, "0:01/00");
  await typeInto(field(page, "位置 X"), "100");
  await keyButton(page, "位置 X").click();
  await goTo(page, "0:03/00");
  await typeInto(field(page, "位置 X"), "300");
  await expect(field(page, "位置 X")).toHaveValue("300");

  await goTo(other, "0:02/00");
  await keyButton(other, "不透明度").click();
  await goTo(other, "0:01/00");
  await keyButton(other, "不透明度").click();
  await expect(count(other)).toHaveText("试改 1 处");
  await other.keyboard.press("Control+s");
  await expect(bar(other)).toHaveCount(0);
  await other.close();

  await goTo(page, "0:03/00");
  await expect(field(page, "位置 X")).toHaveValue("300");
  await goTo(page, "0:01/00");
  await expect(field(page, "位置 X")).toHaveValue("100");
});

test("leaving asks, and what stays for the next time comes back", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await chooseFrom(page, "文件", "关闭项目");
  await expect(dialog(page)).toContainText("有 1 处试改没有保存");
  await dialog(page).getByRole("button", { name: "取消" }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(count(page)).toHaveText("试改 1 处");

  await chooseFrom(page, "文件", "关闭项目");
  await dialog(page).getByRole("button", { name: "保留到下次" }).click();
  await expect(page.getByText("最近的项目")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);

  await page.getByRole("button", { name: "测试项目" }).first().click();
  await expect(count(page)).toHaveText("试改 1 处");
  await chooseFrom(page, "文件", "关闭项目");
  await dialog(page).getByRole("button", { name: "放弃" }).click();
  await expect(page.getByText("最近的项目")).toBeVisible();
  await page.getByRole("button", { name: "测试项目" }).first().click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(clips(page)).toHaveCount(1);
  await expect(bar(page)).toHaveCount(0);
});

test("leaving can save, and nothing is left to ask about after that", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await chooseFrom(page, "文件", "关闭项目");
  await dialog(page).getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("最近的项目")).toBeVisible();
  await page.getByRole("button", { name: "测试项目" }).first().click();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  await tab(page, "timeline").click();
  await expect(clips(page)).toHaveCount(1);
  const box = await clips(page).first().boundingBox();
  await page.mouse.click((box?.x ?? 0) + 20, (box?.y ?? 0) + 10);
  await tab(page, "properties").click();
  await goTo(page, "0:01/00");
  await expect(field(page, "位置 X")).toHaveValue("100");
});

test("what was kept cannot keep a project from opening", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "100");
  await expect(count(page)).toHaveText("试改 1 处");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("animaquill-trials");
        opening.addEventListener("error", () => reject(opening.error));
        opening.addEventListener("success", () => {
          const transaction = opening.result.transaction("trials", "readwrite");
          const trials = transaction.objectStore("trials");
          const reading = trials.getAll();
          reading.addEventListener("success", () => {
            for (const record of reading.result as Record<string, unknown>[]) {
              trials.put({ ...record, trial: { version: 99, nonsense: [null] } });
            }
          });
          transaction.addEventListener("complete", () => resolve());
        });
      }),
  );
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await expect(clips(page)).toHaveCount(1);
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByText("上次的试改有些已经不合法了")).toBeVisible();
});

test("says when it cannot be kept, and the page asks before going away", async ({ page }) => {
  await addColor(page);
  await page.evaluate(() => {
    // The way running out of room shows: the write goes nowhere.
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(...args) {
      if (this.name !== "trials") return original.apply(this, args);
      this.transaction.abort();
      return undefined as unknown as IDBRequest<IDBValidKey>;
    };
  });
  await typeInto(field(page, "位置 X"), "100");
  await expect(page.getByText("试改无法存到这个浏览器")).toBeVisible();
  await expect(count(page)).toHaveText("试改 1 处");
  await expect(field(page, "位置 X")).toHaveValue("100");

  const seen = new Promise<string>((resolve) => {
    page.once("dialog", (asked) => {
      resolve(asked.type());
      void asked.accept();
    });
  });
  await page.close({ runBeforeUnload: true });
  expect(await seen).toBe("beforeunload");
});
