import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  addModel,
  anthropicSays,
  leaveSettings,
  noAutoTitle,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { content, expect, tab, test, showTab } from "./support.ts";

/**
 * The group of AI models in the settings: adding a service from the picker, testing it, the models
 * to turn on and the default among them, settings of before, two windows, and a narrow window.
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

/** What the settings keep, as this browser has them. */
const saved = (page: Page) =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("aq-offline-animaquill.ai") ?? "null"),
  ) as Promise<{
    version?: number;
    services: { id: string; enabled: string[]; model: string }[];
    current?: string;
    default?: { service: string; model: string };
    reasoningFor?: Record<string, string>;
  } | null>;

const rowOf = (page: Page, model: string) =>
  settingsOf(page).locator(
    `[data-testid="ai-service"] [data-testid="ai-model"][data-model="${model}"]`,
  );
const isDefault = (page: Page, model: string) =>
  rowOf(page, model).getByRole("button", { name: "默认模型" });

test("adds a service from the picker: its recommended models on, the first the default, the key, a test", async ({
  page,
}) => {
  const sent: Record<string, unknown>[] = [];
  await page.route(ANTHROPIC, (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return ok(route);
  });
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  const picker = settings.getByTestId("ai-add");
  const search = picker.getByRole("searchbox", { name: "搜服务" });
  await search.fill("千问");
  await expect(picker.getByTestId("ai-kind")).toHaveCount(1);
  await search.fill("");
  const card = picker.locator('[data-testid="ai-kind"][data-kind="anthropic"]');
  await expect(card).toContainText(/\d+ 个模型/);
  await card.click();

  // Added at once and open: the models it starts with, the first the default; then its key.
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-models-count")).toHaveText(/^3 \/ \d+ 启用$/);
  await expect(isDefault(page, "claude-opus-5-5")).toBeVisible();
  await service.getByTestId("ai-key").fill(KEY);
  await service.getByTestId("ai-key").press("Enter");
  // The key shows by its end only.
  await expect(service.getByTestId("ai-key")).toHaveValue("••••••••••••CRET");
  await expect(service.getByTestId("ai-key")).toHaveAttribute("type", "password");
  await service.getByRole("button", { name: "测试", exact: true }).click();
  await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  await expect(service.getByTestId("ai-test")).toHaveAttribute("title", /回答“OK”/);
  await expect(settings.getByTestId("ai-service-item")).toHaveCount(1);
  await expect(settings.getByTestId("ai-service-dot")).toHaveCount(0);
  // The test asked the first model on for a word.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16 });
  expect(await page.content()).not.toContain("SECRET");
  const kept = await saved(page);
  expect(kept?.version).toBe(4);
  expect(kept?.services[0]?.enabled).toEqual([
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
  ]);
  expect(JSON.stringify(kept)).not.toContain("SECRET");
  await settings.screenshot(shot("wide-detail.png"));
  // The chat sends to the default model, and its bubble there goes to the settings.
  await noAutoTitle(page);
  await leaveSettings(page);
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-model")).toHaveText("Claude Opus 5.5");
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill("你好");
  await box.press("Enter");
  await expect(chat(page).getByText("OK", { exact: true })).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ model: "claude-opus-5-5" });
  await chat(page).getByTestId("chat-model").click();
  await chat(page).getByRole("button", { name: "管理模型和服务…" }).click();
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  // The groups on the left, beside the service.
  await expect(settings.getByRole("navigation", { name: "设置分组" })).toHaveCSS(
    "flex-direction",
    "column",
  );
});

