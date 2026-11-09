/**
 * Proxies of large videos in a project folder, the way people meet them: made by themselves in the
 * folder of the project, what the preview decodes unless its quality is full, at the same frame as
 * the video, never what an export gets, made again when people take them away, stopped when people
 * say so, and nothing that a reload halfway leaves is ever taken for one. The project is a folder
 * on the real disk that gets dropped in, see `folder-support.ts`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { PROXY_FOLDER, partOf, proxyName } from "../src/proxy/spec.ts";
import { dialog, footer } from "./folder-support.ts";
import { BITS, encodeIn, kindIn, openProject, projectWith, stateIn } from "./proxy-support.ts";
import { content, expect, findCompositor, needsDevPage, tab, test } from "./support.ts";

test.use({
  folders: true,
  withProject: false,
  // What people have: proxies are for every quality but the full one.
  quality: "auto",
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});
test.setTimeout(180_000);

const FORMAT = { id: "small", name: "小屏", width: 320, height: 180, fps: "30" };
/** Half of the project, at its rate: the video is larger and faster. */
const SPEC = { width: 160, height: 90, fps: { num: 30, den: 1 } };
const VIDEO = { width: 640, height: 360, fps: 60 };

/** A project folder with a video of numbered frames, larger and faster than the project. */
const numbered = async (page: Page) =>
  projectWith(await encodeIn(page, VIDEO, 180), { seconds: 3, format: FORMAT, shape: VIDEO });

/** What the compositor shows: which frame, by its bars, and whether a stand-in is what it decodes. */
async function shown(page: Page) {
  const frame = await findCompositor(page);
  if (!frame) return { index: -1, standIns: "?", green: false };
  return frame.evaluate((bits) => {
    const canvas = document.querySelector("canvas");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return { index: -1, standIns: "?", green: false };
    let index = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      const x = Math.floor(((bit + 0.5) * canvas.width) / bits);
      const [red = 0] = context.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data;
      if (red > 128) index |= 1 << bit;
    }
    const [r = 0, g = 0, b = 0] = context.getImageData(
      canvas.width / 2,
      canvas.height / 2,
      1,
      1,
    ).data;
    return {
      index,
      standIns: document.documentElement.dataset["standIns"] ?? "0",
      green: g > 150 && r < 100 && b < 100,
    };
  }, BITS);
}

