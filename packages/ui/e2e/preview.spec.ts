import { readFileSync } from "node:fs";
import type { Frame, Page } from "@playwright/test";
import {
  compositor,
  content,
  expect,
  findCompositor,
  group,
  resourcesIn,
  tab,
  test,
} from "./support.ts";

const video = {
  name: "红色.webm",
  mimeType: "video/webm",
  buffer: readFileSync(new URL("./fixtures/red.webm", import.meta.url)),
};

const items = (page: Page) => resourcesIn(page, "assets");

/** The colour in the middle of the picture. */
async function middle(page: Page): Promise<readonly number[]> {
  const frame = await findCompositor(page);
  if (!frame) return [];
  return frame.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const data = canvas
      ?.getContext("2d")
      ?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
    return data ? [...data] : [];
  });
}

const isRed = async (page: Page) => {
  const [red = 0, green = 255, blue = 255] = await middle(page);
  return red > 200 && green < 60 && blue < 60;
};

async function putVideoOnTimeline(page: Page) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(video);
  await items(page).first().dblclick();
}

test("shows the frame of a video at the playhead", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
});

test("goes dark when the clip is gone, and comes back with undo", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
  await page.keyboard.press("Control+z");
  await expect.poll(() => isRed(page)).toBe(false);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => isRed(page)).toBe(true);
});

test("shows the same picture after a reload", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
  await page.reload();
  await expect.poll(() => isRed(page)).toBe(true);
});

test("the picture runs in a sandbox without access to the editor", async ({ page }) => {
  const frame = content(page, "preview").locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
});

test("clicking the picture leaves the keyboard with the editor", async ({ page }) => {
  await putVideoOnTimeline(page);
  await expect.poll(() => isRed(page)).toBe(true);
  await content(page, "preview").locator("iframe").click({ force: true });
  await page.keyboard.press("Control+z");
  await expect.poll(() => isRed(page)).toBe(false);
});

const redBlue = {
  name: "红蓝.webm",
  mimeType: "video/webm",
  buffer: readFileSync(new URL("./fixtures/red-blue.webm", import.meta.url)),
};

/** Eight bits of silence is still sound to the browser, which is all this needs. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(44 + samples);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate, 28);
  data.writeUInt16LE(1, 32);
  data.writeUInt16LE(8, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples, 40);
  data.fill(128, 44);
  return data;
}

const isBlue = async (page: Page) => {
  const [red = 255, green = 255, blue = 0] = await middle(page);
  return red < 60 && green < 60 && blue > 200;
};

async function importAndPlace(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(file);
  await items(page).first().dblclick();
}

const button = (page: Page, name: string) =>
  content(page, "preview").getByRole("button", { name, exact: true });

async function goTo(page: Page, time: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

test("finds frames going forwards and backwards in a video", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect.poll(() => isRed(page)).toBe(true);
  await goTo(page, "0:01/15");
  await expect.poll(() => isBlue(page)).toBe(true);
  await goTo(page, "0:00/05");
  await expect.poll(() => isRed(page)).toBe(true);
});

/** Sends the compositor jumps from the editor's side, faster than any hand. */
const jumpTo = (page: Page, places: readonly number[]) =>
  content(page, "preview")
    .locator("iframe")
    .evaluate((element: HTMLIFrameElement, seconds) => {
      for (const place of seconds) {
        element.contentWindow?.postMessage({ type: "seek", seconds: place, jump: true }, "*");
      }
    }, places);

/** Frames come late: the first after `first` milliseconds, each next `each` after the one before. */
const slowDecoder = (frame: Frame, first: number, each: number) =>
  frame.evaluate(
    ([firstMs = 0, eachMs = 0]) => {
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const { VideoDecoder: Real } = window;
      window.VideoDecoder = class extends Real {
        line: Promise<unknown> = pause(firstMs);

        constructor(init: VideoDecoderInit) {
          super({
            ...init,
            output: (decoded) => {
              this.line = this.line
                .then(() => pause(eachMs))
                .then(() => {
                  if (this.state === "closed") decoded.close();
                  else init.output(decoded);
                });
            },
          });
        }

        override async flush() {
          await super.flush();
          await this.line;
        }
      };
    },
    [first, each],
  );

