import type { Locator, Page, Route } from "@playwright/test";
import { expect } from "./support.ts";

/**
 * Setting up AI services in the settings, as people do, against a pretend Anthropic: the page
 * talks to the real address and the test answers in its place.
 */

export const ANTHROPIC = "https://api.anthropic.com/**";

/** The settings, a dialog over the editor or the start page. */
export const settingsOf = (page: Page) => page.getByTestId("settings");

/**
 * Goes to a group of the settings that are open, by its name in the list on the left; where they
 * are narrow, up to the list first.
 */
export async function goToSettingsGroup(page: Page, name: string) {
  const settings = settingsOf(page);
  const groups = settings.getByRole("navigation", { name: "设置分组" });
  for (let up = 0; up < 3 && !(await groups.isVisible()); up += 1)
    await settings.getByTestId("settings-back").click();
  await groups.getByRole("button", { name, exact: true }).click();
}

/** Opens the settings from the title bar, and a group of them by its name in the list. */
export async function openSettingsPage(page: Page, name: string) {
  if (!(await settingsOf(page).isVisible()))
    await page.locator("header").getByRole("button", { name: "设置", exact: true }).click();
  await goToSettingsGroup(page, name);
}

/** Closes the settings with their ✕. */
export async function closeSettings(page: Page) {
  await settingsOf(page).getByRole("button", { name: "关闭设置" }).click();
  await expect(settingsOf(page)).toBeHidden();
}

/** Closes the settings where they are open, to get to the editor behind them. */
export async function leaveSettings(page: Page) {
  if (await settingsOf(page).isVisible()) await closeSettings(page);
}

/** What Anthropic streams for an answer that only says something. */
export function anthropicSays(text: string, model = "claude-test"): string {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** What Anthropic streams for an answer that only calls tools, each with its input. */
export function anthropicCalls(
  calls: readonly { readonly name: string; readonly input: Record<string, unknown> }[],
  model = "claude-test",
): string {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
    ],
  ];
  calls.forEach(({ name, input }, index) => {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: `toolu_${index + 1}`, name, input: {} },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index }],
    );
  });
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

/** Whether a request is the test of a connection: a word, at most 16 tokens. */
export const isConnectionTest = (route: Route) =>
  (route.request().postDataJSON() as { max_tokens?: number } | null)?.max_tokens === 16;

/** Answers the tests of a connection with "OK", ahead of whatever else answers Anthropic. */
const answerTests = async (route: Route) => {
  if (!isConnectionTest(route)) return route.fallback();
  return route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body: anthropicSays("OK"),
  });
};

/**
 * Adds Anthropic from the picker of services, with a key, tested; then, with a model named, that
 * model is the only one on, and the default. Ends on the service in the settings.
 */
export async function addAnthropic(page: Page, key: string, model?: string) {
  const settings = settingsOf(page);
  await page.route(ANTHROPIC, answerTests);
  const picker = page.getByTestId("ai-add");
  if (!(await picker.isVisible())) {
    await openSettingsPage(page, "AI 模型");
    // With no service yet, the picker opens by itself.
    await expect(settings.getByTestId("ai-models")).toBeVisible();
    if (!(await picker.isVisible())) await settings.getByTestId("ai-add-service").click();
  }
  await picker.locator('[data-testid="ai-kind"][data-kind="anthropic"]').click();
  const service = settings.getByTestId("ai-service");
  await service.getByTestId("ai-key").fill(key);
  await service.getByTestId("ai-key").press("Enter");
  await expect(service.getByTestId("ai-key")).toHaveValue(`••••••••••••${key.slice(-4)}`);
  await service.getByRole("button", { name: "测试", exact: true }).click();
  await expect(service.getByTestId("ai-test")).toHaveAttribute("data-state", "ok");
  await page.unroute(ANTHROPIC, answerTests);
  if (model !== undefined) await onlyModel(page, model);
  await noAutoTitle(page);
}

/**
 * Adds a model to the service open from what it lists, as people do with "获取模型…": the pretend
 * service lists only that model.
 */
export async function addModel(page: Page, model: string) {
  const service = settingsOf(page).getByTestId("ai-service");
  const list = async (route: Route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ data: [{ id: model, type: "model" }], has_more: false }),
        })
      : route.fallback();
  const models = "https://api.anthropic.com/v1/models**";
  await page.route(models, list);
  await service.getByTestId("ai-fetch-models").click();
  const fetched = service.getByTestId("ai-fetch");
  await fetched.locator(`[data-testid="ai-fetch-row"][data-model="${model}"]`).click();
  await fetched.getByTestId("ai-fetch-add").click();
  await page.unroute(models, list);
  await expect(
    service.locator(`[data-testid="ai-model"][data-model="${model}"]`).getByRole("switch"),
  ).toBeChecked();
}

/** Makes a model of the service open the only one on, and the default: added if need be. */
export async function onlyModel(page: Page, model: string) {
  const service = settingsOf(page).getByTestId("ai-service");
  const row = service.locator(`[data-testid="ai-model"][data-model="${model}"]`);
  if ((await row.count()) === 0) await addModel(page, model);
  const star = row.getByRole("button", { name: "设为默认模型" });
  if ((await star.count()) > 0) await star.click();
  await expect(row.getByRole("button", { name: "默认模型" })).toBeVisible();
  const others = service.locator('[data-testid="ai-model"]').filter({
    has: page.locator('input[role="switch"]:checked'),
  });
  for (;;) {
    const on = await others.evaluateAll((rows) =>
      rows.map((each) => each.getAttribute("data-model")),
    );
    const other = on.find((each) => each !== model);
    if (other === undefined) break;
    await service
      .locator(`[data-testid="ai-model"][data-model="${other}"]`)
      .getByRole("switch")
      .uncheck();
  }
  await expect(service.getByTestId("ai-models-count")).toContainText("1 / ");
}

/**
 * Turns off the titles the model writes after the first turn of a conversation, in the group of the
 * chat, and goes back to the AI models: each title would be one more request to the pretend service,
 * which tests count.
 */
export async function noAutoTitle(page: Page) {
  await goToSettingsGroup(page, "AI 聊天");
  await settingsOf(page).getByRole("switch", { name: "第一轮后自动起标题" }).uncheck();
  await goToSettingsGroup(page, "AI 模型");
}

/**
 * Opens the work of every turn in the chat that is folded (chat-panel.md 5.2), to see its steps:
 * each turn's line, as people click it.
 */
export async function openWork(chat: Locator): Promise<void> {
  const folded = chat.locator('[data-testid="chat-work"] > button[aria-expanded="false"]:enabled');
  while ((await folded.count()) > 0) await folded.first().click();
}
