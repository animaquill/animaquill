import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  addModel,
  anthropicSays,
  isConnectionTest,
  closeSettings,
  goToSettingsGroup,
  settingsOf,
} from "./ai-support.ts";
import { content, expect, test, showTab } from "./support.ts";

/**
 * The input box, the bubble of models and the list of conversations, against a pretend Anthropic:
 * each conversation its own model, the star the default, drafts that a reload keeps, messages
 * queued while a task runs, deleting and copying conversations, and the chat before any service.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";
const WIDTHS = [420, 320] as const;

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

/** What the box holds, as its draft keeps it: its text with new lines, a block as its link. */
const draft = (page: Page) =>
  box(page).evaluate((root) => {
    let text = "";
    const walk = (node: Node, last: boolean) => {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
      else if (node instanceof HTMLElement && node.dataset["href"] !== undefined)
        text += `[${node.dataset["label"]}](${node.dataset["href"]})`;
      else if (node.nodeName === "BR") text += last ? "" : "\n";
      else {
        if ((node.nodeName === "DIV" || node.nodeName === "P") && text && !text.endsWith("\n"))
          text += "\n";
        const children = [...node.childNodes];
        children.forEach((child, at) => walk(child, last && at === children.length - 1));
      }
    };
    const children = [...root.childNodes];
    children.forEach((child, at) => walk(child, at === children.length - 1));
    return text;
  });

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

