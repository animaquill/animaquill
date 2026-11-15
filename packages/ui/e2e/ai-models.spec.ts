import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  anthropicSays,
  leaveSettings,
  noAutoTitle,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The page of AI models, as pi-web's (S-M2): the tree and what is picked in it, as people set up a
 * server of their own (docs/design/settings-and-
 * properties.md of AnimaQuill Cloud, 6): models got from the service, filled in from the catalogs,
 * the details of one, filling again and undoing, testing a model and its pictures, headers that go
 * with every request, and the order of the models in the chat's picker. A pretend gateway and a
 * pretend models.dev answer in place of the real ones.
 */

const GATEWAY = "https://gw.example.test/v1";
const KEY = "sk-gw-test-0123456789SECRET";
const MODELS_DEV = "https://models.dev/api.json";

const shot = (name: string) => ({ path: test.info().outputPath(name) });
const chat = (page: Page) => content(page, "chat");

/** What models.dev says, as the test has it: two providers agree on Qwen3, two do not on shared-x. */
const CATALOG = {
  alibaba: {
    name: "Alibaba",
    api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: {
      "qwen3-max": {
        id: "qwen3-max",
        name: "Qwen3 Max",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 262144, output: 32768 },
        cost: { input: 1.2, output: 6, cache_read: 0.24 },
      },
      "qwen3-vl-plus": {
        id: "qwen3-vl-plus",
        name: "Qwen3 VL Plus",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.2, output: 1.6 },
      },
      "qwen3-coder-plus": {
        id: "qwen3-coder-plus",
        name: "Qwen3 Coder Plus",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1048576, output: 65536 },
        cost: { input: 1, output: 5 },
      },
      "qwen-max": { id: "qwen-max", name: "Qwen Max", limit: { context: 32768, output: 8192 } },
      "shared-x": { id: "shared-x", name: "Shared X", cost: { input: 1, output: 2 } },
    },
  },
  "alibaba-cn": {
    name: "Alibaba (China)",
    models: {
      "qwen3-max": {
        id: "qwen3-max",
        name: "Qwen3 Max",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 262144, output: 32768 },
        cost: { input: 1.2, output: 6, cache_read: 0.24 },
      },
      "qwen3-vl-plus": {
        id: "qwen3-vl-plus",
        name: "Qwen3 VL Plus",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.2, output: 1.6 },
      },
      "shared-x": { id: "shared-x", name: "Shared X", cost: { input: 3, output: 4 } },
    },
  },
};

/** What the gateway lists: 46 models, of which one is not for conversations. */
const LISTED = [
  ...Array.from({ length: 39 }, (_, index) => ({
    id: `a-model-${String(index + 1).padStart(2, "0")}`,
  })),
  { id: "qwen-internal-ft-0921", context_length: 32768 },
  { id: "qwen-max" },
  { id: "qwen3-coder-plus" },
  { id: "qwen3-max" },
  { id: "qwen3-vl-plus" },
  { id: "shared-x" },
  { id: "text-embedding-v4" },
];

/** What OpenAI-compatible services stream for an answer of a few words. */
const said = (text: string) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

/**
 * The pretend gateway and models.dev. The gateway answers "OK", a picture with "blue" (so that the
 * test of pictures fails), and refuses keys other than `KEY`.
 */
