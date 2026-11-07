import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { png } from "./property-helpers.ts";
import {
  canCapture,
  chooseFolder,
  content,
  expect,
  goTo,
  openAnyway,
  projectFolder as sceneFolder,
  tab,
  test,
} from "./scene-support.ts";

const WIDTH = 640;
const HEIGHT = 360;
const FORMAT = { id: "small", name: "小屏", width: WIDTH, height: HEIGHT, fps: "30" };

const dialog = (page: Page) => page.getByRole("dialog");
const exportStatus = (page: Page) =>
  page.getByRole("contentinfo").getByRole("status").filter({ hasText: "正在导出视频" });

interface Clip {
  readonly id: string;
  readonly start: string;
  readonly duration: string;
  readonly source: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
}

/** A red square that goes from left to right, so that where it is says which frame it is. */
const movingSquare = (seconds: number, id = "square"): Clip => ({
  id,
  start: "0",
  duration: String(seconds),
  source: { kind: "color", color: "#ff0000" },
  properties: {
    "transform.width": 120,
    "transform.height": 120,
    "transform.x": {
      keys: [
        { time: "0", value: -800 },
        { time: String(seconds), value: 800 },
      ],
    },
  },
});

/** Writes a project to a folder, for what the interface has no quick way of making. */
function projectFolder(
  seconds: number,
  clips: readonly Clip[],
  files: Readonly<Record<string, Buffer>> = {},
  assets: Record<string, unknown> = {},
  sound: readonly { readonly muted?: boolean; readonly clips: readonly Clip[] }[] = [],
): string {
  const project = createProject({ name: "视频项目", format: FORMAT });
  const written = writeProject(project);
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(written.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({
    ...section,
    duration: String(seconds),
  }));
  (timeline.tracks[0] as { clips: unknown[] }).clips = [...clips];
  sound.forEach(({ muted, clips: heard }, index) => {
    const track = { id: `sound${index}`, kind: "audio", clips: heard, ...(muted && { muted }) };
    if (index === 0)
      Object.assign(timeline.tracks[1] as object, { clips: heard, ...(muted && { muted }) });
    else timeline.tracks.push(track as never);
  });
  written.set(path, JSON.stringify(timeline));
  if (Object.keys(assets).length > 0) written.set("assets.json", JSON.stringify({ assets }));
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-video-")), "项目");
  const all: [string, string | Buffer][] = [...written, ...Object.entries(files)];
  for (const [name, text] of all) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/**
 * Where the dialog for saving would put the file: the private folder of the site, because a test
 * cannot operate that dialog. Applies from the next page on.
 */
const installSavePicker = (page: Page) =>
  // For every page, also those after a crash.
  page.context().addInitScript(() => {
    const pick = async ({ suggestedName }: { suggestedName: string }) => {
      Object.assign(window, { savedName: suggestedName });
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle("chosen-video", { create: true });
    };
    Object.assign(window, { showSaveFilePicker: pick });
  });

async function open(page: Page, folder: string): Promise<void> {
  await installSavePicker(page);
  await page.reload();
  await chooseFolder(page, folder);
  await expect(tab(page, "preview")).toBeVisible();
}

/** What is in the file the export wrote, or undefined when there is none. */
const savedFile = (page: Page) =>
  page
    .evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("chosen-video").catch(() => undefined);
      if (!handle) return undefined;
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      let text = "";
      for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      }
      return btoa(text);
    })
    .then((base64) => (base64 === undefined ? undefined : Buffer.from(base64, "base64")));

/** Clicks a clip on the canvas, where the list of clips says it is. */
async function clickClip(page: Page, index: number): Promise<void> {
  await tab(page, "timeline").click();
  const box = await content(page, "timeline").getByRole("option").nth(index).boundingBox();
  if (!box) throw new Error("No clip");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const chooseFrom = async (page: Page, item: string) => {
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
};

/** Starts an export through the menu, with what the dialog offers first unless told otherwise. */
async function startExport(page: Page, choices: Record<string, string> = {}): Promise<void> {
  await chooseFrom(page, "导出视频…");
  await expect(dialog(page)).toContainText("导出视频");
  for (const [label, option] of Object.entries(choices)) {
    await dialog(page).getByLabel(label).selectOption({ label: option });
  }
  await dialog(page).getByRole("button", { name: "导出", exact: true }).click();
}

const exported = (page: Page) =>
  expect(page.getByRole("status").getByText("已导出“")).toBeVisible({ timeout: 60_000 });

interface Facts {
  readonly codec: string | null;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly duration: number;
  readonly keys: number;
  readonly firstIsKey: boolean;
}

/** Reads a file the way a player does: Mediabunny, which wrote it, but nothing of the editor. */
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
    duration: await track.computeDuration(),
    keys: packets.filter(({ type }) => type === "key").length,
    firstIsKey: packets[0]?.type === "key",
  };
}

