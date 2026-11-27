import type { Page, Request, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
} from "./ai-support.ts";
import { content, devPageOnly, expect, test, showTab } from "./support.ts";
import { markers, reload } from "./undo-support.ts";

/**
 * "先出方案" (S-D3): the switch under the input box; while it is on, AI only reads and hands a plan,
 * and what it tries to change is held, not shown as a failure. The plan's lines change with a click,
 * go with ×, come with +; its times go to their moment; "按这个做" sends it as people's message and
 * switches it off, and AI does it. Pictures of each go to the output of the test.
 */

devPageOnly("window.aqState");

const chat = (page: Page) => content(page, "chat");
/** The plan that waits for people. */
const card = (page: Page) => chat(page).locator('[data-testid="chat-plan"][data-state="open"]');
const cardIn = (page: Page, state: string) =>
  chat(page).locator(`[data-testid="chat-plan"][data-state="${state}"]`);
const steps = (page: Page) => card(page).getByTestId("chat-plan-step");
/** The pill that says "先出方案" is on, under the box. */
const pill = (page: Page) => chat(page).getByTestId("chat-mode-plan");
const timeShown = (page: Page) =>
  page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" });
const shoot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`sd3-${name}.png`) });

interface Sent {
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}
/** The last message of people in a request, as Anthropic gets it. */
const lastWords = (request: Request | undefined) => {
  const sent = request?.postDataJSON() as Sent | undefined;
  return JSON.stringify(sent?.messages.findLast(({ role }) => role === "user"));
};

const PLAN = {
  kind: "plan",
  title: "片头 30 秒",
  steps: [
    { text: "黑底淡入 logo，低音起", from: "0", to: "4" },
    { text: "三张产品图依次推进，每张 2.5 秒", from: "4", to: "12" },
    { text: "标题逐字弹出，背景慢推", from: "12", to: "30" },
  ],
  length: "30",
  style: "冷色、干净",
};

const fulfil = (route: Route, body: string) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body,
  });

