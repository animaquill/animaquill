import type { Locator, Page } from "@playwright/test";
import {
  BLACK,
  expectColor,
  field,
  goTo,
  keyButton,
  panel,
  placeImage,
  typeInto,
} from "./property-helpers.ts";
import {
  clickFirstClip,
  importFolder,
  needsPlainStage,
  openForScenes,
  projectFolder,
  sceneFrames,
} from "./scene-support.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The handles on the picture. They are drawn on a canvas over the compositor, which also lists
 * them where they are drawn, for whoever reads the page, and for these tests to find them.
 */

interface Place {
  readonly x: number;
  readonly y: number;
}

const list = (page: Page) =>
  content(page, "preview").getByRole("list", { name: "画面上的手柄", exact: true });
const handle = (page: Page, name: string | RegExp) =>
  list(page).getByRole("listitem", { name, exact: typeof name === "string" });

async function middleOf(locator: Locator): Promise<Place> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not on the page");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags from a place on the page to others in turn, in steps, as a hand would. */
async function dragAlong(page: Page, from: Place, ...to: Place[]) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const place of to) await page.mouse.move(place.x, place.y, { steps: 6 });
}

async function drag(page: Page, from: Place, ...to: Place[]) {
  await dragAlong(page, from, ...to);
  await page.mouse.up();
}

/** How many world units a pixel of the page is, by the box of the selected clip. */
async function unitsPerPixel(page: Page, worldWidth: number): Promise<number> {
  const box = await handle(page, "片段框").boundingBox();
  if (!box) throw new Error("no box");
  return worldWidth / box.width;
}

const valueOf = async (page: Page, name: string) =>
  Number((await field(page, name).inputValue()).replace(/[%°]$/u, ""));

/** Waits for a field to come close to a number. */
const expectNear = (page: Page, name: string, wanted: number, within = 1.5) =>
  expect
    .poll(async () => Math.abs((await valueOf(page, name)) - wanted), { message: name })
    .toBeLessThanOrEqual(within);

const RED = [255, 0, 0] as const;

test("shows the box of the selected clip with its handles", async ({ page }) => {
  await placeImage(page);
  await expect(handle(page, "片段框")).toBeAttached();
  for (const name of [
    "缩放（左上）",
    "缩放（上）",
    "缩放（右上）",
    "缩放（右）",
    "缩放（右下）",
    "缩放（下）",
    "缩放（左下）",
    "缩放（左）",
    "旋转",
    "锚点",
  ]) {
    await expect(handle(page, name)).toBeAttached();
  }
  await content(page, "preview").screenshot({ path: test.info().outputPath("box.png") });
});

test("a click selects the clip under it, and one on nothing selects nothing", async ({ page }) => {
  await placeImage(page);
  const box = await handle(page, "片段框").boundingBox();
  if (!box) throw new Error("no box");
  // The picture is contained in the middle: left of it there is nothing.
  await page.mouse.click(box.x - 20, box.y + box.height / 2);
  await expect(handle(page, "片段框")).toHaveCount(0);
  await expect(panel(page)).toContainText("选中时间轴上的片段");
  await page.mouse.click(box.x + 30, box.y + 30);
  await expect(handle(page, "片段框")).toBeAttached();
  await expect(field(page, "位置 X")).toHaveValue("0");
});

test("dragging the picture moves its clip, as one step to undo", async ({ page }) => {
  await placeImage(page);
  const per = await unitsPerPixel(page, 1080);
  const anchor = await middleOf(handle(page, "锚点"));
  const from = { x: anchor.x + 60, y: anchor.y + 40 };
  await dragAlong(page, from, { x: from.x + 100, y: from.y + 50 });
  // On the way the picture moves along, and nothing is written yet.
  await expectColor(page, 420 + 100 * per - 10, 540, BLACK, 4);
  await expect(field(page, "位置 X")).toHaveValue("0");
  await page.mouse.up();
  await expectNear(page, "位置 X", 100 * per);
  await expectNear(page, "位置 Y", 50 * per);
  await expectColor(page, 420 + 100 * per + 10, 540, [...RED], 4);

  await page.keyboard.press("Control+z");
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(field(page, "位置 Y")).toHaveValue("0");
  await expectColor(page, 430, 540, [...RED], 4);
  await page.keyboard.press("Control+Shift+z");
  await expectNear(page, "位置 X", 100 * per);
});