test("each conversation keeps its own model; the first favorite is the default, for new ones", async ({
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
  await closeSettings(page);
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-test");

  // The bubble: the models that are on, by service, the tick on this conversation's. No pack
  // under a model whose pack the rules choose; no favorites yet.
  await chat(page).getByTestId("chat-model").click();
  const bubble = chat(page).getByTestId("chat-model-bubble");
  await expect(bubble.getByTestId("chat-model-option")).toHaveCount(2);
  await expect(option(page, "claude-test").getByRole("option")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(bubble.getByTestId("chat-model-row-pack")).toHaveCount(0);
  await expect(bubble.locator('[data-group="favorites"]')).toHaveCount(0);
  // The model uses the general words: said at the bottom, with where to get a pack.
  await expect(bubble.getByTestId("chat-picker-generic")).toHaveText("这个模型用通用写法装适配包…");
  await shoot(page, "bubble", chat(page).getByTestId("chat"));
  // Clicked, a model is chosen and the bubble closes, the caret back in the box.
  await option(page, "claude-other").getByRole("option").click();
  await expect(bubble).toBeHidden();
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-other");
  await expect(box(page)).toBeFocused();
  // Found by a part of its name; Enter takes it and closes; Esc closes without choosing.
  await chat(page).getByTestId("chat-model").click();
  await bubble.getByRole("combobox", { name: "搜模型、服务" }).fill("TEST");
  await expect(bubble.getByTestId("chat-model-option")).toHaveCount(1);
  await bubble.getByRole("combobox", { name: "搜模型、服务" }).press("Enter");
  await expect(bubble).toBeHidden();
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-test");
  await page.keyboard.press("Alt+m");
  await bubble.getByRole("combobox", { name: "搜模型、服务" }).fill("OTHER");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-other");
  await chat(page).getByTestId("chat-model").click();
  await page.keyboard.press("Escape");
  await expect(bubble).toBeHidden();
  await send(page, "第一个对话");
  await expect(chat(page).getByText("claude-other 回答")).toBeVisible({ timeout: 15_000 });
  expect(asked.at(-1)?.model).toBe("claude-other");

  // Another conversation has the default, which the settings still say.
  await chat(page).getByTestId("chat-new").click();
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-test");
  await send(page, "第二个对话");
  await expect(chat(page).getByText("claude-test 回答")).toBeVisible({ timeout: 15_000 });
  expect(asked.at(-1)?.model).toBe("claude-test");

  // A star is a bookmark: the first one takes the default (what new conversations use) along,
  // first, and leaves it the default. Favorites are listed once, among the favorites.
  await chat(page).getByTestId("chat-model").click();
  await option(page, "claude-other").hover();
  await option(page, "claude-other").getByRole("button", { name: "收藏 claude-other" }).click();
  const favorites = bubble.locator('[data-group="favorites"]');
  await expect(favorites.getByTestId("chat-model-option")).toHaveCount(2);
  await expect(favorites.getByTestId("chat-model-option").first()).toHaveAttribute(
    "data-model",
    "claude-test",
  );
  await expect(favorites.getByTestId("chat-model-first")).toHaveCount(1);
  await expect(bubble.getByTestId("chat-model-option")).toHaveCount(2);
  // Searched, each model shows once, by its service.
  await bubble.getByRole("combobox", { name: "搜模型、服务" }).fill("claude");
  await expect(bubble.getByTestId("chat-model-option")).toHaveCount(2);
  await expect(favorites).toHaveCount(0);
  await bubble.getByRole("combobox", { name: "搜模型、服务" }).fill("");
  // Dragged first, it is what new conversations use; this conversation keeps its model.
  await favorites
    .locator('[data-model="claude-other"]')
    .dragTo(favorites.locator('[data-model="claude-test"]'));
  await expect(favorites.getByTestId("chat-model-option").first()).toHaveAttribute(
    "data-model",
    "claude-other",
  );
  await expect(option(page, "claude-test").getByRole("option")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // From the keyboard too: Alt+↓ and Alt+↑ on the one the cursor is on.
  await favorites.locator('[data-model="claude-other"]').hover();
  await bubble.getByRole("combobox", { name: "搜模型、服务" }).focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(favorites.getByTestId("chat-model-option").first()).toHaveAttribute(
    "data-model",
    "claude-test",
  );
  await page.keyboard.press("Alt+ArrowUp");
  await expect(favorites.getByTestId("chat-model-option").first()).toHaveAttribute(
    "data-model",
    "claude-other",
  );
  // Alt+M closes it again, the caret back in the box.
  await page.keyboard.press("Alt+m");
  await expect(bubble).toBeHidden();
  await expect(box(page)).toBeFocused();
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-test");
  await send(page, "还是第二个");
  await expect(chat(page).getByText("claude-test 回答")).toHaveCount(2, { timeout: 15_000 });
  expect(asked.at(-1)?.model).toBe("claude-test");
  await chat(page).getByTestId("chat-new").click();
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-other");

  // The first conversation, opened again from the list, still has its own.
  await chat(page).getByTestId("chat-title").click();
  await chat(page)
    .getByTestId("chat-switcher-row")
    .filter({ hasText: /^第一个对话/ })
    .click();
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-other");
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
  await closeSettings(page);
  await showTab(page, "chat");

  // Typed and not sent: there again after a reload.
  await box(page).fill("还没写完的话");
  await page.reload();
  await showTab(page, "chat");
  await expect.poll(() => draft(page)).toBe("还没写完的话");
  // The box grows with what is in it, up to ten lines.
  const before = (await box(page).boundingBox())?.height ?? 0;
  await box(page).fill(Array.from({ length: 6 }, (_, at) => `第 ${at + 1} 行`).join("\n"));
  await expect
    .poll(async () => (await box(page).boundingBox())?.height ?? 0)
    .toBeGreaterThan(before + 40);
  await box(page).fill(Array.from({ length: 30 }, (_, at) => `第 ${at + 1} 行`).join("\n"));
  const tall = (await box(page).boundingBox())?.height ?? 0;
  // One line to start with, about ten at most, then it scrolls.
  expect(tall).toBeGreaterThan(before * 6);
  expect(tall).toBeLessThan(before * 10);

  // While a task runs, Enter queues; what is queued shows above the box, and goes after it.
  await send(page, "慢慢来");
  await expect(chat(page).locator('[data-testid="chat-work"][data-tone]')).toBeVisible();
  await expect.poll(() => draft(page)).toBe("");
  await send(page, "排着的第一句");
  await send(page, "排着的第二句");
  const queued = chat(page).getByTestId("chat-queued");
  await expect(queued).toContainText("排队 · 排着的第一句");
  await expect(queued).toContainText("排队 · 排着的第二句");
  await shoot(page, "queued");
  // The second, taken back to change it.
  await queued.getByRole("button", { name: "撤回来改" }).nth(1).click();
  await expect.poll(() => draft(page)).toBe("排着的第二句");
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
  await closeSettings(page);
  await showTab(page, "chat");
  await send(page, "把字幕往上挪一点");
  await expect(chat(page).getByText("字幕往上挪了 12 像素。")).toBeVisible({ timeout: 15_000 });
  await send(page, "开场放慢一点");
  await expect(chat(page).getByText("开场放慢了。")).toBeVisible({ timeout: 15_000 });

  // A new conversation from the second turn: what came before, its words in the box, not sent.
  const second = chat(page).getByTestId("chat-task").nth(1);
  await second.getByTestId("chat-user").hover();
  await second.getByTestId("chat-user-more").click();
  await second.getByRole("menuitem", { name: "在新对话里重问这一句" }).click();
  await expect(chat(page).getByTestId("chat-forked")).toHaveText(
    "从《把字幕往上挪一点》第 2 轮分出来；那之后的改动还在项目里。",
  );
  await expect(chat(page).getByTestId("chat-task")).toHaveCount(1);
  await expect.poll(() => draft(page)).toBe("开场放慢一点");

  // Words of an answer, quoted into the box.
  const words = chat(page).getByTestId("chat-answer").getByText("字幕往上挪了 12 像素。");
  await words.selectText();
  await chat(page).getByTestId("chat-quote").click();
  await expect.poll(() => draft(page)).toBe("开场放慢一点\n\n> 字幕往上挪了 12 像素。\n\n");
  await send(page, "接着来");
  await expect(chat(page).getByTestId("chat-task")).toHaveCount(2, { timeout: 15_000 });

  // The switcher, under the title: today's, the one open ticked, the other one to go to.
  await chat(page).getByTestId("chat-title").click();
  const switcher = chat(page).getByTestId("chat-switcher");
  await expect(switcher.getByTestId("chat-switcher-row")).toHaveCount(2);
  await expect(switcher).toContainText("今天");
  await expect(switcher.locator('[data-testid="chat-switcher-row"][data-current]')).toHaveCount(1);
  await expect(switcher.getByTestId("chat-switcher-search")).toBeFocused();
  await shoot(page, "list");
  // ↓ Enter opens the other one; Esc closes it, back on the title.
  await page.keyboard.press("Escape");
  await expect(switcher).toBeHidden();
  await expect(chat(page).getByTestId("chat-title")).toBeFocused();

  // All of them, a page of its own over the conversation: renamed in its row.
  await chat(page).getByTestId("chat-title").click();
  await switcher.getByTestId("chat-switcher-all").click();
  const list = chat(page).getByTestId("chat-all");
  await expect(list.getByTestId("chat-conversation")).toHaveCount(2);
  await expect(list.getByTestId("chat-conversation").first()).toContainText(
    "从《把字幕往上挪一点》第 2 轮分出",
  );
  // Each says when, how much AI changed, and the model it had.
  const first = list.getByTestId("chat-conversation").filter({ hasText: /^把字幕往上挪一点/ });
  await expect(first).toContainText("claude-test");
  await first.hover();
  await first.getByRole("button", { name: /重命名/ }).click();
  await list.getByRole("textbox", { name: "重命名" }).fill("字幕的位置");
  await list.getByRole("button", { name: "好" }).click();
  await expect(list.getByTestId("chat-conversation").filter({ hasText: "字幕的位置" })).toHaveCount(
    1,
  );

  // Found by what was said in it.
  await list.getByTestId("chat-all-search").fill("12 像素");
  const hit = list.getByTestId("chat-search-hit");
  await expect(hit).toHaveCount(2);
  await expect(hit.filter({ hasText: "字幕的位置" })).toHaveCount(1);
  await expect(hit.first()).toContainText("12 像素");
  await list.getByTestId("chat-all-search").fill("");

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

  // The name of the one open, changed in place with a double click.
  await chat(page).getByTestId("chat-title").dblclick();
  const rename = chat(page).getByTestId("chat-title-rename");
  await rename.fill("开场的节奏");
  await rename.press("Enter");
  await expect(chat(page).getByTestId("chat-title")).toHaveText("开场的节奏");
});

test("before any service: where the key goes, and one click to adding Anthropic, then back", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.route(ANTHROPIC, (route) => answer(route, "OK"));
  await showTab(page, "chat");
  const start = chat(page).getByTestId("chat-onboarding");
  await expect(start).toContainText("key 不经过我们");
  await expect(start.getByTestId("chat-onboard-service")).toHaveCount(3);
  await shoot(page, "onboarding", chat(page).locator('[data-testid="chat-onboarding"]'));

  await start.locator('[data-testid="chat-onboard-service"][data-kind="anthropic"]').click();
  // Added at once, open at its key: given, back in the chat.
  const key = settingsOf(page).getByTestId("ai-service").getByTestId("ai-key");
  await expect(key).toBeVisible();
  await key.fill(KEY);
  await key.press("Enter");
  // Back in the chat, ready: the settings closed, the model, and things to try saying.
  await expect(settingsOf(page)).toBeHidden({ timeout: 15_000 });
  await expect(chat(page).getByTestId("chat-model")).toBeVisible({ timeout: 15_000 });
  // What to say, by how the project is: an empty timeline, nothing to cut, a playhead.
  const suggestions = chat(page).getByTestId("chat-suggestions");
  await expect(suggestions).toBeVisible();
  await suggestions.locator('[data-key="titleScene"]').click();
  await expect.poll(() => draft(page)).toBe("做一个 5 秒的片名场景");
  await shoot(page, "empty");
});

test("sends with Ctrl+Enter where people chose that, and Enter is a new line then", async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route(ANTHROPIC, (route) => {
    if (isConnectionTest(route)) return answer(route, "OK");
    asked.push(askedOf(route).said);
    return answer(route, "收到。");
  });
  await addAnthropic(page, KEY, "claude-test");
  await goToSettingsGroup(page, "AI 聊天");
  await settingsOf(page)
    .getByRole("radiogroup", { name: "发送键" })
    .getByRole("radio", { name: "Ctrl+Enter" })
    .click();
  await closeSettings(page);
  await showTab(page, "chat");
  // The placeholder teaches nothing; those who listen hear how it sends, the button says it.
  await expect(box(page)).toHaveAttribute("data-placeholder", "说说要做什么");
  await expect(box(page)).toHaveAttribute(
    "aria-label",
    "给 AI 发消息，Ctrl+Enter 发送，Enter 换行",
  );
  await box(page).fill("第一行");
  await box(page).press("Enter");
  await box(page).pressSequentially("第二行");
  await expect.poll(() => draft(page)).toBe("第一行\n第二行");
  expect(asked).toEqual([]);
  await box(page).press("Control+Enter");
  await expect(chat(page).getByText("收到。")).toBeVisible();
  // As JSON, where the new line is written out.
  expect(asked).toEqual([expect.stringContaining(String.raw`第一行\n第二行`)]);
});
