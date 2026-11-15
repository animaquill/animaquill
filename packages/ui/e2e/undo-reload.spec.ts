import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  goToSettingsGroup,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { content, devPageOnly, expect, tab, test } from "./support.ts";

/**
 * AI tasks taken back as a whole after the page was loaded again (the design of AI collaboration,
 * "整批撤销跨刷新"): from the card of the task, from the list of what happened, in part where people
 * changed something since, and not at all where they changed all of it. Pictures of each go to the
 * output of the test.
 */

devPageOnly("window.aqExecute and window.aqState");

const chat = (page: Page) => content(page, "chat");
const card = (page: Page) => chat(page).getByTestId("chat-card").last();
const status = (page: Page) =>
  page.getByRole("contentinfo").getByRole("button", { name: /^上次的操作：/ });
const bubble = (page: Page) => page.getByRole("dialog", { name: "最近的操作" });

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

interface Marker {
  readonly name: string;
}

const markers = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as { aqState: () => { timelines: Record<string, unknown> } }
    ).aqState();
    const main = state.timelines["main"] as { markers?: Record<string, Marker> };
    return Object.fromEntries(
      Object.entries(main.markers ?? {}).map(([id, { name }]) => [id, name]),
    );
  });

const execute = (page: Page, call: object) =>
  page.evaluate((given) => {
    const run = (window as unknown as { aqExecute: (call: unknown) => { ok: boolean } }).aqExecute;
    return run(given).ok;
  }, call);

/** Keeps what changed and its undo logs, as a page that goes away a moment later does. */
const reload = async (page: Page) => {
  await page.evaluate(async () => {
    const hooks = window as unknown as {
      aqSave: () => Promise<unknown>;
      aqUndoSaved: () => Promise<unknown>;
    };
    await hooks.aqSave();
    await hooks.aqUndoSaved();
  });
  await page.reload();
  await tab(page, "chat").click();
};

/** AI answers each message with one task that adds these markers, then says it is done. */
async function aiAdds(page: Page, tasks: readonly (readonly [string, string])[][]) {
  let round = 0;
  await page.route(ANTHROPIC, (route: Route) => {
    const task = tasks[Math.floor(round / 2)] ?? [];
    const body =
      round % 2 === 0
        ? anthropicCalls([
            {
              name: "aq_edit",
              input: {
                summary: "加标记",
                operations: task.map(([id, name], index) => ({
                  op: "marker.add",
                  timeline: "main",
                  id,
                  time: String(index + 1),
                  name,
                })),
              },
            },
          ])
        : anthropicSays("加好了。");
    round += 1;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body,
    });
  });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");
  await closeSettings(page);
  await tab(page, "chat").click();
}

async function send(page: Page, text: string) {
  const done = await chat(page).getByText("加好了。").count();
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill(text);
  await box.press("Enter");
  await expect(chat(page).getByText("加好了。")).toHaveCount(done + 1, { timeout: 15_000 });
}

test("a task of AI goes back from its card after a reload, and comes again", async ({ page }) => {
  test.setTimeout(90_000);
  await aiAdds(page, [
    [
      ["m1", "一"],
      ["m2", "二"],
    ],
  ]);
  await send(page, "加两个标记");
  await expect(card(page)).toContainText("改了 2 处");
  await reload(page);

  await expect(card(page).getByRole("button", { name: "撤销这次任务" })).toBeVisible();
  await shot(page, "card-after-reload");
  await card(page).getByRole("button", { name: "撤销这次任务" }).click();
  await expect.poll(() => markers(page)).toEqual({});
  await expect(page.getByText("撤销了 2 处")).toBeVisible();
  await expect(card(page).getByRole("button", { name: "重做这次任务" })).toBeVisible();

  // Taken back, and loaded again: it can be done again.
  await reload(page);
  await card(page).getByRole("button", { name: "重做这次任务" }).click();
  await expect.poll(() => markers(page)).toEqual({ m1: "一", m2: "二" });
});

