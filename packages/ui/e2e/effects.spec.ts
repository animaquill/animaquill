import type { Download, Locator, Page } from "@playwright/test";
import type { RenderLayer, RenderPlan } from "@animaquill/core";
import { importClips } from "./project-files.ts";
import { content, expect, findCompositor, tab, tabScrolls, test } from "./support.ts";

/**
 * Effects: the effects tab, what it puts on clips, the list of a clip in the properties tab, and
 * what each effect does to the picture, as the compositor draws it from a plan it gets straight
 * from here and as an export of the same moment has it. See docs/design/resource-panels.md,
 * section 4, and docs/design/transitions.md, section 7.
 */

test.use({ withProject: false });

/** Screenshots to look at, in the output of each test. */
const shot = (name: string) => ({ path: test.info().outputPath(name) });

const panel = (page: Page) => content(page, "effects");
const item = (page: Page, name: string) =>
  panel(page).getByRole("option", { name, exact: true }).first();
const clips = (page: Page) =>
  content(page, "timeline")
    .getByRole("listbox", { name: "时间轴片段", exact: true })
    .getByRole("option");
const properties = (page: Page) => content(page, "properties");
const effectList = (page: Page) => properties(page).getByRole("region", { name: "效果" });
const effectsOn = (page: Page) => effectList(page).getByRole("listitem");

/** Red, green and blue one after the other. */
async function open(page: Page) {
  await importClips(page, 10, [
    { id: "a", name: "红", start: "0", duration: "3", source: { kind: "color", color: "#ff0000" } },
    { id: "b", name: "绿", start: "3", duration: "3", source: { kind: "color", color: "#00ff00" } },
    { id: "c", name: "蓝", start: "6", duration: "3", source: { kind: "color", color: "#0000ff" } },
  ]);
  await tab(page, "effects").click();
  await expect(panel(page)).toBeVisible();
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not on screen");
  return box;
}

async function onClip(page: Page, index: number, share = 0.5) {
  const box = await boxOf(clips(page).nth(index));
  return { x: box.x + box.width * share, y: box.y + box.height / 2 + 6 };
}

const xy = ({ x, y }: { x: number; y: number }) => [x, y] as const;

/** Drags an effect from the tab to a place, and does `meanwhile` while it is over it. */
async function drag(
  page: Page,
  name: string,
  to: { x: number; y: number },
  meanwhile?: () => Promise<void>,
) {
  await item(page, name).scrollIntoViewIfNeeded();
  const from = await boxOf(item(page, name));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x + 1, to.y, { steps: 2 });
  await meanwhile?.();
  await page.mouse.up();
}

const timelineShot = (page: Page) =>
  content(page, "timeline").getByRole("group", { name: "时间轴" }).screenshot();

const names = async (page: Page) =>
  effectsOn(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label")),
  );

test("lists the effects by what they do, finds them, and moves the one under the pointer", async ({
  page,
}) => {
  await open(page);
  const groups = panel(page).getByRole("group");
  await expect(groups.nth(0)).toHaveAccessibleName("调色");
  await expect(groups.nth(1)).toHaveAccessibleName("模糊");
  await expect(groups.nth(2)).toHaveAccessibleName("变形");
  await expect(groups.nth(0).getByRole("option")).toHaveCount(4);
  // How to use them is not written over them.
  await expect(panel(page).getByText(/拖到时间轴|点一个效果|也可以先选中/)).toHaveCount(0);
  await panel(page).screenshot(shot("effects-panel.png"));

  // Under the pointer the sample goes back and forth.
  const icon = item(page, "模糊").locator("canvas");
  await item(page, "模糊").hover();
  const first = await icon.screenshot();
  await expect.poll(async () => (await icon.screenshot()).equals(first)).toBe(false);

  const search = panel(page).getByRole("searchbox", { name: "搜索效果" });
  await search.fill("冷暖");
  await expect(panel(page).getByRole("option")).toHaveCount(1);
  await expect(item(page, "色温")).toBeVisible();
});

