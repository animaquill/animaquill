import { readFileSync } from "node:fs";
import type { Frame, Page } from "@playwright/test";
import {
  ProjectStore,
  buildRenderPlan,
  orderedTracks,
  type RenderLayer,
  type RenderPlan,
} from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import {
  BLACK,
  addColor,
  clips,
  colorAt,
  compositor,
  dragField,
  expectColor,
  field,
  goTo,
  holdFrames,
  keyButton,
  panel,
  placeImage,
  png,
  row,
  typeInto,
  type Color,
} from "./property-helpers.ts";
import { content, expect, findCompositor, tab, test } from "./support.ts";

test.use({ trying: false });

test("says what to do while nothing is selected", async ({ page }) => {
  await tab(page, "properties").click();
  await expect(panel(page)).toContainText("选中时间轴上的片段");
  await expect(panel(page).getByRole("spinbutton")).toHaveCount(0);
});

test("lists what the description of a clip says, with the value at the playhead", async ({
  page,
}) => {
  await addColor(page);
  for (const [name, value] of [
    ["位置 X", "0"],
    ["位置 Y", "0"],
    ["大小 宽", "自动"],
    ["大小 高", "自动"],
    ["锚点 X", "50%"],
    ["锚点 Y", "50%"],
    ["缩放", "100%"],
    ["旋转", "0°"],
    ["不透明度", "100%"],
  ] as const) {
    await expect(field(page, name)).toHaveValue(value);
  }
  await expect(panel(page).getByRole("combobox", { name: "适应方式" })).toHaveValue("contain");
});

test("moves and fades a picture with two keys, and undo takes it back", async ({ page }) => {
  await placeImage(page);
  await typeInto(field(page, "缩放"), "25");
  // Contained in the stage the picture is 1080 wide, so at a quarter it is 270.
  await expectColor(page, 960, 540, [255, 0, 0]);
  await expectColor(page, 960 - 200, 540, BLACK);

  await typeInto(field(page, "位置 X"), "-500");
  await keyButton(page, "位置 X").click();
  await keyButton(page, "不透明度").click();
  await goTo(page, "0:02/00");
  await typeInto(field(page, "位置 X"), "500");
  await typeInto(field(page, "不透明度"), "20");

  await expectColor(page, 1460, 540, [51, 0, 0]);
  await expectColor(page, 460, 540, BLACK);
  await expectColor(page, 960, 540, BLACK);

  await goTo(page, "0:01/00");
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expect(field(page, "不透明度")).toHaveValue("60%");
  await expectColor(page, 960, 540, [153, 0, 0]);
  await expectColor(page, 460, 540, BLACK);
  await expectColor(page, 1460, 540, BLACK);

  await goTo(page, "0:00/00");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expect(field(page, "不透明度")).toHaveValue("100%");
  await expectColor(page, 460, 540, [255, 0, 0]);
  await expectColor(page, 960, 540, BLACK);

  // Opacity at 2 seconds, then the position there, then the key of the opacity at the start.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(field(page, "不透明度")).toHaveValue("100%");
  await goTo(page, "0:02/00");
  await expect(field(page, "位置 X")).toHaveValue("-500");
  await expectColor(page, 460, 540, [255, 0, 0]);

  await page.keyboard.press("Control+Shift+z");
  await page.keyboard.press("Control+Shift+z");
  await expect(field(page, "位置 X")).toHaveValue("500");
  await expectColor(page, 1460, 540, [255, 0, 0]);
});

test("survives a reload with its keys", async ({ page }) => {
  await placeImage(page);
  await keyButton(page, "位置 X").click();
  await goTo(page, "0:01/00");
  await typeInto(field(page, "位置 X"), "300");
  await page.reload();
  await tab(page, "timeline").click();
  // The list of clips is for finding them. The mouse goes to what is drawn underneath.
  await expect(clips(page)).toHaveCount(1);
  const box = await clips(page).first().boundingBox();
  await page.mouse.click((box?.x ?? 0) + 20, (box?.y ?? 0) + 10);
  await tab(page, "properties").click();
  await expect(field(page, "位置 X")).toHaveValue("300");
  await goTo(page, "0:00/00");
  await expect(field(page, "位置 X")).toHaveValue("0");
});