/** What it takes to decode one frame: everything from the key frame before it. */
async function framePackets(file: Buffer, index: number) {
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video");
  const config = await track.getDecoderConfig();
  if (!config) throw new Error("No decoder config");
  const all = [];
  for await (const packet of new EncodedPacketSink(track).packets()) all.push(packet);
  let from = index;
  while (from > 0 && all[from]?.type !== "key") from -= 1;
  const description = config.description
    ? Buffer.from(config.description as Uint8Array).toString("base64")
    : undefined;
  return {
    config: {
      codec: config.codec,
      codedWidth: config.codedWidth ?? WIDTH,
      codedHeight: config.codedHeight ?? HEIGHT,
    },
    description,
    packets: all.slice(from, index + 1).map((packet) => ({
      data: Buffer.from(packet.data).toString("base64"),
      key: packet.type === "key",
      timestamp: Math.round(packet.timestamp * 1e6),
    })),
  };
}

interface Comparison {
  /** Of the whole picture, against the still, in dB. */
  readonly psnr: number;
  /** Where the middle of what has the color is, in the video and in the still. */
  readonly video: readonly [number, number];
  readonly still: readonly [number, number];
}

/** Decodes a frame of the file in the page and compares it with a still of the same moment. */
async function compare(
  page: Page,
  file: Buffer,
  index: number,
  still: Buffer,
  color: readonly number[] = [255, 0, 0],
) {
  const packets = await framePackets(file, index);
  return page.evaluate(
    async ({
      packets: { config, description, packets: chunks },
      still: stillBase64,
      color: target,
    }) => {
      const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const frames: VideoFrame[] = [];
      const decoder = new VideoDecoder({
        output: (frame) => frames.push(frame),
        error: (error) => {
          throw error;
        },
      });
      decoder.configure(
        description === undefined ? config : { ...config, description: bytes(description) },
      );
      for (const { data, key, timestamp } of chunks) {
        decoder.decode(
          new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: bytes(data) }),
        );
      }
      await decoder.flush();
      const last = frames.at(-1);
      if (!last) throw new Error("Nothing decoded");
      const rgbaOf = async (source: CanvasImageSource, width: number, height: number) => {
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
        const frame = new VideoFrame(canvas, { timestamp: 0 });
        const pixels = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
        await frame.copyTo(pixels, { format: "RGBA" });
        frame.close();
        return pixels;
      };
      const { displayWidth: width, displayHeight: height } = last;
      const video = await rgbaOf(last, width, height);
      for (const frame of frames) frame.close();
      const image = await createImageBitmap(new Blob([bytes(stillBase64)]));
      const picture = await rgbaOf(image, width, height);
      let squares = 0;
      for (let at = 0; at < video.length; at += 4) {
        if (at % 4 === 3) continue;
        for (let part = 0; part < 3; part += 1) {
          const difference = (video[at + part] ?? 0) - (picture[at + part] ?? 0);
          squares += difference * difference;
        }
      }
      const mse = squares / (width * height * 3);
      const middleOfRed = (pixels: Uint8Array): [number, number] => {
        let x = 0;
        let y = 0;
        let count = 0;
        for (let at = 0; at < pixels.length; at += 4) {
          const [red = 0, green = 0, blue = 0] = pixels.subarray(at, at + 3);
          const [r = 0, g = 0, b = 0] = target;
          if (Math.abs(red - r) < 100 && Math.abs(green - g) < 100 && Math.abs(blue - b) < 100) {
            x += (at / 4) % width;
            y += Math.floor(at / 4 / width);
            count += 1;
          }
        }
        return count === 0 ? [-1, -1] : [x / count, y / count];
      };
      return {
        psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
        video: middleOfRed(video),
        still: middleOfRed(picture),
      };
    },
    { packets, still: still.toString("base64"), color },
  ) as Promise<Comparison>;
}

/** A still of the frame at the playhead, through the menu. */
async function stillAt(page: Page, time: string): Promise<Buffer> {
  await goTo(page, time);
  const download = page.waitForEvent("download");
  await chooseFrom(page, "导出当前帧");
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test.use({ withProject: false });

test.describe("a video", () => {
  test("has the frames, the size and the length of the timeline", async ({ page }) => {
    await open(page, projectFolder(2, [movingSquare(2)]));
    await startExport(page);
    await exported(page);
    const file = await savedFile(page);
    if (!file) throw new Error("No file");
    const facts = await factsOf(file);
    expect(facts).toMatchObject({ width: WIDTH, height: HEIGHT, frames: 60, firstIsKey: true });
    expect(facts.codec).toBe("avc");
    expect(facts.duration).toBeCloseTo(2, 2);
    // One every two seconds.
    expect(facts.keys).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { savedName: string }).savedName)).toBe(
      "视频项目-小屏.mp4",
    );
  });

  test("shows what a still of the same moment shows", async ({ page }) => {
    await open(page, projectFolder(2, [movingSquare(2)]));
    await startExport(page);
    await exported(page);
    const file = (await savedFile(page)) as Buffer;
    for (const [index, time] of [
      [0, "0:00/00"],
      [29, "0:00/29"],
      [59, "0:01/29"],
    ] as const) {
      const still = await stillAt(page, time);
      const { psnr, video, still: expected } = await compare(page, file, index, still);
      console.log(`frame ${index}: ${psnr.toFixed(1)} dB, ${video} / ${expected}`);
      expect(psnr).toBeGreaterThan(35);
      expect(Math.abs(video[0] - expected[0])).toBeLessThan(1.5);
      expect(Math.abs(video[1] - expected[1])).toBeLessThan(1.5);
    }
  });

  test("of a part of the timeline is that part", async ({ page }) => {
    await open(
      page,
      projectFolder(4, [movingSquare(1, "first"), { ...movingSquare(1, "second"), start: "2" }]),
    );
    await clickClip(page, 1);
    await startExport(page, { 范围: "选中的片段（0:02/00 到 0:03/00）" });
    await exported(page);
    const facts = await factsOf((await savedFile(page)) as Buffer);
    expect(facts.frames).toBe(30);
  });

  test("goes to the downloads where there is no dialog for saving", async ({ page }) => {
    await chooseFolder(page, projectFolder(1, [movingSquare(1)]));
    await expect(tab(page, "preview")).toBeVisible();
    await page.evaluate(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const download = page.waitForEvent("download", { timeout: 60_000 });
    await startExport(page);
    const stream = await (await download).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect((await factsOf(Buffer.concat(chunks))).frames).toBe(30);
    await expect(page.getByRole("status").getByText("在浏览器的下载里")).toBeVisible();
  });

  test("is WebM with VP9 where H.264 cannot be encoded, and says so first", async ({ page }) => {
    await page.addInitScript(() => {
      const { isConfigSupported } = VideoEncoder;
      VideoEncoder.isConfigSupported = (config) =>
        config.codec.startsWith("avc")
          ? Promise.resolve({ supported: false, config })
          : isConfigSupported.call(VideoEncoder, config);
    });
    await open(page, projectFolder(1, [movingSquare(1)]));
    await chooseFrom(page, "导出视频…");
    await expect(dialog(page)).toContainText("改用 VP9，存成 WebM");
    await dialog(page).getByRole("button", { name: "导出", exact: true }).click();
    await exported(page);
    const facts = await factsOf((await savedFile(page)) as Buffer);
    expect(facts.codec).toBe("vp9");
    expect(facts.frames).toBe(30);
  });
});

