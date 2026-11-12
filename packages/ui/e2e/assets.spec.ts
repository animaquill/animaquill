import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { content, expect, resourcesIn, tab, tabScrolls, test } from "./support.ts";
import { cardMenu } from "./start-support.ts";

const assets = (page: Page) => content(page, "assets");
const items = (page: Page) => resourcesIn(page, "assets");
const timeline = (page: Page) => content(page, "timeline");
const clips = (page: Page) => timeline(page).getByRole("option");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function wav(seconds: number, loud = false): Buffer {
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
  // A square wave at half volume: its bars end between the two places the tests look at.
  if (loud)
    for (let index = 0; index < samples; index += 1) data[44 + index] = index % 2 ? 188 : 68;
  return data;
}

const files = {
  image: { name: "封面.png", mimeType: "image/png", buffer: PNG },
  sound: { name: "配音.wav", mimeType: "audio/wav", buffer: wav(3) },
  video: {
    name: "采访.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync(new URL("./fixtures/clip.mp4", import.meta.url)),
  },
  broken: { name: "坏文件.mp4", mimeType: "video/mp4", buffer: Buffer.from("no video here") },
  changing: {
    name: "红蓝.webm",
    mimeType: "video/webm",
    buffer: readFileSync(new URL("./fixtures/red-blue.webm", import.meta.url)),
  },
  loud: { name: "响.wav", mimeType: "audio/wav", buffer: wav(3, true) },
};

/** Screenshots to look at, in the output of each test. */
const shot = (name: string) => ({ path: test.info().outputPath(name) });

async function importFiles(page: Page, ...list: (typeof files)[keyof typeof files][]) {
  const chooser = page.waitForEvent("filechooser");
  await assets(page).getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(list);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element has no box");
  return box;
}

test.beforeEach(async ({ page }) => {
  await tab(page, "assets").click();
  await tab(page, "timeline").click();
});

test("brings in files, and they survive a reload", async ({ page }) => {
  await importFiles(page, files.image, files.sound, files.video);
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).filter({ hasText: "配音.wav" })).toContainText("0:03");
  await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toBeVisible();
  await page.reload();
  await expect(items(page)).toHaveCount(3);
  await expect(items(page).filter({ hasText: "封面.png" }).locator("img")).toBeVisible();
});

test("groups by type, finds by name, and plays under the pointer", async ({ page }) => {
  await importFiles(page, files.image, files.loud, files.changing);
  await assets(page).getByRole("button", { name: "新建场景" }).click();
  await expect(items(page)).toHaveCount(4);
  const groups = assets(page).locator('[role="group"]:not([data-group="recent"])');
  await expect(groups).toHaveCount(4);
  await expect(groups.nth(0)).toHaveAccessibleName("视频");
  await expect(groups.nth(1)).toHaveAccessibleName("图片");
  await expect(groups.nth(2)).toHaveAccessibleName("声音");
  await expect(groups.nth(3)).toHaveAccessibleName("场景模板");

  // A sound shows its waveform, and a video goes through its frames under the pointer.
  const sound = items(page).filter({ hasText: "响.wav" }).locator("canvas");
  await expect(sound).toBeVisible();
  const video = items(page).filter({ hasText: "红蓝.webm" });
  await expect(video.locator("canvas")).toBeVisible({ timeout: 30_000 });
  const still = await video.locator("canvas").screenshot();
  await video.hover();
  await expect
    .poll(async () => (await video.locator("canvas").screenshot()).equals(still))
    .toBe(false);
  await assets(page).screenshot(shot("assets-panel.png"));

  const search = assets(page).getByRole("searchbox", { name: "搜索素材" });
  await search.fill("红蓝");
  await expect(items(page)).toHaveText([/红蓝\.webm/]);
  await search.fill("没有这种");
  await expect(assets(page).getByText("没有找到“没有这种”")).toBeVisible();
  await search.press("Escape");
  await assets(page).getByRole("radio", { name: "按来源" }).click();
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveAccessibleName("本项目");
  await assets(page).getByRole("radio", { name: "按类型" }).click();

  // What was put on the timeline shows first next time.
  await items(page).filter({ hasText: "封面.png" }).dblclick();
  await expect(clips(page)).toHaveCount(2);
  const recent = assets(page).getByRole("group", { name: "最近用过" });
  await expect(recent.getByRole("option")).toHaveText([/封面\.png/]);
  await expect(items(page)).toHaveCount(4);
});

