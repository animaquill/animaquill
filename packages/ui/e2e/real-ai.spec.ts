import type { Page, Route } from "@playwright/test";
import { closeSettings, noAutoTitle, openSettingsPage, settingsOf } from "./ai-support.ts";
import { content, expect, test, showTab } from "./support.ts";

/**
 * A smoke test with a real model: the browser assistant, from the settings to the answer, against a
 * real OpenAI-compatible service. It costs quota, so it is skipped unless AQ_REAL_AI_URL (the base
 * address, ending in /v1) and AQ_REAL_AI_KEY are in the environment; `scripts/real-ai-smoke` reads
 * them from a file outside the repository. Such a service refuses the browser (no CORS), so the
 * test stands in for the platform's relay: it takes what the browser sends the service and sends
 * it on from Node, and hands the answer back. The key only comes from the environment: it is never
 * logged, and what the test notes has it taken out.
 * Four turns at most: add a clip (there is nothing to read in a new project), read, look, plan.
 */

/** The name of a function called, in an answer of Chat Completions, streamed or whole. */
const CALL = /"function"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/g;

const BASE = process.env["AQ_REAL_AI_URL"];
const KEY = process.env["AQ_REAL_AI_KEY"];
const MODEL = process.env["AQ_REAL_AI_MODEL"] ?? "gpt-6.1-sol";
const CLIP = "冒烟红块";

test.skip(!BASE || !KEY, "needs AQ_REAL_AI_URL and AQ_REAL_AI_KEY");
test.use({ trace: "off", screenshot: "off", video: "off" });

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
const hide = (text: string) => (KEY ? text.split(KEY).join("<key>") : text);
const note = (what: string) => console.log(`[real-ai] ${hide(what)}`);

/** Every request that went to the service: what it was for and how it ended. */
const seen: string[] = [];
/** The tools the model called, in order, as its answers said. */
const called: string[] = [];

async function forward(route: Route) {
  const request = route.request();
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  };
  if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  const started = Date.now();
  try {
    const answer = await fetch(request.url(), {
      method: request.method(),
      headers: request.headers(),
      ...(request.postDataBuffer() ? { body: new Uint8Array(request.postDataBuffer()!) } : {}),
    });
    const body = Buffer.from(await answer.arrayBuffer());
    const type = answer.headers.get("content-type") ?? "";
    const sent = request.postData() ?? "";
    let tools = "";
    try {
      tools = String((JSON.parse(sent) as { tools?: unknown[] }).tools?.length ?? 0);
    } catch {}
    // What the model calls shows in its answer, streamed or not: a call is a name of a function.
    for (const call of body.toString().matchAll(CALL)) called.push(call[1] as string);
    seen.push(
      `${request.method()} ${new URL(request.url()).pathname} ${answer.status} ` +
        `${Date.now() - started}ms out=${sent.length}B in=${body.length}B tools=${tools}`,
    );
    if (answer.status >= 400)
      note(`service said ${answer.status}: ${body.toString().slice(0, 400)}`);
    return route.fulfill({
      status: answer.status,
      headers: { ...cors, "content-type": type },
      body,
    });
  } catch (error) {
    seen.push(`${request.method()} ${request.url()} failed: ${(error as Error).message}`);
    return route.abort("failed");
  }
}