test.describe("an export under way", () => {
  test("can be stopped, and then there is no file", async ({ page }) => {
    await open(page, projectFolder(60, [movingSquare(60)]));
    await startExport(page);
    await expect(exportStatus(page)).toBeVisible();
    await expect.poll(async () => (await savedFile(page)) !== undefined).toBe(true);
    await page.getByRole("button", { name: "取消导出" }).click();
    await expect(page.getByRole("status").getByText("视频导出已取消，没有留下文件")).toBeVisible();
    await expect(exportStatus(page)).toHaveCount(0);
    expect(await savedFile(page)).toBeUndefined();
  });

  test("leaves the preview and the project to people, and takes what was there", async ({
    page,
  }) => {
    await open(page, projectFolder(20, [movingSquare(20)]));
    await startExport(page);
    await expect(exportStatus(page)).toBeVisible();
    // The square goes, while the export goes on.
    await clickClip(page, 0);
    await page.keyboard.press("Delete");
    await expect(content(page, "timeline").getByRole("option")).toHaveCount(0);
    await goTo(page, "0:10/00");
    await exported(page);
    const file = (await savedFile(page)) as Buffer;
    expect((await factsOf(file)).frames).toBe(600);
    // It is still there, in the video.
    await page.keyboard.press("Control+z");
    await expect(content(page, "timeline").getByRole("option")).toHaveCount(1);
    const still = await stillAt(page, "0:10/00");
    const { psnr } = await compare(page, file, 300, still);
    expect(psnr).toBeGreaterThan(35);
  });

  test("stops where a file is missing, and goes there", async ({ page }) => {
    const square = png(64, 64, () => [0, 0, 255]);
    await open(
      page,
      projectFolder(
        3,
        [
          movingSquare(1),
          {
            id: "picture",
            start: "1",
            duration: "2",
            source: { kind: "image", media: { asset: "blue" } },
          },
        ],
        { "assets/blue.png": square },
        { blue: { name: "蓝色", kind: "image", path: "assets/blue.png", storage: "git" } },
      ),
    );
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("animaquill");
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
      const transaction = database.transaction("media", "readwrite");
      transaction.objectStore("media").clear();
      await new Promise((resolve) => transaction.addEventListener("complete", resolve));
      database.close();
    });
    await startExport(page);
    await expect(dialog(page)).toContainText("视频没有导出", { timeout: 60_000 });
    await expect(dialog(page)).toContainText("第 31 帧（0:01/00）");
    await expect(dialog(page)).toContainText("“蓝色”的素材文件不在这台设备上");
    await dialog(page).getByRole("button", { name: "关闭" }).click();
    await expect(
      page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }),
    ).toContainText("0:01/00");
    await expect(content(page, "timeline").getByRole("option", { selected: true })).toHaveCount(1);
    expect(await savedFile(page)).toBeUndefined();
  });
});