test("go last on the clip they are dropped on, which lights up first, and undo takes them off", async ({
  page,
}) => {
  await open(page);
  const plain = await timelineShot(page);
  await drag(page, "亮度", await onClip(page, 1), async () => {
    await expect.poll(async () => (await timelineShot(page)).equals(plain)).toBe(false);
    await content(page, "timeline").screenshot(shot("effects-drop.png"));
  });
  await tab(page, "properties").click();
  await expect(effectsOn(page)).toHaveCount(1);
  await expect(clips(page).nth(1)).toHaveAttribute("data-effects", "1");
  await expect(clips(page).nth(0)).not.toHaveAttribute("data-effects");

  await tab(page, "effects").click();
  await drag(page, "裁切", await onClip(page, 1));
  await tab(page, "properties").click();
  expect(await names(page)).toEqual(["亮度", "裁切"]);
  await content(page, "timeline").screenshot(shot("effects-mark.png"));

  await content(page, "timeline").getByRole("group", { name: "时间轴" }).focus();
  await page.keyboard.press("Control+z");
  expect(await names(page)).toEqual(["亮度"]);
  await page.keyboard.press("Control+z");
  await expect(clips(page).nth(1)).not.toHaveAttribute("data-effects");
});

test("go on every clip selected with a click, and say why where they cannot", async ({ page }) => {
  await open(page);
  await page.mouse.click(...xy(await onClip(page, 0)));
  await page.keyboard.down("Shift");
  await page.mouse.click(...xy(await onClip(page, 1)));
  await page.mouse.click(...xy(await onClip(page, 2)));
  await page.keyboard.up("Shift");
  await expect(panel(page).getByText(/点一个效果|效果列表最后/)).toHaveCount(0);
  await item(page, "模糊").click();
  for (const index of [0, 1, 2]) {
    await expect(clips(page).nth(index)).toHaveAttribute("data-effects", "1");
  }

  // A locked track: they are greyed out, and say why.
  await content(page, "timeline").getByRole("button", { name: /^锁定/ }).first().click();
  await expect(panel(page).getByRole("status")).toHaveText("选中的片段在锁定的轨道上，不能改");
  await expect(item(page, "亮度")).toHaveAttribute("aria-disabled", "true");
  await expect(item(page, "亮度")).toHaveAttribute("title", /锁定的轨道/);
  expect(await tabScrolls(page, "effects")).toBe(false);
  await item(page, "亮度").click({ force: true });
  await expect(clips(page).nth(0)).toHaveAttribute("data-effects", "1");
});

