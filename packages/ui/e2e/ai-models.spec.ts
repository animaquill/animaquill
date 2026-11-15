import type { Page, Route } from "@playwright/test";
import { leaveSettings, noAutoTitle, openSettingsPage, settingsOf } from "./ai-support.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The page of AI models as people set up a server of their own (docs/design/settings-and-
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

/** Adds the gateway from the cards, with its key, as people add a server of their own. */
async function addGateway(page: Page) {
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  const wall = settings.getByTestId("ai-add");
  await wall.locator('[data-testid="ai-kind"][data-kind="openai-compatible"]').click();
  const form = wall.getByTestId("ai-add-form");
  await form.getByLabel("地址").fill(GATEWAY);
  await form.getByLabel("Key", { exact: true }).fill(KEY);
  await form.getByRole("button", { name: "测试并添加" }).click();
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-test")).toContainText("连上了");
  await service.getByLabel("名称").fill("公司网关");
  await service.getByLabel("名称").press("Enter");
  return service;
}

const rowOf = (page: Page, model: string) =>
  settingsOf(page).locator(`[data-testid="ai-model"][data-model="${model}"]`);

test("models got from a server of one's own: picked from its list, filled in from the catalogs, each in detail", async ({
  page,
  problems,
}) => {
  const seen = await pretend(page);
  const service = await addGateway(page);
  const settings = settingsOf(page);
  // The service above, its models below; the default on top of the page.
  const top = await settings.getByTestId("ai-default-model").boundingBox();
  const fields = await service.getByLabel("地址").boundingBox();
  const table = await service.getByTestId("ai-models").boundingBox();
  expect(top!.y).toBeLessThan(fields!.y);
  expect(fields!.y).toBeLessThan(table!.y);
  await expect(service.getByTestId("ai-api")).toHaveValue("openai-completions");

  // From the service: 46, a filter, those already there grey, what is not for a conversation said.
  await service.getByTestId("ai-fetch-models").click();
  const dialog = page.getByTestId("ai-fetch");
  await expect(dialog.getByTestId("ai-fetch-count")).toHaveText("找到 46 个，显示 46 个");
  await expect(dialog.locator('[data-model="text-embedding-v4"]')).toContainText("不是对话模型");
  await expect(dialog.locator('[data-model="a-model-01"]')).toContainText("已添加");
  await dialog.getByRole("searchbox", { name: "筛选" }).fill("qwen");
  await expect(dialog.getByTestId("ai-fetch-count")).toHaveText("找到 5 个，显示 5 个");
  await dialog.getByText("选中显示的 5 个").click();
  await dialog.locator('[data-model="qwen-max"]').getByRole("checkbox").uncheck();
  await expect(dialog.locator('[data-model="qwen3-max"]')).toContainText("Qwen3 Max · 262.1k");
  await expect(
    dialog.locator('[data-model="qwen3-vl-plus"] [data-capability="both"]'),
  ).toBeVisible();
  await expect(dialog.locator('[data-model="qwen-internal-ft-0921"]')).toContainText(
    "目录里没有 · 服务说 32.8k",
  );
  await page.screenshot(shot("S4-fetch.png"));
  await dialog.getByTestId("ai-fetch-add").click();
  await expect(dialog).toBeHidden();

  // Added, and filled in: on in the list, with what the catalogs know.
  await expect(rowOf(page, "qwen3-max")).toContainText("262.1k");
  await expect(rowOf(page, "qwen3-max")).toContainText("$1.2 / $6");
  await expect(rowOf(page, "qwen3-max").locator('[data-capability="thinking"]')).toBeVisible();
  await expect(rowOf(page, "qwen3-coder-plus")).toContainText("1.05M");
  await expect(rowOf(page, "qwen3-coder-plus").locator('[data-capability="image"]')).toBeVisible();
  await expect(rowOf(page, "qwen-internal-ft-0921").locator("[data-capability]")).toHaveCount(0);
  await expect(rowOf(page, "qwen-internal-ft-0921")).toContainText("32.8k");
  await expect(rowOf(page, "qwen-internal-ft-0921")).toContainText("没有价格");
  await expect(service.getByTestId("ai-models-count")).toHaveText("7/7 启用");
  await service.evaluate((element) => element.parentElement?.parentElement?.scrollTo(0, 0));
  await page.screenshot(shot("S2-service.png"));
  await service.getByTestId("ai-models").screenshot(shot("I1-capabilities.png"));

  // The details of one: the catalogs filled it in, by consensus, with a price to trust.
  await rowOf(page, "qwen3-max").getByTestId("ai-model-open").click();
  const detail = settings.getByTestId("ai-model-detail");
  await expect(settings.getByTestId("settings-crumb")).toHaveText(
    "› AI 模型 › 公司网关 › Qwen3 Max",
  );
  const banner = detail.getByTestId("ai-fill");
  await expect(banner).toContainText("已按目录填写");
  await expect(banner).toContainText("models.dev");
  await expect(banner).toContainText("按多家共识");
  await expect(banner).toContainText("价格可靠");
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("262144");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveText("目录");
  await expect(detail.getByTestId("ai-model-price-input")).toHaveValue("1.2");
  // The steps of reasoning models.dev names, ticked; the others not, and so not in the chat.
  const levels = detail.getByTestId("ai-level-map");
  await expect(levels.locator('[data-level="high"] input[type="checkbox"]')).toBeChecked();
  await expect(levels.locator('[data-level="minimal"] input[type="checkbox"]')).not.toBeChecked();
  await expect(levels.locator('[data-level="max"] input[type="checkbox"]')).not.toBeChecked();
  // Where the steps are from, once in the title; a row is marked only where people change it.
  await expect(detail.getByTestId("ai-map-catalog")).toHaveText("目录");
  await expect(levels.locator('[data-level="high"]')).not.toHaveAttribute("data-mark");
  // "Advanced" looks as the rest: no frame, no colour, only folded.
  const advanced = detail.getByTestId("ai-model-advanced");
  await expect(advanced).toHaveCSS("border-top-width", "0px");
  await expect(advanced).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(advanced.locator("summary")).toContainText("都用服务的设置");
  await detail.evaluate((element) => element.parentElement?.parentElement?.scrollTo(0, 0));
  await page.screenshot(shot("S3-model.png"));

  // A cell changed is people's: filling again leaves it, undoing too; back to the catalog's.
  await detail.getByTestId("ai-model-context").fill("300000");
  await detail.getByTestId("ai-model-context").press("Enter");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveText("你改的");
  await detail.getByTestId("ai-model-max-tokens").fill("abc");
  await detail.getByTestId("ai-model-max-tokens").press("Enter");
  await expect(detail.getByText("要填正整数，或者空着。")).toBeVisible();
  await detail.getByTestId("ai-model-max-tokens").fill("32768");
  await detail.getByTestId("ai-model-max-tokens").press("Enter");
  await detail.getByRole("button", { name: "重新按目录填写" }).click();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("300000");
  await detail.getByRole("button", { name: "撤销这次填写" }).click();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("300000");
  await expect(detail.getByTestId("ai-model-price-input")).toHaveValue("1.2");
  await detail.getByTestId("ai-mark-contextWindow").click();
  await detail.getByRole("menuitem", { name: "改回目录的值" }).click();
  await expect(detail.getByTestId("ai-model-context")).toHaveValue("262144");
  await expect(detail.getByTestId("ai-mark-contextWindow")).toHaveText("目录");

  // A step not ticked is not in the chat; a value sent for one.
  await levels.locator('[data-level="low"] input[type="checkbox"]').uncheck();
  await levels.getByRole("textbox", { name: "“高”发给服务的值" }).fill("max");
  await levels.getByRole("textbox", { name: "“高”发给服务的值" }).press("Enter");
  await expect(levels.locator('[data-level="high"]')).toHaveAttribute("data-mark", "edited");
  // Not ticked and ticked again: what people gave it is still there.
  const high = levels.locator('[data-level="high"]');
  await high.getByRole("checkbox").uncheck();
  await expect(high.getByRole("textbox")).toBeDisabled();
  await expect(high.getByRole("textbox")).toHaveValue("max");
  await high.getByRole("checkbox").check();
  await expect(high.getByRole("textbox")).toHaveValue("max");
  await high.getByRole("textbox").fill("a b");
  await high.getByRole("textbox").press("Enter");
  await expect(high).toContainText("只能是英文、数字和符号，不能有空格");
  await high.getByRole("textbox").fill("max");
  await high.getByRole("textbox").press("Enter");

  // Tested as it is now: a word, at the model's own settings.
  await detail.getByTestId("ai-model-test-button").click();
  await expect(detail.getByTestId("ai-test")).toContainText("连上了");
  const tested = seen.findLast((each) => each.url.endsWith("/chat/completions"));
  expect(tested?.body).toMatchObject({ model: "qwen3-max" });
  expect(JSON.stringify(tested?.body)).toContain("Reply with OK only.");

  // A model the catalogs do not know: said, with what that means.
  await detail.getByRole("button", { name: "公司网关", exact: true }).click();
  await rowOf(page, "qwen-internal-ft-0921").getByTestId("ai-model-open").click();
  await expect(detail.getByTestId("ai-fill")).toContainText("目录里没有这个 ID");
  await detail.evaluate((element) => element.parentElement?.parentElement?.scrollTo(0, 0));
  await page.screenshot(shot("catalog-none.png"));

  // One whose price the catalog's providers do not agree on: no price, and why.
  await detail.getByRole("button", { name: "公司网关", exact: true }).click();
  await service.getByRole("button", { name: "＋ 手动加" }).click();
  await service.getByTestId("ai-add-model").getByLabel("模型 ID").fill("shared-x");
  await service.getByTestId("ai-add-model").getByRole("button", { name: "加上并启用" }).click();
  await rowOf(page, "shared-x").getByTestId("ai-model-open").click();
  await expect(detail.getByTestId("ai-fill")).toContainText("价格不可靠（几家价格不一样）");
  await expect(detail.getByTestId("ai-model-price-input")).toHaveValue("");
  await detail.evaluate((element) => element.parentElement?.parentElement?.scrollTo(0, 0));
  await page.screenshot(shot("price-unreliable.png"));

  // The chat: only the steps ticked, and the default step by its star.
  await detail.getByRole("button", { name: "公司网关", exact: true }).click();
  await rowOf(page, "qwen3-max").getByRole("button", { name: "设为默认模型" }).click();
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
  await expect(menu.locator('[data-level="high"] [aria-pressed="true"]')).toBeVisible();
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

test("headers go with every request, a key that is wrong and a model that cannot see are said, and the order is the picker's", async ({
  page,
  problems,
}) => {
  const seen = await pretend(page);
  const service = await addGateway(page);
  const settings = settingsOf(page);

  // A header of the gateway's: sent with every request, kept as secret as a key, so one that
  // looks like a key is taken as it is; one that fetch cannot send is said so and not taken.
  await service.getByTestId("ai-headers").locator("summary").click();
  await service.getByRole("button", { name: "＋ 加一个请求头" }).click();
  await service.getByRole("textbox", { name: "名字" }).fill("x-team");
  await service.getByRole("textbox", { name: "值" }).fill("视频");
  await service.getByRole("textbox", { name: "值" }).press("Enter");
  await expect(service.getByTestId("ai-header-problem")).toContainText("只能是英文、数字和符号");
  await service.getByRole("textbox", { name: "值" }).fill("sk-team-0123456789abcdef");
  await expect(service.getByTestId("ai-header-secret")).toHaveCount(0);
  await service.getByRole("textbox", { name: "值" }).fill("abc");
  await service.getByRole("textbox", { name: "值" }).press("Enter");
  await expect(service.getByTestId("ai-headers").locator("summary")).toContainText("请求头（1）");
  await service.getByRole("button", { name: "测试连接" }).click();
  await expect(service.getByTestId("ai-test")).toContainText("连上了");
  expect(seen.at(-1)?.headers["x-team"]).toBe("abc");

  // A model that should see pictures, and does not answer what colour one is.
  await service.getByRole("button", { name: "＋ 手动加" }).click();
  await service.getByTestId("ai-add-model").getByLabel("模型 ID").fill("qwen3-vl-plus");
  await service.getByTestId("ai-add-model").getByRole("button", { name: "加上并启用" }).click();
  await expect(rowOf(page, "qwen3-vl-plus").locator('[data-capability="both"]')).toBeVisible();
  await rowOf(page, "qwen3-vl-plus").getByTestId("ai-model-open").click();
  const detail = settings.getByTestId("ai-model-detail");
  await detail.getByTestId("ai-model-test-button").click();
  await expect(detail.getByTestId("ai-picture-test")).toContainText("这个模型可能看不了图");
  await expect(detail.getByTestId("ai-picture-test")).toContainText("blue");
  const picture = seen.findLast((each) => JSON.stringify(each.body).includes("image_url"));
  expect(picture?.headers["x-team"]).toBe("abc");
  // Headers of the model go on top of the service's.
  await detail.getByTestId("ai-model-advanced").locator("summary").click();
  await detail
    .getByTestId("ai-model-headers")
    .getByRole("button", { name: "＋ 加一个请求头" })
    .click();
  await detail
    .getByTestId("ai-model-headers")
    .getByRole("textbox", { name: "名字" })
    .fill("x-route");
  await detail.getByTestId("ai-model-headers").getByRole("textbox", { name: "值" }).fill("vision");
  await detail.getByTestId("ai-model-headers").getByRole("textbox", { name: "值" }).press("Enter");
  await expect(detail.getByTestId("ai-model-advanced").locator("summary")).toContainText(
    "改了 1 项",
  );
  await detail.getByRole("button", { name: "取消勾选" }).click();
  await expect(detail.getByTestId("ai-picture-test")).toHaveCount(1);
  await detail.getByTestId("ai-model-test-button").click();
  await expect(detail.getByTestId("ai-test")).toContainText("连上了");
  const last = seen.at(-1);
  expect(last?.headers).toMatchObject({ "x-team": "abc", "x-route": "vision" });
  expect(JSON.stringify(last?.body)).not.toContain("image_url");

  // The order of the models on is the order of the picker: dragged, or with Alt+↑.
  await detail.getByRole("button", { name: "公司网关", exact: true }).click();
  const on = settings.locator('[data-testid="ai-model"][data-enabled]');
  await expect(on).toHaveCount(4);
  const first = await on.first().getAttribute("data-model");
  await rowOf(page, "qwen3-vl-plus").dragTo(on.first(), { targetPosition: { x: 40, y: 2 } });
  await expect(on.first()).toHaveAttribute("data-model", "qwen3-vl-plus");
  await rowOf(page, first!)
    .getByRole("button", { name: `移动 ${first}` })
    .press("ArrowUp");
  await expect(on.first()).toHaveAttribute("data-model", first!);
  const order = await on.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model")));
  await leaveSettings(page);
  await tab(page, "chat").click();
  await chat(page).getByTestId("chat-model").click();
  await expect(chat(page).getByTestId("chat-model-option")).toHaveCount(4);
  expect(
    await chat(page)
      .getByTestId("chat-model-option")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-model"))),
  ).toEqual(order);
  await page.keyboard.press("Escape");

  // A key that is wrong: said so, in the test of the service.
  await openSettingsPage(page, "AI 模型");
  await service.getByRole("button", { name: "更换" }).click();
  await service.getByLabel("Key", { exact: true }).fill("sk-gw-wrong-000000");
  await service.getByLabel("Key", { exact: true }).press("Enter");
  await service.getByRole("button", { name: "测试连接" }).click();
  await expect(service.getByTestId("ai-test")).toHaveText(/key 不对/);
  problems.splice(
    0,
    problems.length,
    ...problems.filter((p) => !/Failed to load resource|401/.test(p)),
  );
});

test("narrow: the service, and the details of a model, one level at a time", async ({ page }) => {
  await pretend(page);
  await addGateway(page);
  const settings = settingsOf(page);
  await settings.getByTestId("ai-service").getByRole("button", { name: "＋ 手动加" }).click();
  await settings.getByTestId("ai-add-model").getByLabel("模型 ID").fill("qwen3-max");
  await settings.getByTestId("ai-add-model").getByRole("button", { name: "加上并启用" }).click();
  await expect(rowOf(page, "qwen3-max")).toContainText("262.1k");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(settings).toHaveAttribute("data-narrow", "");
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  // Nothing wider than the window.
  expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.screenshot(shot("narrow-390-service.png"));
  await rowOf(page, "qwen3-max").getByTestId("ai-model-open").click();
  const back = settings.getByTestId("settings-back");
  await expect(back).toHaveText("公司网关");
  await expect(settings.getByTestId("ai-model-detail")).toBeVisible();
  await page.screenshot(shot("narrow-390-model.png"));
  await page.goBack();
  await expect(settings.getByTestId("ai-service")).toBeVisible();
  await expect(back).toHaveText("AI 模型");
});

test("a gateway that takes its key in a header of its own, as Azure's does: a header like any other", async ({
  page,
  problems,
}) => {
  const seen = await pretend(page);
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  const wall = settings.getByTestId("ai-add");
  await wall.locator('[data-testid="ai-kind"][data-kind="openai-compatible"]').click();
  const form = wall.getByTestId("ai-add-form");
  await form.getByLabel("地址").fill(GATEWAY);
  // No cell for which header the key goes in: as pi-web, it goes in the headers.
  await expect(form.getByLabel("Key 用哪个请求头")).toHaveCount(0);
  await form.getByRole("button", { name: "测试并添加" }).click();
  // Without its key the gateway says no: added anyway, the key goes in a header next.
  await form.getByTestId("ai-add-anyway").click();
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-key-header")).toHaveCount(0);
  await service.getByTestId("ai-headers").locator("summary").click();
  await service.getByRole("button", { name: "＋ 加一个请求头" }).click();
  await service.getByRole("textbox", { name: "名字" }).fill("api-key");
  await service.getByRole("textbox", { name: "值" }).fill(KEY);
  await service.getByRole("textbox", { name: "值" }).press("Enter");
  await service.getByRole("button", { name: "测试连接" }).click();
  await expect(service.getByTestId("ai-test")).toContainText("连上了");
  const listed = seen.findLast((each) => each.url.endsWith("/models"));
  expect(listed?.headers["api-key"]).toBe(KEY);
  expect(listed?.headers["authorization"]).toBeUndefined();
  await service.getByRole("button", { name: "＋ 手动加" }).click();
  await service.getByTestId("ai-add-model").getByLabel("模型 ID").fill("qwen3-max");
  await service.getByTestId("ai-add-model").getByRole("button", { name: "加上并启用" }).click();
  await rowOf(page, "qwen3-max").getByRole("button", { name: "测试", exact: true }).click();
  await expect(rowOf(page, "qwen3-max").getByTestId("ai-model-test")).toContainText("连上了");
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