test("a drag shows on the way, and is one step to undo", async ({ page }) => {
  // It listens before the clip comes, and the clip has to be there first: a message on its way
  // can arrive after a listener that comes later, and that would look like one sent during the drag.
  await (
    await compositor(page)
  ).evaluate(() => {
    const state = window as unknown as { messages: string[] };
    state.messages = [];
    addEventListener("message", ({ data }: MessageEvent<{ type: string; plan?: RenderPlan }>) => {
      state.messages.push(data.plan ? `plan:${data.plan.layers.length}` : data.type);
    });
  });
  const messages = async () =>
    (await compositor(page)).evaluate(() => (window as unknown as { messages: string[] }).messages);
  const plans = async () => (await messages()).filter((type) => type.startsWith("plan"));
  await addColor(page);
  await expect.poll(async () => (await plans()).at(-1)).toBe("plan:1");
  const before = (await plans()).length;
  const x = field(page, "位置 X");

  await dragField(page, x, 60);
  await expect(x).toHaveValue(/^\d+$/);
  await expect
    .poll(async () => (await messages()).filter((type) => type === "channels").length)
    .toBeGreaterThan(2);
  expect(await plans()).toHaveLength(before);
  await page.mouse.up();
  await expect.poll(async () => (await plans()).length).toBe(before + 1);
  const landed = await x.inputValue();
  expect(Number(landed)).toBeGreaterThan(40);

  await page.keyboard.press("Control+z");
  await expect(x).toHaveValue("0");
  await expect(clips(page)).toHaveCount(1);
  await page.keyboard.press("Control+Shift+z");
  await expect(x).toHaveValue(landed);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(0);
});

test("the picture follows a drag, and Escape takes it back without a trace", async ({ page }) => {
  await placeImage(page);
  await typeInto(field(page, "缩放"), "25");
  await expectColor(page, 960 - 200, 540, BLACK);
  const x = field(page, "位置 X");
  await dragField(page, x, -200);
  await expect.poll(async () => Number(await x.inputValue())).toBeLessThan(-180);
  const moved = Math.abs(Number(await x.inputValue()));
  await expectColor(page, 960 - moved - 100, 540, [255, 0, 0]);
  await expectColor(page, 960 + 100, 540, BLACK);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(x).toHaveValue("0");
  await expectColor(page, 960 - 200, 540, BLACK);
  await expectColor(page, 960, 540, [255, 0, 0]);
  await page.keyboard.press("Control+z");
  await expect(field(page, "缩放")).toHaveValue("100%");
});

test("a drag that ends where it started leaves nothing to undo", async ({ page }) => {
  await addColor(page);
  const x = field(page, "位置 X");
  await dragField(page, x, 40);
  const box = await x.boundingBox();
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + 5, { steps: 4 });
  await page.mouse.up();
  await expect(x).toHaveValue("0");
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(0);
});

test("typing writes on Enter and when leaving, and Escape takes it back", async ({ page }) => {
  await addColor(page);
  const x = field(page, "位置 X");
  await typeInto(x, "120.5");
  await expect(x).toHaveValue("120.5");

  await x.click();
  await x.fill("999");
  await x.press("Escape");
  await expect(x).toHaveValue("120.5");

  await x.click();
  await x.fill("200");
  await field(page, "位置 Y").click();
  await expect(x).toHaveValue("200");
  await page.keyboard.press("Escape");

  await x.click();
  await x.fill("不是数字");
  await expect(x).toHaveAttribute("aria-invalid", "true");
  await x.press("Enter");
  await expect(x).toHaveValue("200");

  await typeInto(field(page, "不透明度"), "150");
  await expect(field(page, "不透明度")).toHaveValue("100%");
  await typeInto(field(page, "不透明度"), "37.5%");
  await expect(field(page, "不透明度")).toHaveValue("37.5%");
});

