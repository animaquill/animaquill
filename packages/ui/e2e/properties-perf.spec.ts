import type { Page } from "@playwright/test";
import {
  clickFirstClip,
  content,
  expect,
  goTo,
  importFolder,
  needsPlainStage,
  openForScenes,
  projectFolder,
  sceneFrames,
  tab,
  test,
} from "./scene-support.ts";

/** A skeleton with as many bones as a big one has, each with what a bone has, all of them turning. */
const BONES = 300;
/**
 * The share of the frames that the editor gets with nothing selected, which it keeps with the clip
 * selected and its properties open. Far from what it takes, because a busy machine should not fail
 * this, and that is why it goes by what the same machine does just before: the numbers are the
 * point. With every row drawing again in each frame, the editor got 2 frames a second here, with
 * the React people get. `AQ_REACT=production scripts/e2e properties-perf.spec.ts` measures with it.
 */
const MIN_SHARE_OF_FRAMES = 0.4;
/** How long the page may stop at most, while playing. Every row drawing again took 730 ms. */
const LONGEST_TASK_MS = 500;
/** Rows are there for what is on screen, and not for each of the 1200 properties. */
const MAX_ROWS = 200;

test.use({ withProject: false });
needsPlainStage();
test.setTimeout(180_000);

declare global {
  interface Window {
    longTasks: number[];
  }
}

const rig = `<!doctype html><script>
  const bones = [];
  for (let i = 0; i < ${BONES}; i += 1) {
    bones.push(aq.object("rig.bone" + i, { name: "骨骼 " + i, properties: {
      x: { type: "number", default: 0, group: "position" },
      y: { type: "number", default: 0, group: "position" },
      rotation: { type: "angle", default: 0 },
      scale: 1,
    } }));
  }
  aq.frame((s) => {
    let sum = 0;
    for (const bone of bones) sum += bone.at(s).rotation;
    document.body.dataset.sum = String(Math.round(sum));
  });
</script>`;

function turning(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let bone = 0; bone < BONES; bone += 1) {
    properties[`object.rig.bone${bone}.rotation`] = {
      keys: [
        { time: "0", value: 0 },
        { time: "10", value: 360 + bone },
      ],
    };
  }
  return properties;
}

interface Played {
  readonly framesPerSecond: number;
  readonly worstFrameMs: number;
  readonly longTasks: number;
  readonly longestTaskMs: number;
}

/** Plays for a while, and says how the editor kept up. */
async function play(page: Page, name: string): Promise<Played> {
  await goTo(page, "0:00/00");
  await page.evaluate(() => (window.longTasks.length = 0));
  const frames = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-panel="preview"] button[aria-label="播放"]',
    );
    button?.click();
    const times: number[] = [];
    const start = performance.now();
    while (performance.now() - start < 4000) {
      await new Promise(requestAnimationFrame);
      times.push(performance.now());
    }
    const gaps = times.slice(1).map((time, index) => time - (times[index] as number));
    return {
      framesPerSecond: Math.round(times.length / 4),
      worstFrameMs: Math.round(Math.max(...gaps)),
    };
  });
  await page.keyboard.press("Space");
  const tasks = await page.evaluate(() => window.longTasks.slice());
  const played = {
    ...frames,
    longTasks: tasks.length,
    longestTaskMs: Math.round(Math.max(0, ...tasks)),
  };
  console.log(`${name}: ${JSON.stringify(played)}`);
  return played;
}

function expectSmooth(played: Played, alone: Played, name: string): void {
  const frames = alone.framesPerSecond * MIN_SHARE_OF_FRAMES;
  expect(played.framesPerSecond, name).toBeGreaterThanOrEqual(frames);
  expect(played.longestTaskMs, name).toBeLessThan(LONGEST_TASK_MS);
}

test(`a clip with ${BONES * 4} properties plays smoothly with its properties open`, async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    window.longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.longTasks.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  });
  await openForScenes(page);
  await importFolder(
    page,
    projectFolder({ a: { "index.html": rig } }, [{ duration: "20", properties: turning() }]),
  );
  const sum = () =>
    sceneFrames(page)
      .at(-1)
      ?.evaluate(() => document.body.dataset.sum)
      .catch(() => undefined);
  await expect.poll(sum, { timeout: 30_000 }).toBe("0");

  const alone = await play(page, "nothing selected");

  await clickFirstClip(page);
  await tab(page, "properties").click();
  const panel = content(page, "properties");
  await expect(panel.getByRole("region", { name: "骨骼 0", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  // The regions are all there, for finding them, and only those near the screen have rows.
  await expect(
    panel.getByRole("region", { name: `骨骼 ${BONES - 1}`, exact: true }),
  ).toBeAttached();
  const rows = await panel.getByRole("group").count();
  console.log(`rows: ${rows}`);
  expect(rows).toBeLessThan(MAX_ROWS);
  expectSmooth(await play(page, "clip selected, properties open"), alone, "properties open");
  // Rows on screen follow the playhead, also after playing.
  const turned = (bone: number) =>
    panel
      .getByRole("region", { name: `骨骼 ${bone}`, exact: true })
      .getByRole("spinbutton", { name: "rotation", exact: true });
  await goTo(page, "0:05/00");
  await expect(turned(0)).toHaveValue("180");

  // Further down, rows come as they come near the screen, and show where the playhead is.
  await panel.getByRole("region", { name: "骨骼 150", exact: true }).scrollIntoViewIfNeeded();
  await expect(turned(150)).toHaveValue("255");
  await expect(turned(0)).toHaveCount(0);
  expect(await panel.getByRole("group").count()).toBeLessThan(MAX_ROWS);

  await tab(page, "chat").click();
  await expect(panel).toBeHidden();
  expectSmooth(await play(page, "clip selected, properties hidden"), alone, "properties hidden");
});
