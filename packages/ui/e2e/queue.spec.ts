import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from "mediabunny";
import { chooseFolder, expect, tab, test } from "./scene-support.ts";

const WIDE = { id: "small", name: "小屏", width: 640, height: 360, fps: "30" };
const TALL = { id: "tall", name: "竖屏", width: 360, height: 640, fps: "30" };

const dialog = (page: Page) => page.getByRole("dialog");
const footer = (page: Page) => page.getByRole("contentinfo");
const list = (page: Page) => page.getByRole("list", { name: "导出列表" });
const row = (page: Page, name: string) => list(page).getByRole("listitem", { name });

/** A red square going from left to right, in a project with a wide and a tall format. */
function projectFolder(seconds: number): string {
  const created = createProject({ name: "队列项目", format: WIDE });
  const project = { ...created, manifest: { ...created.manifest, formats: [WIDE, TALL] } };
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
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    {
      id: "square",
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
    },
  ];
  written.set(path, JSON.stringify(timeline));
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-queue-")), "项目");
  for (const [name, text] of written) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/**
 * The dialog for saving puts each file in the private folder of the site under the name it
 * suggests, because a test cannot operate that dialog. Writing a file fails as long as
 * `failWrites` says so, as a full disk would. For every page, also those after a reload.
 */
const installSavePicker = (page: Page) =>
  page.context().addInitScript(() => {
    const known = window as unknown as { failWrites?: number };
    const pick = async ({ suggestedName }: { suggestedName: string }) => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(suggestedName, { create: true });
    };
    Object.assign(window, { showSaveFilePicker: pick });
    const { createWritable } = FileSystemFileHandle.prototype;
    FileSystemFileHandle.prototype.createWritable = function (options) {
      if ((known.failWrites ?? 0) > 0) {
        known.failWrites = (known.failWrites ?? 0) - 1;
        return Promise.reject(new Error("磁盘满了"));
      }
      return createWritable.call(this, options);
    };
  });

async function open(page: Page, folder: string): Promise<void> {
  await installSavePicker(page);
  await page.reload();
  await chooseFolder(page, folder);
  await expect(tab(page, "preview")).toBeVisible();
}

/** What is in a file an export wrote. */
const savedFile = (page: Page, name: string) =>
  page
    .evaluate(async (file) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(file).catch(() => undefined);
      if (!handle) return undefined;
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      let text = "";
      for (let at = 0; at < bytes.length; at += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      }
      return btoa(text);
    }, name)
    .then((base64) => (base64 === undefined ? Buffer.alloc(0) : Buffer.from(base64, "base64")));

/** Reads a file the way a player does. */
async function factsOf(file: Buffer) {
  const input = new Input({ source: new BufferSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video");
  const packets = [];
  for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
  return {
    width: track.displayWidth,
    height: track.displayHeight,
    frames: packets.length,
    duration: await track.computeDuration(),
    keys: packets.filter(({ type }) => type === "key").map(({ timestamp }) => timestamp),
    times: packets.map(({ timestamp }) => Math.round(timestamp * 30)),
  };
}

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

/** Starts an export through the menu, or puts one in line when another runs. */
async function startExport(page: Page, choices: Record<string, string> = {}): Promise<void> {
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "导出视频…", exact: true }).click();
  await expect(dialog(page)).toContainText("导出视频");
  for (const [label, option] of Object.entries(choices)) {
    await dialog(page).getByLabel(label).selectOption({ label: option });
  }
  await dialog(page)
    .getByRole("button", { name: /^(导出|加入队列)$/u })
    .click();
}

const percentOf = async (page: Page) => {
  const status = footer(page)
    .getByRole("status")
    .filter({ hasText: /导出.*%/u });
  const text = (await status.textContent({ timeout: 1000 }).catch(() => "")) ?? "";
  return Number(/(\d+)%/u.exec(text)?.[1] ?? -1);
};

/** The list of exports, from the status bar, which is where people see that there are some. */
async function openList(page: Page): Promise<void> {
  if (await list(page).isVisible()) return;
  await footer(page)
    .getByRole("button", { name: /正在导出|导出：|已暂停|正在暂停/u })
    .first()
    .click();
  await expect(list(page)).toBeVisible();
}