test("clicking into a field and out again changes nothing", async ({ page }) => {
  await addColor(page);
  await field(page, "位置 X").click();
  await panel(page).getByRole("spinbutton", { name: "旋转" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(0);
});

test("a field that was left stays left, however late the next frame is", async ({ page }) => {
  await addColor(page);
  await field(page, "位置 X").click();
  const showFrames = await holdFrames(page);
  await panel(page).getByRole("spinbutton", { name: "旋转" }).click();
  await page.keyboard.press("Escape");
  await showFrames();
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(0);
});

test("the diamond adds and removes a key, and the last one leaves a plain value", async ({
  page,
}) => {
  await addColor(page);
  const x = field(page, "位置 X");
  const key = row(page, "位置 X").getByRole("button", { name: "添加关键帧" });
  await typeInto(x, "100");
  await key.click();
  const remove = row(page, "位置 X").getByRole("button", { name: "删除关键帧" });
  await expect(remove).toHaveAttribute("aria-pressed", "true");
  await goTo(page, "0:02/00");
  await expect(key).toHaveAttribute("aria-pressed", "false");
  await typeInto(x, "300");
  await expect(remove).toBeVisible();
  await goTo(page, "0:01/15");
  await expect(x).toHaveValue("200");

  await goTo(page, "0:02/00");
  await remove.click();
  await expect(x).toHaveValue("100");
  await goTo(page, "0:01/00");
  await remove.click();
  await goTo(page, "0:03/00");
  await expect(x).toHaveValue("100");
  await typeInto(x, "7");
  await goTo(page, "0:01/00");
  await expect(x).toHaveValue("7");
});

test("the arrows go from key to key inside the clip", async ({ page }) => {
  await addColor(page);
  const opacity = row(page, "不透明度");
  const previous = opacity.getByRole("button", { name: "上一个关键帧" });
  const next = opacity.getByRole("button", { name: "下一个关键帧" });
  const time = content(page, "preview").locator("output");
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await expect(next).toHaveAttribute("aria-disabled", "true");
  await keyButton(page, "不透明度").click();
  await goTo(page, "0:03/00");
  await keyButton(page, "不透明度").click();
  await goTo(page, "0:02/00");
  await previous.click();
  await expect(time).toHaveText("0:01/00");
  await expect(previous).toHaveAttribute("aria-disabled", "true");
  await next.click();
  await expect(time).toHaveText("0:03/00");
  await expect(next).toHaveAttribute("aria-disabled", "true");
});

test("the size follows the clip until somebody sets it, and resets back to that", async ({
  page,
}) => {
  await addColor(page);
  const width = field(page, "大小 宽");
  await dragField(page, width, -40);
  await page.mouse.up();
  await expect.poll(async () => Number(await width.inputValue())).toBeLessThan(1900);
  await expect.poll(async () => Number(await width.inputValue())).toBeGreaterThan(1800);
  await row(page, "大小 宽").getByRole("button", { name: "恢复默认" }).click();
  await expect(width).toHaveValue("自动");
});

test("the fit is a choice, without keys", async ({ page }) => {
  await placeImage(page);
  const fit = panel(page).getByRole("combobox", { name: "适应方式" });
  await fit.selectOption("cover");
  await expect(fit).toHaveValue("cover");
  await expect(row(page, "适应方式").getByRole("button", { name: /关键帧/ })).toHaveCount(0);
  await expectColor(page, 10, 10, [255, 0, 0]);
  await page.keyboard.press("Control+z");
  await expect(fit).toHaveValue("contain");
  await expectColor(page, 10, 10, BLACK);
});

test("does not let anything change while the playhead is outside of the clip", async ({ page }) => {
  await placeImage(page);
  const x = field(page, "位置 X");
  await goTo(page, "0:07/00");
  await expect(panel(page).getByRole("status")).toContainText("播放头不在这个片段上");
  await expect(x).toHaveAttribute("readonly", "");
  await dragField(page, x, 50);
  await page.mouse.up();
  await x.click();
  await expect(x).toHaveAttribute("readonly", "");
  await expect(x).toHaveValue("0");
  await expect(keyButton(page, "位置 X")).toHaveAttribute("aria-disabled", "true");
  await expect(panel(page).getByRole("combobox", { name: "适应方式" })).toBeDisabled();

  await panel(page).getByRole("button", { name: "跳到片段" }).click();
  await expect(panel(page).getByRole("status")).toHaveCount(0);
  await typeInto(x, "50");
  await expect(x).toHaveValue("50");
});

test("shows the clip of a locked track, and changes nothing", async ({ page }) => {
  await addColor(page);
  await typeInto(field(page, "位置 X"), "50");
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("button", { name: /^锁定/ }).first().click();
  await tab(page, "properties").click();

  // It stays selected through locking, and what it shows is what the clip has.
  await expect(panel(page).getByRole("status")).toContainText("轨道已锁定");
  await expect(field(page, "位置 X")).toHaveValue("50");
  await expect(field(page, "位置 X")).not.toBeEditable();
  await expect(panel(page).getByRole("combobox", { name: "适应方式" })).toBeDisabled();
  await expect(keyButton(page, "位置 X")).toHaveAttribute("aria-disabled", "true");

  // A click on the clip selects it just the same.
  await tab(page, "timeline").click();
  const clip = clips(page).first();
  const box = await clip.boundingBox();
  if (!box) throw new Error("No clip on the screen");
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + box.width + 40, y);
  await expect(clip).toHaveAttribute("aria-selected", "false");
  await page.mouse.click(box.x + box.width / 2, y);
  await expect(clip).toHaveAttribute("aria-selected", "true");
  await tab(page, "properties").click();
  await expect(field(page, "位置 X")).toHaveValue("50");

  // Unlocked again, it can be changed from where it was.
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("button", { name: /^锁定/ }).first().click();
  await tab(page, "properties").click();
  await expect(panel(page).getByRole("status")).toHaveCount(0);
  await typeInto(field(page, "位置 X"), "60");
  await expect(field(page, "位置 X")).toHaveValue("60");
});

test("shows one clip at a time", async ({ page }) => {
  await addColor(page);
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
  await expect(clips(page)).toHaveCount(2);
  await page.keyboard.press("Control+a");
  await tab(page, "properties").click();
  await expect(panel(page)).toContainText("选中了 2 个有画面的片段");
  await expect(panel(page).getByRole("spinbutton")).toHaveCount(0);
});

const gradient = (x: number, y: number, width: number, height: number): Color => [
  Math.round((x / width) * 255),
  Math.round((y / height) * 255),
  (x * 7 + y * 13) % 256,
];

const wide = png(300, 200, (x, y) => gradient(x, y, 300, 200));

interface Square {
  readonly side: number;
  readonly middle: number;
}

/** Messages sent before it listens are gone. */
const compositorListens = (page: Page) =>
  expect
    .poll(async () => {
      const frame = await findCompositor(page);
      return frame?.evaluate(() => document.querySelector("canvas") !== null);
    })
    .toBe(true);

/** What a plan looks like when the compositor gets it, without going through the interface. */
async function showPlan(page: Page, plan: RenderPlan, seconds = 1) {
  const iframe = content(page, "preview").locator("iframe");
  await compositorListens(page);
  await iframe.evaluate(
    (element: HTMLIFrameElement, message) => {
      element.contentWindow?.postMessage({ type: "plan", plan: message.plan }, "*");
      element.contentWindow?.postMessage(
        { type: "seek", seconds: message.seconds, jump: true },
        "*",
      );
    },
    { plan, seconds },
  );
  await expect
    .poll(async () =>
      (await compositor(page)).evaluate(() => document.querySelector("canvas")?.width),
    )
    .toBe(plan.width);
}

async function sendFile(page: Page, id: string, bytes: Buffer) {
  await compositorListens(page);
  await content(page, "preview")
    .locator("iframe")
    .evaluate(
      (element: HTMLIFrameElement, message) => {
        const file = new Blob([new Uint8Array(message.bytes)], { type: "image/png" });
        element.contentWindow?.postMessage({ type: "file", id: message.id, file }, "*");
      },
      { id, bytes: [...bytes] },
    );
}

function projectIn(width: number, height: number) {
  const format = { id: "only", name: "画幅", width, height, fps: "30" };
  const store = ProjectStore.create(createProject({ name: "画幅", format }));
  const timeline = store.getState().timelines["main"];
  const track = timeline && orderedTracks(timeline).find(({ kind }) => kind === "video");
  const add = (clip: object) => {
    const params = { timeline: "main", track: track?.id, clip };
    const result = store.execute({ type: "clip.add", params });
    if (!result.ok) throw new Error(result.error.message);
  };
  const plan = () => {
    const built = buildRenderPlan(store.getState(), "main");
    if (!built) throw new Error("no plan");
    return built;
  };
  return { add, plan };
}

/** How many pixels of a color there are along the lines through the middle of the picture. */
function redAcross(
  frame: Frame,
): Promise<{ wide: number; tall: number; left: number; top: number }> {
  return frame.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) throw new Error("no picture");
    const isRed = (data: Uint8ClampedArray, index: number) =>
      (data[index * 4] ?? 0) > 200 && (data[index * 4 + 1] ?? 255) < 60;
    const count = (data: Uint8ClampedArray, length: number) => {
      let reds = 0;
      let first = -1;
      for (let index = 0; index < length; index += 1) {
        if (isRed(data, index)) {
          reds += 1;
          if (first < 0) first = index;
        }
      }
      return [reds, first] as const;
    };
    const { width, height } = canvas;
    const [wideCount, left] = count(context.getImageData(0, height / 2, width, 1).data, width);
    const [tallCount, top] = count(context.getImageData(width / 2, 0, 1, height).data, height);
    return { wide: wideCount, tall: tallCount, left, top };
  });
}

