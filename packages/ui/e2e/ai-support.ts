import type { Page, Route } from "@playwright/test";
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
 * Adds Anthropic with a key from the cards of services, tested; then, with a model named, that
 * model is the only one on, and the default. Ends on the service in the settings.
 */
export async function addAnthropic(page: Page, key: string, model?: string) {
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  await page.route(ANTHROPIC, answerTests);
  const wall = settings.getByTestId("ai-add");
  if (!(await wall.isVisible())) await settings.getByTestId("ai-add-service").click();
  await wall.locator('[data-testid="ai-kind"][data-kind="anthropic"]').click();
  const form = wall.getByTestId("ai-add-form");
  await form.getByLabel("Key").fill(key);
  await form.getByRole("button", { name: "测试并添加" }).click();
  const service = settings.getByTestId("ai-service");
  await expect(service.getByTestId("ai-key-saved")).toContainText(key.slice(-4));
  await expect(service.getByTestId("ai-test")).toContainText("连上了");
  await page.unroute(ANTHROPIC, answerTests);
  if (model !== undefined) await onlyModel(page, model);
  await noAutoTitle(page);
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

/** Turns on one more model of the service open, named by hand, leaving the others as they are. */
export async function addModel(page: Page, model: string) {
  const service = settingsOf(page).getByTestId("ai-service");
  await service.getByRole("button", { name: "＋ 手动加" }).click();
  const form = service.getByTestId("ai-add-model");
  await form.getByLabel("模型 ID").fill(model);
  await form.getByRole("button", { name: "加上并启用" }).click();
  await expect(
    service.locator(`[data-testid="ai-model"][data-model="${model}"]`).getByRole("switch"),
  ).toBeChecked();
}

/** Makes a model of the service open the only one on, and the default: named by hand if need be. */
export async function onlyModel(page: Page, model: string) {
  const service = settingsOf(page).getByTestId("ai-service");
  const row = service.locator(`[data-testid="ai-model"][data-model="${model}"]`);
  if ((await row.count()) === 0) {
    await service.getByRole("button", { name: "＋ 手动加" }).click();
    const form = service.getByTestId("ai-add-model");
    await form.getByLabel("模型 ID").fill(model);
    await form.getByRole("button", { name: "加上并启用" }).click();
  }
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
  await expect(service.getByTestId("ai-models-count")).toContainText("1/");
}