test("a jump gets past a decode that is still going to the last place", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect(items(page).first().locator("canvas")).toBeVisible();
  await goTo(page, "0:01/15");
  await expect.poll(() => isBlue(page)).toBe(true);
  const frame = await compositor(page);
  // From now on the decoder takes forever, like a 4K video feels. Only leaving can help.
  await frame.evaluate(() => {
    const { VideoDecoder: Real } = window;
    const state = window as unknown as { realDecoder: typeof Real; stalled: number };
    state.realDecoder = Real;
    state.stalled = 0;
    window.VideoDecoder = class extends Real {
      constructor(init: VideoDecoderInit) {
        super({ ...init, output: (decoded) => decoded.close() });
        state.stalled += 1;
      }

      override flush() {
        return new Promise<void>(() => {});
      }
    };
  });
  const stalled = () => frame.evaluate(() => (window as unknown as { stalled: number }).stalled);
  await goTo(page, "0:01/10");
  await expect.poll(stalled).toBe(1);
  await goTo(page, "0:00/05");
  await expect.poll(stalled).toBe(2);
  // A frame given up leaves no trace: the old picture stays until the new one is whole.
  expect(await isBlue(page)).toBe(true);
  await frame.evaluate(() => {
    const state = window as unknown as { realDecoder: typeof VideoDecoder };
    window.VideoDecoder = state.realDecoder;
  });
  await goTo(page, "0:00/03");
  await expect.poll(() => isRed(page)).toBe(true);
});

test("after many quick jumps the picture is from the last place", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect.poll(() => isRed(page)).toBe(true);
  await jumpTo(page, [1.5, 0.1, 1.6, 0.2, 1.7]);
  await expect.poll(() => isBlue(page)).toBe(true);
  await jumpTo(page, [0.1, 1.5, 0.2, 1.6, 0.3]);
  await expect.poll(() => isRed(page)).toBe(true);
  await page.waitForTimeout(300);
  expect(await isRed(page)).toBe(true);
});

test("the picture keeps up while dragging backwards over a slow decoder", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect(items(page).first().locator("canvas")).toBeVisible();
  await goTo(page, "0:01/25");
  await expect.poll(() => isBlue(page)).toBe(true);
  const frame = await compositor(page);
  await slowDecoder(frame, 100, 0);
  await frame.evaluate(() => {
    const state = window as unknown as { pictures: number };
    state.pictures = 0;
    const { prototype } = CanvasRenderingContext2D;
    prototype.drawImage = new Proxy(prototype.drawImage, {
      apply(draw, context, args) {
        state.pictures += 1;
        Reflect.apply(draw, context, args);
      },
    });
  });
  // Each move comes sooner than a decode can finish, like a hand on the playhead.
  await content(page, "preview")
    .locator("iframe")
    .evaluate(async (element: HTMLIFrameElement) => {
      for (let seconds = 1.8; seconds > 0; seconds -= 0.03) {
        element.contentWindow?.postMessage({ type: "seek", seconds, jump: true }, "*");
        // oxlint-disable-next-line no-await-in-loop -- the moves take their time
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
  const pictures = await frame.evaluate(() => (window as unknown as { pictures: number }).pictures);
  expect(pictures).toBeGreaterThanOrEqual(3);
  await expect.poll(() => isRed(page)).toBe(true);
});

test("jumping leaves no decoded frame open", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect(items(page).first().locator("canvas")).toBeVisible();
  await expect.poll(() => isRed(page)).toBe(true);
  const frame = await compositor(page);
  await frame.evaluate(() => {
    const state = window as unknown as { openFrames: number };
    state.openFrames = 0;
    const { VideoDecoder: Real, VideoFrame: Frame } = window;
    const { close } = Frame.prototype;
    Frame.prototype.close = function counted() {
      state.openFrames -= 1;
      close.call(this);
    };
    window.VideoDecoder = class extends Real {
      constructor(init: VideoDecoderInit) {
        super({
          ...init,
          output: (decoded) => {
            state.openFrames += 1;
            init.output(decoded);
          },
        });
      }
    };
  });
  await slowDecoder(frame, 0, 20);
  for (let round = 0; round < 10; round += 1) {
    // The first walks forwards and is still under way when the second leaves it for good.
    // oxlint-disable-next-line no-await-in-loop -- each round has to overtake the one before
    await jumpTo(page, [1.5, 0.1]);
    // oxlint-disable-next-line no-await-in-loop -- see above
    await page.waitForTimeout(400);
  }
  await jumpTo(page, [0.1]);
  await expect.poll(() => isRed(page)).toBe(true);
  // With the clip gone nothing holds a frame any more. Those from before counting make this below 0.
  await page.keyboard.press("Control+z");
  await expect.poll(() => isRed(page)).toBe(false);
  await expect
    .poll(() => frame.evaluate(() => (window as unknown as { openFrames: number }).openFrames))
    .toBeLessThanOrEqual(0);
});

test("time going on while playing is not a jump, and moving the playhead is", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await expect.poll(() => isRed(page)).toBe(true);
  await (
    await compositor(page)
  ).evaluate(() => {
    const state = window as unknown as { seeks: boolean[] };
    state.seeks = [];
    addEventListener("message", ({ data }: MessageEvent<{ type: string; jump: boolean }>) => {
      if (data.type === "seek") state.seeks.push(data.jump);
    });
  });
  const seeks = async () =>
    (await compositor(page)).evaluate(() => (window as unknown as { seeks: boolean[] }).seeks);
  await button(page, "播放").click();
  await expect.poll(async () => (await seeks()).length).toBeGreaterThan(10);
  await button(page, "暂停").click();
  // The first step of playing has nothing to compare with. It is short either way.
  expect((await seeks()).filter(Boolean).length).toBeLessThanOrEqual(1);
  await goTo(page, "0:00/05");
  await expect.poll(async () => (await seeks()).at(-1)).toBe(true);
});