/**
 * Keeps the export that runs in this page from getting past a frame, however fast this machine
 * encodes, as a computer that stopped would: the compositor gets no request for that frame or any
 * after it. Its window, where it has one, sends from a page of its own. Ends with the page. The
 * projects here have 30 frames a second.
 */
const holdAt = (page: Page, frame: number) =>
  page.evaluate(
    (seconds) => {
      const hold = (realm: typeof globalThis) => {
        const { prototype } = realm.MessagePort;
        const send = prototype.postMessage;
        prototype.postMessage = function (this: MessagePort, message: unknown, ...rest: never[]) {
          const asked = message as { type?: unknown; seconds?: unknown } | null;
          const held =
            asked?.type === "encode-frame" &&
            typeof asked.seconds === "number" &&
            asked.seconds >= seconds;
          if (!held) send.call(this, message, ...rest);
        };
      };
      hold(window);
      const windows = (
        window as unknown as {
          documentPictureInPicture?: { requestWindow(options: unknown): Promise<Window> };
        }
      ).documentPictureInPicture;
      if (!windows) return;
      const request = windows.requestWindow.bind(windows);
      windows.requestWindow = async (options) => {
        const opened = await request(options);
        hold(opened as unknown as typeof globalThis);
        return opened;
      };
    },
    frame / 30 - 1e-6,
  );