const SQUARE: readonly (readonly [number, number, Square])[] = [
  [1920, 1080, { side: 200, middle: 960 }],
  [3840, 2160, { side: 400, middle: 1920 }],
  [1080, 1920, { side: 200, middle: 540 }],
];

for (const [width, height, { side }] of SQUARE) {
  test(`a 200 by 200 square is square at ${width}×${height}, and ${side} pixels wide`, async ({
    page,
  }) => {
    const { add, plan } = projectIn(width, height);
    add({
      id: "square",
      start: "0",
      duration: "5",
      source: { kind: "color", color: "#ff0000" },
      properties: { "transform.width": 200, "transform.height": 200 },
    });
    await showPlan(page, plan());
    await expect
      .poll(async () => redAcross(await compositor(page)))
      .toEqual({
        wide: side,
        tall: side,
        left: (width - side) / 2,
        top: (height - side) / 2,
      });
  });
}

/** How far the picture is from what it was before there was a world, in the worst pixel. */
const distanceFromBefore = (frame: Frame, image: string, scaleBy: "min" | "max") =>
  frame.evaluate(
    async ({ base64, scaleOf }) => {
      const canvas = document.querySelector("canvas");
      if (!canvas) throw new Error("no picture");
      const { width: w, height: h } = canvas;
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const reference = new OffscreenCanvas(w, h).getContext("2d", { alpha: false });
      if (!reference) throw new Error("no canvas");
      reference.fillStyle = "#102030";
      reference.fillRect(0, 0, w, h);
      const scale = Math[scaleOf](w / bitmap.width, h / bitmap.height);
      const dw = bitmap.width * scale;
      const dh = bitmap.height * scale;
      reference.drawImage(bitmap, (w - dw) / 2, (h - dh) / 2, dw, dh);
      const a = canvas.getContext("2d")?.getImageData(0, 0, w, h).data ?? [];
      const b = reference.getImageData(0, 0, w, h).data;
      let worst = 0;
      for (let index = 0; index < b.length; index += 1) {
        worst = Math.max(worst, Math.abs((a[index] ?? 0) - (b[index] ?? 0)));
      }
      return worst;
    },
    { base64: image, scaleOf: scaleBy },
  );