/**
 * Looks at the picture on every refresh of the page, and remembers. Polling from outside waits
 * longer and longer between looks, and blue only lasts about a second.
 */
const watchForBlue = (frame: Frame) =>
  frame.evaluate(() => {
    const state = window as unknown as { sawBlue: boolean };
    state.sawBlue = false;
    const look = () => {
      const canvas = document.querySelector("canvas");
      const [red = 255, green = 255, blue = 0] =
        canvas?.getContext("2d")?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data ??
        [];
      if (red < 60 && green < 60 && blue > 200) state.sawBlue = true;
      else requestAnimationFrame(look);
    };
    look();
  });

test("the picture changes while playing", async ({ page }) => {
  await importAndPlace(page, redBlue);
  // Playing skips frames it has no time for. On a busy machine that can be all the blue of one
  // clip, so there are three to go through. A picture that never changes still fails.
  await items(page).first().dblclick();
  await items(page).first().dblclick();
  await expect(content(page, "timeline").getByRole("option")).toHaveCount(3);
  await expect.poll(() => isRed(page)).toBe(true);
  const frame = await compositor(page);
  await watchForBlue(frame);
  await button(page, "播放").click();
  await expect
    .poll(() => frame.evaluate(() => (window as unknown as { sawBlue: boolean }).sawBlue), {
      timeout: 15_000,
    })
    .toBe(true);
});

test("plays sound, and stops when paused", async ({ page }) => {
  await page.addInitScript(() => {
    const { start } = AudioBufferSourceNode.prototype;
    const counter = window as unknown as { sounds: number };
    counter.sounds = 0;
    AudioBufferSourceNode.prototype.start = function count(...args) {
      counter.sounds += 1;
      start.apply(this, args);
    };
  });
  await page.reload();
  await importAndPlace(page, { name: "配音.wav", mimeType: "audio/wav", buffer: wav(10) });
  const sounds = () => page.evaluate(() => (window as unknown as { sounds: number }).sounds);
  await button(page, "播放").click();
  await expect.poll(sounds).toBeGreaterThan(0);
  await button(page, "暂停").click();
  await page.waitForTimeout(300);
  const stopped = await sounds();
  await page.waitForTimeout(500);
  expect(await sounds()).toBe(stopped);
});

test("a video shows its frames on the clip and in the list, also after a reload", async ({
  page,
}) => {
  await importAndPlace(page, redBlue);
  const clip = content(page, "timeline").getByRole("option").first();
  await expect(clip).toBeVisible();
  const canvas = content(page, "timeline").locator("canvas");
  /** How much red and how much blue there is at both ends of the clip. */
  const ends = async () => {
    const box = await clip.boundingBox();
    const area = await canvas.boundingBox();
    if (!box || !area) return false;
    return canvas.evaluate(
      (element: HTMLCanvasElement, { left, right, y }) => {
        const ratio = element.width / element.clientWidth;
        const context = element.getContext("2d");
        const at = (x: number) => context?.getImageData(x * ratio, y * ratio, 1, 1).data ?? [];
        const [leftRed = 0, , leftBlue = 0] = at(left);
        const [rightRed = 0, , rightBlue = 0] = at(right);
        return leftRed > leftBlue + 60 && rightBlue > rightRed + 60;
      },
      {
        left: box.x - area.x + 12,
        right: box.x - area.x + box.width - 12,
        y: box.y - area.y + box.height - 8,
      },
    );
  };
  await expect.poll(ends).toBe(true);
  await expect(items(page).first().locator("canvas")).toBeVisible();
  await page.reload();
  await expect(clip).toBeVisible();
  await expect.poll(ends).toBe(true);
});