test.describe("in the properties tab", () => {
  test.use({ trying: false });

  async function withThree(page: Page) {
    await importClips(page, 4, [
      {
        id: "a",
        name: "灰",
        start: "0",
        duration: "4",
        source: { kind: "color", color: "#808080" },
        effects: [
          { id: "fx1", type: "brightness" },
          { id: "fx2", type: "blur" },
          { id: "fx3", type: "crop" },
        ],
        properties: { "effect.fx1.brightness": 0.2 },
      },
    ]);
    await page.mouse.click(...xy(await onClip(page, 0)));
    await tab(page, "properties").click();
    await expect(effectsOn(page)).toHaveCount(3);
  }

  test("move by dragging and with the keys, turn off, go, and come back with undo", async ({
    page,
  }) => {
    await withThree(page);
    await properties(page).screenshot(shot("effects-properties.png"));
    // The crop goes first.
    const grip = (name: string) =>
      effectList(page).getByRole("button", { name: `拖动来调整${name}的顺序，或者用上下方向键` });
    const top = await boxOf(effectsOn(page).nth(0));
    await grip("裁切").dragTo(effectsOn(page).nth(0), {
      targetPosition: { x: top.width / 2, y: 4 },
    });
    await expect.poll(() => names(page)).toEqual(["裁切", "亮度", "模糊"]);
    // The keys move the blur up one.
    await grip("模糊").focus();
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => names(page)).toEqual(["裁切", "模糊", "亮度"]);

    const toggle = effectList(page).getByRole("checkbox", { name: "启用亮度" });
    await toggle.uncheck();
    await expect(effectsOn(page).nth(2)).toHaveAttribute("data-off", "true");
    await effectList(page).getByRole("button", { name: "删除模糊" }).click();
    expect(await names(page)).toEqual(["裁切", "亮度"]);

    await content(page, "timeline").getByRole("group", { name: "时间轴" }).focus();
    await page.keyboard.press("Control+z");
    expect(await names(page)).toEqual(["裁切", "模糊", "亮度"]);
    await page.keyboard.press("Control+z");
    await expect(toggle).toBeChecked();
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await expect.poll(() => names(page)).toEqual(["亮度", "模糊", "裁切"]);
  });

  test("have what they take as rows with keys, also in the tree of the keyframes", async ({
    page,
  }) => {
    await withThree(page);
    const row = effectsOn(page).nth(0).getByRole("group", { name: "亮度", exact: true });
    const value = row.getByRole("spinbutton", { name: "亮度" });
    await expect(value).toHaveValue("20%");
    await row.getByRole("button", { name: "添加关键帧" }).click();
    await expect(row.getByRole("button", { name: "删除关键帧" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await tab(page, "keyframes").click();
    const tree = content(page, "keyframes");
    const node = (name: string) => tree.getByRole("treeitem", { name, exact: true });
    await tree.getByRole("button", { name: "展开 灰", exact: true }).click();
    await tree.getByRole("button", { name: "展开 效果", exact: true }).click();
    for (const name of ["亮度", "模糊"]) {
      await tree.getByRole("button", { name: `展开 ${name}`, exact: true }).click();
    }
    // Each effect is a level of its own, under it.
    await expect(node("亮度")).toHaveCount(2);
    await expect(node("模糊")).toBeVisible();
    await expect(node("半径")).toBeVisible();
    await content(page, "keyframes").screenshot(shot("effects-keyframes.png"));
  });
});

/* What effects do to the picture, from plans that go straight to the compositor. */

const WIDTH = 640;
const HEIGHT = 360;
type Color = readonly [number, number, number];

const still = (value: unknown) => ({ kind: "still", value }) as const;

const colorLayer = (
  id: string,
  hex: string,
  effects: readonly { id: string; type: string; values?: Record<string, unknown> }[] = [],
  more: Partial<RenderLayer> = {},
): RenderLayer => {
  const channels: Record<string, unknown> = { ...more.channels };
  for (const effect of effects) {
    for (const [name, value] of Object.entries(effect.values ?? {})) {
      channels[`effect.${effect.id}.${name}`] = still(value);
    }
  }
  return {
    id,
    start: 0,
    end: 10,
    offset: 0,
    source: { kind: "color", color: hex },
    fit: "contain",
    ...more,
    channels: channels as RenderLayer["channels"],
    ...(effects.length > 0 && {
      effects: effects.map(({ id: effect, type }) => ({ id: effect, type })),
    }),
  };
};

const planOf = (layers: readonly RenderLayer[]): RenderPlan => ({
  width: WIDTH,
  height: HEIGHT,
  stage: { width: 1920, height: 1080 },
  camera: {},
  scenes: { format: "f", language: "zh-CN", fps: { num: 30, den: 1 } },
  background: "#000000",
  layers: [...layers],
  joins: [],
});

async function show(page: Page, plan: RenderPlan): Promise<void> {
  await expect
    .poll(async () =>
      (await findCompositor(page))?.evaluate(() => document.querySelector("canvas") !== null),
    )
    .toBe(true);
  await content(page, "preview")
    .locator("iframe")
    .evaluate((element: HTMLIFrameElement, message) => {
      element.contentWindow?.postMessage({ type: "plan", plan: message }, "*");
      element.contentWindow?.postMessage({ type: "seek", seconds: 1, jump: true }, "*");
    }, plan);
}

async function pixel(page: Page, x: number, y: number): Promise<readonly number[]> {
  const read = (await findCompositor(page))?.evaluate(
    ([left = 0, top = 0, width = 0]) => {
      const canvas = document.querySelector("canvas");
      if (canvas?.width !== width) return [];
      return [...(canvas.getContext("2d")?.getImageData(left, top, 1, 1).data ?? [])].slice(0, 3);
    },
    [x, y, WIDTH],
  );
  return (await read?.catch(() => [])) ?? [];
}

const far = (found: readonly number[], wanted: Color) =>
  found.length === 0
    ? Infinity
    : Math.max(...wanted.map((part, index) => Math.abs(part - (found[index] ?? -999))));

/** Shows a plan and waits until these places have these colors, within `within` of 255. */
async function expectPixels(
  page: Page,
  plan: RenderPlan,
  wanted: readonly (readonly [number, number, Color])[],
  within = 3,
) {
  await show(page, plan);
  let read: (readonly number[])[] = [];
  try {
    await expect
      .poll(async () => {
        read = await Promise.all(wanted.map(([x, y]) => pixel(page, x, y)));
        return read.every(
          (found, index) => far(found, (wanted[index] as [number, number, Color])[2]) <= within,
        );
      })
      .toBe(true);
  } catch {
    throw new Error(`wanted ${JSON.stringify(wanted)}, found ${JSON.stringify(read)}`);
  }
}

const MIDDLE = [WIDTH / 2, HEIGHT / 2] as const;

test.describe("the picture", () => {
  test.use({ withProject: true });

  test("of each effect is what the format says, and nothing at the defaults", async ({ page }) => {
    const gray = "#808080";
    // At their defaults they leave the picture as it is, to the last bit.
    const all = ["brightness", "contrast", "saturation", "temperature", "blur", "crop"].map(
      (type) => ({ id: type, type }),
    );
    await expectPixels(
      page,
      planOf([colorLayer("a", gray, all)]),
      [[...MIDDLE, [128, 128, 128]]],
      0,
    );
    await expectPixels(
      page,
      planOf([
        colorLayer("a", gray, [{ id: "b", type: "brightness", values: { brightness: 0.5 } }]),
      ]),
      [[...MIDDLE, [192, 192, 192]]],
    );
    await expectPixels(
      page,
      planOf([
        colorLayer("a", "#c0c0c0", [{ id: "c", type: "contrast", values: { contrast: 0.5 } }]),
      ]),
      [[...MIDDLE, [224, 224, 224]]],
    );
    await expectPixels(
      page,
      planOf([
        colorLayer("a", "#ff0000", [{ id: "s", type: "saturation", values: { saturation: -1 } }]),
      ]),
      [[...MIDDLE, [54, 54, 54]]],
    );
    await expectPixels(
      page,
      planOf([
        colorLayer("a", gray, [{ id: "t", type: "temperature", values: { temperature: 1 } }]),
      ]),
      [[...MIDDLE, [160, 128, 96]]],
    );
    // Crop: the left half goes, and shows the black below.
    await expectPixels(
      page,
      planOf([colorLayer("a", "#ffffff", [{ id: "k", type: "crop", values: { left: 0.5 } }])]),
      [
        [WIDTH / 4, HEIGHT / 2, [0, 0, 0]],
        [(WIDTH * 3) / 4, HEIGHT / 2, [255, 255, 255]],
      ],
    );
  });

  test("works in its order: a blur after a crop softens its edge, a crop after a blur does not", async ({
    page,
  }) => {
    const crop = { id: "k", type: "crop", values: { left: 0.5 } };
    const blur = { id: "b", type: "blur", values: { radius: 30 } };
    const edge = WIDTH / 2 + 2;
    await expectPixels(page, planOf([colorLayer("a", "#ffffff", [blur, crop])]), [
      [edge, HEIGHT / 2, [255, 255, 255]],
    ]);
    await show(page, planOf([colorLayer("a", "#ffffff", [crop, blur])]));
    await expect
      .poll(async () => (await pixel(page, edge, HEIGHT / 2))[0] ?? 255)
      .toBeLessThan(200);
  });

  test("of a clip box half as large has its blur half as wide, in the box", async ({ page }) => {
    const blur = { id: "b", type: "blur", values: { radius: 30 } };
    const scaled = (scale: number) =>
      planOf([
        colorLayer("a", "#ffffff", [blur], {
          channels: { "transform.scale": still(scale) } as RenderLayer["channels"],
        }),
      ]);
    /** How many pixels across the left edge of the box are neither black nor white. */
    const soft = async (plan: RenderPlan, edge: number) => {
      await show(page, plan);
      await expect.poll(async () => (await pixel(page, edge + 30, HEIGHT / 2))[0] ?? 0).toBe(255);
      let count = 0;
      for (let x = edge - 30; x < edge + 30; x += 1) {
        const value = (await pixel(page, x, HEIGHT / 2))[0] ?? 0;
        if (value > 8 && value < 247) count += 1;
      }
      return count;
    };
    // 30 units of the world are 5 pixels of this picture in a box half as large, 2.5 in a quarter.
    const half = await soft(scaled(0.5), WIDTH / 4);
    const quarter = await soft(scaled(0.25), (WIDTH * 3) / 8);
    expect(half).toBeGreaterThan(6);
    expect(Math.abs(half - quarter * 2)).toBeLessThanOrEqual(3);
  });

  test("goes onto what is below in the blend mode of the clip", async ({ page }) => {
    const blend = (mode: string) =>
      ({ channels: { blend: still(mode), "transform.scale": still(0.5) } }) as Partial<RenderLayer>;
    const red = colorLayer("red", "#ff0000");
    await expectPixels(page, planOf([red, colorLayer("g", "#808080", [], blend("multiply"))]), [
      [...MIDDLE, [128, 0, 0]],
    ]);
    await expectPixels(page, planOf([red, colorLayer("b", "#0000ff", [], blend("screen"))]), [
      [...MIDDLE, [255, 0, 255]],
      [10, 10, [255, 0, 0]],
    ]);
    await expectPixels(page, planOf([red, colorLayer("b", "#0000ff", [], blend("add"))]), [
      [...MIDDLE, [255, 0, 255]],
    ]);
    await expectPixels(page, planOf([red, colorLayer("w", "#ffffff", [], blend("darken"))]), [
      [...MIDDLE, [255, 0, 0]],
    ]);
  });
});

/* An export of a moment is the preview of it, effects and all. */

const bytesOf = async (download: Download) => {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

test("an exported frame is the same as the preview, with effects and their keys", async ({
  page,
}) => {
  await importClips(page, 4, [
    {
      id: "a",
      name: "彩",
      start: "0",
      duration: "4",
      source: { kind: "color", color: "#3070c0" },
      effects: [
        { id: "t", type: "temperature" },
        { id: "s", type: "saturation" },
        { id: "k", type: "crop" },
        { id: "b", type: "blur" },
      ],
      properties: {
        "transform.scale": 0.6,
        "transform.rotation": 10,
        "effect.t.temperature": 0.7,
        "effect.s.saturation": {
          keys: [
            { time: "0", value: -0.5 },
            { time: "2", value: 1 },
          ],
        },
        "effect.k.left": 0.2,
        "effect.k.top": 0.1,
        "effect.b.radius": 12,
      },
    },
  ]);
  const frame = await (
    await content(page, "preview").locator("iframe").elementHandle()
  )?.contentFrame();
  if (!frame) throw new Error("No compositor");
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill("0:01/00");
  await page.keyboard.press("Enter");
  const download = page.waitForEvent("download");
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "导出当前帧", exact: true }).click();
  const png = await bytesOf(await download);
  const difference = await frame.evaluate(async (base64) => {
    const pixelsOf = async (source: CanvasImageSource) => {
      const picture = new VideoFrame(source, { timestamp: 0 });
      const pixels = new Uint8Array(picture.allocationSize({ format: "RGBA" }));
      await picture.copyTo(pixels, { format: "RGBA" });
      picture.close();
      return pixels;
    };
    const canvas = document.querySelector("canvas") as HTMLCanvasElement;
    const shown = await pixelsOf(canvas);
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const file = await pixelsOf(await createImageBitmap(new Blob([bytes])));
    let most = file.length === shown.length ? 0 : 255;
    for (let index = 0; index < file.length; index += 1) {
      most = Math.max(most, Math.abs((file[index] ?? 0) - (shown[index] ?? 0)));
    }
    return most;
  }, png.toString("base64"));
  expect(difference).toBeLessThanOrEqual(2);
});