test("Shift keeps a move to one direction, and Escape takes a drag back", async ({ page }) => {
  await placeImage(page);
  const anchor = await middleOf(handle(page, "锚点"));
  const from = { x: anchor.x + 60, y: anchor.y + 40 };
  await page.keyboard.down("Shift");
  await drag(page, from, { x: from.x + 120, y: from.y + 30 });
  await page.keyboard.up("Shift");
  await expect.poll(() => valueOf(page, "位置 X")).toBeGreaterThan(100);
  await expect(field(page, "位置 Y")).toHaveValue("0");

  // Only the picture follows a drag. The properties tab gets what is written in the end.
  await dragAlong(page, from, { x: from.x - 80, y: from.y - 200 });
  await expectColor(page, 1200, 900, BLACK, 4);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expectColor(page, 1200, 900, [...RED], 4);
  await expect(field(page, "位置 Y")).toHaveValue("0");
  await page.keyboard.press("Control+z");
  await expect(field(page, "位置 X")).toHaveValue("0");
});

test("a scale handle scales around the anchor, and keeps the shape", async ({ page }) => {
  await placeImage(page);
  const anchor = await middleOf(handle(page, "锚点"));
  const side = await middleOf(handle(page, "缩放（右）"));
  const reach = side.x - anchor.x;
  await drag(page, side, { x: side.x - reach / 2, y: side.y + 15 });
  await expectNear(page, "缩放", 50, 1);
  // Half as large around the middle, which stays where it was.
  await expectColor(page, 960, 540, [...RED], 4);
  await expectColor(page, 960 - 300, 540, BLACK, 4);
  await expectColor(page, 960 - 250, 540, [...RED], 4);
  await expect(field(page, "位置 X")).toHaveValue("0");

  const corner = await middleOf(handle(page, "缩放（左上）"));
  await drag(page, corner, {
    x: corner.x - (anchor.x - corner.x),
    y: corner.y - (anchor.y - corner.y),
  });
  await expectNear(page, "缩放", 100, 1.5);
  await page.keyboard.press("Control+z");
  await expectNear(page, "缩放", 50, 1);
});

test("the rotate handle turns around the anchor, in steps of 15 degrees with Shift", async ({
  page,
}) => {
  await placeImage(page);
  await typeInto(field(page, "缩放"), "50");
  const anchor = await middleOf(handle(page, "锚点"));
  const knob = await middleOf(handle(page, "旋转"));
  const reach = anchor.y - knob.y;
  expect(reach).toBeGreaterThan(50);
  // A quarter turn clockwise, around the anchor.
  await drag(
    page,
    knob,
    { x: anchor.x + reach * Math.SQRT1_2, y: anchor.y - reach * Math.SQRT1_2 },
    { x: anchor.x + reach, y: anchor.y },
  );
  await expectNear(page, "旋转", 90, 1);

  const turned = await middleOf(handle(page, "旋转"));
  await page.keyboard.down("Shift");
  await drag(page, turned, {
    x: anchor.x + reach * Math.cos(Math.PI / 5),
    y: anchor.y + reach * Math.sin(Math.PI / 5),
  });
  await page.keyboard.up("Shift");
  await expect.poll(() => valueOf(page, "旋转")).toBeGreaterThan(100);
  expect((await valueOf(page, "旋转")) % 15).toBe(0);
});

test("the anchor moves without the picture, and things turn around it then", async ({ page }) => {
  await placeImage(page);
  await typeInto(field(page, "缩放"), "50");
  await expectColor(page, 960 - 260, 540 - 260, [...RED], 4);
  // To the top left corner, where it stops.
  const corner = await middleOf(handle(page, "缩放（左上）"));
  await drag(page, await middleOf(handle(page, "锚点")), { x: corner.x + 3, y: corner.y + 2 });
  // The anchor is a share of the clip box, which is the stage for a picture without a size.
  await expect(field(page, "锚点 X")).toHaveValue("21.88%");
  await expect(field(page, "锚点 Y")).toHaveValue("0%");
  await expect(field(page, "位置 X")).toHaveValue("-270");
  await expect(field(page, "位置 Y")).toHaveValue("-270");
  // The picture did not move.
  for (const [x, y, color] of [
    [960 - 260, 540 - 260, RED],
    [960 + 260, 540 + 260, RED],
    [960 - 290, 540, BLACK],
    [960 + 290, 540, BLACK],
  ] as const) {
    await expectColor(page, x, y, [...color], 4);
  }
  // A quarter turn now goes around that corner.
  await typeInto(field(page, "旋转"), "90");
  await expectColor(page, 960 - 540, 540, [...RED], 4);
  await expectColor(page, 960, 540 + 100, BLACK, 4);
  // One step to undo the anchor, with what kept the picture still.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(field(page, "锚点 X")).toHaveValue("50%");
  await expect(field(page, "位置 X")).toHaveValue("0");
});

