import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicSays,
  isConnectionTest,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The page of AI models in the settings: adding a service from the cards, testing it, the models
 * to turn on and the default among them, settings of before, two windows, and the narrow tab.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";
const shot = (name: string) => ({ path: test.info().outputPath(name) });
const chat = (page: Page) => content(page, "chat");

const ok = (route: Route, text = "OK") =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body: anthropicSays(text),
  });

const refuse = (route: Route) =>
  route.fulfill({
    status: 401,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` },
    }),
  });

/** What the settings keep, as this browser has them. */
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("animaquill.ai") ?? "null")) as Promise<{
    version?: number;
    services: { id: string; enabled: string[]; model: string }[];
    current?: string;
    default?: { service: string; model: string };
    reasoningFor?: Record<string, string>;
  } | null>;

test("adds a service from the cards: tested, its recommended models on, the first the default", async ({
  page,
}) => {
  const sent: Record<string, unknown>[] = [];
  await page.route(ANTHROPIC, (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return ok(route);
  });
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  // Nothing yet: the cards right away.
  const wall = settings.getByTestId("ai-add");
  await expect(wall).toBeVisible();
  await expect(wall.getByRole("region", { name: "常用" })).toBeVisible();
  await expect(wall.getByRole("region", { name: "自己的服务" })).toBeVisible();

  // Found by name, and by a model it has.
  const search = wall.getByRole("searchbox", { name: "搜服务：名字、模型" });
  await search.fill("千问");
  await expect(wall.getByTestId("ai-kind")).toHaveCount(1);
  await search.fill("opus");
  await expect(wall.locator('[data-testid="ai-kind"][data-kind="anthropic"]')).toBeVisible();
  await expect(wall.locator('[data-testid="ai-kind"][data-kind="deepseek"]')).toHaveCount(0);
  await search.fill("");

  // What one's own server through Chat Completions cannot do, said where it is picked.
  await wall.locator('[data-testid="ai-kind"][data-kind="openai-compatible"]').click();
  await expect(wall.getByTestId("ai-gpt6")).toContainText("GPT-6 系列在这条路上调不了工具");
  await wall.getByRole("button", { name: "取消" }).click();

  const card = wall.locator('[data-testid="ai-kind"][data-kind="anthropic"]');
  await expect(card).toContainText(/API key · \d+ 个模型/);
  await card.click();
  const form = wall.getByTestId("ai-add-form");
  await expect(form).toContainText(
    "测通后启用 Claude Opus 5.5、Claude Sonnet 5.5、Claude Haiku 5.5，并设为默认",
  );
  await expect(form).toContainText("不支持 Claude 订阅登录");
  await expect(form.getByRole("button", { name: "测试并添加" })).toBeDisabled();
  await form.getByLabel("Key").fill(KEY);
  await settings.screenshot(shot("wide-wall.png"));
  await form.getByLabel("Key").press("Enter");

  // Added: the key shows by its end only, the test, the models it starts with.
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-key-saved")).toHaveText("••••••••••••CRET");
  await expect(service.getByTestId("ai-test")).toContainText(/连上了 · \d+ 毫秒 · 回答“OK”/);
  await expect(service.getByTestId("ai-models-count")).toHaveText(/^3\/\d+ 启用$/);
  await expect(settings.getByTestId("ai-default-model")).toHaveText(
    "★ Claude Opus 5.5 · Anthropic",
  );
  await expect(settings.getByTestId("ai-service-item")).toHaveCount(1);
  await expect(settings.getByTestId("ai-service-item").locator('[data-state="ok"]')).toHaveCount(1);
  // The test asked the cheapest of them for a word.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 16 });
  expect(await page.content()).not.toContain("SECRET");
  const kept = await saved(page);
  expect(kept?.version).toBe(2);
  expect(kept?.services[0]?.enabled).toEqual([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]);
  expect(JSON.stringify(kept)).not.toContain("SECRET");
  await settings.screenshot(shot("wide-detail.png"));
  // The chat sends to the default model, and its name there opens it in the settings.
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("Claude Opus 5.5");
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill("你好");
  await box.press("Enter");
  await expect(chat(page).getByText("OK", { exact: true })).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ model: "claude-opus-5-5" });
  await chat(page).getByTestId("chat-model").click();
  await expect(settings.getByTestId("ai-service")).toBeVisible();

  // With the window to themselves, the pages on the left.
  for (const other of ["assets", "properties"]) {
    if ((await tab(page, other).count()) === 0) continue;
    await tab(page, other).click({ button: "right" });
    await page.getByRole("menuitem", { name: "全部关闭" }).click();
  }
  await expect(settings.getByRole("navigation", { name: "设置分组" })).toHaveCSS(
    "flex-direction",
    "column",
  );
  await settings.screenshot(shot("wide-full.png"));
});

test("a refused key says so, in adding and in testing, and the service can be added anyway", async ({
  page,
  problems,
}) => {
  let answer: (route: Route) => Promise<void> = refuse;
  await page.route(ANTHROPIC, (route) => answer(route));
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  const wall = settings.getByTestId("ai-add");
  await wall.locator('[data-testid="ai-kind"][data-kind="anthropic"]').click();
  const form = wall.getByTestId("ai-add-form");
  await form.getByLabel("Key").fill(KEY);
  await form.getByRole("button", { name: "测试并添加" }).click();
  await expect(form.getByTestId("ai-test")).toHaveText(/key 不对/);
  await form.getByTestId("ai-test-failure").locator("summary").click();
  await expect(form.getByTestId("ai-test-failure")).toContainText("服务拒绝了这个 key");
  await expect(form.getByTestId("ai-test-failure")).toContainText("401");
  expect(await page.content()).not.toContain("SECRET");
  await settings.screenshot(shot("wide-add-failed.png"));

  await form.getByTestId("ai-add-anyway").click();
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-test")).toHaveText(/key 不对/);
  await expect(
    settings.getByTestId("ai-service-item").locator('[data-state="failed"]'),
  ).toHaveCount(1);
  await service.getByTestId("ai-test-failure").locator("summary").click();
  await settings.screenshot(shot("wide-test-failed.png"));

  // Right now: the test says so, and so does one of a model.
  answer = (route) => ok(route);
  await service.getByRole("button", { name: "测试连接" }).click();
  await expect(service.getByTestId("ai-test")).toContainText("连上了");
  await expect(settings.getByTestId("ai-service-item").locator('[data-state="ok"]')).toHaveCount(1);
  const sonnet = service.locator('[data-testid="ai-model"][data-model="claude-sonnet-5-5"]');
  answer = (route) =>
    route.fulfill({
      status: 404,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model" } }),
    });
  await sonnet.getByRole("button", { name: "测", exact: true }).click();
  await expect(sonnet.getByTestId("ai-model-test")).toHaveText(/找不到/);

  // Without its key: said beside it, and how to give one.
  await service.getByRole("button", { name: "删除", exact: true }).click();
  await expect(settings.getByTestId("ai-service-item").getByText("缺 key")).toBeVisible();
  // A test of before does not count for the next key.
  await expect(service.getByTestId("ai-test")).toHaveCount(0);
  await expect(service).toContainText(/填上 key 就能用这家的 \d+ 个模型/);
  await settings.screenshot(shot("wide-no-key.png"));
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource/.test(p)),
  );
});

test("models: on and off, the default, at least one stays on, one named by hand, its reasoning", async ({
  page,
}) => {
  const sent: Record<string, unknown>[] = [];
  await page.route(ANTHROPIC, (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return ok(route, "好的");
  });
  await addAnthropic(page, KEY);
  const settings = settingsOf(page);
  const service = settings.getByTestId("ai-service");
  const row = (model: string) => service.locator(`[data-testid="ai-model"][data-model="${model}"]`);

  // Another default: it is the one the chat uses.
  await row("claude-sonnet-5-5").getByRole("button", { name: "设为默认模型" }).click();
  await expect(settings.getByTestId("ai-default-model")).toHaveText(
    "★ Claude Sonnet 5.5 · Anthropic",
  );
  // Off, the default goes to one that is on.
  await row("claude-sonnet-5-5").getByRole("switch").uncheck();
  await expect(settings.getByTestId("ai-default-model")).toHaveText(
    "★ Claude Opus 5.5 · Anthropic",
  );
  await row("claude-haiku-5-5").getByRole("switch").uncheck();
  // The last one on cannot go off, and says why.
  await expect(row("claude-opus-5-5").getByRole("switch")).toBeDisabled();
  await expect(row("claude-opus-5-5").getByRole("switch")).toHaveAttribute(
    "title",
    "至少要留一个启用的模型。",
  );
  await expect(service.getByRole("button", { name: "全部停用" })).toHaveCount(0);

  // A model named by hand, with how much it reads; on, and the default by its star.
  await service.getByRole("button", { name: "手动加一个模型名" }).click();
  const adding = service.getByTestId("ai-add-model");
  await adding.getByLabel("模型名").fill("claude-next-6");
  await adding.getByLabel("上下文窗口（token）").fill("400000");
  await adding.getByRole("button", { name: "加上并启用" }).click();
  await expect(row("claude-next-6")).toContainText("400k · 价格未知");
  await expect(row("claude-next-6")).toContainText("手动加的");
  await row("claude-next-6").getByRole("button", { name: "设为默认模型" }).click();

  // How hard the default reasons, unless the conversation says otherwise.
  await row("claude-opus-5-5").getByRole("button", { name: "设为默认模型" }).click();
  await row("claude-opus-5-5").getByRole("button", { name: /展开/ }).click();
  const reasoning = row("claude-opus-5-5").getByRole("combobox", { name: "默认推理强度" });
  await expect(reasoning.locator("option:checked")).toHaveText("按适配包（中）");
  await reasoning.selectOption({ label: "高" });
  await expect
    .poll(async () => (await saved(page))?.reasoningFor)
    .toEqual({ "claude-opus-5-5": "high" });
  await settings.screenshot(shot("wide-models.png"));

  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("Claude Opus 5.5");
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill("你好");
  await box.press("Enter");
  await expect(chat(page).getByText("好的")).toBeVisible();
  const asked = JSON.stringify(sent.at(-1));
  expect(asked).toContain('"model":"claude-opus-5-5"');
  // Its pack says medium; people said high.
  expect(asked).toContain('"effort":"high"');
  expect(asked).not.toContain('"effort":"medium"');
});

test("two windows follow each other, also in what is typed in the settings", async ({ page }) => {
  await addAnthropic(page, KEY);
  const other = await page.context().newPage();
  await other.goto(page.url());
  await openSettingsPage(other, "AI 模型");
  const here = settingsOf(page).getByTestId("ai-service");
  const there = settingsOf(other).getByTestId("ai-service");
  await expect(there.getByTestId("ai-key-saved")).toHaveText("••••••••••••CRET");

  // The address, typed here, is there in the field there, which was open all along.
  await there.getByTestId("ai-advanced").locator("summary").click();
  await expect(there.getByLabel("地址")).toHaveValue("https://api.anthropic.com");
  await here.getByTestId("ai-advanced").locator("summary").click();
  await here.getByLabel("地址").fill("https://gateway.example/anthropic");
  await here.getByLabel("地址").press("Enter");
  await expect(there.getByLabel("地址")).toHaveValue("https://gateway.example/anthropic");
  await expect(there).toContainText("已改");

  // A default chosen there is the default here.
  await there
    .locator('[data-testid="ai-model"][data-model="claude-haiku-5-5"]')
    .getByRole("button", { name: "设为默认模型" })
    .click();
  await expect(settingsOf(page).getByTestId("ai-default-model")).toHaveText(
    "★ Claude Haiku 5.5 · Anthropic",
  );
  await other.close();
});

test("narrow, one level at a time: the pages, the services, one service, and back", async ({
  page,
  problems,
}) => {
  await addAnthropic(page, KEY);
  // The settings 420 wide, as in a group at the side: the middle of the window does not get that
  // narrow, so the test makes the tab so.
  const settings = settingsOf(page);
  const panel = settings.getByTestId("settings-panel");
  await page.addStyleTag({
    content: '[data-testid="settings-panel"] { width: 420px !important; }',
  });
  await expect.poll(async () => (await panel.boundingBox())?.width).toBe(420);
  const pages = settings.getByRole("navigation", { name: "设置分组" });
  // Open on the service that was added: up to the services, then up to the pages.
  await settings.getByRole("button", { name: "AI 模型" }).click();
  await expect(settings.getByTestId("ai-service")).toBeHidden();
  await settings.getByTestId("settings-back").first().click();
  await expect(pages).toBeVisible();
  await panel.screenshot(shot("narrow-pages.png"));
  await pages.getByRole("button", { name: "AI 模型" }).click();
  await expect(pages).toBeHidden();
  await expect(settings.getByTestId("ai-service")).toBeHidden();
  await panel.screenshot(shot("narrow-list.png"));

  await settings.getByTestId("ai-service-item").click();
  const service = settings.getByTestId("ai-service");
  await expect(service).toBeVisible();
  await expect(settings.getByTestId("ai-service-item")).toBeHidden();
  await panel.screenshot(shot("narrow-detail.png"));
  await settings.getByRole("button", { name: "AI 模型" }).click();
  await expect(settings.getByTestId("ai-service-item")).toBeVisible();

  // The cards, a test that fails, and a service without its key, at this width.
  await settings.getByTestId("ai-add-service").click();
  const wall = settings.getByTestId("ai-add");
  await wall.locator('[data-testid="ai-kind"][data-kind="anthropic"]').click();
  await wall.getByTestId("ai-add-form").getByLabel("Key").fill("sk-ant-wrong-key-000000");
  await page.route(ANTHROPIC, (route) => (isConnectionTest(route) ? refuse(route) : route.abort()));
  await wall.getByRole("button", { name: "测试并添加" }).click();
  await expect(wall.getByTestId("ai-test")).toHaveText(/key 不对/);
  await panel.screenshot(shot("narrow-wall-failed.png"));
  await wall.getByTestId("ai-add-anyway").click();
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  await settings
    .getByTestId("ai-service")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await settings.getByRole("button", { name: "AI 模型" }).click();
  await expect(settings.getByTestId("ai-service-item").getByText("缺 key")).toBeVisible();
  await panel.screenshot(shot("narrow-no-key.png"));

  // Back up to the pages.
  await settings.getByTestId("settings-back").first().click();
  await expect(pages).toBeVisible();
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource/.test(p)),
  );
});

test("settings of before come up with their services, models, choices and keys", async ({
  page,
}) => {
  await page.evaluate(async (key) => {
    localStorage.setItem(
      "animaquill.ai",
      JSON.stringify({
        services: [
          {
            id: "service-old",
            kind: "anthropic",
            name: "我的 Anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-test",
            route: "direct",
          },
          {
            id: "x",
            kind: "from-a-newer-editor",
            name: "X",
            baseUrl: "https://x",
            model: "m",
            route: "direct",
          },
        ],
        current: "service-old",
        maxToolCalls: 77,
        packFor: { "claude-test": "animaquill/claude-5" },
      }),
    );
    const open = indexedDB.open("animaquill-keys", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys", { keyPath: "service" });
    const database = await new Promise<IDBDatabase>((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    const transaction = database.transaction("keys", "readwrite");
    transaction.objectStore("keys").put({ service: "service-old", key });
    await new Promise((resolve) => {
      transaction.oncomplete = resolve;
    });
    database.close();
  }, KEY);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  await expect(settings.getByTestId("ai-service-item")).toHaveCount(1);
  await expect(settings.getByTestId("ai-default-model")).toHaveText(
    "★ claude-test · 我的 Anthropic",
  );
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-key-saved")).toHaveText("••••••••••••CRET");
  await expect(
    service.locator('[data-testid="ai-model"][data-model="claude-test"]').getByRole("switch"),
  ).toBeChecked();
  await expect(settings.getByRole("spinbutton")).toHaveValue("77");
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test");

  // Written as version 2 once something changes, with what a page of before reads, and the service
  // this editor cannot read kept.
  await openSettingsPage(page, "AI 模型");
  await service
    .locator('[data-testid="ai-model"][data-model="claude-opus-5-5"]')
    .getByRole("switch")
    .check();
  await expect.poll(async () => (await saved(page))?.version).toBe(2);
  const kept = await saved(page);
  expect(kept?.current).toBe("service-old");
  expect(kept?.services.map(({ id }) => id)).toEqual(["service-old", "x"]);
  expect(kept?.services[0]).toMatchObject({
    model: "claude-test",
    enabled: ["claude-test", "claude-opus-5-5"],
  });
});

test("settings a newer editor wrote are left alone, and said so", async ({ page }) => {
  const newer = JSON.stringify({ version: 9, services: [{ id: "a", kind: "anthropic" }] });
  await page.evaluate((value) => localStorage.setItem("animaquill.ai", value), newer);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  await expect(settings.getByTestId("ai-held")).toContainText("更新版本的编辑器写的");
  await expect(settings.getByTestId("ai-add-service")).toBeDisabled();
  await expect(settings.getByRole("spinbutton")).toBeDisabled();
  await settings.screenshot(shot("wide-held.png"));
  expect(await page.evaluate(() => localStorage.getItem("animaquill.ai"))).toBe(newer);
});
