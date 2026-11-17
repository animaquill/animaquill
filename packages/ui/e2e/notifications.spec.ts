import type { Locator, Page } from "@playwright/test";
import { devPageOnly, expect, test } from "./support.ts";

/** How the notifications in the corner lay out what they say and their buttons. */

devPageOnly("window.aqNotify");

const LONG =
  "这一批改动里有 3 条轨道被锁定，波纹删除只能挪动没锁定的轨道，锁定轨道上的片段会和其他轨道错开。可以只动这几条轨道，或者先解锁再删除，也可以撤销这次。";
const LABELS = ["只动这几条轨道", "解锁后再删", "撤销这次"] as const;

const notify = (page: Page, message: string, labels: readonly string[]) =>
  page.evaluate(
    ([text, names]) =>
      (
        window as unknown as { aqNotify: (text: string, names: readonly string[]) => number }
      ).aqNotify(text, names),
    [message, labels] as const,
  );

const notices = (page: Page) => page.locator("[data-notifications]").getByRole("status");

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("no box");
  return box;
}

async function shoot(page: Page, name: string) {
  const box = await boxOf(notices(page));
  await page.screenshot({
    path: test.info().outputPath(name),
    clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 },
  });
}

/** The text goes across the top, the buttons in a row of their own under it, to the right. */
async function expectStacked(page: Page, message: string) {
  const text = notices(page).getByText(message);
  const item = text.locator("xpath=..");
  const close = item.getByRole("button", { name: "关闭" });
  const actions = item.getByTestId("notification-actions");
  const itemBox = await boxOf(item);
  const textBox = await boxOf(text);
  const closeBox = await boxOf(close);
  const actionsBox = await boxOf(actions);
  // The text takes the width there is beside the close button.
  expect(textBox.width).toBeGreaterThan(itemBox.width - closeBox.width - 48);
  // The close button stays in the corner, on the first line.
  expect(closeBox.y).toBeLessThan(textBox.y + 12);
  expect(closeBox.x).toBeGreaterThan(textBox.x + textBox.width - 1);
  // Every button is under all of the text, and the last one at the right.
  expect(actionsBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height);
  const buttons = actions.getByRole("button");
  for (const button of await buttons.all())
    expect((await boxOf(button)).y).toBeGreaterThanOrEqual(textBox.y + textBox.height);
  const last = await boxOf(buttons.last());
  expect(last.x + last.width).toBeGreaterThan(itemBox.x + itemBox.width - 16);
  return { textBox, itemBox };
}

for (const scheme of ["dark", "light"] as const) {
  test.describe(`in ${scheme} colours`, () => {
    test.use({ colorScheme: scheme });

    test("say what they say on top, with their buttons in a row under it", async ({ page }) => {
      await notify(page, LONG, LABELS);
      await expect(notices(page).getByRole("button", { name: LABELS[2] })).toBeVisible();
      await expectStacked(page, LONG);
      await expect(notices(page).getByRole("button")).toHaveCount(LABELS.length + 1);
      await shoot(page, `notice-long-${scheme}.png`);

      // A short one keeps the same order, and is no wider than the long one.
      await notices(page).getByRole("button", { name: "关闭" }).click();
      await notify(page, "已并入 2 处改动。", ["查看", "撤销这次"]);
      await expectStacked(page, "已并入 2 处改动。");
      await shoot(page, `notice-short-${scheme}.png`);
    });
  });
}

test("a button does what it says and the notification goes away", async ({ page }) => {
  await notify(page, LONG, LABELS);
  await notices(page).getByRole("button", { name: LABELS[0] }).click();
  await expect(notices(page).getByText(LONG)).toHaveCount(0);
});