for (const fit of ["contain", "cover"] as const) {
  for (const [width, height] of [
    [1920, 1080],
    [1280, 720],
    [1080, 1920],
  ] as const) {
    test(`a clip without transforms looks the way it always did: ${fit} at ${width}×${height}`, async ({
      page,
    }) => {
      await sendFile(page, "wide", wide);
      const units = 1080 / Math.min(width, height);
      const plan: RenderPlan = {
        width,
        height,
        stage: { width: width * units, height: height * units },
        camera: {},
        scenes: { format: "f", language: "zh-CN", fps: { num: 30, den: 1 } },
        background: "#102030",
        layers: [
          {
            id: "a",
            start: 0,
            end: 5,
            offset: 0,
            source: { kind: "image", file: "wide" },
            fit,
            channels: {},
          },
        ],
        joins: [],
      };
      await showPlan(page, plan);
      const image = wide.toString("base64");
      const scaleBy = fit === "cover" ? "max" : "min";
      // The picture has to be decoded first, and until then it is not there at all.
      await expect
        .poll(async () => distanceFromBefore(await compositor(page), image, scaleBy))
        .toBeLessThanOrEqual(2);
    });
  }
}

/**
 * What a phone records upright: stored on its side, with a note to turn it. The left half is red, so
 * once it is turned the top half has to be. Made once with mediabunny in the browser: 320 by 160, VP9
 * in MP4, rotation 90. A file, so that this also runs against the deployed site.
 */