async function goTo(page: Page, time: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

async function quality(page: Page, name: string) {
  await content(page, "preview").getByRole("button", { name: "预览画质" }).click();
  await page.getByRole("radio", { name: new RegExp(`^${name}`) }).click();
}

interface Facts {
  readonly codec: string | null;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly keys: number;
  readonly duration: number;
}

/** Reads a file the way a player does, with nothing of the editor. */
async function factsOf(file: Buffer): Promise<Facts> {
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video");
  const packets = [];
  for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
  return {
    codec: track.codec,
    width: track.displayWidth,
    height: track.displayHeight,
    frames: packets.length,
    keys: packets.filter(({ type }) => type === "key").length,
    duration: await track.computeDuration(),
  };
}

const proxyPath = (disk: string, hash: string) => join(disk, PROXY_FOLDER, proxyName(hash, SPEC));
const inFolder = (disk: string) =>
  existsSync(join(disk, PROXY_FOLDER)) ? readdirSync(join(disk, PROXY_FOLDER)).toSorted() : [];

test.describe("the proxy of a large video", () => {
  test.beforeEach(({ devPage }) => {
    test.skip(!devPage, needsDevPage("window.aqProxies"));
  });

  test("is made in the project folder, and the preview decodes it at the same frames", async ({
    page,
  }) => {
    const { disk, hash } = await numbered(page);
    await openProject(page, disk);
    await expect.poll(() => kindIn(page, hash), { timeout: 60_000 }).toBe("ready");
    const facts = await factsOf(readFileSync(proxyPath(disk, hash)));
    expect(facts).toMatchObject({ codec: "avc", width: 160, height: 90 });
    // Every other frame of the video, at 30 a second, and the one at the moment it ends.
    expect(facts.frames).toBe(91);
    // One every half a second.
    expect(facts.keys).toBe(7);
    expect(facts.duration).toBeCloseTo(91 / 30, 2);
    expect(inFolder(disk)).toEqual([proxyName(hash, SPEC)]);
    expect(readFileSync(join(disk, ".animaquill/.gitignore"), "utf8")).toBe("*\n");
    // The preview decodes it now, and shows the frame the video shows at each moment.
    await expect.poll(async () => (await shown(page)).standIns).toBe("1");
    for (const [time, index] of [
      ["0:01/15", 90],
      ["0:02/07", 134],
      ["0:00/01", 2],
    ] as const) {
      await goTo(page, time);
      await expect.poll(async () => (await shown(page)).index).toBe(index);
    }
    await tab(page, "assets").click();
    await expect(content(page, "assets").getByText("代理", { exact: true })).toBeVisible();
  });

  test("gives way to the video at full quality, at the same frame, and comes back", async ({
    page,
  }) => {
    const { disk, hash } = await numbered(page);
    await openProject(page, disk);
    await expect.poll(() => kindIn(page, hash), { timeout: 60_000 }).toBe("ready");
    await goTo(page, "0:01/15");
    await expect.poll(() => shown(page)).toEqual({ index: 90, standIns: "1", green: false });
    await quality(page, "全分辨率");
    await expect.poll(() => shown(page)).toEqual({ index: 90, standIns: "0", green: false });
    await quality(page, "1/2");
    await expect.poll(() => shown(page)).toEqual({ index: 90, standIns: "1", green: false });
    await goTo(page, "0:02/07");
    await expect.poll(async () => (await shown(page)).index).toBe(134);
    await quality(page, "全分辨率");
    await expect.poll(() => shown(page)).toEqual({ index: 134, standIns: "0", green: false });
  });

  test("never goes to an export, which has the video itself", async ({ page }) => {
    // Where the dialog for saving would put the file: the private folder of the site.
    await page.context().addInitScript(() => {
      const pick = async () =>
        (await navigator.storage.getDirectory()).getFileHandle("chosen-video", { create: true });
      Object.assign(window, { showSaveFilePicker: pick });
    });
    await page.reload();
    const { disk, hash } = await numbered(page);
    // A proxy of another colour, so that it shows where it is used.
    const green = await encodeIn(page, { width: 160, height: 90, fps: 30 }, 91, {
      look: { colour: "#00ff00" },
    });
    mkdirSync(join(disk, PROXY_FOLDER), { recursive: true });
    writeFileSync(proxyPath(disk, hash), green);
    await openProject(page, disk);
    await expect.poll(() => kindIn(page, hash)).toBe("ready");
    await goTo(page, "0:01/15");
    await expect.poll(async () => (await shown(page)).green).toBe(true);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "导出视频…", exact: true }).click();
    await dialog(page).getByRole("button", { name: "导出", exact: true }).click();
    await expect(page.getByRole("status").getByText("已导出“")).toBeVisible({ timeout: 60_000 });
    const exported = await page.evaluate(async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle("chosen-video");
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      let text = "";
      for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      }
      return btoa(text);
    });
    // The frame at one and a half seconds, decoded as a player would: the video, never the proxy.
    const pixels = await decodedFrame(page, Buffer.from(exported, "base64"), 45);
    expect(pixels.green).toBe(false);
    expect(pixels.index).toBe(90);
    // And the preview goes on with the proxy.
    expect((await shown(page)).green).toBe(true);
  });

  test("is made again when people take it away, and the preview has the video meanwhile", async ({
    page,
  }) => {
    await page.goto("/?proxyFrameMs=40");
    const { disk, hash } = await numbered(page);
    await openProject(page, disk);
    await expect.poll(() => kindIn(page, hash), { timeout: 60_000 }).toBe("ready");
    await expect.poll(async () => (await shown(page)).standIns).toBe("1");
    rmSync(join(disk, ".animaquill"), { recursive: true });
    // People come back to the window from their files.
    await page.evaluate(() => dispatchEvent(new Event("focus")));
    await expect.poll(() => kindIn(page, hash)).toBe("making");
    await expect.poll(async () => (await shown(page)).standIns).toBe("0");
    await expect.poll(() => kindIn(page, hash), { timeout: 60_000 }).toBe("ready");
    expect((await factsOf(readFileSync(proxyPath(disk, hash)))).frames).toBe(91);
    expect(readFileSync(join(disk, ".animaquill/.gitignore"), "utf8")).toBe("*\n");
    await expect.poll(async () => (await shown(page)).standIns).toBe("1");
  });

  test("can be stopped, leaves nothing, and is made when people ask", async ({ page }) => {
    await page.goto("/?proxyFrameMs=60");
    const { disk, hash } = await numbered(page);
    await openProject(page, disk);
    const status = page
      .getByRole("contentinfo")
      .getByRole("status")
      .filter({ hasText: "代理文件" });
    await expect(status).toContainText("正在生成代理文件", { timeout: 30_000 });
    await page.getByRole("contentinfo").getByRole("button", { name: "停止生成代理文件" }).click();
    await expect.poll(() => kindIn(page, hash)).toBe("stopped");
    await expect(status).toHaveCount(0);
    await expect.poll(() => inFolder(disk)).toEqual([]);
    expect((await shown(page)).standIns).toBe("0");
    await tab(page, "assets").click();
    await content(page, "assets").getByRole("listitem").filter({ hasText: "数字.mp4" }).click({
      button: "right",
    });
    await page.getByRole("menuitem", { name: "生成代理文件" }).click();
    await expect.poll(() => kindIn(page, hash), { timeout: 60_000 }).toBe("ready");
    expect(inFolder(disk)).toEqual([proxyName(hash, SPEC)]);
  });

  test("is never what a reload halfway, or a file that is no proxy, leaves", async ({ page }) => {
    await page.goto("/?proxyFrameMs=60");
    const { disk, hash } = await numbered(page);
    const name = proxyName(hash, SPEC);
    // Something at its name that is no proxy, as half of one would be.
    mkdirSync(join(disk, PROXY_FOLDER), { recursive: true });
    writeFileSync(proxyPath(disk, hash), Buffer.alloc(4096, 7));
    // What people put there themselves stays as it is.
    const theirs = {
      ".animaquill/.gitignore": "自己的规则\n",
      [`${PROXY_FOLDER}/笔记.txt`]: "笔记",
    };
    for (const [path, text] of Object.entries(theirs)) writeFileSync(join(disk, path), text);
    await openProject(page, disk);
    await expect
      .poll(async () => (await stateIn(page, hash)).percent ?? 0, { timeout: 30_000 })
      .toBeGreaterThan(20);
    // On its way it has a name of its own, and the preview has the video.
    expect(inFolder(disk)).not.toContain(name);
    expect(inFolder(disk)).toContain(partOf(name));
    expect((await shown(page)).standIns).toBe("0");
    // The page goes away in the middle of it, and comes back.
    await page.reload();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    // Whatever is at its name from now on is a whole proxy.
    const seen: number[] = [];
    await expect
      .poll(
        async () => {
          if (existsSync(proxyPath(disk, hash))) {
            const facts = await factsOf(readFileSync(proxyPath(disk, hash))).catch(() => undefined);
            seen.push(facts?.frames ?? -1);
          }
          return kindIn(page, hash);
        },
        { timeout: 60_000 },
      )
      .toBe("ready");
    seen.push((await factsOf(readFileSync(proxyPath(disk, hash)))).frames);
    expect(new Set(seen)).toEqual(new Set([91]));
    expect(inFolder(disk)).toEqual([name, "笔记.txt"].toSorted());
    for (const [path, text] of Object.entries(theirs)) {
      expect(readFileSync(join(disk, path), "utf8")).toBe(text);
    }
    await expect.poll(async () => (await shown(page)).standIns).toBe("1");
  });
});