test("does not keep the same file twice", async ({ page }) => {
  await importFiles(page, files.image);
  await expect(items(page)).toHaveCount(1);
  await importFiles(page, { ...files.image, name: "别的名字.png" });
  await page.waitForTimeout(300);
  await expect(items(page)).toHaveCount(1);
});

test("says so when it cannot read a file, and goes on with the others", async ({ page }) => {
  await importFiles(page, files.broken, files.image);
  await expect(page.getByText("这个浏览器解不了“坏文件.mp4”")).toBeVisible();
  await expect(items(page)).toHaveCount(1);
});

test("a video with sound becomes two clips that belong together", async ({ page }) => {
  await importFiles(page, files.video);
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(2);
  await expect(clips(page).first()).toHaveAttribute("aria-label", /采访.mp4，视频 1/);
  await expect(clips(page).nth(1)).toHaveAttribute("aria-label", /采访.mp4，音频 1/);
  await expect(clips(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(clips(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(0);
});

test("can be dragged to a track", async ({ page }) => {
  await importFiles(page, files.image);
  const area = await boxOf(timeline(page).getByRole("group", { name: "时间轴" }));
  await items(page)
    .first()
    .dragTo(timeline(page).getByRole("group", { name: "时间轴" }), {
      targetPosition: { x: 300, y: 50 },
    });
  await expect(clips(page)).toHaveCount(1);
  const clip = await boxOf(clips(page).first());
  expect(clip.x).toBeGreaterThan(area.x + 250);
});

test("goes to the track also when the timeline changes under the pointer right before the drop", async ({
  page,
}) => {
  await importFiles(page, files.image);
  const stage = timeline(page).getByRole("group", { name: "时间轴" });
  const area = await boxOf(stage);
  await dragOver(page, items(page).first(), { x: area.x + 300, y: area.y + 50 }, async () => {
    // Only `dragenter` comes before the drop then: the timeline takes it all the same.
    await stage.evaluate((element) => {
      const cover = document.createElement("div");
      cover.style.cssText = "position: absolute; inset: 0; z-index: 5";
      element.append(cover);
    });
  });
  await expect(clips(page)).toHaveCount(1);
});

/** Holds a drag of an asset over a place of the timeline, and does `meanwhile` there. */
async function dragOver(
  page: Page,
  from: Locator,
  to: { x: number; y: number },
  meanwhile: () => Promise<void>,
) {
  const start = await boxOf(from);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 10, start.y + start.height / 2 + 10, {
    steps: 3,
  });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.move(to.x + 1, to.y, { steps: 2 });
  await meanwhile();
  await page.mouse.up();
}

/** What the timeline has drawn, kept, for looking at after the drop. */
const keepCanvas = (page: Page) =>
  timeline(page)
    .locator("canvas")
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      const copy = document.createElement("canvas");
      copy.width = canvas.width;
      copy.height = canvas.height;
      copy.getContext("2d")?.drawImage(canvas, 0, 0);
      (window as unknown as { kept: HTMLCanvasElement }).kept = copy;
    });

/** The color of what was kept at a place on the page. */
const keptColor = (page: Page, x: number, y: number) =>
  timeline(page)
    .locator("canvas")
    .first()
    .evaluate(
      (canvas: HTMLCanvasElement, [left, top]) => {
        const kept = (window as unknown as { kept: HTMLCanvasElement }).kept;
        const box = canvas.getBoundingClientRect();
        const ratio = canvas.width / box.width;
        const data = kept
          .getContext("2d")
          ?.getImageData((left - box.left) * ratio, (top - box.top) * ratio, 1, 1).data;
        return data ? [...data].slice(0, 3) : [];
      },
      [x, y] as const,
    );

test("shows where a drag lands, snapped and over what, and lands right there", async ({ page }) => {
  await importFiles(page, files.image, files.sound);
  await items(page).filter({ hasText: "封面.png" }).dblclick();
  await expect(clips(page)).toHaveCount(1);
  const picture = await boxOf(clips(page).first());
  const status = timeline(page).locator("[role=status][data-drop]");

  // Sound dropped a few pixels after the picture: on the sound track, its start on the end of it.
  const sound = items(page).filter({ hasText: "配音.wav" });
  const near = { x: picture.x + picture.width + 4, y: picture.y + picture.height / 2 };
  await dragOver(page, sound, near, async () => {
    await expect(status).toHaveText("松手放到音频 1，0:05/00");
    await keepCanvas(page);
    await timeline(page).screenshot(shot("drop-preview.png"));
  });
  await expect(status).toHaveCount(0);
  await expect(clips(page)).toHaveCount(2);
  const landed = clips(page).nth(1);
  await expect(landed).toHaveAttribute("aria-label", /^配音\.wav，音频 1，0:05\/00 到/);
  await timeline(page).screenshot(shot("drop-landed.png"));
  // What the preview drew is where the clip is now: inside it, and not before it.
  const clip = await boxOf(landed);
  const lane = await keptColor(page, clip.x - 12, clip.y + clip.height / 2);
  const ghost = await keptColor(page, clip.x + clip.width / 2, clip.y + clip.height / 2);
  const differs = (a: readonly number[], b: readonly number[]) =>
    a.some((value, index) => Math.abs(value - (b[index] ?? 0)) > 24);
  expect(differs(ghost, lane)).toBe(true);
  const after = await keptColor(page, clip.x + clip.width + 12, clip.y + clip.height / 2);
  expect(differs(after, lane)).toBe(false);

  // Overwriting, it stays where the mouse is, and says what it would cover.
  await timeline(page).getByRole("button", { name: "覆盖模式" }).click();
  const middle = { x: picture.x + picture.width / 2, y: picture.y + picture.height / 2 };
  await dragOver(page, items(page).filter({ hasText: "封面.png" }), middle, async () => {
    await expect(status).toContainText("松手放到视频 1，0:02");
    await expect(status).toContainText("会覆盖 1 处");
    await timeline(page).screenshot(shot("drop-overwrite.png"));
  });
  await expect(clips(page).and(page.locator('[aria-selected="true"]')).first()).toHaveAttribute(
    "aria-label",
    /^封面\.png，视频 1，0:02/,
  );
});

test("says where a click put it, and lights it up on the timeline", async ({ page }) => {
  await importFiles(page, files.image);
  const item = items(page).first();
  await item.click();
  await expect(clips(page)).toHaveCount(1);
  await expect(clips(page).first()).toHaveAttribute("data-flash", "true");
  await expect(item).toContainText("✓ 已加到 视频 1，0:00");
  await expect(assets(page).locator("[data-notice]")).toHaveText("封面.png已加到 视频 1，0:00");
  await assets(page).screenshot(shot("assets-added.png"));
  await timeline(page).screenshot(shot("assets-added-flash.png"));
  await expect(clips(page).first()).not.toHaveAttribute("data-flash");
});

test("a clip cannot grow past the end of its file", async ({ page }) => {
  await importFiles(page, files.sound);
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(1);
  await page.waitForTimeout(200);
  const { x, y, width, height } = await boxOf(clips(page).first());
  await page.mouse.move(x + width - 2, y + height / 2);
  await page.mouse.down();
  await page.mouse.move(x + width + 300, y + height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await expect(clips(page).first()).toHaveAttribute("aria-label", /到 0:03\/00/);
});

test("is looked after in the explorer, which asks before a file in use goes", async ({ page }) => {
  await importFiles(page, files.image);
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(1);
  // Right there is only the way to the explorer: looking after files happens there.
  await items(page).first().click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveText(["在资源管理器里显示"]);
  await page.getByRole("menuitem", { name: "在资源管理器里显示" }).click();
  const explorer = content(page, "explorer");
  await expect(explorer).toBeVisible();
  await expect(explorer.getByRole("option", { name: "封面.png" }).first()).toBeFocused();
  await explorer.getByRole("option", { name: "封面.png" }).first().click();
  const details = content(page, "code").getByRole("region", { name: "详情" });
  await expect(details.getByRole("heading", { name: "封面.png" })).toBeVisible();
  await details.getByRole("button", { name: "删除…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("时间轴上有 1 处用到它");
  await dialog.getByRole("button", { name: "取消" }).click();
  await tab(page, "assets").click();
  await expect(items(page)).toHaveCount(1);
  await expect(clips(page)).toHaveCount(1);
});

test("the files of a project go with it", async ({ page }) => {
  await importFiles(page, files.image);
  await expect(items(page)).toHaveCount(1);
  const count = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const open = indexedDB.open("animaquill");
          open.onsuccess = () => {
            const request = open.result.transaction("media").objectStore("media").count();
            request.onsuccess = () => {
              open.result.close();
              resolve(request.result);
            };
          };
        }),
    );
  expect(await count()).toBe(1);
  await page.getByRole("banner").getByRole("button", { name: "文件" }).click();
  await page.getByRole("menuitem", { name: "关闭项目" }).click();
  await cardMenu(page, "测试项目", "删除…");
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await expect.poll(count).toBe(0);
});

test("a project saved before files existed still opens, and takes files", async ({ page }) => {
  const url = page.url();
  await page.evaluate(async () => {
    const read = <T>(asked: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        asked.addEventListener("success", () => resolve(asked.result));
        asked.addEventListener("error", () => reject(asked.error));
      });
    const current = await read(indexedDB.open("animaquill"));
    const transaction = current.transaction(["projects", "updates"]);
    const projects = await read(transaction.objectStore("projects").getAll());
    const updates = await read(transaction.objectStore("updates").getAll());
    current.close();
    await read(indexedDB.deleteDatabase("animaquill"));

    // The database as the first version made it.
    const open = indexedDB.open("animaquill", 1);
    open.onupgradeneeded = () => {
      const database = open.result;
      database.createObjectStore("projects", { keyPath: "id" });
      const store = database.createObjectStore("updates", { keyPath: "seq", autoIncrement: true });
      store.createIndex("project", "project");
    };
    const old = await read(open);
    const writing = old.transaction(["projects", "updates"], "readwrite");
    for (const project of projects) writing.objectStore("projects").put(project);
    for (const update of updates) writing.objectStore("updates").put(update);
    await new Promise((resolve) => (writing.oncomplete = resolve));
    old.close();
  });
  await page.goto(url);
  await expect(page.getByRole("contentinfo")).toContainText("测试项目");
  await tab(page, "assets").click();
  await importFiles(page, files.image);
  await expect(items(page)).toHaveCount(1);
});