const sideways = {
  name: "竖拍.mp4",
  mimeType: "video/mp4",
  buffer: readFileSync(new URL("./fixtures/sideways.mp4", import.meta.url)),
};

test("a video that a phone recorded upright shows upright", async ({ page }) => {
  await compositorListens(page);
  await placeImage(page, sideways);
  await expectColor(page, 960, 270, [255, 0, 0], 40);
  await expectColor(page, 960, 810, [0, 0, 255], 40);
  // It is 540 wide in a picture of 1920, so there is nothing to the left of that.
  await expectColor(page, 960 - 300, 270, BLACK);
  await expectColor(page, 960 + 300, 810, BLACK);
  await typeInto(field(page, "缩放"), "50");
  await expectColor(page, 960, 400, [255, 0, 0], 40);
  await expectColor(page, 960, 680, [0, 0, 255], 40);
  await expectColor(page, 960, 270 - 30, BLACK);
});

test("turns clockwise around its anchor, and scales from there", async ({ page }) => {
  const { add, plan } = projectIn(1920, 1080);
  add({
    id: "bar",
    start: "0",
    duration: "5",
    source: { kind: "color", color: "#ff0000" },
    properties: {
      "transform.width": 200,
      "transform.height": 40,
      "transform.anchorX": 0,
      "transform.anchorY": 0.5,
      "transform.x": 300,
      "transform.y": -100,
      "transform.rotation": 90,
      "transform.scale": 2,
    },
  });
  await showPlan(page, plan());
  // From 300, -100 it now goes 400 down, and is 80 wide around that line.
  await expectColor(page, 960 + 300, 540 - 100 + 390, [255, 0, 0]);
  await expectColor(page, 960 + 300 + 35, 540 - 100 + 200, [255, 0, 0]);
  await expectColor(page, 960 + 300, 540 - 100 - 10, BLACK);
  await expectColor(page, 960 + 300, 540 - 100 + 410, BLACK);
  await expectColor(page, 960 + 300 + 45, 540 - 100 + 200, BLACK);
});

test("what left the picture is gone, whatever is on top of it", async ({ page }) => {
  const { add, plan } = projectIn(1920, 1080);
  add({ id: "large", start: "0", duration: "2", source: { kind: "color", color: "#ff0000" } });
  add({
    id: "small",
    start: "2",
    duration: "2",
    source: { kind: "color", color: "#00ff00" },
    properties: { "transform.scale": 0.25 },
  });
  // One track has no room for this: the small one lies on top, and stays when the other one goes.
  const [large, small] = plan().layers as [RenderLayer, RenderLayer];
  const seek = (seconds: number) =>
    content(page, "preview")
      .locator("iframe")
      .evaluate((element: HTMLIFrameElement, moment) => {
        element.contentWindow?.postMessage({ type: "seek", seconds: moment, jump: true }, "*");
      }, seconds);
  await showPlan(page, { ...plan(), layers: [large, { ...small, start: 0 }] }, 1);
  await expectColor(page, 20, 20, [255, 0, 0]);
  await expectColor(page, 960, 540, [0, 255, 0]);
  await seek(3);
  await expectColor(page, 960, 540, [0, 255, 0]);
  await expectColor(page, 20, 20, BLACK);
  await expectColor(page, 1900, 1060, BLACK);
});

/** Left half red, right half blue, which shows where the middle of the media ended up. */
const halves = png(200, 100, (x) => (x < 100 ? [255, 0, 0] : [0, 0, 255]));