test("the list of what happened has AI tasks after a reload, each to take back", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await aiAdds(page, [[["m1", "一"]], [["m2", "二"]]]);
  await send(page, "加标记一");
  await send(page, "加标记二");
  await reload(page);

  await status(page).click();
  const items = bubble(page).getByRole("list", { name: "最近的操作" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("AI：“加标记二”改了 1 处");
  await expect(items.last()).toContainText("AI：“加标记一”改了 1 处");
  await shot(page, "operations-after-reload");
  await items.last().getByRole("button", { name: "撤销这次" }).click();
  await expect.poll(() => markers(page)).toEqual({ m2: "二" });
  await expect(items.last().getByRole("button", { name: "重做这次" })).toBeVisible();
});

test("what people changed since stays, and says which; all of it changed, nothing goes", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await aiAdds(page, [
    [
      ["m1", "一"],
      ["m2", "二"],
    ],
    [["m3", "三"]],
  ]);
  await send(page, "加两个标记");
  await send(page, "再加一个");
  // People change one of the first task, and all of the second.
  expect(
    await execute(page, {
      type: "marker.update",
      params: { timeline: "main", marker: "m2", changes: { name: "我改的" } },
    }),
  ).toBe(true);
  expect(
    await execute(page, { type: "marker.remove", params: { timeline: "main", marker: "m3" } }),
  ).toBe(true);
  await reload(page);

  // The second task: nothing of it is left to take back, which its button says.
  const blocked = card(page).getByRole("button", { name: "撤销这次任务" });
  await expect(blocked).toHaveAttribute("aria-disabled", "true");
  await blocked.hover();
  await expect(page.getByRole("tooltip")).toHaveText("这次任务改的地方后来都被改过了");
  await shot(page, "blocked-hover");
  await blocked.click({ force: true });
  await expect.poll(() => markers(page)).toEqual({ m1: "一", m2: "我改的" });

  // The first: what people changed stays.
  const first = chat(page).getByTestId("chat-card").first();
  await first.getByRole("button", { name: "撤销这次任务" }).click();
  await expect.poll(() => markers(page)).toEqual({ m2: "我改的" });
  const notice = page.getByText("撤销了 1 处");
  await expect(notice).toBeVisible();
  await expect(page.getByText("1 处你后来又改过，保留了你的。")).toBeVisible();
  await shot(page, "partly");
  await page.getByRole("button", { name: "查看是哪 1 处" }).click();
  const dialog = page.getByRole("dialog", { name: "保留了 1 处" });
  await expect(dialog).toContainText("标记「我改的」");
  await shot(page, "partly-which");
});

test("the undo logs show in the settings, and go", async ({ page }) => {
  test.setTimeout(90_000);
  await aiAdds(page, [[["m1", "一"]]]);
  await send(page, "加一个标记");
  await page.evaluate(() =>
    (window as unknown as { aqUndoSaved: () => Promise<unknown> }).aqUndoSaved(),
  );
  await openSettingsPage(page, "AI 模型");
  await goToSettingsGroup(page, "存储和数据");
  const line = settingsOf(page).getByTestId("settings-undo");
  await expect(line).toHaveText(/^撤销记录：1 个项目，\d/);
  await shot(page, "settings-row");
  await settingsOf(page)
    .locator('[data-setting="storage.undo"]')
    .getByRole("button", { name: "清除" })
    .click();
  await page
    .getByRole("dialog", { name: "清除撤销记录？" })
    .getByRole("button", { name: "清除" })
    .click();
  await expect(line).toHaveCount(0);
  await closeSettings(page);
  await reload(page);
  await expect(card(page).getByRole("button", { name: /撤销这次任务|重做这次任务/ })).toHaveCount(
    0,
  );
});

test.describe("a project of the platform", () => {
  test.use({ withProject: false });

  test("on a device that did not make the changes, the button is grey and says where", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
      if (window !== window.top) return;
      if (sessionStorage.getItem("animaquill.fakeAccount") === null)
        sessionStorage.setItem(
          "animaquill.fakeAccount",
          JSON.stringify({ signedIn: true, installed: true }),
        );
    });
    await page.goto("/?account=fake&cloud=fake");
    await page.evaluate(() =>
      (
        window as unknown as { aqCloud: { seed(name: string, options: object): string } }
      ).aqCloud.seed("年会视频", { repository: "annual" }),
    );
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "打开云端的项目…" }).click();
    await page.getByText("年会视频").first().click();
    await expect(page.locator("footer [data-cloud]")).toHaveAttribute("data-cloud", "online");
    await aiAdds(page, [[["m1", "一"]]]);
    await send(page, "加一个标记");
    await expect(card(page).getByRole("button", { name: "撤销这次任务" })).not.toHaveAttribute(
      "aria-disabled",
    );
    // What the other device has: the conversation, which goes with the account, and no undo log.
    await page.evaluate(() =>
      (window as unknown as { aqUndoElsewhere: () => Promise<unknown> }).aqUndoElsewhere(),
    );
    const button = card(page).getByRole("button", { name: "撤销这次任务" });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await button.hover();
    await expect(page.getByRole("tooltip")).toHaveText("在做这次改动的那台电脑上能撤销");
    await shot(page, "other-device");
  });
});