test.describe("a long export", () => {
  test("takes no more memory the longer it goes", async ({ page }) => {
    test.setTimeout(240_000);
    const seconds = 60;
    // Noise does not compress, so the file grows as fast as the bitrate lets it.
    const noise = png(WIDTH, HEIGHT, () => [
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
    ]);
    const picture: Clip = {
      id: "noise",
      start: "0",
      duration: String(seconds),
      source: { kind: "image", media: { asset: "noise" } },
      properties: {
        "transform.x": {
          keys: [
            { time: "0", value: -400 },
            { time: String(seconds), value: 400 },
          ],
        },
      },
    };
    const tone = {
      id: "tone",
      start: "0",
      duration: String(seconds),
      source: { kind: "audio", media: { asset: "tone" } },
    };
    await open(
      page,
      projectFolder(
        seconds,
        [picture],
        { "assets/noise.png": noise, "assets/tone.wav": tones([{ hz: 440, seconds }]) },
        {
          noise: { name: "噪点", kind: "image", path: "assets/noise.png", storage: "git" },
          tone: { name: "测试音", kind: "audio", path: "assets/tone.wav", storage: "git" },
        },
        [{ clips: [tone] }],
      ),
    );
    const editor = await page.context().newCDPSession(page);
    const heapOf = async (session: typeof editor) => {
      await session.send("HeapProfiler.collectGarbage");
      // Bytes of files and frames are outside of the heap of objects, in what backs them.
      const { usedSize, embedderHeapUsedSize, backingStorageSize } =
        await session.send("Runtime.getHeapUsage");
      return usedSize + embedderHeapUsedSize + backingStorageSize;
    };
    const percent = async () => {
      const text =
        (await exportStatus(page)
          .textContent()
          .catch(() => "")) ?? "";
      return Number(/(\d+)%/u.exec(text)?.[1] ?? -1);
    };
    await startExport(page, { 码率: "较高" });
    await expect(exportStatus(page)).toBeVisible();
    const shown = await (
      await content(page, "preview").locator("iframe").elementHandle()
    )?.contentFrame();
    // In the window of the export, which is a page of its own here.
    const exporting = page
      .context()
      .pages()
      .flatMap((each) => each.frames())
      .find((frame) => frame.url().includes("compositor.html") && frame !== shown);
    if (!exporting) throw new Error("No compositor");
    const box = await page.context().newCDPSession(exporting);
    await expect.poll(percent, { timeout: 120_000 }).toBeGreaterThanOrEqual(15);
    const early = { editor: await heapOf(editor), compositor: await heapOf(box) };
    await expect.poll(percent, { timeout: 200_000 }).toBeGreaterThanOrEqual(90);
    const late = { editor: await heapOf(editor), compositor: await heapOf(box) };
    await exported(page);
    const file = (await savedFile(page)) as Buffer;
    const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    console.log(
      `memory at 15%: editor ${megabytes(early.editor)} MB, compositor ${megabytes(early.compositor)} MB; ` +
        `at 90%: editor ${megabytes(late.editor)} MB, compositor ${megabytes(late.compositor)} MB; ` +
        `file ${megabytes(file.byteLength)} MB`,
    );
    expect((await factsOf(file)).frames).toBe(seconds * 30);
    const sound = await soundOf(page, file);
    expect(sound?.duration).toBeGreaterThan(seconds - 0.001);
    // The file grows by three quarters of its size in between, and memory does not go with it.
    expect(file.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    expect(late.editor - early.editor).toBeLessThan(4 * 1024 * 1024);
    expect(late.compositor - early.compositor).toBeLessThan(4 * 1024 * 1024);
  });
});

/** A white square on black that goes from left to right, at 192 world units a second. */
const SLIDE = `<!doctype html><style>
  body { background: #000 }
  #square { position: absolute; left: 0; top: 490px; width: 100px; height: 100px; background: #fff;
    animation: slide 10s linear both }
  @keyframes slide { to { transform: translateX(1920px) } }
</style><div id="square"></div>`;

test.describe("a video with a scene", () => {
  test.skip(!canCapture, "needs a browser that can capture");

  test("has each frame of the scene, as a still of it has", async ({ page }) => {
    await installSavePicker(page);
    await page.reload();
    const folder = sceneFolder({ a: { "index.html": SLIDE } }, [{ duration: "2" }], FORMAT);
    await chooseFolder(page, folder);
    await openAnyway(page);
    await expect(tab(page, "preview")).toBeVisible();
    // The timeline is longer than the clip, which is all there is to see.
    await clickClip(page, 0);
    await startExport(page, { 范围: "选中的片段（0:00/00 到 0:02/00）" });
    await exported(page);
    const file = (await savedFile(page)) as Buffer;
    const facts = await factsOf(file);
    expect(facts.width).toBe(WIDTH);
    for (const [index, time] of [
      [15, "0:00/15"],
      [45, "0:01/15"],
    ] as const) {
      const still = await stillAt(page, time);
      const {
        psnr,
        video,
        still: expected,
      } = await compare(page, file, index, still, [255, 255, 255]);
      console.log(`scene frame ${index}: ${psnr.toFixed(1)} dB, ${video} / ${expected}`);
      expect(psnr).toBeGreaterThan(35);
      expect(Math.abs(video[0] - expected[0])).toBeLessThan(1.5);
    }
  });
});

/** A WAV file of sine tones, one after the other, mono at 48 kHz. */
function tones(parts: readonly { readonly hz: number; readonly seconds: number }[], level = 0.5) {
  const rate = 48_000;
  const total = parts.reduce((all, { seconds }) => all + Math.round(seconds * rate), 0);
  const data = Buffer.alloc(total * 2);
  let at = 0;
  for (const { hz, seconds } of parts) {
    const count = Math.round(seconds * rate);
    for (let index = 0; index < count; index += 1) {
      const value = Math.sin((2 * Math.PI * hz * index) / rate) * level;
      data.writeInt16LE(Math.round(value * 32767), (at + index) * 2);
    }
    at += count;
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The sound of a file, decoded in the page, as samples of its first channel from time zero. */
async function soundOf(page: Page, file: Buffer) {
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) return undefined;
  const config = await track.getDecoderConfig();
  if (!config) throw new Error("No decoder config");
  const packets = [];
  for await (const packet of new EncodedPacketSink(track).packets()) {
    packets.push({
      data: Buffer.from(packet.data).toString("base64"),
      timestamp: Math.round(packet.timestamp * 1e6),
    });
  }
  const description = config.description
    ? Buffer.from(config.description as Uint8Array).toString("base64")
    : undefined;
  const decoded = await page.evaluate(
    async ({
      config: { codec, sampleRate, numberOfChannels },
      description: head,
      packets: all,
    }) => {
      const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const pieces: { timestamp: number; samples: Float32Array }[] = [];
      const decoder = new AudioDecoder({
        output: (data) => {
          const samples = new Float32Array(data.numberOfFrames);
          data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
          pieces.push({ timestamp: data.timestamp, samples });
          data.close();
        },
        error: (error) => {
          throw error;
        },
      });
      decoder.configure({
        codec,
        sampleRate,
        numberOfChannels,
        ...(head === undefined ? {} : { description: bytes(head) }),
      });
      for (const { data, timestamp } of all) {
        decoder.decode(new EncodedAudioChunk({ type: "key", timestamp, data: bytes(data) }));
      }
      await decoder.flush();
      const end = pieces.reduce(
        (last, { timestamp, samples }) =>
          Math.max(last, Math.round((timestamp * sampleRate) / 1e6) + samples.length),
        0,
      );
      const joined = new Float32Array(end);
      for (const { timestamp, samples } of pieces) {
        joined.set(samples, Math.max(Math.round((timestamp * sampleRate) / 1e6), 0));
      }
      let text = "";
      const raw = new Uint8Array(joined.buffer);
      for (let at = 0; at < raw.length; at += 0x8000) {
        text += String.fromCharCode(...raw.subarray(at, at + 0x8000));
      }
      return { rate: sampleRate, samples: btoa(text) };
    },
    {
      config: {
        codec: config.codec,
        sampleRate: config.sampleRate,
        numberOfChannels: config.numberOfChannels,
      },
      description,
      packets,
    },
  );
  const raw = Buffer.from(decoded.samples, "base64");
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return {
    codec: track.codec,
    duration: await track.computeDuration(),
    rate: decoded.rate,
    samples,
  };
}

/** What a stretch of sound measures, in seconds of it. */
function measure(samples: Float32Array, rate: number, from: number, to: number) {
  const part = samples.subarray(Math.round(from * rate), Math.round(to * rate));
  let squares = 0;
  let crossings = 0;
  for (let index = 0; index < part.length; index += 1) {
    const value = part[index] ?? 0;
    squares += value * value;
    if (index > 0 && (part[index - 1] ?? 0) < 0 && value >= 0) crossings += 1;
  }
  return { rms: Math.sqrt(squares / Math.max(part.length, 1)), hz: crossings / (to - from) };
}

/** Where something can first and last be heard, in seconds. */
function audible(samples: Float32Array, rate: number, threshold = 0.05) {
  let first = -1;
  let last = -1;
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index] ?? 0) > threshold) {
      if (first < 0) first = index;
      last = index;
    }
  }
  return { first: first / rate, last: last / rate };
}