test("models: on and off, the default, at least one stays on, one got from the service, its reasoning, a test of one", async ({
  page,
  problems,
}) => {
  const sent: Record<string, unknown>[] = [];
  let missing = false;
  await page.route(ANTHROPIC, (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    if (missing)
      return route.fulfill({
        status: 404,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify({
          type: "error",
          error: { type: "not_found_error", message: "model" },
        }),
      });
    return ok(route, "好的");
  });
  await addAnthropic(page, KEY);
  const settings = settingsOf(page);
  const service = settings.getByTestId("ai-service");
  const row = (model: string) => rowOf(page, model);

  // Another default: it is the one the chat uses.
  await row("claude-sonnet-5-5").getByRole("button", { name: "设为默认模型" }).click();
  await expect(isDefault(page, "claude-sonnet-5-5")).toBeVisible();
  // Off, the default goes to one that is on.
  await row("claude-sonnet-5-5").getByRole("switch").uncheck();
  await expect(isDefault(page, "claude-opus-5-5")).toBeVisible();
  await row("claude-haiku-5-5").getByRole("switch").uncheck();
  // The last one on cannot go off, and says why.
  await expect(row("claude-opus-5-5").getByRole("switch")).toBeDisabled();
  await expect(row("claude-opus-5-5").getByRole("switch")).toHaveAttribute(
    "title",
    "至少要留一个启用的模型。",
  );
  await expect(service.getByRole("button", { name: "全部停用" })).toBeDisabled();

  // A model the service lists that pi does not know: on, with no price.
  await addModel(page, "claude-next-6");
  await expect(row("claude-next-6")).not.toContainText("$");
  // How much it reads, in its details, which is people's own from then on.
  await row("claude-next-6").getByTestId("ai-model-open").click();
  const detail = settings.getByTestId("ai-model-detail");
  await detail.getByTestId("ai-model-context").fill("400000");
  await detail.getByTestId("ai-model-context").press("Enter");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveAttribute("data-mark", "edited");
  await settings.locator('[data-testid="ai-service-item"]').click();
  await expect(row("claude-next-6")).toContainText("400k");

  // A model that is not there: its test says so.
  await row("claude-sonnet-5-5").getByTestId("ai-model-open").click();
  missing = true;
  await detail.getByTestId("ai-model-test-button").click();
  await expect(detail.getByTestId("ai-test")).toHaveText("找不到");
  await expect(settings.getByTestId("ai-service-dot")).toHaveAttribute("data-state", "failed");
  missing = false;

  // How hard the default reasons, unless the conversation says otherwise: in its details.
  await settings.locator('[data-testid="ai-service-item"]').click();
  await row("claude-opus-5-5").getByTestId("ai-model-open").click();
  const reasoning = detail.getByRole("combobox", { name: "默认推理强度" });
  await expect(reasoning.locator("option:checked")).toHaveText("自动：中");
  await reasoning.selectOption({ label: "高" });
  await expect
    .poll(async () => (await saved(page))?.reasoningFor)
    .toEqual({ "claude-opus-5-5": "high" });
  await settings.locator('[data-testid="ai-service-item"]').click();
  await settings.screenshot(shot("wide-models.png"));

  await noAutoTitle(page);
  await leaveSettings(page);
  await showTab(page, "chat");
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
  // The request went through: the service has no dot any more.
  await openSettingsPage(page, "AI 模型");
  await expect(settings.getByTestId("ai-service-dot")).toHaveCount(0);
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource/.test(p)),
  );
});

test("two windows follow each other, also in what is typed in the settings", async ({ page }) => {
  await addAnthropic(page, KEY);
  const other = await page.context().newPage();
  await other.goto(page.url());
  await openSettingsPage(other, "AI 模型");
  const here = settingsOf(page).getByTestId("ai-service");
  const there = settingsOf(other).getByTestId("ai-service");
  await expect(there.getByTestId("ai-key")).toHaveValue("••••••••••••CRET");

  // The address, typed here, is there in the field there, which was open all along.
  await expect(there.getByLabel("地址")).toHaveValue("");
  await expect(there.getByLabel("地址")).toHaveAttribute(
    "placeholder",
    "https://api.anthropic.com",
  );
  await here.getByLabel("地址").fill("https://gateway.example/anthropic");
  await here.getByLabel("地址").press("Enter");
  await expect(there.getByLabel("地址")).toHaveValue("https://gateway.example/anthropic");

  // A default chosen there is the default here.
  await there
    .locator('[data-testid="ai-model"][data-model="claude-haiku-5-5"]')
    .getByRole("button", { name: "设为默认模型" })
    .click();
  await expect(isDefault(page, "claude-haiku-5-5")).toBeVisible();
  await other.close();
});