/** The colours just inside the border of a clip, and between its top and its middle. */
async function waveformProbe(page: Page) {
  const { x, y, width, height } = await boxOf(clips(page).first());
  const canvas = timeline(page).locator("canvas");
  const area = await boxOf(canvas);
  return canvas.evaluate(
    (element: HTMLCanvasElement, { left, top, inner }) => {
      const ratio = element.width / element.clientWidth;
      const context = element.getContext("2d");
      const colour = (at: number) =>
        [...(context?.getImageData(left * ratio, at * ratio, 1, 1).data ?? [])].join();
      return [colour(top + 5), colour(top + inner / 3)];
    },
    { left: x - area.x + width / 2, top: y - area.y, inner: height },
  );
}

test("a loud sound shows a waveform, and it comes back after a reload", async ({ page }) => {
  await importFiles(page, { name: "响.wav", mimeType: "audio/wav", buffer: wav(3, true) });
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(1);
  const differs = async () => {
    const [edge, inside] = await waveformProbe(page);
    return edge !== inside;
  };
  await expect.poll(differs).toBe(true);
  await page.reload();
  await expect(clips(page)).toHaveCount(1);
  await expect.poll(differs).toBe(true);
});

test("a silent sound shows no waveform", async ({ page }) => {
  await importFiles(page, { name: "静.wav", mimeType: "audio/wav", buffer: wav(3) });
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(1);
  await page.waitForTimeout(500);
  const [edge, inside] = await waveformProbe(page);
  expect(inside).toBe(edge);
});

