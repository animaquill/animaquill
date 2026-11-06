import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

const help = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "帮助" }).click();
  await page.getByRole("menuitem", { name }).click();
};

const status = (page: Page) => page.getByRole("contentinfo").getByText("正在记录运行情况");

async function finishAndRead(page: Page) {
  await help(page, "结束记录并发送");
  await expect(page.getByRole("dialog")).toContainText("不包含项目名、文件名和内容");
  const download = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name: "保存文件" }).click();
  const path = await (await download).path();
  return readFile(path, "utf8");
}

test("records nothing until asked, and shows while it does", async ({ page }) => {
  await expect(status(page)).toHaveCount(0);
  await help(page, "开始记录运行情况");
  await expect(status(page)).toBeVisible();
  await help(page, "放弃这次记录");
  await expect(status(page)).toHaveCount(0);
});

test("the report has timings and leaves out names", async ({ page }) => {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (
    await chooser
  ).setFiles({
    name: "我的秘密文件.webm",
    mimeType: "video/webm",
    buffer: await readFile(new URL("./fixtures/red-blue.webm", import.meta.url)),
  });
  await content(page, "assets").getByRole("listitem").first().dblclick();
  await help(page, "开始记录运行情况");
  await content(page, "preview").getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForTimeout(1500);
  await content(page, "preview").getByRole("button", { name: "暂停", exact: true }).click();
  const text = await finishAndRead(page);
  const report = JSON.parse(text);
  expect(report.format).toBe(1);
  expect(report.device.cores).toBeGreaterThan(0);
  expect(report.project.clips).toBe(1);
  expect(report.project.assets[0].kind).toBe("video");
  expect(Object.keys(report.frameTimes).length).toBeGreaterThan(0);
  expect(report.events.some(({ kind }: { kind: string }) => kind === "play")).toBe(true);
  expect(text).not.toContain("秘密");
  expect(text).not.toContain("测试项目");
  await expect(status(page)).toHaveCount(0);
});

test("cancelling keeps it recording", async ({ page }) => {
  await help(page, "开始记录运行情况");
  await help(page, "结束记录并发送");
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  await expect(status(page)).toBeVisible();
});

test("playing from one clip into the next needs no decoder to start", async ({ page }) => {
  const list = content(page, "assets").getByRole("listitem");
  const goTo = async (time: string) => {
    await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
    await page.getByRole("textbox", { name: "当前时间" }).fill(time);
    await page.keyboard.press("Enter");
  };
  await tab(page, "assets").click();
  for (const name of ["red-blue.webm", "red.webm"]) {
    const chooser = page.waitForEvent("filechooser");
    await content(page, "assets").getByRole("button", { name: "导入" }).click();
    const buffer = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
    await (await chooser).setFiles({ name, mimeType: "video/webm", buffer });
    await expect(list.filter({ hasText: name })).toBeVisible();
  }
  await list.first().dblclick();
  await goTo("0:02/00");
  await list.nth(1).dblclick();
  await goTo("0:00/00");
  await page.waitForTimeout(500);

  await help(page, "开始记录运行情况");
  const preview = content(page, "preview");
  await preview.getByRole("button", { name: "播放", exact: true }).click();
  await expect(preview.locator("output")).toContainText("0:03/", { timeout: 8000 });
  await preview.getByRole("button", { name: "暂停", exact: true }).click();
  await page.waitForTimeout(700);
  const report = JSON.parse(await finishAndRead(page));
  const started = report.events.filter(
    ({ kind, cold }: { kind: string; cold?: number }) => kind === "frame" && (cold ?? 0) > 0,
  );
  expect(started).toEqual([]);
});