test("narrow, one level at a time: the groups, the tree, one service, and back", async ({
  page,
}) => {
  await addAnthropic(page, KEY);
  // A window 420 wide: the settings fill it, one level at a time.
  await page.setViewportSize({ width: 420, height: 800 });
  const settings = settingsOf(page);
  await expect(settings).toHaveAttribute("data-narrow", "");
  const pages = settings.getByRole("navigation", { name: "设置分组" });
  const back = settings.getByTestId("settings-back");
  // In the group of AI models, at its tree: up to the groups.
  await expect(pages).toBeHidden();
  await expect(settings.getByTestId("ai-service-item")).toBeVisible();
  await expect(settings.getByTestId("ai-service")).toBeHidden();
  await back.click();
  await expect(pages).toBeVisible();
  await settings.screenshot(shot("narrow-pages.png"));
  await pages.getByRole("button", { name: "AI 模型" }).click();
  await expect(pages).toBeHidden();
  await expect(settings.getByTestId("ai-service")).toBeHidden();
  await settings.screenshot(shot("narrow-list.png"));

  await settings.getByTestId("ai-service-item").click();
  const service = settings.getByTestId("ai-service");
  await expect(service).toBeVisible();
  await expect(settings.getByTestId("ai-service-item")).toBeHidden();
  await expect(back).toHaveText("AI 模型");
  await settings.screenshot(shot("narrow-detail.png"));
  // The browser's back goes up a level too.
  await page.goBack();
  await expect(settings.getByTestId("ai-service-item")).toBeVisible();

  // The picker at this width; a service added without its key, its dot in the tree.
  await settings.getByTestId("ai-add-service").click();
  const picker = settings.getByTestId("ai-add");
  await expect(picker.locator('[data-kind="anthropic"]')).toBeDisabled();
  await settings.screenshot(shot("narrow-picker.png"));
  await picker.locator('[data-kind="deepseek"]').click();
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  await back.click();
  await expect(
    settings
      .locator('[data-testid="ai-service-item"]', { hasText: "DeepSeek" })
      .getByTestId("ai-service-dot"),
  ).toHaveAttribute("data-state", "noKey");
  await settings.screenshot(shot("narrow-no-key.png"));

  // Back up to the groups, and from there the browser's back closes the settings.
  await back.click();
  await expect(pages).toBeVisible();
  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(tab(page, "preview")).toBeAttached();
});

test("settings of before come up with their services, models, choices and keys", async ({
  page,
}) => {
  await page.evaluate(async (key) => {
    localStorage.setItem(
      "aq-offline-animaquill.ai",
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
    const open = indexedDB.open("aq-offline-animaquill-keys", 1);
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
  await expect(isDefault(page, "claude-test")).toBeVisible();
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-key")).toHaveValue("••••••••••••CRET");
  await expect(
    service.locator('[data-testid="ai-model"][data-model="claude-test"]').getByRole("switch"),
  ).toBeChecked();
  await openSettingsPage(page, "AI 聊天");
  await expect(settings.getByRole("textbox", { name: "一次任务最多调用工具" })).toHaveValue("77");
  await leaveSettings(page);
  await showTab(page, "chat");
  // The pack chosen for the model before is said beside it.
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test · Claude 5");

  // Written as version 4 once something changes, with what a page of before reads, and the service
  // this editor cannot read kept.
  await openSettingsPage(page, "AI 模型");
  await service
    .locator('[data-testid="ai-model"][data-model="claude-opus-5-5"]')
    .getByRole("switch")
    .check();
  await expect.poll(async () => (await saved(page))?.version).toBe(4);
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
  await page.evaluate((value) => localStorage.setItem("aq-offline-animaquill.ai", value), newer);
  await page.reload();
  await expect(tab(page, "preview")).toBeVisible();
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  await expect(settings.getByTestId("ai-held")).toContainText("更新版本的编辑器写的");
  await expect(settings.getByTestId("ai-add-service")).toBeDisabled();
  await settings.screenshot(shot("wide-held.png"));
  await openSettingsPage(page, "AI 聊天");
  await expect(settings.getByRole("textbox", { name: "一次任务最多调用工具" })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.getItem("aq-offline-animaquill.ai"))).toBe(newer);
});