test("a real model: edits, reads, looks, plans first", async ({ page }) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(`${new URL(BASE!).origin}/**`, forward);

  // The service, as people add one of their own, straight from the browser.
  await openSettingsPage(page, "AI 模型");
  const settings = settingsOf(page);
  const picker = page.getByTestId("ai-add");
  if (!(await picker.isVisible())) await settings.getByTestId("ai-add-service").click();
  await picker.locator('[data-testid="ai-kind"][data-kind="openai-compatible"]').click();
  const service = settings.getByTestId("ai-service");
  const address = service.getByTestId("ai-base-url").locator("input");
  await address.fill(BASE!);
  await address.press("Enter");
  await service.getByTestId("ai-key").fill(KEY!);
  await service.getByTestId("ai-key").press("Enter");
  await service.getByTestId("ai-fetch-models").click();
  const fetched = service.getByTestId("ai-fetch");
  const row = fetched.locator(`[data-testid="ai-fetch-row"][data-model="${MODEL}"]`);
  await expect(row.or(fetched.getByTestId("ai-fetch-failed"))).toBeVisible({ timeout: 60_000 });
  note(`the service lists ${MODEL}: ${(await row.count()) === 1}`);
  await row.click();
  await fetched.getByTestId("ai-fetch-add").click();
  await expect(settings.getByRole("button", { name: "默认模型" })).toBeVisible();
  await noAutoTitle(page);
  await closeSettings(page);
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-model")).toHaveText(/gpt-?6\.1/i);

  const usage: string[] = [];
  const clips = async () => {
    await showTab(page, "timeline");
    return content(page, "timeline")
      .getByRole("option")
      .evaluateAll((each) => each.map((one) => one.getAttribute("aria-label")));
  };
  const turn = async (words: string, name: string, done: () => Promise<void>) => {
    await box(page).fill(words);
    await box(page).press("Enter");
    await done();
    const line = chat(page).getByTestId("chat-usage").last();
    await expect(line).toBeVisible({ timeout: 60_000 });
    const text = ((await line.textContent()) ?? "").trim();
    const detail = (await line.locator("span[title]").first().getAttribute("title")) ?? "";
    usage.push(`${name}: ${text} | ${detail}`);
    note(`turn ${name}: ${text} | ${detail}`);
    note(`  tools called so far: ${called.join(" ")}`);
    await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  };
  const answered = () =>
    expect(chat(page).getByTestId("chat-phase")).toBeHidden({ timeout: 240_000 });
  const failures = () => chat(page).getByTestId("chat-failure");

  try {
    // 1. Edit.
    await turn(
      `在主时间轴上加一个纯色片段：名字叫“${CLIP}”，颜色 #e5484d（红），从 0 秒开始，时长 4 秒。`,
      "1-edit",
      async () => {
        await expect(chat(page).getByTestId("chat-change").first()).toBeVisible({
          timeout: 240_000,
        });
        await answered();
      },
    );
    expect(await failures().count(), "turn 1 failed").toBe(0);
    expect((await clips()).join()).toContain(CLIP);
    await showTab(page, "chat");

    // 2. Read.
    const before = called.length;
    await turn("时间轴上现在有什么？", "2-read", async () => {
      await expect(chat(page).getByTestId("chat-answer").last()).toContainText(CLIP, {
        timeout: 240_000,
      });
      await answered();
    });
    const read = called.slice(before);
    note(`  this turn: ${read.join(" ")}`);
    expect(
      read.some((each) => /^aq_(project_status|timeline_read|object_read|search)$/.test(each)),
    ).toBe(true);
    expect(read).not.toContain("aq_edit");

    // 3. Look.
    await turn("看一下第 1 秒的画面，告诉我画面是什么颜色。", "3-look", async () => {
      await expect(chat(page).locator('[data-testid="chat-tool"][data-look]').first()).toBeVisible({
        timeout: 240_000,
      });
      await answered();
    });
    expect(called).toContain("aq_render_frames");
    await expect(chat(page).getByTestId("chat-look-picture").first().locator("img")).toBeVisible();

    // 4. Plan first: a card, and nothing changed.
    const changes = await chat(page).getByTestId("chat-change").count();
    const timeline = (await clips()).join();
    await showTab(page, "chat");
    await chat(page).getByTestId("chat-plus").click();
    await chat(page).getByTestId("chat-plus-plan").click();
    await expect(chat(page).getByTestId("chat-mode-plan")).toBeVisible();
    await turn(
      "做一个 10 秒的片头：先红块淡入，再出标题“你好”。先给我方案。",
      "4-plan",
      async () => {
        await expect(
          chat(page).locator('[data-testid="chat-plan"][data-state="open"]'),
        ).toBeVisible({ timeout: 240_000 });
        await answered();
      },
    );
    expect(await chat(page).getByTestId("chat-change").count()).toBe(changes);
    expect(called).toContain("aq_propose");
    expect((await clips()).join()).toBe(timeline);
  } finally {
    note(`usage per turn:\n${usage.join("\n")}`);
    const total = chat(page).getByTestId("chat-usage-total");
    if (await total.count()) note(`total meter: ${(await total.textContent())?.trim()}`);
    note(`requests to the service:\n${seen.join("\n")}`);
  }
});
