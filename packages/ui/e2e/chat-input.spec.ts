import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  addModel,
  anthropicSays,
  isConnectionTest,
  settingsOf,
} from "./ai-support.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The input box, the bubble of models and the list of conversations, against a pretend Anthropic:
 * each conversation its own model, the star the default, drafts that a reload keeps, messages
 * queued while a task runs, deleting and copying conversations, and the chat before any service.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";
const WIDTHS = [420, 320] as const;

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

/** What a request asked for: the model, and the last thing people said. */
function askedOf(route: Route): { model: string; said: string } {
  const body = route.request().postDataJSON() as {
    model: string;
    messages: { role: string; content: unknown }[];
  };
  const last = body.messages.findLast((message) => message.role === "user");
  return { model: body.model, said: JSON.stringify(last?.content ?? "") };
}

const answer = (route: Route, text: string) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body: anthropicSays(text),
  });

async function send(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

/** Saves a picture of the chat at each width the design asks for. */
async function shoot(page: Page, name: string, target = chat(page).getByTestId("chat")) {
  const panel = chat(page).getByTestId("chat");
  for (const width of WIDTHS) {
    await page.addStyleTag({
      content: `[data-testid="chat"] { width: ${width}px !important; }`,
    });
    await expect.poll(async () => (await panel.boundingBox())?.width).toBe(width);
    await target.screenshot({ path: test.info().outputPath(`cm3-${name}-${width}.png`) });
  }
}

const option = (page: Page, model: string) =>
  chat(page)
    .getByTestId("chat-model-bubble")
    .locator(`[data-testid="chat-model-option"][data-model="${model}"]`);

test("each conversation keeps its own model; the star changes the default, for new ones", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 2000, height: 1000 });
  const asked: { model: string; said: string }[] = [];
  await page.route(ANTHROPIC, (route) => {
    if (isConnectionTest(route)) return answer(route, "OK");
    const request = askedOf(route);
    asked.push(request);
    return answer(route, `${request.model} 回答`);
  });
  await addAnthropic(page, KEY, "claude-test");
  await addModel(page, "claude-other");
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test");

  // The bubble: the models that are on, by service, the tick on this conversation's, the star on
  // the default, and the model pack of the model under the cursor.
  await chat(page).getByTestId("chat-model").click();
  const bubble = chat(page).getByTestId("chat-model-bubble");
  await expect(bubble.getByTestId("chat-model-option")).toHaveCount(2);
  await expect(option(page, "claude-test").getByRole("option")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    option(page, "claude-test").getByRole("button", { name: "默认模型（新对话用）" }),
  ).toBeVisible();
  await expect(bubble.getByTestId("chat-model-pack")).toContainText("适配包");
  await shoot(page, "bubble", chat(page).getByTestId("chat"));
  // Found by a part of its name; Enter takes it.
  await bubble.getByRole("textbox", { name: "搜模型、服务" }).fill("OTHER");
  await expect(bubble.getByTestId("chat-model-option")).toHaveCount(1);
  await bubble.getByRole("textbox", { name: "搜模型、服务" }).press("Enter");
  await expect(bubble).toBeHidden();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-other");
  await send(page, "第一个对话");
  await expect(chat(page).getByText("claude-other 回答")).toBeVisible({ timeout: 15_000 });
  expect(asked.at(-1)?.model).toBe("claude-other");

  // Another conversation has the default, which the settings still say.
  await chat(page).getByTestId("chat-more").click();
  await chat(page).getByRole("menuitem", { name: "新对话" }).click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test");
  await send(page, "第二个对话");
  await expect(chat(page).getByText("claude-test 回答")).toBeVisible({ timeout: 15_000 });
  expect(asked.at(-1)?.model).toBe("claude-test");

  // The star makes another the default: this conversation keeps its model, a new one has it.
  await chat(page).getByTestId("chat-model").click();
  await option(page, "claude-other").hover();
  await option(page, "claude-other")
    .getByRole("button", { name: /设为默认模型/ })
    .click();
  await expect(
    option(page, "claude-other").getByRole("button", { name: "默认模型（新对话用）" }),
  ).toBeVisible();
  await expect(option(page, "claude-test").getByRole("option")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test");
  await send(page, "还是第二个");
  await expect(chat(page).getByText("claude-test 回答")).toHaveCount(2, { timeout: 15_000 });
  expect(asked.at(-1)?.model).toBe("claude-test");
  await chat(page).getByTestId("chat-more").click();
  await chat(page).getByRole("menuitem", { name: "新对话" }).click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-other");

  // The first conversation, opened again from the list, still has its own.
  await chat(page).getByTestId("chat-title").click();
  await chat(page)
    .getByTestId("chat-list")
    .getByRole("button", { name: /^第一个对话/ })
    .click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-other");
  await expect(chat(page).getByText("claude-other 回答")).toBeVisible();
});