async function goTo(page: Page, time: string) {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

/** The clip that is selected, alone. */
const selected = (page: Page) => clips(page).and(page.locator('[aria-selected="true"]'));

test("a click puts it at the playhead, on a track that has room, as one step", async ({ page }) => {
  await importFiles(page, files.image);
  const picture = items(page).first();
  const tracks = timeline(page).getByText(/^视频 \d$/);
  await expect(tracks).toHaveText(["视频 1"]);

  await picture.click();
  await expect(clips(page)).toHaveCount(1);
  await expect(selected(page)).toHaveAttribute("aria-label", /^封面\.png，视频 1，0:00\/00 到/);

  // Where the selected clip is there is no room: none of the tracks has any, so there is a new one.
  await picture.click();
  await expect(clips(page)).toHaveCount(2);
  await expect(selected(page)).toHaveAttribute("aria-label", /^封面\.png，视频 2，0:00\/00 到/);
  await expect(tracks).toHaveCount(2);
  // The clip and its track are one step.
  await timeline(page).getByRole("group", { name: "时间轴" }).focus();
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(1);
  await expect(tracks).toHaveText(["视频 1"]);
  await picture.click();
  await expect(selected(page)).toHaveAttribute("aria-label", /，视频 2，0:00\/00 到/);

  // Both have room right where they end: the track of the selected clip goes first.
  await goTo(page, "0:05/00");
  await picture.click();
  await expect(clips(page)).toHaveCount(3);
  await expect(selected(page)).toHaveAttribute("aria-label", /，视频 2，0:05\/00 到/);

  // With nothing selected, it is the first track with room.
  await timeline(page).getByRole("group", { name: "时间轴" }).focus();
  await page.keyboard.press("Escape");
  await expect(selected(page)).toHaveCount(0);
  await goTo(page, "0:06/00");
  await picture.click();
  await expect(clips(page)).toHaveCount(4);
  await expect(selected(page)).toHaveAttribute("aria-label", /，视频 1，0:06\/00 到/);
  await page.screenshot(shot("assets-click-add.png"));
});

test("Ctrl and the arrow keys only choose, a double click adds once, and Enter adds", async ({
  page,
}) => {
  await importFiles(page, files.image, files.sound);
  await expect(items(page)).toHaveCount(2);
  await items(page)
    .first()
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(items(page).first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(items(page).nth(1)).toBeFocused();
  await expect(clips(page)).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(clips(page)).toHaveCount(1);
  await items(page).first().dblclick();
  await expect(clips(page)).toHaveCount(2);
  await page.waitForTimeout(300);
  await expect(clips(page)).toHaveCount(2);
});

test("selecting a clip leaves the tab as it was, with no words about how to use it", async ({
  page,
}) => {
  await importFiles(page, files.image, files.sound, files.video);
  await expect(items(page)).toHaveCount(3);
  await items(page).filter({ hasText: "采访.mp4" }).click();
  await expect(clips(page)).toHaveCount(2);
  await expect(selected(page)).toHaveCount(2);
  expect(await tabScrolls(page, "assets")).toBe(false);
  await expect(assets(page).getByText(/拖到时间轴|双击|点一个/)).toHaveCount(0);

  // Groups close, and stay closed in this tab only.
  const pictures = assets(page).getByRole("button", { name: "图片" });
  await pictures.click();
  await expect(pictures).toHaveAttribute("aria-expanded", "false");
  await expect(items(page)).toHaveCount(2);
  expect(await tabScrolls(page, "assets")).toBe(false);
  await assets(page).screenshot(shot("assets-closed-group.png"));
  await page.reload();
  await tab(page, "assets").click();
  await expect(pictures).toHaveAttribute("aria-expanded", "false");
  await expect(items(page)).toHaveCount(2);
});
