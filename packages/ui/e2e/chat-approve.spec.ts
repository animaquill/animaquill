import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  goToSettingsGroup,
  settingsOf,
} from "./ai-support.ts";
import { content, devPageOnly, expect, tab, test } from "./support.ts";
import { execute } from "./undo-support.ts";

/**
 * "AI 改项目前先问我" (S-D4): the switch in the settings of the chat; while it is on, each change AI
 * wants to make waits under the turn as the card of changes, with three answers. Allowed, it is
 * written and the next is asked again; for the task, the rest of that task is not asked; not
 * allowed, nothing is written and the rest of the answer neither; and what people changed meanwhile
 * at the same place is a conflict, nothing written. Pictures of each go to the output of the test.
 */

devPageOnly("window.aqExecute and window.aqState");

const chat = (page: Page) => content(page, "chat");
const asking = (page: Page) => chat(page).getByTestId("chat-approve");
const shoot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`sd4-${name}.png`) });

/** The markers of the main timeline, by id: their names and times. */
const markers = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        aqState: () => {
          timelines: Record<string, { markers?: Record<string, { name: string; time: string }> }>;
        };
      }
    ).aqState();
    return Object.fromEntries(
      Object.entries(state.timelines["main"]?.markers ?? {}).map(([id, { name, time }]) => [
        id,
        `${name}@${time}`,
      ]),
    );
  });

const fulfil = (route: Route, body: string) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body,
  });

const add = (id: string, time: string) => ({
  name: "aq_edit",
  input: { operations: [{ op: "marker.add", timeline: "main", id, time, name: id }] },
});