test("keys on the position make a path, and dragging a key on it changes that key", async ({
  page,
}) => {
  await placeImage(page);
  await typeInto(field(page, "缩放"), "25");
  await typeInto(field(page, "位置 X"), "-500");
  await keyButton(page, "位置 X").click();
  await goTo(page, "0:02/00");
  await typeInto(field(page, "位置 X"), "500");
  await goTo(page, "0:01/00");
  await expect(handle(page, /^位置关键帧/)).toHaveCount(2);
  const first = await middleOf(handle(page, "位置关键帧 0"));
  const last = await middleOf(handle(page, "位置关键帧 2"));
  expect(last.x - first.x).toBeGreaterThan(100);
  expect(Math.abs(last.y - first.y)).toBeLessThan(1);
  await content(page, "preview").screenshot({ path: test.info().outputPath("path.png") });

  const per = await unitsPerPixel(page, 270);
  // Y has no keys, and a drag does not move all of the path down.
  await drag(page, last, { x: last.x - 100, y: last.y + 40 });
  await goTo(page, "0:02/00");
  await expectNear(page, "位置 X", 500 - 100 * per, 2);
  await expect(field(page, "位置 Y")).toHaveValue("0");
  await goTo(page, "0:00/00");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await page.keyboard.press("Control+z");
  await goTo(page, "0:02/00");
  await expect(field(page, "位置 X")).toHaveValue("500");
});

test.describe("code objects", () => {
  test.use({ withProject: false });
  needsPlainStage();

  /** A box that a code object moves, with a handle at its middle, and that says where it is. */
  const arm = `<!doctype html>
<style>body { margin: 0; background: #000 }</style>
<script>
  const arm = aq.object("arm", {
    name: "手臂",
    properties: {
      x: { type: "number", unit: "world", default: 0 },
      turn: { type: "angle", default: 0 },
    },
    bounds: (v) => [v.x - 50, -50, 100, 100],
    handles: (v) => [
      { kind: "move", id: "tip", at: [v.x, 0], bind: { x: "x" } },
      { kind: "rotate", id: "spin", at: [v.x, 0], radius: 200, bind: "turn" },
      { kind: "move", id: "sneaky", at: [0, 300], bind: { x: "transform.x" } },
    ],
  });
  aq.frame((seconds) => {
    const { x, turn } = arm.at(seconds);
    document.body.dataset.x = String(x);
    document.body.dataset.turn = String(turn);
  });
</script>`;

  const said = (page: Page, key: string) =>
    sceneFrames(page)
      .at(-1)
      ?.evaluate((name) => document.body.dataset[name], key)
      .catch(() => undefined);

  test("a point handle of a code object changes what it binds, as one step to undo", async ({
    page,
  }) => {
    await openForScenes(page);
    await importFolder(page, projectFolder({ a: { "index.html": arm } }, [{}]));
    await clickFirstClip(page);
    await tab(page, "properties").click();
    const tip = handle(page, "手臂 的手柄 tip");
    await expect(tip).toBeAttached();
    // What would reach outside of the object itself is left out.
    await expect(handle(page, "手臂 的手柄 sneaky")).toHaveCount(0);
    await expect(handle(page, "手臂 的手柄 spin")).toBeAttached();
    await content(page, "preview").screenshot({ path: test.info().outputPath("object.png") });
    const per = await unitsPerPixel(page, 1920);
    const from = await middleOf(tip);
    await drag(page, from, { x: from.x + 80, y: from.y + 30 });
    await expect
      .poll(async () => Math.abs(Number(await said(page, "x")) - 80 * per))
      .toBeLessThanOrEqual(1.5);
    // The handle came along.
    await expect.poll(async () => (await middleOf(tip)).x - from.x).toBeGreaterThan(70);
    await expect(field(page, "位置 X")).toHaveValue("0");

    await page.keyboard.press("Control+z");
    await expect.poll(() => said(page, "x")).toBe("0");
  });
});