const decibels = (ratio: number) => 20 * Math.log10(ratio);

test.describe("the sound of a video", () => {
  test("is the mix: in its place, from its offset, at its volume, without muted tracks", async ({
    page,
  }) => {
    const wanted = {
      id: "tone",
      start: "1",
      duration: "2",
      offset: "0.5",
      source: { kind: "audio", media: { asset: "tone" } },
      properties: { "audio.volume": -6 },
    };
    const muted = {
      id: "high",
      start: "0",
      duration: "4",
      source: { kind: "audio", media: { asset: "high" } },
    };
    await open(
      page,
      projectFolder(
        4,
        [movingSquare(4)],
        {
          // The first half second is another tone, which an offset of half a second leaves out.
          "assets/tone.wav": tones([
            { hz: 220, seconds: 0.5 },
            { hz: 440, seconds: 3 },
          ]),
          "assets/high.wav": tones([{ hz: 1000, seconds: 4 }], 0.9),
        },
        {
          tone: { name: "测试音", kind: "audio", path: "assets/tone.wav", storage: "git" },
          high: { name: "高音", kind: "audio", path: "assets/high.wav", storage: "git" },
        },
        [{ clips: [wanted] }, { muted: true, clips: [muted] }],
      ),
    );
    await chooseFrom(page, "导出视频…");
    const notes = (await dialog(page).textContent()) ?? "";
    const opus = notes.includes("声音改用 Opus，仍然存成 MP4");
    expect(opus || notes.includes("声音用 AAC 编码")).toBe(true);
    await dialog(page).getByRole("button", { name: "导出", exact: true }).click();
    await exported(page);
    const file = (await savedFile(page)) as Buffer;
    const video = await factsOf(file);
    const sound = await soundOf(page, file);
    if (!sound) throw new Error("No sound");
    expect(sound.codec).toBe(opus ? "opus" : "aac");
    const { rate, samples } = sound;
    const heard = audible(samples, rate);
    const tone = measure(samples, rate, 1.2, 2.8);
    const before = measure(samples, rate, 0, 0.95);
    const after = measure(samples, rate, 3.05, 3.9);
    console.log(
      `sound ${sound.codec}: ${sound.duration.toFixed(3)} s against ${video.duration.toFixed(3)} s, ` +
        `heard ${heard.first.toFixed(4)} to ${heard.last.toFixed(4)} s, ${tone.hz.toFixed(1)} Hz, ` +
        `${decibels(tone.rms).toFixed(2)} dBFS, before ${decibels(before.rms).toFixed(1)}, after ${decibels(after.rms).toFixed(1)}`,
    );
    // One frame of the codec at most: Opus has 20 ms, AAC 21.
    expect(Math.abs(sound.duration - video.duration)).toBeLessThan(0.025);
    // Its place, to a few milliseconds: the window of 1 ms that is loud enough, and codec delay.
    expect(Math.abs(heard.first - 1)).toBeLessThan(0.01);
    expect(Math.abs(heard.last - 3)).toBeLessThan(0.01);
    // From its offset: what is heard is the second tone.
    expect(Math.abs(tone.hz - 440)).toBeLessThan(2);
    // At its volume: half of 0.5, as a sine, is −15.0 dBFS. A codec at 192 kbit/s keeps that.
    const expected = decibels((0.5 * 10 ** (-6 / 20)) / Math.SQRT2);
    expect(Math.abs(decibels(tone.rms) - expected)).toBeLessThan(0.5);
    // Nothing of the muted track, which is louder and higher.
    expect(decibels(before.rms)).toBeLessThan(-60);
    expect(decibels(after.rms)).toBeLessThan(-60);
  });
});

