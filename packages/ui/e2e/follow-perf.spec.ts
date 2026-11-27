import type { Key } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { importClips } from "./project-files.ts";
import { content, expect, test } from "./support.ts";

/**
 * What playing costs a frame with the playhead held in the middle, where the timeline draws again
 * in every frame, against a page at a time, where it only moves the playhead. A big timeline, with
 * the rows of keys open under the clips. The numbers are the point: it only fails far off.
 */
const CLIPS = 2000;
const KEYS_PER_PROPERTY = 5;
const AVERAGE_FRAME_MS = 30;
const PLAY_MS = 4000;

test.use({ withProject: false });
test.setTimeout(300_000);

const panel = (page: Page) => content(page, "timeline");
const stage = (page: Page) => panel(page).getByRole("group", { name: "时间轴", exact: true });

const keysOf = (first: number): { keys: Key[] } => ({
  keys: Array.from({ length: KEYS_PER_PROPERTY }, (_, index) => ({
    time: String(index / KEYS_PER_PROPERTY),
    value: first + index,
  })),
});

const bigClips = () =>
  Array.from({ length: CLIPS }, (_, index) => ({
    id: `c${index}`,
    start: String(index / 2),
    duration: "0.5",
    source: { kind: "color", color: "#336699" },
    properties: { "transform.x": keysOf(index), "transform.y": keysOf(-index) },
  }));

declare global {
  interface Window {
    frameCosts: Map<number, number>;
    /** What each kind of callback costs in all, by the start of its source. */
    byCallback: Map<string, number>;
  }
}

const countFrames = (page: Page) =>
  page.addInitScript(() => {
    if (window !== window.top) return;
    window.frameCosts = new Map();
    window.byCallback = new Map();
    const original = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      original((now) => {
        const started = performance.now();
        callback(now);
        const spent = performance.now() - started;
        window.frameCosts.set(now, (window.frameCosts.get(now) ?? 0) + spent);
        const name = callback.toString().replaceAll(/\s+/g, " ").slice(0, 70);
        window.byCallback.set(name, (window.byCallback.get(name) ?? 0) + spent);
      });
  });

async function play(page: Page, name: string) {
  await stage(page).focus();
  await page.keyboard.press("Home");
  await page.evaluate(() => {
    window.frameCosts.clear();
    window.byCallback.clear();
  });
  await page.keyboard.press("Space");
  await page.waitForTimeout(PLAY_MS);
  await page.keyboard.press("Space");
  const measured = await page.evaluate(() => {
    const costs = [...window.frameCosts.values()].toSorted((a, b) => a - b);
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    return {
      frames: costs.length,
      average: Number((total / Math.max(costs.length, 1)).toFixed(2)),
      p95: Number((costs[Math.floor(costs.length * 0.95)] ?? 0).toFixed(2)),
      worst: Number((costs.at(-1) ?? 0).toFixed(2)),
    };
  });
  console.log(`${name}: ${JSON.stringify(measured)}`);
  const parts = await page.evaluate(() =>
    [...window.byCallback]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(
        ([source, spent]) =>
          `${(spent / Math.max(window.frameCosts.size, 1)).toFixed(2)} ms ${source}`,
      ),
  );
  console.log(parts.join("\n"));
  expect(measured.average, name).toBeLessThan(AVERAGE_FRAME_MS);
  return measured;
}

test("playing a big timeline costs a frame no matter how it follows", async ({ page }) => {
  await countFrames(page);
  await page.reload();
  await importClips(page, CLIPS / 2, bigClips());
  await expect(stage(page)).toBeVisible();
  // Every clip with its rows of keys open, about forty of them on screen.
  await stage(page).focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("u");
  for (let step = 0; step < 12; step += 1) await page.keyboard.press("=");
  await page.waitForTimeout(500);

  await play(page, "a page at a time");
  await panel(page).getByRole("button", { name: "跟随方式" }).click();
  await page.getByRole("menuitemradio", { name: "居中" }).click();
  await page.waitForTimeout(500);
  await play(page, "held in the middle");
});