/** For people to look at what it looks like: the list does not say whether it looks right. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

test.use({ withProject: false });

test.describe("the line of exports", () => {
  test("goes one after the other, a wide and a tall one, and each file is right", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await open(page, projectFolder(8));
    await startExport(page);
    await expect.poll(() => percentOf(page)).toBeGreaterThanOrEqual(0);
    await startExport(page, { 画幅: "竖屏（360×640，30 帧）", 码率: "较高" });
    await expect(page.getByRole("status").getByText("已加入导出队列")).toBeVisible();
    await expect(footer(page)).toContainText("后面还有 1 个");
    await openList(page);
    await expect(row(page, "队列项目-小屏.mp4")).toContainText("正在导出");
    await expect(row(page, "队列项目-竖屏.mp4")).toContainText("排队中，下一个就是它");
    await shot(page, "queue-running");
    await expect(row(page, "队列项目-竖屏.mp4")).toContainText("已完成", { timeout: 90_000 });
    await expect(row(page, "队列项目-小屏.mp4")).toContainText("已完成");
    const wide = await factsOf(await savedFile(page, "队列项目-小屏.mp4"));
    const tall = await factsOf(await savedFile(page, "队列项目-竖屏.mp4"));
    expect(wide).toMatchObject({ width: 640, height: 360, frames: 240 });
    expect(tall).toMatchObject({ width: 360, height: 640, frames: 240 });
    expect(tall.times).toEqual(Array.from({ length: 240 }, (_, index) => index));
    expect(await keptExports(page)).toEqual({ exports: 0, pieces: 0 });
    await shot(page, "queue-done");
  });

  test("pauses at a place to go on from, and goes on to a file like one made in one go", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await open(page, projectFolder(30));
    await startExport(page);
    await expect.poll(() => percentOf(page)).toBeGreaterThanOrEqual(3);
    await footer(page).getByRole("button", { name: "暂停", exact: true }).click();
    await expect(footer(page)).toContainText("正在暂停");
    await expect(page.getByRole("status").getByText("已暂停，导到第 300 / 900 帧")).toBeVisible({
      timeout: 60_000,
    });
    // It holds no window, and does not go on by itself.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { documentPictureInPicture?: { window: Window | null } })
              .documentPictureInPicture?.window ?? null,
        ),
      )
      .toBeNull();
    expect(await keptExports(page)).toMatchObject({ exports: 1 });
    await openList(page);
    const paused = row(page, "队列项目-小屏.mp4");
    await expect(paused).toContainText("已暂停 · 第 300 / 900 帧");
    await shot(page, "queue-paused");
    await paused.getByRole("button", { name: /^继续/u }).click();
    await expect(paused).toContainText("已完成", { timeout: 90_000 });
    const facts = await factsOf(await savedFile(page, "队列项目-小屏.mp4"));
    expect(facts.frames).toBe(900);
    expect(facts.duration).toBeCloseTo(30, 2);
    expect(facts.times).toEqual(Array.from({ length: 900 }, (_, index) => index));
    // A key frame every two seconds, as in one made in one go: none more where it went on.
    expect(facts.keys.map((at) => Math.round(at))).toEqual(
      Array.from({ length: 15 }, (_, index) => index * 2),
    );
    expect(await keptExports(page)).toEqual({ exports: 0, pieces: 0 });
  });

  test("fails, is retried from where it was kept with nothing piling up, and then goes through", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await open(page, projectFolder(12));
    await page.evaluate(() => Object.assign(window, { failWrites: 2 }));
    await startExport(page);
    await expect(dialog(page)).toContainText("视频没有导出", { timeout: 60_000 });
    await expect(dialog(page)).toContainText("在“导出”选项卡里点“重试”");
    await dialog(page).getByRole("button", { name: "关闭" }).click();
    const kept = await keptExports(page);
    expect(kept.exports).toBe(1);
    await openList(page);
    const failed = row(page, "队列项目-小屏.mp4");
    await expect(failed).toContainText("没有导出");
    await shot(page, "queue-failed");
    // Once more before it is put right: it goes on from what it kept, and keeps no more.
    await failed.getByRole("button", { name: /^重试/u }).click();
    await expect(dialog(page)).toContainText("视频没有导出", { timeout: 60_000 });
    await dialog(page).getByRole("button", { name: "关闭" }).click();
    expect(await keptExports(page)).toEqual(kept);
    // Put right now: the disk has room again.
    await failed.getByRole("button", { name: /^重试/u }).click();
    await expect(failed).toContainText("已完成", { timeout: 60_000 });
    const facts = await factsOf(await savedFile(page, "队列项目-小屏.mp4"));
    expect(facts.frames).toBe(360);
    expect(facts.times).toEqual(Array.from({ length: 360 }, (_, index) => index));
    expect(await keptExports(page)).toEqual({ exports: 0, pieces: 0 });
  });

  test("is still there after a reload, and goes on with all of it", async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, projectFolder(20));
    // Past the place to go on from at frame 300, and not done when the page goes. Going by how far
    // it says it is, a fast machine got to the end, or the next export, before the page went.
    await holdAt(page, 400);
    await startExport(page);
    await expect.poll(() => percentOf(page)).toBeGreaterThanOrEqual(0);
    await startExport(page, { 画幅: "竖屏（360×640，30 帧）" });
    await expect(footer(page)).toContainText("后面还有 1 个");
    // The one in line is kept for after a reload a moment after it shows in line.
    await expect.poll(() => keptExports(page)).toMatchObject({ exports: 2 });
    await expect.poll(() => percentOf(page), { timeout: 60_000 }).toBe(66);
    const asked = page.waitForEvent("dialog");
    page.once("dialog", (question) => void question.accept());
    await page.reload();
    expect((await asked).type()).toBe("beforeunload");
    const offer = dialog(page).filter({ hasText: "有一个没完成的导出" });
    await expect(offer).toContainText("导到了第 300 / 600 帧");
    expect(await keptExports(page)).toMatchObject({ exports: 2 });
    await offer.getByRole("button", { name: "继续导出" }).click();
    await openList(page);
    await expect(row(page, "队列项目-竖屏.mp4")).toContainText(/排队中|正在导出|已完成/u);
    await shot(page, "queue-after-reload");
    await expect(row(page, "队列项目-竖屏.mp4")).toContainText("已完成", { timeout: 150_000 });
    await expect(row(page, "队列项目-小屏.mp4")).toContainText("已完成");
    const wide = await factsOf(await savedFile(page, "队列项目-小屏.mp4"));
    const tall = await factsOf(await savedFile(page, "队列项目-竖屏.mp4"));
    expect(wide.times).toEqual(Array.from({ length: 600 }, (_, index) => index));
    expect(tall).toMatchObject({ width: 360, height: 640, frames: 600 });
    expect(await keptExports(page)).toEqual({ exports: 0, pieces: 0 });
  });
});