/** What the window of the export says, or null while there is none. */
const windowText = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { documentPictureInPicture?: { window: Window | null } })
        .documentPictureInPicture?.window?.document.body.innerText ?? null,
  );

const closeWindow = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { documentPictureInPicture?: { window: Window | null } }
    ).documentPictureInPicture?.window?.close(),
  );

/** The frames of compositors in this page, which do not include those in a window of its own. */
const compositorsHere = (page: Page) =>
  page.frames().filter((frame) => frame.url().includes("compositor.html")).length;

const percentOf = async (page: Page) => {
  // Whether it goes on or waits.
  const status = page
    .getByRole("contentinfo")
    .getByRole("status")
    .filter({ hasText: /导出.*%/u });
  const text = (await status.textContent({ timeout: 1000 }).catch(() => "")) ?? "";
  return Number(/(\d+)%/u.exec(text)?.[1] ?? -1);
};

test.describe("the window of an export", () => {
  test("is where it runs, and says how far it is", async ({ page }) => {
    await open(page, projectFolder(10, [movingSquare(10)]));
    const started = Date.now();
    await startExport(page);
    await expect.poll(() => windowText(page)).toContain("第 ");
    expect(await windowText(page)).toContain("关掉这个小窗会暂停导出");
    expect(compositorsHere(page)).toBe(1);
    await exported(page);
    console.log(
      `in a window: ${(300 / ((Date.now() - started) / 1000)).toFixed(1)} frames a second`,
    );
    await expect.poll(() => windowText(page)).toBeNull();
    expect((await factsOf((await savedFile(page)) as Buffer)).frames).toBe(300);
  });

  test("pauses when it is closed, keeps what was written, and goes on in a new one", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await open(page, projectFolder(10, [movingSquare(10)]));
    await startExport(page);
    await expect.poll(() => percentOf(page)).toBeGreaterThanOrEqual(20);
    await closeWindow(page);
    await expect(page.getByRole("contentinfo")).toContainText("视频导出已暂停");
    await expect(page.getByRole("status").getByText("导出的小窗关掉了")).toBeVisible();
    const paused = await percentOf(page);
    await page.waitForTimeout(500);
    expect(await percentOf(page)).toBe(paused);
    await page.getByRole("contentinfo").getByRole("button", { name: "继续导出" }).click();
    await expect.poll(() => windowText(page)).toContain("第 ");
    await exported(page);
    const file = (await savedFile(page)) as Buffer;
    const facts = await factsOf(file);
    expect(facts.frames).toBe(300);
    expect(facts.duration).toBeCloseTo(10, 2);
    // A frame on each side of where it went on, and the last one, as the stills have them.
    for (const [index, time] of [
      [Math.floor((paused / 100) * 300) - 5, ""],
      [Math.floor((paused / 100) * 300) + 20, ""],
      [299, "0:09/29"],
    ] as const) {
      const at =
        time ||
        `0:${String(Math.floor(index / 30)).padStart(2, "0")}/${String(index % 30).padStart(2, "0")}`;
      const still = await stillAt(page, at);
      const { psnr, video, still: expected } = await compare(page, file, index, still);
      console.log(`after a pause, frame ${index}: ${psnr.toFixed(1)} dB, ${video} / ${expected}`);
      expect(psnr).toBeGreaterThan(35);
      expect(Math.abs(video[0] - expected[0])).toBeLessThan(1.5);
    }
  });

  test("can be stopped from the window, and then there is no file", async ({ page }) => {
    await open(page, projectFolder(30, [movingSquare(30)]));
    await startExport(page);
    await expect.poll(() => windowText(page)).toContain("第 ");
    await page.evaluate(() =>
      (
        window as unknown as { documentPictureInPicture: { window: Window } }
      ).documentPictureInPicture.window.document
        .querySelector("button")
        ?.click(),
    );
    await expect(page.getByRole("status").getByText("视频导出已取消，没有留下文件")).toBeVisible();
    await expect.poll(() => windowText(page)).toBeNull();
    expect(await savedFile(page)).toBeUndefined();
  });

  test("takes another press when the dialog for saving took the first", async ({ page }) => {
    await open(page, projectFolder(2, [movingSquare(2)]));
    // A real dialog for saving takes the press that opened it, and a window needs one too. The
    // dialog here is no real one, so the press is taken away for it.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "userActivation", {
        configurable: true,
        value: { isActive: false, hasBeenActive: true },
      });
    });
    await startExport(page);
    await expect(dialog(page)).toContainText("在小窗里导出？");
    expect(await windowText(page)).toBeNull();
    await dialog(page).getByRole("button", { name: "开小窗导出" }).click();
    await expect.poll(() => windowText(page)).toContain("第 ");
    await exported(page);
    expect((await factsOf((await savedFile(page)) as Buffer)).frames).toBe(60);
  });

  test("is not there without the browser having them, which says to stay in front", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture;
    });
    await open(page, projectFolder(10, [movingSquare(10)]));
    await chooseFrom(page, "导出视频…");
    await expect(dialog(page)).toContainText("这个浏览器不能开小窗");
    const started = Date.now();
    await dialog(page).getByRole("button", { name: "导出", exact: true }).click();
    await expect(exportStatus(page)).toBeVisible();
    await expect.poll(() => compositorsHere(page)).toBe(2);
    await exported(page);
    console.log(
      `in the page: ${(300 / ((Date.now() - started) / 1000)).toFixed(1)} frames a second`,
    );
    expect((await factsOf((await savedFile(page)) as Buffer)).frames).toBe(300);
  });
});

