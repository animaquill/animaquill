import type { Locator, Page } from "@playwright/test";
import { closeSettings, goToSettingsGroup, settingsOf } from "./ai-support.ts";
import { BLACK, expectColor, field, goTo, placeImage } from "./property-helpers.ts";
import { clickFirstClip } from "./scene-support.ts";
import { animateBesideTimeline, content, expect, test, showTab } from "./support.ts";

/**
 * Automatic keys (docs/design/keyframes-and-fit.md of AnimaQuill Cloud, 1.4): a round switch in the
 * keyframes and in the properties, a red frame around the keyframes and the picture while it is on,
 * and a change then animates a property from what it was at the start of its clip.
 */

const RED = [255, 0, 0] as const;

const recordIn = (page: Page, panel: "properties" | "keyframes") =>
  content(page, panel).getByRole("button", { name: "自动关键帧", exact: true });
const frameIn = (page: Page, panel: "preview" | "keyframes") =>
  content(page, panel).getByTestId("recording-frame");
const handle = (page: Page, name: string) =>
  content(page, "preview")
    .getByRole("list", { name: "画面上的手柄", exact: true })
    .getByRole("listitem", { name, exact: true });

async function middleOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not on the page");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const valueOf = async (page: Page, name: string) =>
  Number((await field(page, name).inputValue()).replace(/[%°]$/u, ""));

const expectNear = (page: Page, name: string, wanted: number, within = 1.5) =>
  expect
    .poll(async () => Math.abs((await valueOf(page, name)) - wanted), { message: name })
    .toBeLessThanOrEqual(within);

test("a move at 2 seconds while recording slides the picture there from where it was", async ({
  page,
}) => {
  await placeImage(page);
  const record = recordIn(page, "properties");
  await expect(record).toHaveAttribute("aria-pressed", "false");
  await expect(frameIn(page, "preview")).toHaveCount(0);
  await record.click();
  await expect(record).toHaveAttribute("aria-pressed", "true");
  await expect(frameIn(page, "preview")).toBeVisible();

  await goTo(page, "0:02/00");
  const box = await handle(page, "片段框").boundingBox();
  if (!box) throw new Error("no box");
  // World units per pixel: the picture is 1080 wide.
  const per = 1080 / box.width;
  const anchor = await middleOf(handle(page, "锚点"));
  const from = { x: anchor.x + 60, y: anchor.y + 40 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 100, from.y, { steps: 6 });
  await page.mouse.move(from.x + 200, from.y, { steps: 6 });
  await page.mouse.up();
  await expectNear(page, "位置 X", 200 * per);

  // At the start it is where it was, halfway it is halfway.
  await goTo(page, "0:00/00");
  await expect(field(page, "位置 X")).toHaveValue("0");
  await expectColor(page, 430, 540, [...RED], 4);
  await goTo(page, "0:01/00");
  await expectNear(page, "位置 X", 100 * per);

  // Played from the start, it goes from there to the right.
  await goTo(page, "0:00/00");
  await expectColor(page, 430, 540, [...RED], 4);
  await content(page, "preview").getByRole("button", { name: "播放", exact: true }).click();
  await expectColor(page, 430, 540, BLACK, 4);
  await content(page, "preview").getByRole("button", { name: "暂停", exact: true }).click();

  // One step takes it all back.
  await page.keyboard.press("Control+z");
  await goTo(page, "0:02/00");
  await expect(field(page, "位置 X")).toHaveValue("0");

  await record.click();
  await expect(record).toHaveAttribute("aria-pressed", "false");
  await expect(frameIn(page, "preview")).toHaveCount(0);
});

test("the switch in the keyframes is the same, with a red frame there too", async ({ page }) => {
  await placeImage(page);
  await animateBesideTimeline(page);
  const inKeys = recordIn(page, "keyframes");
  await expect(inKeys).toBeVisible();
  await expect(frameIn(page, "keyframes")).toHaveCount(0);
  await inKeys.click();
  await expect(inKeys).toHaveAttribute("aria-pressed", "true");
  await expect(frameIn(page, "keyframes")).toBeVisible();
  await expect(frameIn(page, "preview")).toBeVisible();
  await showTab(page, "properties");
  await expect(recordIn(page, "properties")).toHaveAttribute("aria-pressed", "true");
  await recordIn(page, "properties").click();
  await expect(frameIn(page, "preview")).toHaveCount(0);
  await showTab(page, "keyframes");
  await expect(inKeys).toHaveAttribute("aria-pressed", "false");
  await expect(frameIn(page, "keyframes")).toHaveCount(0);
});

test("the status bar says it records, and turns it off", async ({ page }) => {
  await placeImage(page);
  const status = page.getByTestId("key-recording-status");
  await expect(status).toHaveCount(0);
  await recordIn(page, "properties").click();
  await expect(status).toHaveText("自动关键帧");
  await status.click();
  await expect(status).toHaveCount(0);
  await expect(recordIn(page, "properties")).toHaveAttribute("aria-pressed", "false");
  await expect(frameIn(page, "preview")).toHaveCount(0);
});

test("recording starts off again after a reload", async ({ page }) => {
  await placeImage(page);
  await recordIn(page, "properties").click();
  await expect(recordIn(page, "properties")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await showTab(page, "timeline");
  await clickFirstClip(page);
  await showTab(page, "properties");
  await expect(recordIn(page, "properties")).toHaveAttribute("aria-pressed", "false");
  await expect(frameIn(page, "preview")).toHaveCount(0);
});

test("the shortcuts list both, automatic keys without a key of its own", async ({ page }) => {
  await placeImage(page);
  await page.keyboard.press("Control+Comma");
  await goToSettingsGroup(page, "快捷键");
  const keys = settingsOf(page).getByTestId("settings-keys");
  const record = keys.locator('[data-action="keyframes.toggleRecording"]');
  await expect(record).toContainText("自动关键帧");
  await expect(record.locator("kbd")).toHaveCount(0);
  const object = keys.locator('[data-action="keyframes.toggleObjectKeys"]');
  await expect(object.locator("kbd")).toHaveText("Alt+Shift+K");
  await closeSettings(page);
});