test("a draft stays through a reload, and messages queue while a task runs", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 2000, height: 1000 });
  const asked: { model: string; said: string }[] = [];
  const waiting: Route[] = [];
  await page.route(ANTHROPIC, (route) => {
    if (isConnectionTest(route)) return answer(route, "OK");
    const request = askedOf(route);
    asked.push(request);
    if (request.said.includes("慢慢来")) return void waiting.push(route);
    return answer(route, `回答：${asked.length}`);
  });
  await addAnthropic(page, KEY, "claude-test");
  await tab(page, "chat").click();

  // Typed and not sent: there again after a reload.
  await box(page).fill("还没写完的话");
  await page.reload();
  await tab(page, "chat").click();
  await expect(box(page)).toHaveValue("还没写完的话");
  // The box grows with what is in it, up to ten lines.
  const before = (await box(page).boundingBox())?.height ?? 0;
  await box(page).fill(Array.from({ length: 6 }, (_, at) => `第 ${at + 1} 行`).join("\n"));
  await expect
    .poll(async () => (await box(page).boundingBox())?.height ?? 0)
    .toBeGreaterThan(before + 40);
  await box(page).fill(Array.from({ length: 30 }, (_, at) => `第 ${at + 1} 行`).join("\n"));
  const tall = (await box(page).boundingBox())?.height ?? 0;
  expect(tall).toBeLessThan(before * 6);

  // While a task runs, Enter queues; what is queued shows above the box, and goes after it.
  await send(page, "慢慢来");
  await expect(chat(page).getByTestId("chat-phase")).toBeVisible();
  await expect(box(page)).toHaveValue("");
  await send(page, "排着的第一句");
  await send(page, "排着的第二句");
  const queued = chat(page).getByTestId("chat-queued");
  await expect(queued).toContainText("排着：排着的第一句");
  await expect(queued).toContainText("排着：排着的第二句");
  await shoot(page, "queued");
  // The second, taken back to change it.
  await queued.getByRole("button", { name: "撤回来改" }).nth(1).click();
  await expect(box(page)).toHaveValue("排着的第二句");
  await expect(queued).not.toContainText("排着的第二句");
  await box(page).fill("");
  const slow = waiting.shift();
  await slow?.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body: anthropicSays("慢的回答"),
  });
  await expect(chat(page).getByText("慢的回答")).toBeVisible({ timeout: 15_000 });
  await expect(chat(page).getByTestId("chat-user")).toHaveCount(2, { timeout: 15_000 });
  await expect(chat(page).getByTestId("chat-user").last()).toHaveText("排着的第一句");
  await expect(queued).toBeHidden();
  await expect.poll(() => asked.at(-1)?.said).toContain("排着的第一句");
});