/** What exports keep for after a reload, as it is in the browser. */
const keptExports = (page: Page) =>
  page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("animaquill-exports");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    if (!database.objectStoreNames.contains("exports")) return { exports: 0, pieces: 0 };
    const transaction = database.transaction(["exports", "pieces"]);
    const count = (name: string) =>
      new Promise<number>((resolve) => {
        const request = transaction.objectStore(name).count();
        request.addEventListener("success", () => resolve(request.result));
      });
    const found = { exports: await count("exports"), pieces: await count("pieces") };
    database.close();
    return found;
  });

const offer = (page: Page) => dialog(page).filter({ hasText: "有一个没完成的导出" });

test.describe("an export after a reload", () => {
  /** Forty seconds, which has places to go on from every ten, stopped somewhere after twenty. */
  async function stopHalfway(page: Page, how: "reload" | "crash"): Promise<Page> {
    await open(page, projectFolder(40, [movingSquare(40)]));
    await startExport(page);
    await expect.poll(() => percentOf(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(55);
    if (how === "reload") {
      // The page asks first, which people would answer.
      const asked = page.waitForEvent("dialog");
      page.once("dialog", (question) => void question.accept());
      await page.reload();
      expect((await asked).type()).toBe("beforeunload");
      return page;
    }
    // A crash says nothing first.
    const address = page.url();
    const next = await page.context().newPage();
    await page.close({ runBeforeUnload: false });
    await next.goto(address);
    return next;
  }

  test("goes on where it was, and the file is as one made in one go", async ({ page }) => {
    test.setTimeout(120_000);
    const again = await stopHalfway(page, "reload");
    await expect(offer(again)).toContainText("导到了第 600 / 1200 帧");
    await offer(again).getByRole("button", { name: "继续导出" }).click();
    // It goes on from twenty seconds, not from the start.
    await expect.poll(() => percentOf(again)).toBeGreaterThanOrEqual(50);
    await exported(again);
    const file = (await savedFile(again)) as Buffer;
    const facts = await factsOf(file);
    expect(facts.frames).toBe(1200);
    expect(facts.duration).toBeCloseTo(40, 2);
    expect(await keptExports(again)).toEqual({ exports: 0, pieces: 0 });
    for (const [index, time] of [
      [299, "0:09/29"],
      [599, "0:19/29"],
      [600, "0:20/00"],
      [1199, "0:39/29"],
    ] as const) {
      const still = await stillAt(again, time);
      const { psnr, video, still: expected } = await compare(again, file, index, still);
      console.log(`after a reload, frame ${index}: ${psnr.toFixed(1)} dB, ${video} / ${expected}`);
      expect(psnr).toBeGreaterThan(35);
      expect(Math.abs(video[0] - expected[0])).toBeLessThan(1.5);
    }
  });

  test("goes on after a crash too", async ({ page }) => {
    test.setTimeout(120_000);
    const again = await stopHalfway(page, "crash");
    await offer(again).getByRole("button", { name: "继续导出" }).click();
    await exported(again);
    expect((await factsOf((await savedFile(again)) as Buffer)).frames).toBe(1200);
  });

  test("starts over with a project that changed since, when people say so", async ({ page }) => {
    test.setTimeout(120_000);
    const again = await stopHalfway(page, "crash");
    await offer(again).getByRole("button", { name: "取消" }).click();
    await again.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await again
      .getByRole("menu")
      .getByRole("menuitem", { name: "重命名项目", exact: true })
      .click();
    await again.getByRole("textbox").fill("改过的项目");
    await again.keyboard.press("Enter");
    await expect(again.getByRole("contentinfo")).toContainText("已保存");
    await again.reload();
    await offer(again).getByRole("button", { name: "继续导出" }).click();
    await expect(dialog(again)).toContainText("项目在这次导出之后改过了");
    await dialog(again).getByRole("button", { name: "用现在的内容重新导出" }).click();
    await expect.poll(() => percentOf(again)).toBeLessThan(40);
    await exported(again);
    expect((await factsOf((await savedFile(again)) as Buffer)).frames).toBe(1200);
  });

  test("goes somewhere else when the file is gone", async ({ page }) => {
    test.setTimeout(120_000);
    const again = await stopHalfway(page, "crash");
    await again.evaluate(async () => {
      await (await navigator.storage.getDirectory()).removeEntry("chosen-video");
    });
    await offer(again).getByRole("button", { name: "继续导出" }).click();
    await expect(dialog(again)).toContainText("不在了");
    await dialog(again).getByRole("button", { name: "另选位置" }).click();
    await exported(again);
    expect((await factsOf((await savedFile(again)) as Buffer)).frames).toBe(1200);
  });

  test("starts over when the encoder now encodes another way, and says so", async ({ page }) => {
    test.setTimeout(120_000);
    const again = await stopHalfway(page, "crash");
    await offer(again).getByRole("button", { name: "取消" }).click();
    // As on another computer, or after an update: what the encoder said about decoding differs.
    await again.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open("animaquill-exports");
        request.addEventListener("success", () => resolve(request.result));
      });
      const transaction = database.transaction("exports", "readwrite");
      const store = transaction.objectStore("exports");
      const all = store.getAll();
      all.addEventListener("success", () => {
        for (const saved of all.result) {
          saved.state.progress.decoderConfig.description = new Uint8Array([1, 2, 3]);
          store.put(saved);
        }
      });
      await new Promise((resolve) => transaction.addEventListener("complete", resolve));
      database.close();
    });
    await again.reload();
    await offer(again).getByRole("button", { name: "继续导出" }).click();
    await expect(again.getByRole("status").getByText("视频从头重新导出")).toBeVisible();
    await exported(again);
    const file = (await savedFile(again)) as Buffer;
    expect((await factsOf(file)).frames).toBe(1200);
    const still = await stillAt(again, "0:30/00");
    expect((await compare(again, file, 900, still)).psnr).toBeGreaterThan(35);
  });

  test("can be given up, and leaves nothing", async ({ page }) => {
    test.setTimeout(120_000);
    const again = await stopHalfway(page, "crash");
    await offer(again).getByRole("button", { name: "放弃" }).click();
    await expect(again.getByRole("status").getByText("没完成的导出已经放弃")).toBeVisible();
    expect(await keptExports(again)).toEqual({ exports: 0, pieces: 0 });
    expect(await savedFile(again)).toBeUndefined();
  });
});

