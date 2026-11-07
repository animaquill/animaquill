import { bezierProgress } from "@animaquill/core";
import type { Locator, Page } from "@playwright/test";
import {
  BLACK,
  addColor,
  clips,
  colorAt,
  dragField,
  expectColor,
  field,
  goTo,
  keyButton,
  near,
  placeImage,
  typeInto,
} from "./property-helpers.ts";
import { importClips } from "./project-files.ts";
import { content, expect, group, tab, test } from "./support.ts";

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

/**
 * What a reading comes to once it stays the same for a moment. The tab measures itself a moment
 * after it shows or moves, and the list of keys follows the view a moment after that.
 */
async function settled<T>(read: () => Promise<T>): Promise<T> {
  let before = JSON.stringify(await read());
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await read());
        const same = now === before;
        before = now;
        return same;
      },
      { intervals: [150] },
    )
    .toBe(true);
  return JSON.parse(before) as T;
}

/** Where the keys of the tab are, by the list that is in the same places. */
const keyPlaces = (page: Page) =>
  panel(page)
    .getByRole("option")
    .evaluateAll((items) =>
      items.map((item) => [item.getAttribute("aria-label"), item.getAttribute("style")]),
    );

/**
 * All of the timeline in view, so that keys have room to go. What fits is what the tab measured, so
 * that waits for the tab to have its size, and what is read after it for the keys to follow.
 */
const showAll = async (page: Page) => {
  await settled(() => stage(page).boundingBox());
  await panel(page).getByRole("button", { name: "显示全部" }).click();
  await settled(() => keyPlaces(page));
};

const tallButton = (page: Page, name: string) =>
  panel(page).getByRole("button", { name: `加高 ${name} 这一行`, exact: true });

/** Makes a row taller, and waits for the keys to be where they go then. */
const makeTall = async (page: Page, name: string) => {
  await tallButton(page, name).click();
  await settled(() => keyPlaces(page));
};

/** The same on the timeline, which zooms on its own. */
const showAllOnTimeline = async (page: Page) => {
  await content(page, "timeline").getByRole("button", { name: "显示全部" }).click();
};

