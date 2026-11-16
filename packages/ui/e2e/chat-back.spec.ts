import type { Page } from "@playwright/test";
import { content, devPageOnly, expect, test } from "./support.ts";
import { aiAdds, execute, markers, reload, send } from "./undo-support.ts";

/**
 * Back to before a turn (S-D2): from a message, the list of what goes for each turn from there on,
 * grey with why for one that cannot; it goes, the newest first, and comes again as a whole. What
 * people changed since, and what another conversation changed, stay. Pictures of each go to the
 * output of the test.
 */

devPageOnly("window.aqExecute and window.aqState");

const chat = (page: Page) => content(page, "chat");
const message = (page: Page, text: string) =>
  chat(page).getByTestId("chat-user").filter({ hasText: text });
/** The button on a message, which shows when it is hovered. */
const backOf = async (page: Page, text: string) => {
  await message(page, text).hover();
  return message(page, text).locator("xpath=..").getByRole("button", { name: "回到这一轮之前" });
};
const list = (page: Page) => chat(page).getByTestId("chat-back");

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const MARKER_UPDATE = { type: "marker.update", params: { timeline: "main" } };

test("back to before the first turn takes back every turn from there, and does them again", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await aiAdds(page, [
    [
      ["m1", "一"],
      ["m2", "二"],
    ],
    [["m3", "三"]],
    [
      ["m4", "四"],
      ["m5", "五"],
    ],
  ]);
  await send(page, "第一轮加两个标记");
  await send(page, "第二轮加一个");
  await send(page, "第三轮再加两个");
  // Another conversation adds one; people change one of the first turn, and all of the second.
  expect(
    await execute(
      page,
      { type: "marker.add", params: { timeline: "main", id: "m9", time: "9", name: "别的对话" } },
      { origin: "ai:another-conversation" },
    ),
  ).toBe(true);
  expect(
    await execute(page, {
      ...MARKER_UPDATE,
      params: { ...MARKER_UPDATE.params, marker: "m2", changes: { name: "我改的" } },
    }),
  ).toBe(true);
  expect(
    await execute(page, { type: "marker.remove", params: { timeline: "main", marker: "m3" } }),
  ).toBe(true);
  // It works after a reload as before it: the undo logs are kept.
  await reload(page);

  const back = await backOf(page, "第一轮加两个标记");
  await expect(back).toBeVisible();
  await shot(page, "sd2-button");
  await back.click();
  await expect(list(page).getByText("撤掉 2 轮的 3 处改动")).toBeVisible();
  const rows = list(page).getByTestId("chat-back-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("第一轮加两个标记");
  await expect(rows.nth(0)).toContainText("1 处");
  await expect(rows.nth(1)).toHaveAttribute("aria-disabled", "true");
  await expect(rows.nth(2)).toContainText("2 处");
  // Counted as the card of the turn counts: what goes back and what stays add up to it.
  const cards = chat(page).getByTestId("chat-card");
  await expect(cards.nth(2)).toContainText("改了 2 处");
  await expect(cards.nth(0)).toContainText("改了 2 处");
  await expect(list(page).getByText("后来改过的 1 处保留")).toBeVisible();
  await rows.nth(1).getByTestId("chat-back-why").hover();
  await expect(page.getByRole("tooltip")).toHaveText("这次任务改的地方后来都被改过了");
  await shot(page, "sd2-list");

  await list(page).getByRole("button", { name: "撤掉" }).click();
  await expect.poll(() => markers(page)).toEqual({ m2: "我改的", m9: "别的对话" });
  const done = chat(page).getByTestId("chat-back-done");
  await expect(done).toContainText("撤掉了 3 处");
  // Each card says so, as if each turn had been taken back on its own.
  await expect(cards.nth(0).getByRole("button", { name: "重做这次任务" })).toBeVisible();
  await expect(cards.nth(2).getByRole("button", { name: "重做这次任务" })).toBeVisible();
  await shot(page, "sd2-done");

  await done.getByRole("button", { name: "重做" }).click();
  await expect
    .poll(() => markers(page))
    .toEqual({ m1: "一", m2: "我改的", m4: "四", m5: "五", m9: "别的对话" });
  await expect(done).toHaveCount(0);
  await expect(cards.nth(0).getByRole("button", { name: "撤销这次任务" })).toBeVisible();
  await expect(cards.nth(2).getByRole("button", { name: "撤销这次任务" })).toBeVisible();
  await shot(page, "sd2-redone");

  // Loaded again, from the last turn: only that one.
  await reload(page);
  await (await backOf(page, "第三轮再加两个")).click();
  await expect(list(page).getByText("撤掉 1 轮的 2 处改动")).toBeVisible();
  await list(page).getByRole("button", { name: "撤掉" }).click();
  await expect.poll(() => markers(page)).toEqual({ m1: "一", m2: "我改的", m9: "别的对话" });

  // On a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await (await backOf(page, "第一轮加两个标记")).click();
  await expect(list(page).getByTestId("chat-back-row")).toHaveCount(2);
  await list(page).scrollIntoViewIfNeeded();
  await shot(page, "sd2-list-390");
});

test("when the project changed while the list was open, nothing goes and the list says what would", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await aiAdds(page, [[["m1", "一"]], [["m2", "二"]]]);
  await send(page, "加标记一");
  await send(page, "加标记二");
  await (await backOf(page, "加标记一")).click();
  await expect(list(page).getByText("撤掉 2 轮的 2 处改动")).toBeVisible();
  // Meanwhile all of the second turn is changed.
  expect(
    await execute(page, { type: "marker.remove", params: { timeline: "main", marker: "m2" } }),
  ).toBe(true);
  await list(page).getByRole("button", { name: "撤掉" }).click();
  await expect(list(page).getByText("撤掉 1 轮的 1 处改动")).toBeVisible();
  expect(await markers(page)).toEqual({ m1: "一" });
  await list(page).getByRole("button", { name: "撤掉" }).click();
  await expect.poll(() => markers(page)).toEqual({});
});
