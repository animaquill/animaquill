import type { Locator, Page } from "@playwright/test";
import {
  BLACK,
  addColor,
  clips,
  dragField,
  expectColor,
  field,
  goTo,
  keyButton,
  placeImage,
  typeInto,
} from "./property-helpers.ts";
import { importClips } from "./project-files.ts";
import { content, expect, tab, test } from "./support.ts";

const RED = [255, 0, 0] as const;

const panel = (page: Page) => content(page, "keyframes");
const row = (page: Page, name: string) => panel(page).getByRole("treeitem", { name, exact: true });
const value = (page: Page, name: string) =>
  panel(page).getByRole("spinbutton", { name, exact: true });
/** Keys are drawn on a canvas. This list is in the same places. */
const keysOf = (root: Locator, name: string) =>
  root.getByRole("option", { name: new RegExp(`^${name}，`) });
const keys = (page: Page, name: string) => keysOf(panel(page), name);
const stage = (page: Page) => panel(page).getByRole("group", { name: "关键帧", exact: true });
const trialBar = (page: Page) => page.getByRole("group", { name: "试改", exact: true });

async function animate(page: Page) {
  await page.getByRole("button", { name: "动画", exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

async function open(page: Page, name: string, root: Locator = panel(page)) {
  await root.getByRole("button", { name: `展开 ${name}`, exact: true }).click();
}

const centerOf = async (locator: Locator) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("not on screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** Picks up what is at a place and goes somewhere, with the steps a mouse reports. */
async function dragBy(page: Page, from: Locator, x: number, y = 0) {
  const start = await centerOf(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + x / 2, start.y + y / 2, { steps: 4 });
  await page.mouse.move(start.x + x, start.y + y, { steps: 4 });
  await page.mouse.up();
}

/** Lets go of the clip that adding it selected, because what is selected always stays listed. */
async function deselect(page: Page) {
  const box = await content(page, "timeline")
    .getByRole("group", { name: "时间轴", exact: true })
    .boundingBox();
  if (!box) throw new Error("no timeline");
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20);
}

/** All of the timeline in view, so that keys have room to go. */
const showAll = async (page: Page) => {
  await panel(page).getByRole("button", { name: "显示全部" }).click();
};

/** A clip with keys on X at 1 and 3 seconds, in the workspace for animating, and opened up. */
async function keyedColor(page: Page) {
  await addColor(page);
  await keyButton(page, "位置 X").click();
  await goTo(page, "0:03/00");
  await typeInto(field(page, "位置 X"), "300");
  await animate(page);
  await showAll(page);
  await open(page, "纯色");
  await open(page, "位置");
  await expect(keys(page, "位置 X")).toHaveCount(2);
}

const saveTrial = async (page: Page) => {
  await page.keyboard.press("Control+s");
  await expect(trialBar(page)).toHaveCount(0);
};

const timeOf = async (key: Locator) => {
  const label = await key.getAttribute("aria-label");
  return label?.split("，").at(-1);
};

const timesOf = async (locator: Locator) =>
  Promise.all((await locator.all()).map((key) => timeOf(key)));

test("the workspace for animating has the tab, and it says when there is nothing here", async ({
  page,
}) => {
  await animate(page);
  await expect(tab(page, "keyframes")).toBeVisible();
  await expect(tab(page, "timeline")).toBeVisible();
  await expect(panel(page)).toContainText("播放头这里没有能打关键帧的内容");
});

test("opens up from tracks through clips to properties", async ({ page }) => {
  await addColor(page);
  await animate(page);
  await expect(row(page, "视频 1")).toBeVisible();
  await expect(row(page, "纯色")).toBeVisible();
  await expect(row(page, "位置")).toHaveCount(0);
  await expect(row(page, "不透明度")).toHaveCount(0);

  await open(page, "纯色");
  await expect(row(page, "位置")).toBeVisible();
  await expect(row(page, "不透明度")).toBeVisible();
  await expect(value(page, "不透明度")).toHaveValue("100%");
  await expect(row(page, "位置 X")).toHaveCount(0);
  // What cannot have keys is for the properties tab.
  await expect(row(page, "适应方式")).toHaveCount(0);

  await open(page, "位置");
  await expect(value(page, "位置 X")).toHaveValue("0");
  await expect(row(page, "位置 X").getByRole("img")).toHaveAttribute("data-source", "default");

  await panel(page).getByRole("button", { name: "收起 纯色", exact: true }).click();
  await expect(row(page, "位置")).toHaveCount(0);
  await expect(row(page, "纯色")).toBeVisible();
});

test("comes back after a reload the way it was", async ({ page }) => {
  await addColor(page);
  await animate(page);
  await panel(page).getByRole("radio", { name: "全部" }).click();
  await open(page, "纯色");
  await expect(row(page, "位置")).toBeVisible();
  await page.waitForTimeout(500);
  await page.reload();
  await expect(panel(page).getByRole("radio", { name: "全部" })).toBeChecked();
  await expect(row(page, "位置")).toBeVisible();
});

test("finds a property by its name", async ({ page }) => {
  await addColor(page);
  await animate(page);
  await panel(page).getByRole("searchbox").fill("旋转");
  await expect(row(page, "旋转")).toBeVisible();
  await expect(row(page, "不透明度")).toHaveCount(0);
  await panel(page).getByRole("searchbox").fill("没有这个");
  await expect(panel(page)).toContainText("没有找到这个属性");
  await panel(page).getByRole("searchbox").press("Escape");
  await expect(row(page, "纯色")).toBeVisible();
});

test("the list follows the playhead, and stays as it is while playing", async ({ page }) => {
  await addColor(page);
  await animate(page);
  await deselect(page);
  await expect(row(page, "纯色")).toBeVisible();

  await goTo(page, "0:06/00");
  await expect(row(page, "纯色")).toHaveCount(0);
  await goTo(page, "0:04/25");
  await expect(row(page, "纯色")).toBeVisible();

  await page.getByRole("toolbar", { name: "播放" }).getByRole("button", { name: "播放" }).click();
  const shown = page.getByRole("contentinfo").getByRole("status", { name: "播放头" });
  await expect
    .poll(
      async () => {
        const text = (await shown.textContent()) ?? "";
        return text >= "0:05/10";
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  // The clip is over by now, and the list has not moved.
  await expect(row(page, "纯色")).toBeVisible();
  await page.getByRole("toolbar", { name: "播放" }).getByRole("button", { name: "暂停" }).click();
  await expect(row(page, "纯色")).toHaveCount(0);
});

test("the three ranges say what they list", async ({ page }) => {
  await addColor(page);
  await keyButton(page, "不透明度").click();
  await animate(page);
  await deselect(page);
  await goTo(page, "0:06/00");
  await expect(row(page, "纯色")).toHaveCount(0);

  await panel(page).getByRole("radio", { name: "全部" }).click();
  await expect(row(page, "纯色")).toBeVisible();
  await panel(page).getByRole("radio", { name: "有关键帧" }).click();
  await open(page, "纯色");
  await expect(row(page, "不透明度")).toBeVisible();
  await expect(row(page, "旋转")).toHaveCount(0);
});

test("a pinned clip stays, wherever the playhead goes", async ({ page }) => {
  await addColor(page);
  await animate(page);
  await deselect(page);
  await row(page, "纯色").hover();
  await panel(page).getByRole("button", { name: "钉住 纯色" }).click();
  await goTo(page, "0:06/00");
  await expect(row(page, "纯色")).toBeVisible();
  await panel(page).getByRole("button", { name: "取消钉住 纯色" }).click();
  await expect(row(page, "纯色")).toHaveCount(0);
});

test.describe("with changes written right away", () => {
  test.use({ trying: false });

  test("the diamond writes a key at the playhead, and the value writes the next one", async ({
    page,
  }) => {
    await addColor(page);
    await animate(page);
    await open(page, "纯色");
    await panel(page).getByRole("button", { name: "展开 位置" }).click();
    const buttons = row(page, "位置 X").getByRole("button", { name: /关键帧$/ });

    await typeInto(value(page, "位置 X"), "10");
    await expect(row(page, "位置 X").getByRole("img")).toHaveAttribute("data-source", "value");
    await typeInto(value(page, "位置 X"), "0");

    await buttons.nth(1).click();
    await expect(keys(page, "位置 X")).toHaveCount(1);
    await expect(row(page, "位置 X").getByRole("img")).toHaveAttribute("data-source", "keys");
    await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");

    await goTo(page, "0:02/00");
    await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "false");
    await typeInto(value(page, "位置 X"), "120");
    await expect(keys(page, "位置 X")).toHaveCount(2);
    expect(await timesOf(keys(page, "位置 X"))).toEqual(["0:01/00", "0:02/00"]);

    await buttons.first().click();
    await expect(page.getByRole("contentinfo").getByRole("status", { name: "播放头" })).toHaveText(
      "0:01/00",
    );
    await expect(value(page, "位置 X")).toHaveValue("0");
    await buttons.nth(2).click();
    await expect(value(page, "位置 X")).toHaveValue("120");
    await expect(field(page, "位置 X")).toHaveValue("120");
  });

  test("a value can be dragged, and that is one step and one key", async ({ page }) => {
    await keyedColor(page);
    await goTo(page, "0:02/00");
    const start = await value(page, "位置 X").inputValue();
    await dragField(page, value(page, "位置 X"), 40);
    await page.mouse.up();
    await expect(keys(page, "位置 X")).toHaveCount(3);
    expect(await value(page, "位置 X").inputValue()).not.toBe(start);
    await page.keyboard.press("Control+z");
    await expect(keys(page, "位置 X")).toHaveCount(2);
    await expect(value(page, "位置 X")).toHaveValue(start);
  });

  test("dragging a key is one step to undo, and shows on the way", async ({ page }) => {
    await keyedColor(page);
    const [, second] = await keys(page, "位置 X").all();
    if (!second) throw new Error("no key");
    const start = await centerOf(second);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y, { steps: 4 });
    await page.mouse.move(start.x + 80, start.y, { steps: 4 });
    // Nothing is in the project yet.
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/00$/);
    await page.mouse.up();
    await expect(keys(page, "位置 X").nth(1)).not.toHaveAttribute("aria-label", /0:03\/00$/);
    const moved = await timesOf(keys(page, "位置 X"));

    await page.keyboard.press("Control+z");
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/00$/);
    await page.keyboard.press("Control+Shift+z");
    await expect.poll(() => timesOf(keys(page, "位置 X"))).toEqual(moved);
  });

  test("Escape takes a drag back", async ({ page }) => {
    await keyedColor(page);
    const start = await centerOf(keys(page, "位置 X").nth(1));
    await stage(page).focus();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/00$/);
  });

  test("the arrow keys move what is selected by a frame, and Delete takes it away", async ({
    page,
  }) => {
    await keyedColor(page);
    const start = await centerOf(keys(page, "位置 X").nth(1));
    await page.mouse.click(start.x, start.y);
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(keys(page, "位置 X").first()).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("ArrowRight");
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/01$/);
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:02\/26$/);
    await page.keyboard.press("Delete");
    await expect(keys(page, "位置 X")).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(keys(page, "位置 X")).toHaveCount(2);
  });

  test("without anything selected the arrow keys go through the frames", async ({ page }) => {
    await keyedColor(page);
    await stage(page).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("contentinfo").getByRole("status", { name: "播放头" })).toHaveText(
      "0:03/01",
    );
  });

  test("a box selects what is in it, and only that", async ({ page }) => {
    await keyedColor(page);
    await expect(keys(page, "位置 X")).toHaveCount(2);
    const first = await centerOf(keys(page, "位置 X").first());
    await page.mouse.move(first.x - 30, first.y - 8);
    await page.mouse.down();
    await page.mouse.move(first.x + 20, first.y + 6, { steps: 6 });
    await page.mouse.up();
    await expect(keys(page, "位置 X").first()).toHaveAttribute("aria-selected", "true");
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-selected", "false");
  });

  test("copying puts keys at the playhead, as far apart as they were", async ({ page }) => {
    await keyedColor(page);
    await panel(page).getByRole("button", { name: "X", exact: true }).click();
    await expect(keys(page, "位置 X").first()).toHaveAttribute("aria-selected", "true");
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Control+c");
    await goTo(page, "0:04/00");
    await stage(page).focus();
    await page.keyboard.press("Control+v");
    // The list follows a moment after the change.
    await expect
      .poll(() => timesOf(keys(page, "位置 X")))
      .toEqual(["0:01/00", "0:03/00", "0:04/00", "0:06/00"]);
  });

  test("dragging a summary takes what is below along", async ({ page }) => {
    await addColor(page);
    await keyButton(page, "位置 X").click();
    await keyButton(page, "位置 Y").click();
    await keyButton(page, "不透明度").click();
    await goTo(page, "0:03/00");
    await keyButton(page, "位置 X").click();
    await animate(page);
    await showAll(page);
    await open(page, "纯色");
    await open(page, "位置");
    await expect(keys(page, "位置")).toHaveCount(2);
    await expect(keys(page, "位置 X")).toHaveCount(2);
    await expect(keys(page, "位置 Y")).toHaveCount(1);

    await dragBy(page, keys(page, "位置").first(), 58);
    await expect.poll(() => timeOf(keys(page, "位置 Y").first())).not.toBe("0:01/00");
    const landed = await timeOf(keys(page, "位置 Y").first());
    expect(await timeOf(keys(page, "位置 X").first())).toBe(landed);
    // Outside of the group.
    expect(await timeOf(keys(page, "不透明度").first())).toBe("0:01/00");

    await page.keyboard.press("Control+z");
    await expect.poll(() => timeOf(keys(page, "位置 Y").first())).toBe("0:01/00");
    expect(await timeOf(keys(page, "位置 X").first())).toBe("0:01/00");
  });

  test("the shape of a key says how it goes on, and the picture follows", async ({ page }) => {
    await placeImage(page);
    await typeInto(field(page, "缩放"), "25");
    await typeInto(field(page, "位置 X"), "-500");
    await goTo(page, "0:01/00");
    await keyButton(page, "位置 X").click();
    await goTo(page, "0:03/00");
    await typeInto(field(page, "位置 X"), "500");
    await goTo(page, "0:02/00");
    await expectColor(page, 960, 540, RED);

    await animate(page);
    await showAll(page);
    await open(page, "红色.png");
    await open(page, "位置");
    const first = keys(page, "位置 X").first();
    await expect(first).toHaveAttribute("data-mark", "linear");
    await page.mouse.click(...(Object.values(await centerOf(first)) as [number, number]));
    await expect(first).toHaveAttribute("aria-selected", "true");

    await panel(page).getByRole("button", { name: "插值" }).click();
    const bubble = page.getByRole("dialog", { name: "插值" });
    await expect(bubble.getByRole("radio", { name: "线性" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await bubble.getByRole("radio", { name: "保持" }).click();
    await expect(first).toHaveAttribute("data-mark", "hold");
    await expectColor(page, 960, 540, BLACK);
    await expectColor(page, 460, 540, RED);

    await bubble.getByRole("radio", { name: "缓入缓出" }).click();
    await expect(first).toHaveAttribute("data-mark", "eased");
    await expectColor(page, 960, 540, RED);
    await expect(bubble.getByRole("radio", { name: "缓入缓出" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);
  });

  test("a row opens up to show its curve, and the bottom of it can be pulled", async ({ page }) => {
    await keyedColor(page);
    const canvas = panel(page).locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");

    /** Where the curve is in a column of the canvas, by its colour. */
    const curveAt = (x: number, top: number, bottom: number) =>
      canvas.evaluate(
        (element, area) => {
          const context = (element as HTMLCanvasElement).getContext("2d");
          const ratio = (element as HTMLCanvasElement).width / element.clientWidth;
          const pixels = context?.getImageData(area.x * ratio, 0, 1, element.clientHeight * ratio);
          for (let y = area.top * ratio; y < area.bottom * ratio; y += 1) {
            const [red = 0, green = 0, blue = 0] = pixels?.data.slice(y * 4, y * 4 + 3) ?? [];
            if (red < 90 && green > 130 && blue > 200) return y / ratio;
          }
          return undefined;
        },
        { x, top, bottom },
      );

    const first = await centerOf(keys(page, "位置 X").first());
    const last = await centerOf(keys(page, "位置 X").nth(1));
    const inCanvas = (x: number) => Math.round(x - box.x);
    const rowTop = first.y - box.y + 12;
    const beforeCurve = await curveAt(inCanvas((first.x + last.x) / 2), rowTop, rowTop + 72);
    expect(beforeCurve).toBeUndefined();

    await panel(page).getByRole("button", { name: "显示 位置 X 的曲线" }).click();
    const quarter = inCanvas(first.x + (last.x - first.x) / 4);
    const half = inCanvas((first.x + last.x) / 2);
    const most = inCanvas(first.x + ((last.x - first.x) * 3) / 4);
    await expect.poll(() => curveAt(half, rowTop, rowTop + 72)).toBeDefined();
    const [low, middle, high] = [
      await curveAt(quarter, rowTop, rowTop + 72),
      await curveAt(half, rowTop, rowTop + 72),
      await curveAt(most, rowTop, rowTop + 72),
    ] as [number, number, number];
    expect(low).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(high);

    // Linear: as much from a quarter to the middle as from there to three quarters.
    expect(Math.abs(low - middle - (middle - high))).toBeLessThanOrEqual(2);

    const lower = await row(page, "位置 X").boundingBox();
    if (!lower) throw new Error("no row");
    const edge = lower.y + lower.height - 2;
    await page.mouse.move(box.x + 300, edge);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, edge + 30, { steps: 3 });
    await page.mouse.up();
    await expect
      .poll(async () => (await row(page, "位置 X").boundingBox())?.height)
      .toBe(lower.height + 30);
  });

  test("keys are drawn where they are, in the shape of how they go on", async ({ page }) => {
    await keyedColor(page);
    const canvas = panel(page).locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");
    /** Whether a key is drawn at a place, which is a light colour on a dark lane. */
    const isLight = (x: number, y: number) =>
      canvas.evaluate(
        (element, place) => {
          const context = (element as HTMLCanvasElement).getContext("2d");
          const pixel = context?.getImageData(place.x, place.y, 1, 1).data;
          return Math.min(pixel?.[0] ?? 0, pixel?.[1] ?? 0, pixel?.[2] ?? 0) > 120;
        },
        { x: Math.round(x - box.x), y: Math.round(y - box.y) },
      );

    const first = keys(page, "位置 X").first();
    const { x, y } = await centerOf(first);
    await expect.poll(() => isLight(x, y)).toBe(true);
    // A diamond does not reach its corners.
    expect(await isLight(x + 3, y + 3)).toBe(false);
    expect(await isLight(x - 30, y)).toBe(false);

    await page.mouse.click(x, y);
    await panel(page).getByRole("button", { name: "插值" }).click();
    await page.getByRole("dialog").getByRole("radio", { name: "保持" }).click();
    await page.keyboard.press("Escape");
    await page.mouse.click(box.x + box.width - 10, y);
    // A square does, and a click next to it left it unselected.
    await expect(first).toHaveAttribute("aria-selected", "false");
    await expect.poll(() => isLight(x + 3, y + 3)).toBe(true);
    await expect(first).toHaveAttribute("data-mark", "hold");
  });

  test("what is outside of its clip is grey, and what was trimmed away is fainter", async ({
    page,
  }) => {
    await keyedColor(page);
    const canvas = panel(page).locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas");
    const brightness = (x: number, y: number) =>
      canvas.evaluate(
        (element, place) => {
          const context = (element as HTMLCanvasElement).getContext("2d");
          const pixel = context?.getImageData(place.x, place.y, 1, 1).data;
          return (pixel?.[0] ?? 0) + (pixel?.[1] ?? 0) + (pixel?.[2] ?? 0);
        },
        { x: Math.round(x - box.x), y: Math.round(y - box.y) },
      );

    const key = await centerOf(keys(page, "位置 X").nth(1));
    const other = await centerOf(keys(page, "位置 X").first());
    const perSecond = (key.x - other.x) / 2;
    const end = other.x + 4 * perSecond;
    const laneY = key.y + 8;
    // The clip is five seconds long, and it is on the second of them.
    const inside = await brightness(end - 10, laneY);
    const outside = await brightness(end + 10, laneY);
    expect(outside).toBeLessThan(inside);

    await goTo(page, "0:02/00");
    await tab(page, "timeline").click();
    const clip = await clips(page).first().boundingBox();
    if (!clip) throw new Error("no clip");
    // The end of the clip goes in front of the last key, which stays on the clock of the clip.
    await page.mouse.move(clip.x + clip.width - 2, clip.y + clip.height / 2);
    await page.mouse.down();
    await page.mouse.move(clip.x + clip.width * 0.45, clip.y + clip.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => brightness(key.x, key.y)).toBeLessThan(450);
    const shown = await brightness(other.x, other.y);
    expect(shown).toBeGreaterThan(450);
  });

  test("the tab goes along with the timeline, until it does not", async ({ page }) => {
    await keyedColor(page);
    const button = (name: string) => panel(page).getByRole("button", { name, exact: true });
    const gap = async () => {
      const found = await keys(page, "位置 X").all();
      const [first, second] = found;
      if (!first || !second) return 0;
      return (await centerOf(second)).x - (await centerOf(first)).x;
    };
    const start = await gap();
    await button("放大").click();
    await expect.poll(gap).toBeGreaterThan(start * 1.3);
    const zoomed = await gap();
    const zoom = content(page, "timeline").getByRole("slider", { name: "缩放" });
    const shared = await zoom.inputValue();

    await button("和时间轴同步").click();
    await button("缩小").click();
    await button("缩小").click();
    await expect.poll(gap).toBeLessThan(start);
    expect(await zoom.inputValue()).toBe(shared);

    await button("和时间轴同步").click();
    await expect.poll(gap).toBeCloseTo(zoomed, 0);
  });

  /** The clip of `keyedColor`, opened up on the timeline with the key for it. */
  async function openOnTimeline(page: Page) {
    await keyedColor(page);
    const timeline = content(page, "timeline");
    const box = await clips(page).first().boundingBox();
    if (!box) throw new Error("no clip");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press("u");
    const rowHere = (name: string) => timeline.getByRole("treeitem", { name, exact: true });
    await expect(rowHere("位置 X")).toBeVisible();
    return { timeline, rowHere };
  }

  test("the timeline shows the same rows under a clip, with their keys drawn", async ({ page }) => {
    const { timeline, rowHere } = await openOnTimeline(page);
    await expect(rowHere("纯色")).toBeVisible();
    await expect(rowHere("位置")).toBeVisible();
    await expect(keysOf(timeline, "位置 X")).toHaveCount(2);

    // The keys are drawn on the canvas of the timeline, not only listed.
    const canvas = timeline.locator("canvas");
    const area = await canvas.boundingBox();
    if (!area) throw new Error("no canvas");
    const key = await centerOf(keysOf(timeline, "位置 X").first());
    const light = await canvas.evaluate(
      (element, place) => {
        const pixel = (element as HTMLCanvasElement)
          .getContext("2d")
          ?.getImageData(place.x, place.y, 1, 1).data;
        return Math.min(pixel?.[0] ?? 0, pixel?.[1] ?? 0, pixel?.[2] ?? 0);
      },
      { x: Math.round(key.x - area.x), y: Math.round(key.y - area.y) },
    );
    expect(light).toBeGreaterThan(120);

    await timeline.getByRole("button", { name: "收起 纯色", exact: true }).click();
    await expect(rowHere("位置")).toHaveCount(0);
    await expect(clips(page)).toHaveCount(1);
  });

  test("keys under a clip move in one step, and are the same keys as in the tab", async ({
    page,
  }) => {
    const { timeline } = await openOnTimeline(page);
    await dragBy(page, keysOf(timeline, "位置 X").nth(1), 60);
    await expect.poll(() => timeOf(keysOf(timeline, "位置 X").nth(1))).not.toBe("0:03/00");
    const moved = await timeOf(keysOf(timeline, "位置 X").nth(1));
    await expect.poll(() => timeOf(keys(page, "位置 X").nth(1))).toBe(moved);
    await page.keyboard.press("Control+z");
    await expect.poll(() => timeOf(keysOf(timeline, "位置 X").nth(1))).toBe("0:03/00");
  });

  test("with a key under a clip selected, the keys of the timeline are about that key", async ({
    page,
  }) => {
    const { timeline } = await openOnTimeline(page);
    const second = await centerOf(keysOf(timeline, "位置 X").nth(1));
    await page.mouse.click(second.x, second.y);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => timeOf(keysOf(timeline, "位置 X").nth(1))).toBe("0:03/01");
    // Delete takes the key, not the clip.
    await page.keyboard.press("Delete");
    await expect(keysOf(timeline, "位置 X")).toHaveCount(1);
    await expect(clips(page).first()).toBeAttached();
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect.poll(() => timeOf(keysOf(timeline, "位置 X").nth(1))).toBe("0:03/00");
  });

  test("after keys were copied, clips that are cut are what a paste moves", async ({ page }) => {
    const { timeline } = await openOnTimeline(page);
    const second = await centerOf(keysOf(timeline, "位置 X").nth(1));
    await page.mouse.click(second.x, second.y);
    await page.keyboard.press("Control+c");
    const box = await clips(page).first().boundingBox();
    if (!box) throw new Error("no clip");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(keysOf(timeline, "位置 X").nth(1)).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Control+x");
    await goTo(page, "0:06/00");
    await timeline.getByRole("group", { name: "时间轴", exact: true }).focus();
    await page.keyboard.press("Control+v");
    await expect.poll(async () => (await clips(page).first().boundingBox())?.x).not.toBe(box.x);
    await expect(clips(page)).toHaveCount(1);
    // The clip went with its two keys, and no key went anywhere. It is a new clip, with its
    // position closed, which sums up what is in it.
    await page.keyboard.press("u");
    await expect(keysOf(timeline, "位置")).toHaveCount(2);
  });

  test("a clip opens with the button on it and from its menu", async ({ page }) => {
    await keyedColor(page);
    const timeline = content(page, "timeline");
    const box = await clips(page).first().boundingBox();
    if (!box) throw new Error("no clip");
    const rowHere = timeline.getByRole("treeitem", { name: "纯色", exact: true });
    // It shows on what is selected, which a clip is right after adding it.
    await page.mouse.click(box.x + 13, box.y + 14);
    await expect(rowHere).toBeVisible();
    await page.mouse.click(box.x + 13, box.y + 14);
    await expect(rowHere).toHaveCount(0);

    await page.mouse.click(box.x + 100, box.y + 30, { button: "right" });
    await page.getByRole("menuitem", { name: "展开属性" }).click();
    await expect(rowHere).toBeVisible();
    await page.mouse.click(box.x + 100, box.y + 30, { button: "right" });
    await page.getByRole("menuitem", { name: "收起属性" }).click();
    await expect(rowHere).toHaveCount(0);
  });

  test("the menu of a key has what can be done with it", async ({ page }) => {
    await keyedColor(page);
    const at = await centerOf(keys(page, "位置 X").first());
    await page.mouse.click(at.x, at.y, { button: "right" });
    await page.getByRole("menuitem", { name: "选中这一行" }).click();
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-selected", "true");

    await page.mouse.click(at.x, at.y, { button: "right" });
    await page.getByRole("menuitem", { name: "插值…" }).click();
    await page.getByRole("dialog", { name: "插值" }).getByRole("radio", { name: "保持" }).click();
    await expect(keys(page, "位置 X").first()).toHaveAttribute("data-mark", "hold");
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("data-mark", "hold");
    await page.keyboard.press("Escape");

    await page.mouse.click(at.x, at.y, { button: "right" });
    await page.getByRole("menuitem", { name: "删除关键帧" }).click();
    await expect(keys(page, "位置 X")).toHaveCount(0);
  });

  test("a double click selects all keys of a moment", async ({ page }) => {
    await addColor(page);
    await keyButton(page, "位置 X").click();
    await keyButton(page, "位置 Y").click();
    await animate(page);
    await showAll(page);
    await open(page, "纯色");
    await open(page, "位置");
    const at = await centerOf(keys(page, "位置 X").first());
    await page.mouse.dblclick(at.x, at.y);
    await expect(keys(page, "位置 Y").first()).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("a project written by hand", () => {
  test.use({ withProject: false, trying: false });

  test("keys that nothing describes stay in sight, one value at a time", async ({ page }) => {
    const stepped = (first: string | boolean, second: string | boolean) => ({
      keys: [
        { time: "0", value: first },
        { time: "2", value: second },
      ],
    });
    await importClips(page, 10, [
      {
        id: "c",
        start: "0",
        duration: "5",
        source: { kind: "color", color: "#336699" },
        properties: {
          "param.title": stepped("你好", "再见"),
          "param.visible": stepped(true, false),
        },
      },
    ]);
    // It says that the project is here, right over the lanes.
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await animate(page);
    await showAll(page);
    await open(page, "纯色");
    await open(page, "未连接");
    await expect(row(page, "param.title")).toBeVisible();
    await expect(row(page, "param.title")).toContainText("你好");
    await expect(row(page, "param.visible")).toContainText("开");
    await expect(keys(page, "param.title")).toHaveCount(2);
    await expect(keys(page, "param.title").first()).toHaveAttribute("data-mark", "hold");
    // There is nothing between two values of this kind, so no curve to show.
    await expect(row(page, "param.title").getByRole("button", { name: /曲线/ })).toHaveCount(0);

    await dragBy(page, keys(page, "param.title").nth(1), 50);
    await expect.poll(() => timeOf(keys(page, "param.title").nth(1))).not.toBe("0:02/00");
  });
});

test.describe("while trying things out", () => {
  test("keys and rows that are not saved look like it, and saving is one step", async ({
    page,
  }) => {
    await keyedColor(page);
    await saveTrial(page);
    await expect(keys(page, "位置 X").nth(1)).not.toHaveAttribute("data-tried");
    await expect(row(page, "位置 X")).not.toHaveAttribute("data-tried");

    await dragBy(page, keys(page, "位置 X").nth(1), 60);
    await expect(trialBar(page).getByRole("status")).toHaveText("试改 1 处");
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("data-tried");
    await expect(keys(page, "位置 X").first()).not.toHaveAttribute("data-tried");
    await expect(row(page, "位置 X")).toHaveAttribute("data-tried");
    await expect(row(page, "位置 X").getByRole("img")).toHaveAttribute("data-source", "trial");
    const moved = await timeOf(keys(page, "位置 X").nth(1));

    await page.keyboard.press("Control+z");
    await expect(trialBar(page)).toHaveCount(0);
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/00$/);
    await page.keyboard.press("Control+Shift+z");
    await expect(trialBar(page).getByRole("status")).toHaveText("试改 1 处");
    await expect.poll(() => timeOf(keys(page, "位置 X").nth(1))).toBe(moved);

    await saveTrial(page);
    await expect(row(page, "位置 X")).not.toHaveAttribute("data-tried");
    await expect(keys(page, "位置 X").nth(1)).not.toHaveAttribute("data-tried");
    await page.keyboard.press("Control+z");
    await expect.poll(() => timeOf(keys(page, "位置 X").nth(1))).toBe("0:03/00");
  });

  test("while comparing, Delete on a key under a clip says why it stays, and the clip stays", async ({
    page,
  }) => {
    await keyedColor(page);
    await saveTrial(page);
    await dragBy(page, keys(page, "位置 X").nth(1), 60);
    await expect(trialBar(page).getByRole("status")).toHaveText("试改 1 处");
    await trialBar(page).getByRole("button", { name: "对比" }).click();
    const timeline = content(page, "timeline");
    const box = await clips(page).first().boundingBox();
    if (!box) throw new Error("no clip");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press("u");
    await expect(keysOf(timeline, "位置 X")).toHaveCount(2);
    const first = await centerOf(keysOf(timeline, "位置 X").first());
    await page.mouse.click(first.x, first.y);
    await expect(keysOf(timeline, "位置 X").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Delete");
    await expect(
      page.getByText("正在对比已保存的内容，关键帧不能改。", { exact: false }),
    ).toBeVisible();
    await expect(clips(page)).toHaveCount(1);
    await expect(keysOf(timeline, "位置 X")).toHaveCount(2);
  });

  test("a row can give up on what is tried, and comparing shows what is saved", async ({
    page,
  }) => {
    await keyedColor(page);
    await saveTrial(page);
    await dragBy(page, keys(page, "位置 X").nth(1), 60);
    await expect(row(page, "位置 X")).toHaveAttribute("data-tried");

    await trialBar(page).getByRole("button", { name: "对比" }).click();
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/00$/);
    const diamond = row(page, "位置 X")
      .getByRole("button", { name: /关键帧$/ })
      .nth(1);
    await expect(diamond).toHaveAttribute("aria-disabled", "true");
    await trialBar(page).getByRole("button", { name: "对比" }).click();
    await expect(diamond).not.toHaveAttribute("aria-disabled");

    await row(page, "位置 X").getByRole("button", { name: "X", exact: true }).click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: "放弃这个属性的试改" }).click();
    await expect(trialBar(page)).toHaveCount(0);
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/00$/);
  });
});