test("plan first: changes are held, the plan is changed and accepted, and then AI does it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const requests: Request[] = [];
  await page.route(ANTHROPIC, (route) => {
    const asked = route.request().postDataJSON() as { max_tokens?: number; tools?: unknown };
    if (asked.max_tokens === 16) return route.fallback();
    // A title for the conversation, which goes without the tools.
    if (asked.tools === undefined) return fulfil(route, anthropicSays("片头"));
    requests.push(route.request());
    const marker = (id: string) => ({
      name: "aq_edit",
      input: { operations: [{ op: "marker.add", timeline: "main", id, time: "1", name: id }] },
    });
    // Each answer has calls of its own ids, as a service gives them.
    const calls = (list: Parameters<typeof anthropicCalls>[0]) =>
      anthropicCalls(list).replaceAll("toolu_", `toolu_${requests.length}_`);
    switch (requests.length) {
      // It tries to change the project first, as a model may: once as a dry run, once for real.
      case 1:
        return fulfil(
          route,
          calls([
            { name: "aq_edit", input: { ...marker("m0").input, dry_run: true } },
            marker("m0"),
          ]),
        );
      case 2:
        return fulfil(
          route,
          calls([{ name: "aq_propose", input: { ...PLAN, title: "片头 40 秒" } }]),
        );
      case 3:
        return fulfil(route, calls([{ name: "aq_propose", input: PLAN }]));
      case 4:
        return fulfil(route, calls([marker("m1")]));
      default:
        return fulfil(route, anthropicSays("做好了。"));
    }
  });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");
  await closeSettings(page);
  await showTab(page, "chat");

  // The switch: off in a new conversation, lit once on.
  await expect(pill(page)).toBeHidden();
  await chat(page).getByTestId("chat-plus").click();
  await expect(chat(page).getByTestId("chat-plus-plan")).toHaveAttribute("aria-checked", "false");
  await chat(page).getByTestId("chat-plus-plan").click();
  await expect(pill(page)).toBeVisible();
  await shoot(page, "1-switch");

  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill("做个 30 秒的片头");
  await box.press("Enter");
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  // AI was told, after people's words; what it tried to change was held, and is no failure.
  expect(lastWords(requests[0])).toContain("Plan first: only read and look");
  expect(lastWords(requests[0])).not.toContain("按这个做");
  expect(await markers(page)).toEqual({});
  await expect(chat(page).locator('[data-testid="chat-tool"][data-state="failed"]')).toHaveCount(0);
  await chat(page).getByTestId("chat-work").getByRole("button").first().click();
  await expect(chat(page).locator('[data-testid="chat-tool"][data-state="held"]')).toHaveCount(2);
  await chat(page).getByTestId("chat-work").getByRole("button").first().click();

  // Not quite: said in the box, with the switch still on, and a new version replaces the card.
  await box.fill("短一点");
  await box.press("Enter");
  await expect(cardIn(page, "replaced")).toContainText("片头 40 秒");
  await expect(cardIn(page, "replaced")).toContainText("已换新方案");
  await expect(card(page)).toContainText("片头 30 秒");
  expect(lastWords(requests[2])).toContain("Plan first: only read and look");

  await expect(steps(page)).toHaveCount(3);
  await expect(steps(page).first()).toContainText("黑底淡入 logo，低音起");
  await expect(steps(page).first().getByTestId("chat-chip")).toHaveText(["0:00", "0:04"]);
  await expect(card(page).getByTestId("chat-plan-end")).toContainText("风格 冷色、干净");
  await shoot(page, "2-plan-card");

  // A time goes to its moment.
  await steps(page).first().getByTestId("chat-chip").nth(1).click();
  await expect(timeShown(page)).toContainText("0:04");

  // On hovering a line, a pencil and ×; the pencil opens the line, Esc leaves it as it was.
  await steps(page).first().hover();
  await steps(page).first().getByRole("button", { name: "改这一步" }).click();
  await card(page).getByRole("textbox", { name: "改这一步" }).press("Escape");
  await expect(steps(page).first()).toContainText("黑底淡入 logo，低音起");

  // A line changes with a click, one goes with ×, one comes with +.
  await steps(page).nth(1).getByRole("button", { name: "三张产品图依次推进，每张 2.5 秒" }).click();
  const input = card(page).getByRole("textbox", { name: "改这一步" });
  await input.fill("三张产品图依次推进，每张 2 秒");
  await input.press("Enter");
  await steps(page).nth(2).hover();
  await steps(page).nth(2).getByRole("button", { name: "删掉这一步" }).click();
  await expect(steps(page)).toHaveCount(2);
  await card(page).getByTestId("chat-plan-add").click();
  await card(page).getByRole("textbox", { name: "改这一步" }).fill("结尾留白 1 秒");
  await card(page).getByRole("textbox", { name: "改这一步" }).press("Enter");
  await expect(steps(page)).toHaveCount(3);
  await expect(steps(page).nth(1)).toContainText("每张 2 秒");
  await expect(steps(page).nth(2)).toContainText("结尾留白 1 秒");

  // What people changed is there after a reload, and so is the switch.
  await reload(page);
  await expect(steps(page)).toHaveCount(3);
  await expect(steps(page).nth(2)).toContainText("结尾留白 1 秒");
  await expect(pill(page)).toBeVisible();
  await shoot(page, "3-plan-edited");

  // The chat 330 (as it opens here), 390 and 420 wide: the model keeps its name, send its icon.
  const panel = chat(page).getByTestId("chat");
  for (const width of [330, 390, 420]) {
    // Wider by the edge between the chat and what is left of it, as people drag it.
    const edge = await panel.boundingBox();
    if (edge && Math.abs(edge.width - width) > 2) {
      const y = edge.y + edge.height / 2;
      await page.mouse.move(edge.x - 1, y);
      await page.mouse.down();
      await page.mouse.move(edge.x - 1 - (width - edge.width), y, { steps: 5 });
      await page.mouse.up();
    }
    await expect(chat(page).getByTestId("chat-model")).toBeVisible();
    await panel.screenshot({ path: test.info().outputPath(`sd3-chat-${width}.png`) });
  }

  // A phone: the pill keeps its icon and ×; "+" says it is on, as an item ticked.
  await page.setViewportSize({ width: 390, height: 844 });
  await showTab(page, "chat");
  await card(page).scrollIntoViewIfNeeded();
  await expect(pill(page)).toBeVisible();
  await expect(chat(page).getByTestId("chat-model")).toBeVisible();
  await shoot(page, "390-plan");
  await chat(page).getByTestId("chat-plus").click();
  await expect(chat(page).getByRole("menuitemcheckbox", { name: "先出方案" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await shoot(page, "390-menu");
  await chat(page).getByTestId("chat-plus").click();
  await page.setViewportSize({ width: 1440, height: 900 });

  // 按这个做: the plan as changed goes as people's message, the switch goes off, and AI does it.
  await card(page).getByTestId("chat-plan-accept").click();
  await expect(chat(page).getByText("做好了。")).toBeVisible({ timeout: 15_000 });
  await expect(pill(page)).toBeHidden();
  const accepted = chat(page).getByTestId("chat-user").last();
  await expect(accepted).toContainText("按这个做：片头 30 秒");
  await expect(accepted).toContainText("每张 2 秒");
  await expect(accepted).toContainText("结尾留白 1 秒");
  await expect(accepted).not.toContainText("标题逐字弹出");
  await expect(accepted.getByTestId("chat-chip")).toHaveText([
    "0:00",
    "0:04",
    "0:04",
    "0:12",
    "0:30",
  ]);
  const words = lastWords(requests[3]);
  expect(words).toContain("aq://time?timeline=main&t=4");
  expect(words).not.toContain("Plan first");
  expect(await markers(page)).toEqual({ m1: "m1" });
  // The plan is one line now, which says it was accepted.
  // Only the message of the task that runs says to plan first.
  expect(JSON.stringify((requests[3]?.postDataJSON() as Sent | undefined)?.messages)).not.toContain(
    "Plan first",
  );
  await expect(cardIn(page, "accepted")).toContainText("片头 30 秒");
  await expect(cardIn(page, "accepted")).toContainText("已按这个做");
  await expect(chat(page).getByTestId("chat-plan-accept")).toHaveCount(0);
  await shoot(page, "4-accepted");
});