test("asked before each change: allow, allow the task, not allow, and a conflict", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  let requests = 0;
  await page.route(ANTHROPIC, (route) => {
    const asked = route.request().postDataJSON() as { max_tokens?: number; tools?: unknown };
    if (asked.max_tokens === 16) return route.fallback();
    if (asked.tools === undefined) return fulfil(route, anthropicSays("标记"));
    requests += 1;
    const calls = (list: Parameters<typeof anthropicCalls>[0]) =>
      anthropicCalls(list).replaceAll("toolu_", `toolu_${requests}_`);
    switch (requests) {
      // The first message: it reads, changes two places, then one more, which people do not allow.
      case 1:
        return fulfil(route, calls([{ name: "aq_timeline_read", input: { timeline: "main" } }]));
      case 2:
        return fulfil(
          route,
          calls([
            {
              name: "aq_edit",
              input: {
                summary: "片头标记挪到 2 秒，再加一个",
                operations: [
                  {
                    op: "marker.update",
                    timeline: "main",
                    marker: "m0",
                    changes: { time: "2" },
                  },
                  { op: "marker.add", timeline: "main", id: "m1", time: "4", name: "m1" },
                ],
              },
            },
          ]),
        );
      case 3:
        return fulfil(route, calls([add("m2", "6"), add("m9", "9")]));
      case 4:
        return fulfil(route, anthropicSays("那你想怎么改？"));
      // The second: allowed for the task, the second change goes without asking.
      case 5:
        return fulfil(route, calls([add("m3", "8")]));
      case 6:
        return fulfil(route, calls([add("m4", "10")]));
      case 7:
        return fulfil(route, anthropicSays("加好了。"));
      // The third: asked again, and people change the same marker meanwhile.
      case 8:
        return fulfil(
          route,
          calls([
            {
              name: "aq_edit",
              input: {
                operations: [
                  { op: "marker.update", timeline: "main", marker: "m0", changes: { name: "AI" } },
                ],
              },
            },
          ]),
        );
      default:
        return fulfil(route, anthropicSays("你刚改过它，我没动。"));
    }
  });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");

  // The switch, off until people turn it on.
  await goToSettingsGroup(page, "AI 聊天");
  const toggle = settingsOf(page).getByRole("switch", { name: "AI 改项目前先问我" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await toggle.scrollIntoViewIfNeeded();
  await shoot(page, "1-setting");
  await closeSettings(page);

  expect(
    await execute(page, {
      type: "marker.add",
      params: { timeline: "main", id: "m0", time: "1", name: "片头" },
    }),
  ).toBe(true);
  await tab(page, "chat").click();
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill("片头标记挪一下，再加几个");
  await box.press("Enter");

  // The card: what AI said the batch does, each place as on the card of changes, three answers.
  await expect(asking(page)).toBeVisible({ timeout: 15_000 });
  await expect(asking(page)).toContainText("要改 2 处");
  await expect(asking(page)).toContainText("片头标记挪到 2 秒，再加一个");
  await expect(asking(page).getByTestId("chat-change")).toHaveCount(2);
  expect(await markers(page)).toEqual({ m0: "片头@1" });
  await shoot(page, "2-card");
  await chat(page)
    .getByTestId("chat")
    .screenshot({
      path: test.info().outputPath("sd4-2-card-chat-330.png"),
    });
  // A line opens to before and after, as on the card of changes.
  const moved = asking(page).getByTestId("chat-change").filter({ hasText: "片头" });
  await moved.locator("button[aria-expanded]").click();
  const detail = moved.getByTestId("chat-change-detail");
  await expect(detail).toBeVisible();
  await expect(detail.locator('[data-field="time"]')).toContainText("→");
  await shoot(page, "3-card-open");

  // 允许: written as it was shown; the next change is asked again.
  await asking(page).getByTestId("chat-approve-once").click();
  await expect(asking(page)).toContainText("要改 1 处");
  expect(await markers(page)).toEqual({ m0: "片头@2", m1: "m1@4" });
  // 不允许: nothing is written, nor the change after it in the same answer; AI asks what instead.
  await asking(page).getByTestId("chat-approve-no").click();
  await expect(chat(page).getByText("那你想怎么改？")).toBeVisible({ timeout: 15_000 });
  await expect(asking(page)).toHaveCount(0);
  expect(await markers(page)).toEqual({ m0: "片头@2", m1: "m1@4" });
  // The steps say what people answered, and not allowing is no failure.
  await chat(page).getByTestId("chat-process").getByRole("button").first().click();
  const tools = chat(page).getByTestId("chat-tool");
  await expect(tools.filter({ hasText: "允许了 2 处" })).toHaveCount(1);
  await expect(tools.filter({ hasText: "没允许" })).toHaveCount(1);
  await expect(chat(page).locator('[data-testid="chat-tool"][data-state="failed"]')).toHaveCount(0);
  await expect(chat(page).locator('[data-testid="chat-tool"][data-state="held"]')).toHaveCount(2);
  await shoot(page, "4-answered");

  // 这次任务都允许, while the page is in the background: it says so, then asks no more this task.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { notices: typeof seen }).notices = seen;
    class Notice {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title: string) {
        seen.push(title);
      }
      addEventListener() {}
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Notice;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  await box.fill("都加上");
  await box.press("Enter");
  await expect(asking(page)).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { notices: unknown }).notices))
    .toEqual(["AI 要改项目，等你允许"]);
  await expect.poll(() => page.title()).toMatch(/^● /);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await asking(page).getByTestId("chat-approve-task").click();
  await expect(chat(page).getByText("加好了。")).toBeVisible({ timeout: 15_000 });
  expect(await markers(page)).toMatchObject({ m3: "m3@8", m4: "m4@10" });
  expect(requests).toBe(7);

  // Another task asks again; people change the same marker while it waits: nothing is written.
  await box.fill("把片头标记改名");
  await box.press("Enter");
  await expect(asking(page)).toBeVisible({ timeout: 15_000 });
  expect(
    await execute(page, {
      type: "marker.update",
      params: { timeline: "main", marker: "m0", changes: { name: "我改的" } },
    }),
  ).toBe(true);
  await asking(page).getByTestId("chat-approve-once").click();
  await expect(chat(page).getByText("你刚改过它，我没动。")).toBeVisible({ timeout: 15_000 });
  expect((await markers(page)).m0).toBe("我改的@2");
  const failed = chat(page).locator('[data-testid="chat-tool"][data-state="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed.getByTestId("chat-tool-error")).toContainText(
    "等你允许的时候，要改的地方被改过了",
  );
  await failed.scrollIntoViewIfNeeded();
  await shoot(page, "5-conflict");
});