test("the list: rename, search, delete; a new conversation from a turn; quoting an answer", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.route(ANTHROPIC, (route) => {
    if (isConnectionTest(route)) return answer(route, "OK");
    const { said } = askedOf(route);
    return answer(route, said.includes("字幕") ? "字幕往上挪了 12 像素。" : "开场放慢了。");
  });
  await addAnthropic(page, KEY, "claude-test");
  await tab(page, "chat").click();
  await send(page, "把字幕往上挪一点");
  await expect(chat(page).getByText("字幕往上挪了 12 像素。")).toBeVisible({ timeout: 15_000 });
  await send(page, "开场放慢一点");
  await expect(chat(page).getByText("开场放慢了。")).toBeVisible({ timeout: 15_000 });

  // A new conversation from the second turn: what came before, its words in the box, not sent.
  const second = chat(page).getByTestId("chat-task").nth(1);
  await second.getByTestId("chat-user").hover();
  await second.getByRole("button", { name: "从这里开新对话" }).click();
  await expect(chat(page).getByTestId("chat-forked")).toHaveText(
    "从《把字幕往上挪一点》第 2 轮分出来；那之后的改动还在项目里。",
  );
  await expect(chat(page).getByTestId("chat-task")).toHaveCount(1);
  await expect(box(page)).toHaveValue("开场放慢一点");

  // Words of an answer, quoted into the box.
  const words = chat(page).getByTestId("chat-answer").getByText("字幕往上挪了 12 像素。");
  await words.selectText();
  await chat(page).getByTestId("chat-quote").click();
  await expect(box(page)).toHaveValue("开场放慢一点\n\n> 字幕往上挪了 12 像素。\n\n");
  await send(page, "接着来");
  await expect(chat(page).getByTestId("chat-task")).toHaveCount(2, { timeout: 15_000 });

  // The list, over the conversation: today's, the one open marked.
  await chat(page).getByTestId("chat-title").click();
  const list = chat(page).getByTestId("chat-list");
  await expect(list.getByTestId("chat-conversation")).toHaveCount(2);
  await expect(list).toContainText("今天");
  await shoot(page, "list");

  // Renamed in its row.
  await expect(list.getByTestId("chat-conversation").first()).toContainText(
    "从《把字幕往上挪一点》第 2 轮分出",
  );
  const first = list.getByTestId("chat-conversation").filter({ hasText: /^把字幕往上挪一点/ });
  await first.hover();
  await first.getByRole("button", { name: /重命名/ }).click();
  await list.getByRole("textbox", { name: "重命名" }).fill("字幕的位置");
  await list.getByRole("button", { name: "好" }).click();
  await expect(list.getByTestId("chat-conversation").filter({ hasText: "字幕的位置" })).toHaveCount(
    1,
  );

  // Found by what was said in it.
  await list.getByRole("textbox", { name: "搜这个项目的对话" }).fill("12 像素");
  const hit = list.getByTestId("chat-search-hit");
  await expect(hit).toHaveCount(2);
  await expect(hit.filter({ hasText: "字幕的位置" })).toHaveCount(1);
  await expect(hit.first()).toContainText("12 像素");
  await list.getByRole("textbox", { name: "搜这个项目的对话" }).fill("");

  // Deleted, after asking in the row.
  const renamed = list.getByTestId("chat-conversation").filter({ hasText: "字幕的位置" });
  await renamed.hover();
  await renamed.getByRole("button", { name: /删除/ }).click();
  await expect(list).toContainText("删除这个对话？");
  await expect(list).toContainText("对话里 AI 做的改动不会撤销。");
  await list.getByRole("button", { name: "删除", exact: true }).click();
  await expect(list.getByTestId("chat-conversation")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
});

test("before any service: where the key goes, and one click to adding Anthropic, then back", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.route(ANTHROPIC, (route) => answer(route, "OK"));
  await tab(page, "chat").click();
  const start = chat(page).getByTestId("chat-onboarding");
  await expect(start).toContainText("key 不经过我们");
  await expect(start.getByTestId("chat-onboard-service")).toHaveCount(3);
  await shoot(page, "onboarding", chat(page).locator('[data-testid="chat-onboarding"]'));

  await start.locator('[data-testid="chat-onboard-service"][data-kind="anthropic"]').click();
  const form = settingsOf(page).getByTestId("ai-add-form");
  await form.getByLabel("Key").fill(KEY);
  await form.getByRole("button", { name: "测试并添加" }).click();
  // Back in the chat, ready: the model, and things to try saying.
  await expect(chat(page).getByTestId("chat-model")).toBeVisible({ timeout: 15_000 });
  const examples = chat(page).getByTestId("chat-examples");
  await expect(examples).toBeVisible();
  await examples.getByRole("button", { name: "开场放慢一点" }).click();
  await expect(box(page)).toHaveValue("开场放慢一点");
  await shoot(page, "empty");
});
