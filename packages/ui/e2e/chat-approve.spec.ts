import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  goToSettingsGroup,
  settingsOf,
  openWork,
} from "./ai-support.ts";
import { content, devPageOnly, expect, test, showTab } from "./support.ts";
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
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
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

type Calls = Parameters<typeof anthropicCalls>[0];
/** One answer of the pretend model: calls of tools, or words. */
type Answer = Calls | string;

const add = (id: string, time: string) => ({
  name: "aq_edit",
  input: { operations: [{ op: "marker.add", timeline: "main", id, time, name: id }] },
});
const read = { name: "aq_timeline_read", input: { timeline: "main" } };
/** Moves the marker people made, and adds one: two places. */
const moveAndAdd = {
  name: "aq_edit",
  input: {
    summary: "片头标记挪到 2 秒，再加一个",
    operations: [
      { op: "marker.update", timeline: "main", marker: "m0", changes: { time: "2" } },
      { op: "marker.add", timeline: "main", id: "m1", time: "4", name: "m1" },
    ],
  },
};

/**
 * A model that gives these answers in order, a marker "片头" at 1 s that people made, and the
 * switch turned on in the settings, as people do: off until then. The chat is open.
 */
async function setUp(page: Page, answers: readonly Answer[], shot?: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  let requests = 0;
  await page.route(ANTHROPIC, (route) => {
    const asked = route.request().postDataJSON() as { max_tokens?: number; tools?: unknown };
    if (asked.max_tokens === 16) return route.fallback();
    if (asked.tools === undefined) return fulfil(route, anthropicSays("标记"));
    const answer = answers[requests] ?? "好了。";
    requests += 1;
    return fulfil(
      route,
      typeof answer === "string"
        ? anthropicSays(answer)
        : anthropicCalls(answer).replaceAll("toolu_", `toolu_${requests}_`),
    );
  });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");
  await goToSettingsGroup(page, "AI 聊天");
  const toggle = settingsOf(page).getByRole("switch", { name: "AI 改项目前先问我" });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  if (shot) {
    await toggle.scrollIntoViewIfNeeded();
    await shoot(page, shot);
  }
  await closeSettings(page);
  const made = { timeline: "main", id: "m0", time: "1", name: "片头" };
  expect(await execute(page, { type: "marker.add", params: made })).toBe(true);
  await showTab(page, "chat");
  return { requests: () => requests };
}

async function send(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
  await expect(asking(page)).toBeVisible({ timeout: 15_000 });
}

test("allowed: the card shows what would change and opens to before and after; the next is asked again", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setUp(page, [[read], [moveAndAdd], [add("m2", "6")], "好了。"], "1-setting");
  await send(page, "片头标记挪一下，再加几个");

  // What AI said the batch does, each place as it would be, not yet done, and three answers.
  await expect(asking(page)).toContainText("要改 2 处");
  await expect(asking(page)).toContainText("片头标记挪到 2 秒，再加一个");
  const lines = asking(page).getByTestId("chat-change");
  await expect(lines).toHaveText([/把标记「片头」的时间从 1 改成 2/, /新加标记「m1」/]);
  await expect(asking(page)).not.toContainText("新加了");
  expect(await markers(page)).toEqual({ m0: "片头@1" });
  await shoot(page, "2-card");
  await chat(page)
    .getByTestId("chat")
    .screenshot({ path: test.info().outputPath("sd4-2-card-chat-330.png") });

  // A line opens to before and after, as on the card of changes.
  const moved = lines.filter({ hasText: "片头" });
  await moved.locator("button[aria-expanded]").click();
  const time = moved.getByTestId("chat-change-detail").locator('[data-field="time"]');
  await expect(time).toContainText("时间");
  await expect(time).toContainText(/1\s*→\s*2/);
  await shoot(page, "3-card-open");

  // Written as it was shown; the next change is asked again, and nothing of it is written yet.
  await asking(page).getByTestId("chat-approve-once").click();
  await expect(asking(page)).toContainText("要改 1 处");
  expect(await markers(page)).toEqual({ m0: "片头@2", m1: "m1@4" });
  await asking(page).getByTestId("chat-approve-once").click();
  await expect(chat(page).getByText("好了。")).toBeVisible({ timeout: 15_000 });
  expect(await markers(page)).toEqual({ m0: "片头@2", m1: "m1@4", m2: "m2@6" });
  // Written, the card of the task says it as done.
  await expect(chat(page).getByTestId("chat-card")).toContainText("新加了标记「m1」");
});

test("not allowed: nothing is written, nor the rest of the answer, and AI asks what instead", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { requests } = await setUp(page, [[add("m2", "6"), add("m9", "9")], "那你想怎么改？"]);
  await send(page, "加两个标记");
  await expect(asking(page)).toContainText("要改 1 处");
  await asking(page).getByTestId("chat-approve-no").click();
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("那你想怎么改？", {
    timeout: 15_000,
  });
  await expect(asking(page)).toHaveCount(0);
  expect(await markers(page)).toEqual({ m0: "片头@1" });
  expect(requests()).toBe(2);
  // The steps say what people answered; not allowing is no failure, nor what it held back.
  await chat(page).getByTestId("chat-work").getByRole("button").first().click();
  const tools = chat(page).getByTestId("chat-tool");
  await expect(tools.filter({ hasText: "没允许" })).toHaveCount(1);
  await expect(chat(page).locator('[data-testid="chat-tool"][data-state="failed"]')).toHaveCount(0);
  await expect(chat(page).locator('[data-testid="chat-tool"][data-state="held"]')).toHaveCount(2);
  await shoot(page, "4-answered");
});

test("allowed for the task, from the background: told, then not asked again; the next task asks", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await setUp(page, [[add("m3", "8")], [add("m4", "10")], "加好了。", [add("m5", "12")]]);
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
  await send(page, "都加上");
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
  expect(await markers(page)).toEqual({ m0: "片头@1", m3: "m3@8", m4: "m4@10" });
  // Another task: asked again.
  await send(page, "再加一个");
  expect(await markers(page)).toEqual({ m0: "片头@1", m3: "m3@8", m4: "m4@10" });
  await asking(page).getByTestId("chat-approve-once").click();
  await expect.poll(() => markers(page)).toMatchObject({ m5: "m5@12" });
});

test("people change the same place while asked: nothing is written, and the step says why", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const rename = {
    name: "aq_edit",
    input: {
      operations: [
        { op: "marker.update", timeline: "main", marker: "m0", changes: { name: "AI" } },
      ],
    },
  };
  await setUp(page, [[read], [rename], "你刚改过它，我没动。"]);
  await send(page, "把片头标记改名");
  const changed = { timeline: "main", marker: "m0", changes: { name: "我改的" } };
  expect(await execute(page, { type: "marker.update", params: changed })).toBe(true);
  await asking(page).getByTestId("chat-approve-once").click();
  await expect(chat(page).getByText("你刚改过它，我没动。")).toBeVisible({ timeout: 15_000 });
  expect((await markers(page)).m0).toBe("我改的@1");
  await openWork(chat(page));
  const failed = chat(page).locator('[data-testid="chat-tool"][data-state="failed"]');
  await expect(failed).toHaveCount(1);
  await failed.getByRole("button").first().click();
  await expect(failed.getByTestId("chat-tool-error")).toHaveText(
    "没有成功：等你允许的时候，要改的地方被改过了",
  );
  await failed.scrollIntoViewIfNeeded();
  await shoot(page, "5-conflict");
});