/** The frame at an index of a video file, decoded in the page: which one it shows, and its colour. */
async function decodedFrame(page: Page, file: Buffer, index: number) {
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video");
  const config = await track.getDecoderConfig();
  if (!config) throw new Error("No decoder config");
  const all = [];
  for await (const packet of new EncodedPacketSink(track).packets()) all.push(packet);
  let from = index;
  while (from > 0 && all[from]?.type !== "key") from -= 1;
  const chunks = all.slice(from, index + 1).map(({ data, type, timestamp }) => ({
    data: Buffer.from(data).toString("base64"),
    key: type === "key",
    timestamp: Math.round(timestamp * 1e6),
  }));
  const description = config.description
    ? Buffer.from(config.description as Uint8Array).toString("base64")
    : undefined;
  const rest = {
    codec: config.codec,
    codedWidth: config.codedWidth,
    codedHeight: config.codedHeight,
  };
  return page.evaluate(
    async ({ config: plain, description: head, chunks: packets, bits }) => {
      const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const frames: VideoFrame[] = [];
      const decoder = new VideoDecoder({ output: (frame) => frames.push(frame), error: () => {} });
      decoder.configure(head === undefined ? plain : { ...plain, description: bytes(head) });
      for (const { data, key, timestamp } of packets) {
        decoder.decode(
          new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: bytes(data) }),
        );
      }
      await decoder.flush();
      const last = frames.at(-1);
      if (!last) return { index: -1, green: false };
      const canvas = new OffscreenCanvas(last.displayWidth, last.displayHeight);
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      context.drawImage(last, 0, 0);
      for (const frame of frames) frame.close();
      let shownIndex = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        const x = Math.floor(((bit + 0.5) * canvas.width) / bits);
        const [red = 0] = context.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data;
        if (red > 128) shownIndex |= 1 << bit;
      }
      const [r = 0, g = 0, b = 0] = context.getImageData(
        canvas.width / 2,
        canvas.height / 2,
        1,
        1,
      ).data;
      return { index: shownIndex, green: g > 150 && r < 100 && b < 100 };
    },
    { config: rest as VideoDecoderConfig, description, chunks, bits: BITS },
  );
}