test.describe("a scene that keeps its own state, after a crash", () => {
  test.skip(!canCapture, "needs a browser that can capture");

  test("goes through its frames again up to where the export goes on", async ({ page }) => {
    test.setTimeout(120_000);
    // Where the square is depends on every frame the code went through, and on nothing else.
    const counting = `<!doctype html><style>
      body { background: #000 }
      #square { position: absolute; left: 0; top: 490px; width: 100px; height: 100px; background: #fff }
    </style><div id="square"></div><script>
      let x = 0;
      requestAnimationFrame(function step() {
        x += 4;
        document.getElementById("square").style.left = x + "px";
        requestAnimationFrame(step);
      });
    </script>`;
    await installSavePicker(page);
    await page.reload();
    await chooseFolder(
      page,
      sceneFolder({ a: { "index.html": counting } }, [{ duration: "20" }], FORMAT),
    );
    await openAnyway(page);
    await clickClip(page, 0);
    await startExport(page, { 范围: "选中的片段（0:00/00 到 0:20/00）" });
    await expect.poll(() => percentOf(page), { timeout: 60_000 }).toBeGreaterThanOrEqual(60);
    const address = page.url();
    const again = await page.context().newPage();
    await page.close({ runBeforeUnload: false });
    await again.goto(address);
    await offer(again).getByRole("button", { name: "继续导出" }).click();
    await expect.poll(() => percentOf(again)).toBeGreaterThanOrEqual(50);
    await exported(again);
    const file = (await savedFile(again)) as Buffer;
    expect((await factsOf(file)).frames).toBe(600);
    for (const [index, time] of [
      [299, "0:09/29"],
      [300, "0:10/00"],
      [450, "0:15/00"],
    ] as const) {
      const still = await stillAt(again, time);
      const found = await compare(again, file, index, still, [255, 255, 255]);
      console.log(
        `stateful after a crash, frame ${index}: ${found.psnr.toFixed(1)} dB, ${found.video} / ${found.still}`,
      );
      expect(found.psnr).toBeGreaterThan(35);
      expect(found.video[0]).toBeGreaterThan(0);
      expect(Math.abs(found.video[0] - found.still[0])).toBeLessThan(1.5);
    }
  });
});
