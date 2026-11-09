import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { compositor, content, devPageOnly, expect, resourcesIn, tab, test } from "./support.ts";

const panel = (page: Page) => content(page, "performance");
const press = (page: Page, name: string) =>
  panel(page).getByRole("button", { name, exact: true }).click();

async function openPanel(page: Page) {
  await page.getByRole("button", { name: "帮助" }).click();
  await page.getByRole("menuitem", { name: "运行情况" }).click();
  await expect(panel(page).getByRole("button", { name: "开始记录" })).toBeVisible();
}

const status = (page: Page) => page.getByRole("contentinfo").getByText("正在记录运行情况");

async function finishAndRead(page: Page) {
  await press(page, "结束记录");
  await expect(panel(page).getByText("查看报告全部内容")).toBeVisible();
  const download = page.waitForEvent("download");
  await press(page, "保存文件");
  const path = await (await download).path();
  return readFile(path, "utf8");
}

test("records nothing until asked, and shows while it does", async ({ page }) => {
  await openPanel(page);
  await expect(status(page)).toHaveCount(0);
  await expect(panel(page)).toContainText("不包含项目名、文件名和内容");
  await press(page, "开始记录");
  await expect(status(page)).toBeVisible();
  await press(page, "放弃");
  await expect(status(page)).toHaveCount(0);
  await expect(panel(page).getByRole("button", { name: "开始记录" })).toBeVisible();
});

test("shows what it finds while recording", async ({ page }) => {
  await openPanel(page);
  await press(page, "开始记录");
  await expect(panel(page).getByRole("timer")).toBeVisible();
  await expect(panel(page).getByRole("group", { name: "运行数据" })).toContainText("慢帧");
  await expect(panel(page)).toContainText("每帧耗时");
});

test("the whole report can be read before anything leaves", async ({ page }) => {
  await openPanel(page);
  await press(page, "开始记录");
  await press(page, "结束记录");
  await panel(page).getByText("查看报告全部内容").click();
  await expect(panel(page).locator("pre")).toContainText('"format": 1');
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
  await resourcesIn(page, "assets").first().dblclick();
  await openPanel(page);
  await press(page, "开始记录");
  await content(page, "preview").getByRole("button", { name: "播放", exact: true }).click();
  await page.waitForTimeout(1500);
  await content(page, "preview").getByRole("button", { name: "暂停", exact: true }).click();
  const text = await finishAndRead(page);
  const report = JSON.parse(text);
  expect(report.format).toBe(1);
  expect(report.device.cores).toBeGreaterThan(0);
  expect(report.project.clips).toBe(1);
  expect(report.project.layout[0]).toMatchObject({ kind: "video", start: 0, end: 2 });
  expect(report.project.assets[0].kind).toBe("video");
  expect(Object.keys(report.frameTimes).length).toBeGreaterThan(0);
  expect(report.events.some(({ kind }: { kind: string }) => kind === "play")).toBe(true);
  expect(text).not.toContain("秘密");
  expect(text).not.toContain("测试项目");
  await expect(status(page)).toHaveCount(0);
});