test("frames appear with the preview tab closed", async ({ page }) => {
  await tab(page, "preview").click({ button: "middle" });
  await expect(tab(page, "preview")).toHaveCount(0);
  await importAndPlace(page, redBlue);
  await expect(items(page).first().locator("canvas")).toBeVisible();
});

test("the status bar says how many frames the preview really shows", async ({ page }) => {
  await importAndPlace(page, redBlue);
  await items(page).first().dblclick();
  await items(page).first().dblclick();
  await expect(content(page, "timeline").getByRole("option")).toHaveCount(3);
  const status = page.getByRole("contentinfo").getByLabel(/^预览画质和帧率/);
  await expect(status).toHaveText("预览 完整");
  await button(page, "播放").click();
  // A number only comes from frames that reached the canvas, so a preview that draws nothing shows 0.
  await expect(status).toHaveText(/^预览 完整 · [1-9]\d* 帧$/, { timeout: 5000 });
  await status.hover();
  await expect(
    page.getByText(/最近 1 秒实际画出 \d+ 帧，项目帧率 30 帧，丢了 \d+ 帧。点击修改画质。$/),
  ).toBeVisible();
  await button(page, "暂停").click();
  await expect(status).toHaveText("预览 完整");
  // Without a preview there is nothing to count.
  await group(page, "preview").locator('button[aria-label="关闭 预览"]').click();
  await expect(tab(page, "preview")).toHaveCount(0);
  await expect(status).toHaveCount(0);
});

test.describe("the quality of the preview", () => {
  const canvasSize = async (page: Page) =>
    (await compositor(page)).evaluate(() => {
      const canvas = document.querySelector("canvas");
      const room = canvas?.getBoundingClientRect();
      return {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        // How large it is on the screen, which takes the picture at full quality.
        shown: Math.round(Math.min(room?.width ?? 0, ((room?.height ?? 0) * 16) / 9)),
      };
    });

  async function choose(page: Page, name: string) {
    await content(page, "preview").getByRole("button", { name: "预览画质" }).click();
    await page.getByRole("radio", { name: new RegExp(`^${name}`) }).click();
  }

  test("draws on fewer pixels, says so, and stays that way after a reload", async ({ page }) => {
    await putVideoOnTimeline(page);
    await expect.poll(() => isRed(page)).toBe(true);
    const full = await canvasSize(page);
    expect(full).toMatchObject({ width: 1920, height: 1080 });
    const status = page.getByRole("contentinfo").getByLabel(/^预览画质和帧率/);
    await expect(status).toHaveText("预览 完整");

    await choose(page, "1/2");
    await expect.poll(() => canvasSize(page)).toEqual({ ...full, width: 960, height: 540 });
    await expect.poll(() => isRed(page)).toBe(true);
    await expect(status).toHaveText("预览 1/2");
    await status.hover();
    await expect(page.getByText(/现在画 960×540，导出始终是全分辨率 1920×1080/)).toBeVisible();
    await expect(content(page, "preview").getByRole("button", { name: "预览画质" })).toHaveText(
      "画质 1/2",
    );

    await page.reload();
    await expect.poll(() => isRed(page)).toBe(true);
    expect(await canvasSize(page)).toEqual({ ...full, width: 960, height: 540 });
    await expect(status).toHaveText("预览 1/2");

    // The status bar opens the same choices.
    await status.click();
    await page
      .getByRole("dialog", { name: "预览画质" })
      .getByRole("radio", { name: /^全分辨率/ })
      .click();
    await expect.poll(() => canvasSize(page)).toEqual(full);
    await expect(status).toHaveText("预览 完整");
  });

  test.describe("left to the editor", () => {
    test.use({ quality: "auto" });

    test("is automatic, and says that decoding videos does not get any faster", async ({
      page,
    }) => {
      // Short: what automatic stands for right now is in the status bar.
      const opener = content(page, "preview").getByRole("button", { name: "预览画质" });
      await expect(opener).toHaveText("画质 自动");
      await expect(page.getByRole("contentinfo").getByLabel(/^预览画质和帧率/)).toHaveText(
        "预览 自动 完整",
      );
      await opener.click();
      await expect(page.getByText(/视频解码的还是原片/)).toBeVisible();
      await expect(page.getByRole("radio", { name: /^自动（现在 全分辨率）/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  });
});