/** A clip with keys on X at 1 and 3 seconds, in the workspace for animating, and opened up. */
async function keyedColor(page: Page) {
  await addColor(page);
  await keyButton(page, "位置 X").click();
  await goTo(page, "0:03/00");
  await typeInto(field(page, "位置 X"), "300");
  await animate(page);
  await showAll(page);
  await showAllOnTimeline(page);
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

    // Not as far as the next key of X, whatever the size of the tab.
    const one = await centerOf(keys(page, "位置 X").first());
    const three = await centerOf(keys(page, "位置 X").nth(1));
    await dragBy(page, keys(page, "位置").first(), (three.x - one.x) * 0.4);
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

  /**
   * Where the curve is in a column of the canvas, by its colour, between two heights: the middle of
   * the pixels it covers there, which are more where it is steep.
   */
  const curveAt = (page: Page, x: number, top: number, bottom: number) =>
    panel(page)
      .locator("canvas")
      .evaluate(
        (element, area) => {
          const canvas = element as HTMLCanvasElement;
          const box = canvas.getBoundingClientRect();
          const ratio = canvas.width / canvas.clientWidth;
          const column = Math.round((area.x - box.x) * ratio);
          const pixels = canvas.getContext("2d")?.getImageData(column, 0, 1, canvas.height).data;
          const from = Math.round((area.top - box.y) * ratio);
          const to = Math.round((area.bottom - box.y) * ratio);
          const covered: number[] = [];
          for (let y = from; y < to; y += 1) {
            const [red = 0, green = 0, blue = 0] = pixels?.slice(y * 4, y * 4 + 3) ?? [];
            // The curve is a light blue, and only it.
            if (red < 90 && green > 130 && blue > 200) covered.push(y);
          }
          const [first, last] = [covered[0], covered.at(-1)];
          if (first === undefined || last === undefined) return undefined;
          return box.y + ((first + last) / 2 + 0.5) / ratio;
        },
        { x, top, bottom },
      );

  test("a row is the curve of its number, the way it is worked out", async ({ page }) => {
    await keyedColor(page);
    await makeTall(page, "位置 X");
    const first = await centerOf(keys(page, "位置 X").first());
    const last = await centerOf(keys(page, "位置 X").nth(1));
    // 300 is higher up than 0.
    expect(last.y).toBeLessThan(first.y - 60);
    const lane = await row(page, "位置 X").boundingBox();
    if (!lane) throw new Error("no row");
    const measure = async (progress: (share: number) => number) => {
      for (const share of [0.25, 0.5, 0.75]) {
        const x = first.x + (last.x - first.x) * share;
        const expected = first.y + (last.y - first.y) * progress(share);
        const found = () => curveAt(page, x, lane.y, lane.y + lane.height);
        await expect.poll(async () => Math.abs(((await found()) ?? 0) - expected)).toBeLessThan(2);
      }
    };
    await measure((share) => share);

    await page.mouse.click(first.x, first.y);
    await panel(page).getByRole("button", { name: "插值" }).click();
    const bubble = page.getByRole("dialog", { name: "插值" });
    await bubble.getByRole("radio", { name: "缓入缓出" }).click();
    await page.keyboard.press("Escape");
    await measure((share) => bezierProgress(0.42, 0, 0.58, 1, share));

    await panel(page).getByRole("button", { name: "插值" }).click();
    await bubble.getByRole("radio", { name: "保持" }).click();
    await page.keyboard.press("Escape");
    await measure(() => 0);
  });

  test("a handle of a selected key bends the curve, and the picture follows, in one step", async ({
    page,
  }) => {
    await keyedColor(page);
    await makeTall(page, "位置 X");
    await goTo(page, "0:02/00");
    await expect(value(page, "位置 X")).toHaveValue("150");
    // The clip is as big as the stage, and half way it is 150 to the right.
    const blackAt200 = async () => near(await colorAt(page, 200, 540), BLACK);
    await expect.poll(blackAt200).toBe(false);
    const first = await centerOf(keys(page, "位置 X").first());
    await page.mouse.click(first.x, first.y);
    const handle = panel(page).locator('[data-handle="out"][data-of="位置 X"]');
    await expect(handle).toHaveCount(1);
    const from = await centerOf(handle);
    // A third of the way along a straight line.
    const last = await centerOf(keys(page, "位置 X").nth(1));
    expect(from.x).toBeCloseTo(first.x + (last.x - first.x) / 3, -1);
    expect(from.y).toBeCloseTo(first.y + (last.y - first.y) / 3, -1);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 20, from.y - 30, { steps: 4 });
    await page.mouse.move(from.x - 40, from.y - 60, { steps: 4 });
    // While the mouse holds it, the picture already shows what it does.
    await expect.poll(blackAt200).toBe(true);
    await page.mouse.up();
    await expect(keys(page, "位置 X").first()).toHaveAttribute("data-mark", "eased");
    const bent = Number(await value(page, "位置 X").inputValue());
    expect(bent).toBeGreaterThan(200);
    await page.keyboard.press("Control+z");
    await expect(value(page, "位置 X")).toHaveValue("150");
    await expect(keys(page, "位置 X").first()).toHaveAttribute("data-mark", "linear");
    await expect.poll(blackAt200).toBe(false);
    await page.keyboard.press("Control+Shift+z");
    await expect(value(page, "位置 X")).toHaveValue(String(bent));
  });

  test("a key goes up and down for its value, and Shift keeps it to one way", async ({ page }) => {
    await keyedColor(page);
    await makeTall(page, "位置 X");
    await goTo(page, "0:03/00");
    await expect(value(page, "位置 X")).toHaveValue("300");
    await dragBy(page, keys(page, "位置 X").nth(1), 0, 40);
    await expect
      .poll(async () => Number(await value(page, "位置 X").inputValue()))
      .toBeLessThan(300);
    await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:03\/00$/);
    await page.keyboard.press("Control+z");
    await expect(value(page, "位置 X")).toHaveValue("300");

    const key = await centerOf(keys(page, "位置 X").nth(1));
    await page.keyboard.down("Shift");
    await page.mouse.move(key.x, key.y);
    await page.mouse.down();
    await page.mouse.move(key.x + 30, key.y + 10, { steps: 4 });
    await page.mouse.move(key.x + 60, key.y + 20, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(keys(page, "位置 X").nth(1)).not.toHaveAttribute("aria-label", /0:03\/00$/);
    // It stayed as high up as it was, which is its value.
    expect((await centerOf(keys(page, "位置 X").nth(1))).y).toBeCloseTo(key.y, 0);
  });

  test("a row is made taller on its own, pulled to a height, and stays so", async ({ page }) => {
    await keyedColor(page);
    const height = async () => (await row(page, "位置 X").boundingBox())?.height ?? 0;
    const usual = await height();
    await makeTall(page, "位置 X");
    await expect.poll(height).toBe(120);
    // The bottom edge, on the side of the keys.
    const box = await row(page, "位置 X").boundingBox();
    const canvas = await panel(page).locator("canvas").boundingBox();
    if (!box || !canvas) throw new Error("no row");
    const edge = box.y + box.height - 2;
    await page.mouse.move(canvas.x + 200, edge);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 200, edge + 40, { steps: 4 });
    await page.mouse.up();
    await expect.poll(height).toBe(160);
    // And on the side of the list.
    const separator = panel(page).getByRole("separator", { name: "拖动调整 位置 X 这一行的高度" });
    const line = await centerOf(separator);
    await page.mouse.move(line.x, line.y);
    await page.mouse.down();
    await page.mouse.move(line.x, line.y - 20, { steps: 4 });
    await page.mouse.up();
    await expect.poll(height).toBe(140);
    await page.waitForTimeout(500);
    await page.reload();
    await expect.poll(height).toBe(140);
    await panel(page)
      .getByRole("button", { name: "恢复 位置 X 这一行的高度", exact: true })
      .click();
    await expect.poll(height).toBe(usual);
    await makeTall(page, "位置 X");
    await expect.poll(height).toBe(140);
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

  test("the tab scrolls and zooms on its own, and the playhead is the same", async ({ page }) => {
    await keyedColor(page);
    const button = (name: string) => panel(page).getByRole("button", { name, exact: true });
    const gap = async () => {
      const found = await keys(page, "位置 X").all();
      const [first, second] = found;
      if (!first || !second) return 0;
      return (await centerOf(second)).x - (await centerOf(first)).x;
    };
    const timeline = content(page, "timeline");
    const zoom = timeline.getByRole("slider", { name: "缩放" });
    const shared = await zoom.inputValue();
    const clip = await clips(page).first().boundingBox();
    const start = await gap();
    await button("放大").click();
    await expect.poll(gap).toBeGreaterThan(start * 1.3);
    expect(await zoom.inputValue()).toBe(shared);
    expect(await clips(page).first().boundingBox()).toEqual(clip);

    // The other way round, too.
    const zoomed = await gap();
    await zoom.fill("0.9");
    await expect.poll(gap).toBeCloseTo(zoomed, 0);

    // The ruler of the tab moves the one playhead.
    const box = await stage(page).boundingBox();
    if (!box) throw new Error("no stage");
    await page.mouse.click(box.x + box.width / 2, box.y + 14);
    const time = await page
      .getByRole("contentinfo")
      .getByRole("status", { name: "播放头" })
      .textContent();
    await expect(timeline.getByRole("slider", { name: "播放头", exact: true })).toHaveAttribute(
      "aria-valuetext",
      time ?? "",
    );
  });

  test("rows of keys get taller and shorter, as on the timeline, and stay so", async ({ page }) => {
    await keyedColor(page);
    const height = async () => (await row(page, "位置 X").boundingBox())?.height ?? 0;
    const start = await height();
    await stage(page).focus();
    await page.keyboard.press("Shift+=");
    await expect.poll(height).toBeGreaterThan(start);
    // What is on the timeline stays as it was.
    const clip = await clips(page).first().boundingBox();
    const taller = await height();
    const center = await centerOf(row(page, "位置 X"));
    await page.mouse.move(center.x, center.y);
    await page.keyboard.down("Control");
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Shift");
    await page.keyboard.up("Control");
    await expect.poll(height).toBeLessThan(taller);
    expect(await clips(page).first().boundingBox()).toEqual(clip);
    await page.keyboard.press("Shift+=");
    await page.keyboard.press("Shift+=");
    const tallest = await height();
    expect(tallest).toBeGreaterThan(start);
    // A key is still where its row is.
    const key = await centerOf(keys(page, "位置 X").first());
    const rowBox = await row(page, "位置 X").boundingBox();
    if (!rowBox) throw new Error("no row");
    expect(key.y).toBeGreaterThan(rowBox.y);
    expect(key.y).toBeLessThan(rowBox.y + rowBox.height);
    await page.waitForTimeout(500);
    await page.reload();
    await expect.poll(height).toBeCloseTo(tallest, 0);
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

/** The ways the timeline can be out of sight while the keyframe tab shows. */
const hidingTimeline = {
  closed: async (page: Page) => {
    await group(page, "timeline").locator('button[aria-label="关闭 时间轴"]').click();
    await expect(tab(page, "timeline")).toHaveCount(0);
  },
  "behind the keyframe tab": async (page: Page) => {
    const from = await tab(page, "keyframes").boundingBox();
    const strip = await group(page, "timeline").locator(".dv-tabs-container").boundingBox();
    if (!from || !strip) throw new Error("no tabs");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 });
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(group(page, "timeline").locator('[data-tab="keyframes"]')).toBeVisible();
    await expect(content(page, "timeline")).toBeHidden();
  },
};

for (const [how, hide] of Object.entries(hidingTimeline)) {
  test.describe(`with the timeline ${how}`, () => {
    test.use({ trying: false });

    const playheadHere = (page: Page) =>
      stage(page).getByRole("slider", { name: "播放头", exact: true });
    /** Where the playhead line is on screen. */
    const playheadX = async (page: Page) => {
      const box = await playheadHere(page).boundingBox();
      if (!box) throw new Error("no playhead");
      return box.x + box.width / 2;
    };

    test("the ruler puts the playhead where the mouse is", async ({ page }) => {
      await keyedColor(page);
      // How wide the timeline was is what the view used to go by, also after it was closed.
      const timeline = await content(page, "timeline")
        .getByRole("group", { name: "时间轴", exact: true })
        .boundingBox();
      if (!timeline) throw new Error("no timeline");
      await hide(page);
      const button = (name: string) => panel(page).getByRole("button", { name, exact: true });
      // Zoomed in, the end of the timeline is far on the right, and the mouse stays before it.
      await button("放大").click();
      await button("放大").click();
      const box = await stage(page).boundingBox();
      if (!box) throw new Error("no stage");
      const y = box.y + 14;
      const end = await playheadHere(page).getAttribute("aria-valuemax");
      await page.mouse.move(box.x + 20, y);
      await page.mouse.down();
      for (const share of [0.3, 0.6, 0.9, 1.1, 0.7]) {
        const x = box.x + Math.min(share * timeline.width, box.width * 0.9);
        await page.mouse.move(x, y, { steps: 5 });
        await expect.poll(() => playheadX(page)).toBeCloseTo(x, -1);
        await expect(playheadHere(page)).not.toHaveAttribute("aria-valuenow", end ?? "");
      }
      await page.mouse.up();
      const x = await playheadX(page);
      // Going on by a frame does not throw the view somewhere else.
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => playheadX(page)).toBeGreaterThan(x);
      expect(await playheadX(page)).toBeLessThan(x + 20);
    });

    test("zooming and showing all still work", async ({ page }) => {
      await keyedColor(page);
      await hide(page);
      const button = (name: string) => panel(page).getByRole("button", { name, exact: true });
      const gap = async () => {
        const [first, second] = await keys(page, "位置 X").all();
        if (!first || !second) return 0;
        return (await centerOf(second)).x - (await centerOf(first)).x;
      };
      // Showing all again would go back to where it was before.
      await button("放大").click();
      await showAll(page);
      const all = await gap();
      await button("放大").click();
      await expect.poll(gap).toBeGreaterThan(all * 1.3);
      await showAll(page);
      await expect.poll(gap).toBeCloseTo(all, -1);
      const box = await stage(page).boundingBox();
      const last = await centerOf(keys(page, "位置 X").nth(1));
      if (!box) throw new Error("no stage");
      // All of it fits, with the end of the timeline before the right edge.
      expect(last.x).toBeLessThan(box.x + box.width);
    });

    test("a key goes where it is dragged, and a box selects", async ({ page }) => {
      await keyedColor(page);
      await hide(page);
      const first = await centerOf(keys(page, "位置 X").first());
      const second = await centerOf(keys(page, "位置 X").nth(1));
      await dragBy(page, keys(page, "位置 X").nth(1), (first.x - second.x) / 2);
      await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-label", /0:02\/\d\d$/);
      const moved = await centerOf(keys(page, "位置 X").nth(1));
      expect(moved.x).toBeCloseTo((first.x + second.x) / 2, -1);

      await page.mouse.move(first.x - 30, first.y - 8);
      await page.mouse.down();
      await page.mouse.move(first.x + 20, first.y + 6, { steps: 6 });
      await page.mouse.up();
      await expect(keys(page, "位置 X").first()).toHaveAttribute("aria-selected", "true");
      await expect(keys(page, "位置 X").nth(1)).toHaveAttribute("aria-selected", "false");
    });
  });
}

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

  test("a switch and a choice change in their row, at the playhead when they have keys", async ({
    page,
  }) => {
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
          "param.visible": stepped(true, false),
          blend: stepped("normal", "screen"),
        },
      },
    ]);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await animate(page);
    await showAll(page);
    await open(page, "纯色");
    await open(page, "未连接");
    await goTo(page, "0:01/00");
    const toggle = panel(page).getByRole("switch", { name: "param.visible" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(keys(page, "param.visible")).toHaveCount(3);
    expect(await timesOf(keys(page, "param.visible"))).toEqual(["0:00/00", "0:01/00", "0:02/00"]);
    const choice = panel(page).getByRole("combobox", { name: "blend" });
    await expect(choice).toHaveValue("normal");
    await choice.selectOption("multiply");
    await expect(keys(page, "blend")).toHaveCount(3);
    await page.keyboard.press("Control+z");
    await expect(keys(page, "blend")).toHaveCount(2);

    // Taller, it still has its values from key to key, and nothing to ease.
    await panel(page).getByRole("button", { name: "加高 param.visible 这一行" }).click();
    const list = await panel(page).getByRole("tree").boundingBox();
    if (!list) throw new Error("no list");
    await page.mouse.move(list.x + 40, list.y + 40);
    await page.mouse.wheel(0, 400);
    /** Where something is, without scrolling what is around it. */
    const boxOf = async (locator: Locator) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error("not there");
      return { ...box, middle: box.y + box.height / 2, center: box.x + box.width / 2 };
    };
    await expect.poll(async () => (await boxOf(row(page, "param.visible"))).height).toBe(120);
    const tall = await boxOf(row(page, "param.visible"));
    await expect
      .poll(async () => (await boxOf(keys(page, "param.visible").nth(1))).middle)
      .toBeCloseTo(tall.middle, 0);
    const found = await boxOf(keys(page, "param.visible").nth(1));
    const key = { x: found.center, y: found.middle };
    await page.mouse.click(key.x, key.y);
    await expect(keys(page, "param.visible").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(keys(page, "param.visible").nth(1)).toHaveAttribute("data-mark", "hold");
    await expect(panel(page).getByRole("button", { name: "插值" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
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