async function pretend(page: Page) {
  const seen: Seen[] = [];
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  await page.route(MODELS_DEV, (route) =>
    route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify(CATALOG),
    }),
  );
  await page.route(`${GATEWAY}/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const headers = await request.allHeaders();
    let body: Record<string, unknown> | null = null;
    try {
      body = request.postDataJSON() as Record<string, unknown> | null;
    } catch {
      body = null;
    }
    seen.push({ url: request.url(), method: request.method(), headers, body });
    const keyed = headers["authorization"] === `Bearer ${KEY}` || headers["api-key"] === KEY;
    if (!keyed)
      return route.fulfill({
        status: 401,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ error: { message: "Incorrect API key provided" } }),
      });
    if (request.url().endsWith("/models"))
      return route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify({ object: "list", data: LISTED }),
      });
    const picture = JSON.stringify(body).includes("image_url");
    return route.fulfill({
      status: 200,
      headers: { ...cors, "content-type": "text/event-stream" },
      body: said(picture ? "blue" : "OK"),
    });
  });
  return seen;
}

/** Adds a server of one's own from the picker, and fills in its name, address and key. */
async function addGateway(page: Page) {
  const settings = settingsOf(page);
  const picker = settings.getByTestId("ai-add");
  if (!(await picker.isVisible())) {
    await openSettingsPage(page, "AI 模型");
    // With no service yet, the picker opens by itself.
    await expect(settings.getByTestId("ai-models")).toBeVisible();
    if (!(await picker.isVisible())) await settings.getByTestId("ai-add-service").click();
  }
  await picker.locator('[data-testid="ai-kind"][data-kind="openai-compatible"]').click();
  await expect(picker).toBeHidden();
  const service = settings.getByTestId("ai-service");
  await service.getByLabel("名称").fill("公司网关");
  await service.getByLabel("名称").press("Enter");
  await service.getByLabel("地址").fill(GATEWAY);
  await service.getByLabel("地址").press("Enter");
  await service.getByTestId("ai-key").fill(KEY);
  await service.getByTestId("ai-key").press("Enter");
  await expect(service.getByTestId("ai-key")).toHaveValue("••••••••••••CRET");
  return service;
}

/** Gets models from the service open and adds those named. */
async function fetchModels(page: Page, models: readonly string[]) {
  const service = settingsOf(page).getByTestId("ai-service");
  await service.getByTestId("ai-fetch-models").click();
  const fetched = service.getByTestId("ai-fetch");
  for (const model of models)
    await fetched.locator(`[data-testid="ai-fetch-row"][data-model="${model}"]`).click();
  await fetched.getByTestId("ai-fetch-add").click();
  await expect(fetched).toBeHidden();
}

const tree = (page: Page) => settingsOf(page).getByTestId("ai-tree");
const inTree = (page: Page, model: string) =>
  tree(page).locator(`[data-testid="ai-model"][data-model="${model}"]`);
/** Scrolls what is on the right back to its top, for a screenshot. */
const toTop = (page: Page) =>
  settingsOf(page)
    .getByTestId("ai-models")
    .evaluate((element) => element.querySelector("[class*=detail]")?.scrollTo(0, 0));

test("a server of one's own: the picker, its settings one under another, models got from it and named by hand, each in detail", async ({
  page,
  problems,
}) => {
  const seen = await pretend(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);

  // Nothing yet: the picker right away, as pi-web's: a search, one's own, the services.
  const picker = settings.getByTestId("ai-add");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("region", { name: "自建" })).toBeVisible();
  await expect(picker.getByRole("region", { name: "服务商" })).toContainText(/\d+ 个模型/);
  const search = picker.getByRole("searchbox", { name: "搜服务" });
  await search.fill("opus");
  await expect(picker.locator('[data-testid="ai-kind"][data-kind="anthropic"]')).toBeVisible();
  await expect(picker.locator('[data-testid="ai-kind"][data-kind="deepseek"]')).toHaveCount(0);
  await search.fill("");
  await page.screenshot(shot("M6-picker.png"));

  const service = await addGateway(page);
  // In the tree, below the line where there are services of the catalog; picked.
  await expect(
    settings.locator('[data-testid="ai-service-item"][aria-current="true"]'),
  ).toContainText("公司网关");
  // One column, in pi-web's order, then how it is reached last; no sentences, only labels.
  const tops: number[] = [];
  const lefts: number[] = [];
  for (const label of ["名称", "地址", "API key", "接口类型", "请求头", "连接"]) {
    const box = await service.getByText(label, { exact: true }).first().boundingBox();
    tops.push(box!.y);
    lefts.push(box!.x);
  }
  expect(tops).toEqual(tops.toSorted((a, b) => a - b));
  expect(new Set(lefts).size).toBe(1);
  await expect(service.locator("p")).toHaveCount(0);
  await expect(service).not.toContainText("Chat Completions：");
  await expect(service.getByLabel("Key 用哪个请求头")).toHaveCount(0);
  await expect(service.getByTestId("ai-api")).toHaveValue("openai-completions");
  // The address and the key are not among the settings in the clear.
  const plain = await page.evaluate(() => localStorage.getItem("animaquill.ai"));
  expect(plain).not.toContain(KEY);
  expect(plain).not.toContain(new URL(GATEWAY).host);

  // Tested: with no model yet, its list of models.
  await service.getByRole("button", { name: "测试", exact: true }).click();
  await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  await expect(service.getByTestId("ai-test")).toHaveText(/\d+ 毫秒|\d+\.\d+ 秒/);

  // Got from the service, below it: a filter, ticking all, those not for a conversation said.
  await service.getByTestId("ai-fetch-models").click();
  const fetched = service.getByTestId("ai-fetch");
  await expect(fetched.getByTestId("ai-fetch-count")).toHaveText("46 个");
  await expect(fetched.getByRole("searchbox")).toHaveAttribute("placeholder", "筛选 46 个模型");
  await expect(fetched.locator('[data-model="text-embedding-v4"]')).toContainText("不是对话模型");
  await fetched.getByRole("searchbox").fill("qwen");
  await expect(fetched.getByTestId("ai-fetch-count")).toHaveText("5 个");
  const all = fetched.getByRole("checkbox", { name: "全选" });
  await all.check();
  for (const model of ["qwen-max", "qwen3-coder-plus", "qwen-internal-ft-0921"])
    await fetched.locator(`[data-model="${model}"]`).getByRole("checkbox").uncheck();
  expect(await all.evaluate((box) => (box as HTMLInputElement).indeterminate)).toBe(true);
  await expect(fetched.locator('[data-model="qwen3-max"]')).toContainText("262.1k · $1.2 / $6");
  await expect(
    fetched.locator('[data-model="qwen3-vl-plus"] [data-capability="both"]'),
  ).toBeVisible();
  await toTop(page);
  await fetched.scrollIntoViewIfNeeded();
  await page.screenshot(shot("M2-fetch.png"));
  await fetched.getByTestId("ai-fetch-add").click();
  await expect(fetched).toBeHidden();
  // In the tree, under the service, on as they came: those already there grey the next time.
  await expect(inTree(page, "qwen3-max")).toBeVisible();
  await expect(inTree(page, "qwen3-vl-plus").locator('[data-capability="both"]')).toBeVisible();
  await toTop(page);
  await page.screenshot(shot("M1-service.png"));
  await service.getByTestId("ai-fetch-models").click();
  await expect(fetched.locator('[data-model="qwen3-max"]')).toContainText("已添加");
  await expect(fetched.locator('[data-model="qwen3-max"]').getByRole("checkbox")).toBeDisabled();

  // "＋ 模型": a new one in the tree, only its id; leaving the cell fills it in from the catalogs.
  await tree(page).getByTestId("ai-add-model").click();
  await expect(tree(page).getByTestId("ai-model-new")).toHaveText("新模型");
  const blank = settings.getByTestId("ai-model-detail");
  await expect(blank.getByText("模型 ID", { exact: true })).toBeVisible();
  await expect(blank.getByTestId("ai-model-id")).toBeFocused();
  await page.screenshot(shot("M5-new-model.png"));
  await blank.getByTestId("ai-model-id").fill("qwen3-coder-plus");
  await blank.getByTestId("ai-model-id").press("Tab");
  const detail = settings.getByTestId("ai-model-detail");
  await expect(detail).toHaveAttribute("data-model", "qwen3-coder-plus");
  await expect(inTree(page, "qwen3-coder-plus")).toBeVisible();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("1048576");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveAttribute("data-mark", "catalog");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveAttribute("title", "目录");
  // One provider of the catalog only names its price: not to be trusted, not filled in.
  await expect(detail.getByTestId("ai-model-price-input")).toHaveText("—");
  await expect(detail.getByTestId("ai-fill-source")).toHaveAttribute("title", /价格不可靠/);
  // Undone, and filled again.
  await detail.getByRole("button", { name: "撤销填写" }).click();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveCount(0);
  await detail.getByRole("button", { name: "按目录填写" }).click();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("1048576");

  // A cell changed is people's (blue): filling again leaves it; back to the catalog's from its line.
  await detail.getByTestId("ai-model-context").fill("300000");
  await detail.getByTestId("ai-model-context").press("Enter");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveAttribute("data-mark", "edited");
  await detail.getByTestId("ai-model-max-tokens").fill("abc");
  await detail.getByTestId("ai-model-max-tokens").press("Enter");
  await expect(detail.getByTestId("ai-model-max-tokens")).toHaveAttribute("aria-invalid", "true");
  await expect(detail.getByTestId("ai-model-max-tokens")).toHaveAttribute(
    "title",
    "要填正整数，或者空着。",
  );
  await detail.getByTestId("ai-model-max-tokens").fill("65536");
  await detail.getByTestId("ai-model-max-tokens").press("Enter");
  await detail.getByRole("button", { name: "按目录填写" }).click();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("300000");
  await detail.getByTestId("ai-mark-contextWindow").click();
  await detail.getByRole("menuitem", { name: "改回目录的值" }).click();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("1048576");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveAttribute("data-mark", "catalog");

  // The prices read only, until "改价格".
  await expect(detail.getByTestId("ai-model-prices").locator("input")).toHaveCount(0);
  await detail.getByRole("button", { name: "改价格" }).click();
  await expect(detail.getByTestId("ai-model-prices").locator("input")).toHaveCount(4);
  await detail.getByRole("button", { name: "完成" }).click();

  // A model of the catalog, in detail: only labels, the steps of reasoning under "高级".
  await inTree(page, "qwen3-max").getByTestId("ai-model-open").click();
  await expect(detail).toHaveAttribute("data-model", "qwen3-max");
  await expect(settings.getByTestId("settings-crumb")).toHaveText(
    "› AI 模型 › 公司网关 › Qwen3 Max",
  );
  await expect(detail.locator("p")).toHaveCount(0);
  await expect(detail).not.toContainText("发给服务的名字");
  await expect(detail.getByTestId("ai-fill-source")).toHaveText("models.dev");
  await expect(detail.getByTestId("ai-fill-source")).toHaveAttribute("title", /按多家共识/);
  const advanced = detail.getByTestId("ai-model-advanced");
  await expect(advanced).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(advanced.locator("summary")).toContainText("用服务的设置");
  await expect(detail.getByTestId("ai-level-map")).toBeHidden();
  await toTop(page);
  await page.screenshot(shot("M3-model.png"));
  await advanced.locator("summary").click();
  const levels = detail.getByTestId("ai-level-map");
  await expect(levels.locator('[data-level="high"] input[type="checkbox"]')).toBeChecked();
  await expect(levels.locator('[data-level="minimal"] input[type="checkbox"]')).not.toBeChecked();
  await expect(levels.locator('[data-level="high"]')).toHaveAttribute("data-mark", "catalog");
  // A step not ticked is not in the chat; a value sent for one.
  await levels.locator('[data-level="low"] input[type="checkbox"]').uncheck();
  const high = levels.locator('[data-level="high"]');
  await high.getByRole("textbox").fill("max");
  await high.getByRole("textbox").press("Enter");
  await expect(high).toHaveAttribute("data-mark", "edited");
  await high.getByRole("checkbox").uncheck();
  await expect(high.getByRole("textbox")).toBeDisabled();
  await expect(high.getByRole("textbox")).toHaveValue("max");
  await high.getByRole("checkbox").check();
  await high.getByRole("textbox").fill("a b");
  await high.getByRole("textbox").press("Enter");
  await expect(high.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  await high.getByRole("textbox").fill("max");
  await high.getByRole("textbox").press("Enter");
  await advanced.evaluate((element) => element.scrollIntoView());
  await page.screenshot(shot("M4-advanced.png"));

  // Tested as it is now.
  await detail.getByTestId("ai-model-test-button").click();
  await expect(detail.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  const tested = seen.findLast((each) => each.url.endsWith("/chat/completions"));
  expect(tested?.body).toMatchObject({ model: "qwen3-max" });

  // The default by its star in the tree; the chat: only the steps ticked.
  // The star shows on the default always, on another as the pointer is on it.
  await expect(inTree(page, "qwen3-max").getByRole("button", { name: "默认模型" })).toBeVisible();
  await expect(inTree(page, "qwen3-vl-plus").getByRole("button")).toHaveCount(1);
  await inTree(page, "qwen3-vl-plus").hover();
  await inTree(page, "qwen3-vl-plus").getByRole("button", { name: "设为默认模型" }).click();
  await expect(inTree(page, "qwen3-max").getByRole("button", { name: "默认模型" })).toHaveCount(0);
  await inTree(page, "qwen3-max").hover();
  await inTree(page, "qwen3-max").getByRole("button", { name: "设为默认模型" }).click();
  await expect(inTree(page, "qwen3-max").getByRole("button", { name: "默认模型" })).toBeVisible();
  await noAutoTitle(page);
  await leaveSettings(page);
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("Qwen3 Max");
  await chat(page).getByTestId("chat-reasoning").click();
  const menu = chat(page).getByTestId("chat-reasoning-menu");
  await expect(menu.locator("[data-level]")).toHaveCount(3);
  await expect(menu.locator('[data-level="low"]')).toHaveCount(0);
  await menu
    .locator('[data-level="high"]')
    .getByRole("button", { name: /设“高”为/ })
    .click();
  await page.keyboard.press("Escape");
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill("你好");
  await box.press("Enter");
  await expect(chat(page).getByText("OK", { exact: true })).toBeVisible();
  const asked = seen.findLast((each) => each.url.endsWith("/chat/completions"));
  expect(asked?.body).toMatchObject({ model: "qwen3-max", reasoning_effort: "max" });
  expect(await page.content()).not.toContain("SECRET");
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource/.test(p)),
  );
});

test("a service of the catalog: its models as switches on the right, a dot only for no key or a failure", async ({
  page,
  problems,
}) => {
  let refused = true;
  await page.route(ANTHROPIC, (route) =>
    refused
      ? route.fulfill({
          status: 401,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" },
          }),
        })
      : route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
          body: anthropicSays("OK"),
        }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  await settings.getByTestId("ai-add").locator('[data-kind="anthropic"]').click();
  const service = settings.getByTestId("ai-service");
  const item = settings.locator('[data-testid="ai-service-item"]', { hasText: "Anthropic" });
  const dot = item.getByTestId("ai-service-dot");
  // No key: yellow.
  await expect(dot).toHaveAttribute("data-state", "noKey");
  await expect(dot).toHaveAttribute("title", "缺 key");
  // Its models are not in the tree: on the right, a switch each, with the recommended ones on.
  await expect(tree(page).getByTestId("ai-model")).toHaveCount(0);
  await expect(service.getByTestId("ai-models-count")).toHaveText(/^3 \/ \d+ 启用$/);
  await expect(
    service.locator('[data-testid="ai-model"][data-model="claude-opus-5-5"]').getByRole("button", {
      name: "默认模型",
    }),
  ).toBeVisible();
  // The address of the catalog's light in its place; the interface fixed.
  await expect(service.getByLabel("地址")).toHaveValue("");
  await expect(service.getByLabel("地址")).toHaveAttribute(
    "placeholder",
    "https://api.anthropic.com",
  );
  await expect(service.getByTestId("ai-api")).toBeDisabled();

  // A key the service refuses: red, and why on hovering.
  await service.getByTestId("ai-key").fill(`sk-ant-wrong-${KEY}`);
  await service.getByTestId("ai-key").press("Enter");
  await expect(item.getByTestId("ai-service-dot")).toHaveCount(0);
  await service.getByRole("button", { name: "测试", exact: true }).click();
  await expect(service.getByTestId("ai-test")).toHaveText("key 不对");
  await expect(dot).toHaveAttribute("data-state", "failed");
  await expect(dot).toHaveAttribute("title", /key 不对/);
  await page.screenshot(shot("M2b-catalog-service.png"));
  // Through: no dot.
  refused = false;
  await service.getByRole("button", { name: "测试", exact: true }).click();
  await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  await expect(item.getByTestId("ai-service-dot")).toHaveCount(0);
  // The key emptied: gone, yellow again.
  await service.getByTestId("ai-key").fill("");
  await service.getByTestId("ai-key").press("Enter");
  await expect(dot).toHaveAttribute("data-state", "noKey");

  // On and off; all at once; the last one on stays.
  const row = (model: string) => service.locator(`[data-testid="ai-model"][data-model="${model}"]`);
  // All off would leave no model on anywhere: not offered.
  await expect(service.getByRole("button", { name: "全部停用" })).toBeDisabled();
  await row("claude-sonnet-5-5").getByRole("switch").uncheck();
  await row("claude-haiku-5-5").getByRole("switch").uncheck();
  await expect(row("claude-opus-5-5").getByRole("switch")).toBeDisabled();
  await expect(row("claude-opus-5-5").getByRole("switch")).toHaveAttribute(
    "title",
    "至少要留一个启用的模型。",
  );
  await expect(service.getByRole("button", { name: "全部停用" })).toBeDisabled();
  await service.getByRole("button", { name: "全部启用" }).click();
  await expect(service.getByTestId("ai-models-count")).toHaveText(/^(\d+) \/ \1 启用$/);
  // A model's name opens it; it is turned off there too.
  await row("claude-sonnet-5-5").getByTestId("ai-model-open").click();
  const detail = settings.getByTestId("ai-model-detail");
  await expect(detail.getByTestId("ai-model-id")).toHaveValue("claude-sonnet-5-5");
  await expect(detail.getByTestId("ai-model-id")).toHaveAttribute("readonly", "");
  await expect(detail.getByRole("switch")).toBeChecked();
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource|401/.test(p)),
  );
});

test("headers go with every request, a model that cannot see is said, the order is the picker's, a service turned off leaves it", async ({
  page,
  problems,
}) => {
  const seen = await pretend(page);
  const service = await addGateway(page);
  const settings = settingsOf(page);

  // A header of the gateway's: sent with every request. One that cannot be sent is marked.
  const headers = service.getByTestId("ai-headers");
  await headers.getByRole("button", { name: "添加请求头" }).click();
  await headers.getByRole("textbox", { name: "名字" }).fill("x-team");
  await headers.getByRole("textbox", { name: "值" }).fill("视频");
  await headers.getByRole("textbox", { name: "值" }).press("Enter");
  await expect(headers.getByRole("textbox", { name: "值" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await headers.getByRole("textbox", { name: "值" }).fill("abc");
  await headers.getByRole("textbox", { name: "值" }).press("Enter");
  await service.getByRole("button", { name: "测试", exact: true }).click();
  await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  expect(seen.at(-1)?.headers["x-team"]).toBe("abc");

  await fetchModels(page, ["qwen3-vl-plus", "qwen3-max", "qwen-max"]);
  // A model that should see pictures, and does not answer what colour one is.
  await inTree(page, "qwen3-vl-plus").getByTestId("ai-model-open").click();
  const detail = settings.getByTestId("ai-model-detail");
  await detail.getByTestId("ai-model-test-button").click();
  await expect(detail.getByTestId("ai-picture-test")).toHaveText("看图没通过");
  await expect(detail.getByTestId("ai-picture-test")).toHaveAttribute("title", /blue/);
  const picture = seen.findLast((each) => JSON.stringify(each.body).includes("image_url"));
  expect(picture?.headers["x-team"]).toBe("abc");
  // Headers of the model go on top of the service's.
  await detail.getByTestId("ai-model-advanced").locator("summary").click();
  const own = detail.getByTestId("ai-model-headers");
  await own.getByRole("button", { name: "添加请求头" }).click();
  await own.getByRole("textbox", { name: "名字" }).fill("x-route");
  await own.getByRole("textbox", { name: "值" }).fill("vision");
  await own.getByRole("textbox", { name: "值" }).press("Enter");
  await expect(detail.getByTestId("ai-model-advanced").locator("summary")).toContainText(
    "改了 1 项",
  );
  await detail.getByRole("button", { name: "取消能看图" }).click();
  await expect(detail.getByTestId("ai-picture-test")).toHaveCount(0);
  await detail.getByTestId("ai-model-test-button").click();
  await expect(detail.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  const last = seen.at(-1);
  expect(last?.headers).toMatchObject({ "x-team": "abc", "x-route": "vision" });
  expect(JSON.stringify(last?.body)).not.toContain("image_url");

  // The order in the tree is the order of the picker: dragged, or with Alt+↑.
  const models = tree(page).getByTestId("ai-model");
  const order = () => models.evaluateAll((rows) => rows.map((row) => row.dataset.model));
  expect(await order()).toEqual(["qwen3-vl-plus", "qwen3-max", "qwen-max"]);
  await inTree(page, "qwen-max").dragTo(models.first(), { targetPosition: { x: 40, y: 2 } });
  expect(await order()).toEqual(["qwen-max", "qwen3-vl-plus", "qwen3-max"]);
  await inTree(page, "qwen3-max").getByTestId("ai-model-open").press("Alt+ArrowUp");
  expect(await order()).toEqual(["qwen-max", "qwen3-max", "qwen3-vl-plus"]);
  await leaveSettings(page);
  await tab(page, "chat").click();
  await chat(page).getByTestId("chat-model").click();
  expect(
    await chat(page)
      .getByTestId("chat-model-option")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model"))),
  ).toEqual(["qwen-max", "qwen3-max", "qwen3-vl-plus"]);
  await page.keyboard.press("Escape");

  // Removed: gone from the tree; it comes back from the service's list.
  await openSettingsPage(page, "AI 模型");
  await inTree(page, "qwen-max").getByTestId("ai-model-open").click();
  await detail.getByRole("button", { name: "移除" }).click();
  await expect(inTree(page, "qwen-max")).toHaveCount(0);

  // Turned off, the service fades and leaves the picker; another service holds the chat.
  await page.route(ANTHROPIC, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: anthropicSays("OK"),
    }),
  );
  await settings.getByTestId("ai-add-service").click();
  await settings.getByTestId("ai-add").locator('[data-kind="anthropic"]').click();
  await settings.locator('[data-testid="ai-service-item"]', { hasText: "公司网关" }).click();
  await service.getByTestId("ai-service-switch").uncheck();
  await expect(
    settings.locator('[data-testid="ai-service-item"]', { hasText: "公司网关" }).locator(".."),
  ).toHaveAttribute("data-off", "");
  await expect(inTree(page, "qwen3-max")).toBeVisible();
  await leaveSettings(page);
  await chat(page).getByTestId("chat-model").click();
  await expect(
    chat(page).locator('[data-testid="chat-model-option"][data-model^="qwen"]'),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openSettingsPage(page, "AI 模型");
  await settings.locator('[data-testid="ai-service-item"]', { hasText: "公司网关" }).click();
  await service.getByTestId("ai-service-switch").check();
  expect(await order()).toEqual(["qwen3-max", "qwen3-vl-plus"]);
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource|401/.test(p)),
  );
});

test("narrow: the tree, then a service or a model, one level at a time", async ({ page }) => {
  await pretend(page);
  await addGateway(page);
  await fetchModels(page, ["qwen3-max"]);
  const settings = settingsOf(page);
  await page.setViewportSize({ width: 420, height: 844 });
  await expect(settings).toHaveAttribute("data-narrow", "");
  const back = settings.getByTestId("settings-back");
  // At the service: up to the tree.
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  await expect(tree(page)).toBeHidden();
  await back.click();
  await expect(tree(page)).toBeVisible();
  await expect(settings.getByTestId("ai-service")).toBeHidden();
  await inTree(page, "qwen3-max").getByTestId("ai-model-open").click();
  await expect(settings.getByTestId("ai-model-detail")).toBeVisible();
  await expect(tree(page)).toBeHidden();
  await expect(back).toHaveText("公司网关");
  // Back from a model: its service, then the tree.
  await page.goBack();
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  await expect(back).toHaveText("AI 模型");
  await back.click();
  await expect(tree(page)).toBeVisible();
  await settings.locator('[data-testid="ai-service-item"]').click();
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  // Nothing wider than the window.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot(shot("narrow-390-service.png"));
  await back.click();
  await inTree(page, "qwen3-max").getByTestId("ai-model-open").click();
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot(shot("narrow-390-model.png"));
});

test("a gateway that takes its key in a header of its own, as Azure's does: a header like any other", async ({
  page,
  problems,
}) => {
  const seen = await pretend(page);
  const service = await addGateway(page);
  await service.getByTestId("ai-key").fill("");
  await service.getByTestId("ai-key").press("Enter");
  const headers = service.getByTestId("ai-headers");
  await headers.getByRole("button", { name: "添加请求头" }).click();
  await headers.getByRole("textbox", { name: "名字" }).fill("api-key");
  await headers.getByRole("textbox", { name: "值" }).fill(KEY);
  await headers.getByRole("textbox", { name: "值" }).press("Enter");
  await service.getByRole("button", { name: "测试", exact: true }).click();
  await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  const listed = seen.findLast((each) => each.url.endsWith("/models"));
  expect(listed?.headers["api-key"]).toBe(KEY);
  expect(listed?.headers["authorization"]).toBeUndefined();
  await fetchModels(page, ["qwen3-max"]);
  await inTree(page, "qwen3-max").getByTestId("ai-model-open").click();
  await settingsOf(page).getByTestId("ai-model-test-button").click();
  await expect(settingsOf(page).getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  const asked = seen.findLast((each) => each.url.endsWith("/chat/completions"));
  expect(asked?.headers["api-key"]).toBe(KEY);
  expect(asked?.headers["authorization"]).toBeUndefined();
  // Neither the header nor the address is among the settings: they are kept with the key.
  const plain = await page.evaluate(() => localStorage.getItem("animaquill.ai"));
  expect(plain).not.toContain(KEY);
  expect(plain).not.toContain(new URL(GATEWAY).host);
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource|401/.test(p)),
  );
});
