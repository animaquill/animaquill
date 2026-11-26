import type { Locator, Page } from "@playwright/test";
import { closeSettings, goToSettingsGroup, settingsOf } from "./ai-support.ts";
import { lines, openFile } from "./code-support.ts";
import { importFolder, projectFolder } from "./scene-support.ts";
import { content, expect, test, showTab } from "./support.ts";

/**
 * The theme and the size of words (docs/design/settings-and-properties.md of AnimaQuill Cloud,
 * S-E): following the system by default, also as it changes; dark or light whatever the system;
 * three sizes of words with nothing out of its place; what is drawn on a canvas follows.
 */

const root = (page: Page) => page.locator("html");
const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const fontSize = (page: Page) => page.evaluate(() => getComputedStyle(document.body).fontSize);

/** A pixel at the top left of the timeline's canvas, past its ruler: the colour of the lanes. */
const timelineColor = (page: Page) =>
  content(page, "timeline")
    .locator("canvas")
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      const ratio = devicePixelRatio;
      const data = canvas.getContext("2d")?.getImageData(4 * ratio, 40 * ratio, 1, 1).data;
      return data ? [...data].slice(0, 3).join(",") : "";
    });

async function choose(page: Page, setting: string, option: string) {
  await settingsOf(page)
    .getByRole("radiogroup", { name: setting })
    .getByRole("radio", { name: option, exact: true })
    .click();
}

async function openGeneral(page: Page) {
  await page.keyboard.press("Control+Comma");
  await goToSettingsGroup(page, "常规");
}

/** Whatever is wider than its box and not meant to scroll: words that do not fit. */
const overflowing = (area: Locator) =>
  area.evaluate((element) =>
    [...element.querySelectorAll<HTMLElement>("*")]
      .filter((each) => {
        const style = getComputedStyle(each);
        if (style.overflowX === "auto" || style.overflowX === "scroll") return false;
        if (style.textOverflow === "ellipsis") return false;
        return each.scrollWidth > each.clientWidth + 1 && each.clientWidth > 0;
      })
      .map((each) => `${each.tagName}.${each.className} ${each.textContent?.slice(0, 30)}`),
  );

test.describe("a system in light colours", () => {
  test.use({ colorScheme: "light" });

  test("follows the system by default, and as it changes", async ({ page }) => {
    await expect(root(page)).toHaveAttribute("data-theme", "light");
    await expect(root(page)).toHaveAttribute("data-font-size", "normal");
    expect(await background(page)).toBe("rgb(243, 243, 243)");
    await showTab(page, "timeline");
    await expect.poll(() => timelineColor(page)).toBe("248,248,248");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(root(page)).toHaveAttribute("data-theme", "dark");
    expect(await background(page)).toBe("rgb(24, 24, 24)");
    // The canvas draws again in the colours of the other theme.
    await expect.poll(() => timelineColor(page)).toBe("28,28,28");

    await page.emulateMedia({ colorScheme: "light" });
    await expect(root(page)).toHaveAttribute("data-theme", "light");
  });

  test("dark, chosen, stays dark whatever the system, also after a reload", async ({ page }) => {
    await openGeneral(page);
    const theme = settingsOf(page).getByRole("radiogroup", { name: "颜色主题" });
    await expect(theme.getByRole("radio", { name: "跟随系统" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await choose(page, "颜色主题", "深色");
    await expect(root(page)).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(root(page)).toHaveAttribute("data-theme", "dark");
    await closeSettings(page);

    await page.reload();
    await expect(page.locator("header").first()).toBeVisible();
    await expect(root(page)).toHaveAttribute("data-theme", "dark");
    expect(await background(page)).toBe("rgb(24, 24, 24)");
  });
});

test("light, chosen, shows at once, and in another window too", async ({ page, context }) => {
  await expect(root(page)).toHaveAttribute("data-theme", "dark");
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.locator("header").first()).toBeVisible();

  await openGeneral(page);
  await choose(page, "颜色主题", "浅色");
  await expect(root(page)).toHaveAttribute("data-theme", "light");
  expect(await background(page)).toBe("rgb(243, 243, 243)");
  await expect(settingsOf(page)).toBeVisible();
  await expect(root(other)).toHaveAttribute("data-theme", "light");

  await other.close();
});

test.describe("a project with code", () => {
  test.use({ withProject: false });

  test("the code editor takes the theme and the size of words", async ({ page }) => {
    await importFolder(
      page,
      projectFolder({ a: { "index.html": "<p>a</p>", "main.js": "1;\n" } }, []),
    );
    await openFile(page, "main.js");
    const editor = content(page, "code").locator(".monaco-editor").first();
    await expect(editor).toHaveClass(/vs-dark/);
    const size = () => lines(page).evaluate((element) => getComputedStyle(element).fontSize);
    expect(await size()).toBe("13px");

    await openGeneral(page);
    await choose(page, "颜色主题", "浅色");
    await choose(page, "界面字号", "大");
    await closeSettings(page);
    await expect(editor).not.toHaveClass(/vs-dark/);
    await expect.poll(size).toBe("15px");
  });
});

for (const [option, value, pixels, taller] of [
  ["小", "small", "11px", 1],
  ["大", "large", "15px", 15 / 13],
] as const) {
  test(`words ${option}: everything bigger or smaller, nothing out of its place`, async ({
    page,
  }) => {
    const bar = page.locator("header").first();
    const trackRow = () =>
      content(page, "timeline").getByText("视频 1", { exact: true }).locator("xpath=..");
    await showTab(page, "timeline");
    const before = { bar: await bar.boundingBox(), row: await trackRow().boundingBox() };
    await openGeneral(page);
    await choose(page, "界面字号", option);
    await expect(root(page)).toHaveAttribute("data-font-size", value);
    expect(await fontSize(page)).toBe(pixels);
    // The dialog, as one of what has words in rows.
    expect(await overflowing(settingsOf(page))).toEqual([]);
    await closeSettings(page);

    // A menu, its items still one line each.
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    for (const item of await menu.getByRole("menuitem").all()) {
      const box = await item.boundingBox();
      expect(box?.height ?? 0).toBeLessThan(40);
    }
    expect(await overflowing(menu)).toEqual([]);
    await page.keyboard.press("Escape");

    // The names of the tracks fit their rows, which the canvas draws beside them.
    await showTab(page, "timeline");
    const header = content(page, "timeline").getByText("视频 1", { exact: true });
    const row = header.locator("xpath=..");
    const [name, around] = [await header.boundingBox(), await row.boundingBox()];
    expect(name && around).toBeTruthy();
    if (name && around) {
      expect(name.y).toBeGreaterThanOrEqual(around.y);
      expect(name.y + name.height).toBeLessThanOrEqual(around.y + around.height + 0.5);
    }

    // Large makes the bars and the rows as much taller; small leaves them as they are.
    const after = { bar: await bar.boundingBox(), row: await trackRow().boundingBox() };
    expect(after.bar?.height ?? 0).toBeCloseTo((before.bar?.height ?? 0) * taller, 0);
    expect(after.row?.height ?? 0).toBeCloseTo((before.row?.height ?? 0) * taller, 0);

    // The buttons over the assets stay in one line, with their words or as icons.
    await showTab(page, "assets");
    const tops = await content(page, "assets")
      .getByRole("button", { name: /^(导入|新建)$/ })
      .evaluateAll((all) => all.map((each) => Math.round(each.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);

    // And back to standard, as it was.
    await openGeneral(page);
    await choose(page, "界面字号", "标准");
    expect(await fontSize(page)).toBe("13px");
  });
}