function imagePlan(fit: RenderLayer["fit"], properties: object): RenderPlan {
  const { add, plan } = projectIn(1920, 1080);
  add({
    id: "c",
    start: "0",
    duration: "5",
    source: { kind: "color", color: "#000000" },
    properties,
  });
  const [layer] = plan().layers as [RenderLayer];
  return { ...plan(), layers: [{ ...layer, fit, source: { kind: "image", file: "halves" } }] };
}

const BLUE: Color = [0, 0, 255];
const RED: Color = [255, 0, 0];

test("fixed is as large as the media, a pixel for a unit", async ({ page }) => {
  await sendFile(page, "halves", halves);
  await showPlan(page, imagePlan("fixed", {}));
  await expectColor(page, 960 - 95, 540, RED);
  await expectColor(page, 960 + 95, 540, BLUE);
  await expectColor(page, 960 - 95, 540 - 45, RED);
  await expectColor(page, 960 - 105, 540, BLACK);
  await expectColor(page, 960 + 105, 540, BLACK);
  await expectColor(page, 960 - 95, 540 - 55, BLACK);
});

test("fixed fills a box whatever its shape, and does not keep the shape of the media", async ({
  page,
}) => {
  await sendFile(page, "halves", halves);
  const size = { "transform.width": 100, "transform.height": 400 };
  await showPlan(page, imagePlan("fixed", size));
  await expectColor(page, 960 - 45, 540 - 195, RED);
  await expectColor(page, 960 + 45, 540 + 195, BLUE);
  await expectColor(page, 960 - 55, 540, BLACK);
  await expectColor(page, 960, 540 + 205, BLACK);
});

test("cover in a small box fills it and leaves out what sticks out", async ({ page }) => {
  await sendFile(page, "halves", halves);
  // A tall box: the media gets as high as the box, and only its middle fits.
  const size = { "transform.width": 100, "transform.height": 300 };
  await showPlan(page, imagePlan("cover", size));
  await expectColor(page, 960 - 45, 540 - 145, RED);
  await expectColor(page, 960 + 45, 540 + 145, BLUE);
  await expectColor(page, 960 - 55, 540, BLACK);
  await expectColor(page, 960 + 55, 540, BLACK);
  await expectColor(page, 960, 540 - 155, BLACK);
  await expectColor(page, 960, 540 + 155, BLACK);
});

test("contain in a small box leaves room around the media", async ({ page }) => {
  await sendFile(page, "halves", halves);
  const size = { "transform.width": 100, "transform.height": 300 };
  await showPlan(page, imagePlan("contain", size));
  await expectColor(page, 960 - 45, 540, RED);
  await expectColor(page, 960 + 45, 540, BLUE);
  await expectColor(page, 960 - 45, 540 - 30, BLACK);
  await expectColor(page, 960 + 45, 540 + 30, BLACK);
});

test("a key that is not on a frame any more can be reached and removed", async ({ page }) => {
  await addColor(page);
  const x = field(page, "位置 X");
  const time = content(page, "preview").locator("output");
  await typeInto(x, "100");
  await goTo(page, "0:00/10");
  await keyButton(page, "位置 X").click();
  await goTo(page, "0:02/00");
  await typeInto(x, "300");
  // 10 frames at 30 is 1/3 of a second, which is between two frames at 25.
  await page.getByRole("contentinfo").getByRole("button", { name: "项目帧率" }).click();
  await page.getByRole("radio", { name: "25", exact: true }).click();
  await goTo(page, "0:01/00");
  await row(page, "位置 X").getByRole("button", { name: "上一个关键帧" }).click();
  await expect(time).toHaveText("0:00/08");
  const remove = row(page, "位置 X").getByRole("button", { name: "删除关键帧" });
  await expect(remove).toHaveAttribute("aria-pressed", "true");
  await typeInto(x, "150");
  await expect(x).toHaveValue("150");
  await row(page, "位置 X").getByRole("button", { name: "下一个关键帧" }).click();
  await row(page, "位置 X").getByRole("button", { name: "上一个关键帧" }).click();
  await expect(x).toHaveValue("150");
  await remove.click();
  await goTo(page, "0:00/00");
  await expect(x).toHaveValue("300");
});