test("playing from one clip into the next needs no decoder to start", async ({ page }) => {
  const list = resourcesIn(page, "assets");
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

  await openPanel(page);
  await press(page, "开始记录");
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

test.describe("errors", () => {
  devPageOnly("the tab 崩溃测试");

  const prompt = (page: Page) =>
    page.getByRole("alertdialog", { name: "出错了，要发送错误报告吗？" });

  /** Stands in for the server, and keeps what reaches it. */
  async function receive(page: Page) {
    const received: unknown[] = [];
    await page.route("**/api/diagnostics", async (route) => {
      received.push(route.request().postDataJSON());
      await route.fulfill({ json: { id: "20261107-abc123" } });
    });
    return received;
  }

  async function crash(page: Page) {
    const crashTab = content(page, "dev.crash");
    if (!(await crashTab.isVisible())) {
      await page.getByRole("button", { name: "视图" }).click();
      await page.getByRole("menu").getByRole("menuitem", { name: "崩溃测试", exact: true }).click();
    }
    await crashTab.getByRole("button", { name: "崩溃" }).click();
    await expect(page.getByText("这个选项卡出错了，其他选项卡不受影响。")).toBeVisible();
  }

  /** React says what it caught, which is what these tests provoke. */
  function expected(problems: string[]) {
    const others = problems.filter((text) => !text.includes("Crash on request"));
    problems.splice(0, problems.length, ...others);
  }

  test("asks after a crash, and sends what people saw when they say so", async ({
    page,
    problems,
  }) => {
    const received = await receive(page);
    await crash(page);
    await expect(prompt(page)).toBeVisible();
    await prompt(page).getByRole("button", { name: "查看内容" }).click();
    const text = await prompt(page).getByLabel("错误报告的全部内容").textContent();
    const shown = JSON.parse(text ?? "");
    expect(shown).toMatchObject({ format: 1, kind: "error", version: "dev" });
    expect(shown.error).toMatchObject({
      source: "panel",
      panel: "dev.crash",
      name: "Error",
      message: "Crash on request",
      count: 1,
    });
    expect(shown.error.frames.length).toBeGreaterThan(0);
    expect(shown.trail).toContainEqual(
      expect.objectContaining({ kind: "action", id: "view.open.dev.crash", way: "menu" }),
    );
    expect(text).not.toContain("测试项目");
    expect(received).toEqual([]);

    await prompt(page).getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.getByRole("alertdialog", { name: "错误报告已发送" })).toContainText(
      "编号 20261107-abc123",
    );
    expect(received).toEqual([shown]);
    expected(problems);
  });

  test("what goes wrong in the compositor comes to the editor, without what it said", async ({
    page,
    problems,
  }) => {
    const received = await receive(page);
    // Code that is not the code of the compositor: all it may tell is the kind of error. The
    // compositor of a project that just opened can still make way for another one.
    await expect(async () => {
      const frame = await compositor(page);
      await frame.evaluate(() => {
        setTimeout(() => {
          throw new RangeError("budget 10000 for Acme");
        });
      });
      await expect(prompt(page)).toBeVisible({ timeout: 1000 });
    }).toPass();
    await prompt(page).getByRole("button", { name: "查看内容" }).click();
    const text = (await prompt(page).getByLabel("错误报告的全部内容").textContent()) ?? "";
    expect(JSON.parse(text).error).toMatchObject({
      source: "compositor",
      name: "RangeError",
      message: "",
    });
    expect(text).not.toMatch(/budget|Acme|10000/);
    await prompt(page).getByRole("button", { name: "不发送" }).click();
    expect(received).toEqual([]);
    const others = problems.filter((line) => !line.includes("budget 10000"));
    problems.splice(0, problems.length, ...others);
  });

  test("sends nothing unless asked, and asks only once about the same error", async ({
    page,
    problems,
  }) => {
    const received = await receive(page);
    await crash(page);
    await prompt(page).getByRole("button", { name: "不发送" }).click();
    await expect(prompt(page)).toHaveCount(0);

    await page.getByRole("button", { name: "重试" }).click();
    await crash(page);
    await page.waitForTimeout(500);
    await expect(prompt(page)).toHaveCount(0);

    await openPanel(page);
    const errors = panel(page).getByRole("region", { name: "错误" });
    await expect(errors).toContainText("选项卡");
    await expect(errors).toContainText("Crash on request");
    await expect(errors).toContainText("2 次");
    await expect(errors).toContainText("你选了不发送");
    expect(received).toEqual([]);

    // It is still there for whoever changes their mind.
    await errors.getByRole("button", { name: "发送" }).click();
    await expect(errors).toContainText("已发送，编号 20261107-abc123");
    expect(received).toHaveLength(1);
    expected(problems);
  });
});
