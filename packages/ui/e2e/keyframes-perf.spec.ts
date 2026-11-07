import type { Key } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { importClips } from "./project-files.ts";
import { content, expect, test } from "./support.ts";

const CLIPS = 5000;
const KEYS_PER_PROPERTY = 5;
/**
 * Far from what it takes, because a busy machine should not fail this: the numbers are the point.
 * Drawing all lanes and not only those on screen takes an average of 70 ms in the same frames.
 */
const WORST_FRAME_MS = 300;
const AVERAGE_FRAME_MS = 30;

test.use({ withProject: false });
test.setTimeout(240_000);

const panel = (page: Page) => content(page, "keyframes");

function keysOf(first: number): { keys: Key[] } {
  const keys = Array.from({ length: KEYS_PER_PROPERTY }, (_, index) => ({
    time: String(index / KEYS_PER_PROPERTY),
    value: first + index,
  }));
  return { keys };
}

/** A timeline as long as it gets. */
const bigClips = () =>
  Array.from({ length: CLIPS }, (_, index) => ({
    id: `c${index}`,
    start: String(index),
    duration: "1",
    source: { kind: "color", color: "#336699" },
    properties: { "transform.x": keysOf(index), "transform.y": keysOf(-index) },
  }));

interface Measured {
  readonly frames: number;
  readonly average: number;
  readonly p95: number;
  readonly worst: number;
  readonly longTasks: number;
  /** How long the page stopped for at most. */
  readonly longest: number;
}

declare global {
  interface Window {
    frameCosts: Map<number, number>;
    longTasks: number[];
  }
}

/** What the browser spends in each frame, whoever asked for it. */
const countFrames = (page: Page) =>
  page.addInitScript(() => {
    if (window !== window.top) return;
    window.frameCosts = new Map();
    window.longTasks = [];
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      original((now) => {
        const started = performance.now();
        callback(now);
        const spent = performance.now() - started;
        window.frameCosts.set(now, (window.frameCosts.get(now) ?? 0) + spent);
      });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.longTasks.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  });

const startCounting = (page: Page) =>
  page.evaluate(() => {
    window.frameCosts.clear();
    window.longTasks.length = 0;
  });

const results = (page: Page): Promise<Measured> =>
  page.evaluate(() => {
    const costs = [...window.frameCosts.values()].toSorted((a, b) => a - b);
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    return {
      frames: costs.length,
      average: Number((total / Math.max(costs.length, 1)).toFixed(2)),
      p95: Number((costs[Math.floor(costs.length * 0.95)] ?? 0).toFixed(2)),
      worst: Number((costs.at(-1) ?? 0).toFixed(2)),
      longTasks: window.longTasks.length,
      longest: Math.round(Math.max(0, ...window.longTasks)),
    };
  });

/** A wheel that keeps turning for some frames, over the time side of the tab. */
const turnWheel = (page: Page, frames: number, deltaX: number, deltaY: number) =>
  page.evaluate(
    async ([count = 0, x = 0, y = 0]) => {
      const stage = document.querySelector('[data-panel="keyframes"] canvas');
      for (let frame = 0; frame < count; frame += 1) {
        stage?.dispatchEvent(
          new WheelEvent("wheel", { deltaX: x, deltaY: y, bubbles: true, cancelable: true }),
        );
        await new Promise(requestAnimationFrame);
      }
    },
    [frames, deltaX, deltaY],
  );

async function report(page: Page, name: string): Promise<Measured> {
  const measured = await results(page);
  console.log(`${name}: ${JSON.stringify(measured)}`);
  return measured;
}

async function reportSmooth(page: Page, name: string): Promise<void> {
  const { worst, average } = await report(page, name);
  expect(worst, name).toBeLessThan(WORST_FRAME_MS);
  expect(average, name).toBeLessThan(AVERAGE_FRAME_MS);
}

test("5000 clips with 50000 keys stay smooth", async ({ page }) => {
  await countFrames(page);
  await page.reload();
  await importClips(page, CLIPS, bigClips());

  await page.getByRole("button", { name: "动画", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  const list = panel(page).getByRole("treeitem");
  await expect(list.first()).toBeVisible({ timeout: 30_000 });

  await startCounting(page);
  await panel(page).getByRole("radio", { name: "全部" }).click();
  await expect(list.nth(5)).toBeVisible();
  await report(page, "listing all of it");
  expect(await list.count()).toBeLessThan(80);

  await startCounting(page);
  await turnWheel(page, 120, 0, 240);
  await reportSmooth(page, "up and down through 5000 clips");

  await page.getByRole("button", { name: "显示全部" }).first().click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await startCounting(page);
  await turnWheel(page, 60, 0, 240);
  await reportSmooth(page, "everything on screen at once");

  const zoomIn = panel(page).getByRole("button", { name: "放大" });
  for (let step = 0; step < 14; step += 1) await zoomIn.click();
  await startCounting(page);
  await turnWheel(page, 120, 80, 0);
  await reportSmooth(page, "along the timeline, zoomed in");

  await panel(page).getByRole("searchbox").fill("X");
  await expect(panel(page).getByRole("treeitem").first()).toBeVisible();
  await startCounting(page);
  await turnWheel(page, 120, 0, 240);
  await reportSmooth(page, "up and down through 5000 rows of keys");
  await panel(page).getByRole("searchbox").fill("");

  const stage = panel(page).getByRole("group", { name: "关键帧", exact: true });
  await stage.focus();
  await startCounting(page);
  await page.keyboard.press("Control+a");
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await turnWheel(page, 30, 0, 240);
  await reportSmooth(page, "selecting 50000 keys, and going through them");
  await page.keyboard.press("Escape");

  // Rows of values follow the playhead, in every frame.
  await panel(page).getByRole("radio", { name: "当前位置" }).click();
  await panel(page)
    .getByRole("button", { name: /^展开 纯色/ })
    .first()
    .click();
  await panel(page).getByRole("button", { name: "展开 位置" }).click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await startCounting(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(3000);
  await page.keyboard.press("Space");
  // Playing has the compositor in it too, which is another matter on a machine without a GPU.
  await report(page, "playing for three seconds with rows open");

  await page.getByRole("button", { name: "剪辑", exact: true }).click();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await startCounting(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(3000);
  await page.keyboard.press("Space");
  await report(page, "playing for three seconds without the tab");
});