test("pulls a fade out of the corner of a clip, which the properties tab sets, each a step", async ({
  page,
}) => {
  await addColor(page);
  let full: readonly number[] = [];
  await expect.poll(async () => (full = await colorAt(page, 100, 100)).length).toBe(4);
  const [red = 0, green = 0, blue = 0] = full;
  const half: Color = [red / 2, green / 2, blue / 2];

  // The handle at the top left corner of the clip pulls a fade in out of it, as it did fades.
  await tab(page, "timeline").click();
  const clip = clips(page).first();
  const box = await clip.boundingBox();
  if (!box) throw new Error("no clip on screen");
  const top = box.y + 4;
  await page.mouse.move(box.x + 2, top);
  await expect(content(page, "timeline").getByRole("group", { name: "时间轴" })).toHaveCSS(
    "cursor",
    "col-resize",
  );
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, top, { steps: 8 });
  await page.mouse.up();

  // What it made is selected, and the properties tab shows what a transition has, and no more.
  await tab(page, "properties").click();
  const transition = panel(page).getByRole("region", { name: "淡入" });
  await expect(transition).toBeVisible();
  await expect(transition).toContainText("的入转场");
  await expect(panel(page).getByRole("spinbutton")).toHaveCount(0);
  const duration = transition.getByRole("textbox", { name: "时长" });
  // A second into a fade of two seconds, half of the clip shows over black.
  await typeInto(duration, "2");
  await expect(duration).toHaveValue("0:02/00");
  await expectColor(page, 100, 100, half, 3);

  // An ease in starts slowly: at half of its time it is about a third of the way.
  const linear = transition.getByRole("button", { name: "匀速" });
  const easeIn = transition.getByRole("button", { name: "缓入", exact: true });
  await expect(linear).toHaveAttribute("aria-pressed", "true");
  await easeIn.click();
  await expect(easeIn).toHaveAttribute("aria-pressed", "true");
  await expectColor(page, 100, 100, [red * 0.315, green * 0.315, blue * 0.315], 4);
  await page.keyboard.press("Control+z");
  await expect(linear).toHaveAttribute("aria-pressed", "true");
  await expectColor(page, 100, 100, half, 3);

  // A handle of the curve, dragged and let go, is one more step.
  const handle = transition.getByRole("slider", { name: "开始的手柄" });
  const place = await handle.boundingBox();
  if (!place) throw new Error("no handle");
  const curve = await transition.getByRole("group", { name: "速度曲线" }).boundingBox();
  if (!curve) throw new Error("no curve");
  await page.mouse.move(place.x + place.width / 2, place.y + place.height / 2);
  await page.mouse.down();
  await page.mouse.move(curve.x + curve.width * 0.9, curve.y + curve.height * 0.9, { steps: 6 });
  await expect(linear).toHaveAttribute("aria-pressed", "true");
  await page.mouse.up();
  await expect(linear).toHaveAttribute("aria-pressed", "false");
  const slower = await colorAt(page, 100, 100);
  expect((slower[0] ?? 0) + (slower[1] ?? 0) + (slower[2] ?? 0)).toBeLessThan(
    (red + green + blue) / 2,
  );
  await page.keyboard.press("Control+z");
  await expect(linear).toHaveAttribute("aria-pressed", "true");

  // Delete on the timeline takes the transition away, and leaves the clip.
  await tab(page, "timeline").click();
  await content(page, "timeline").getByRole("group", { name: "时间轴" }).focus();
  await page.keyboard.press("Delete");
  await expectColor(page, 100, 100, [red, green, blue], 3);
  await expect(clips(page)).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expectColor(page, 100, 100, half, 3);
});

test("a clip fades in and out, on top of its opacity, as it always did", async ({ page }) => {
  const { add, plan } = projectIn(1920, 1080);
  add({
    id: "fading",
    start: "1",
    duration: "4",
    enter: { type: "fade", duration: "2" },
    exit: { type: "fade", duration: "1" },
    source: { kind: "color", color: "#ff0000" },
    properties: { opacity: 0.5 },
  });
  await showPlan(page, plan(), 2);
  await expectColor(page, 960, 540, [64, 0, 0], 3);
  await content(page, "preview")
    .locator("iframe")
    .evaluate((element: HTMLIFrameElement) => {
      element.contentWindow?.postMessage({ type: "seek", seconds: 4.5, jump: true }, "*");
    });
  await expectColor(page, 960, 540, [64, 0, 0], 3);
});
