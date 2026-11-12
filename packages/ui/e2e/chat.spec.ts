import type { Page, Request, Route } from "@playwright/test";
import { addAnthropic, openSettingsPage, settingsOf } from "./ai-support.ts";
import { clips } from "./property-helpers.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The chat with AI in the browser, against a pretend Anthropic: the page talks to the real address
 * the way it would for people, and the test answers in its place with what the service streams.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";
const ANTHROPIC = "https://api.anthropic.com/**";

const chat = (page: Page) => content(page, "chat");

/** Sets up Anthropic with a key and a model, as people do in the settings. */
async function setUpService(page: Page) {
  await addAnthropic(page, KEY, "claude-test");
  await expect(content(page, "settings").getByTestId("ai-keys-where")).toContainText(
    "animaquill-keys",
  );
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test");
  await expect(chat(page).getByRole("textbox", { name: /给 AI 发消息/ })).toBeVisible();
}

/** A new conversation, from the menu of the one open. */
async function newConversation(page: Page) {
  await chat(page).getByTestId("chat-more").click();
  await chat(page).getByRole("menuitem", { name: "新对话" }).click();
}

async function send(page: Page, text: string) {
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill(text);
  await box.press("Enter");
}

type Block =
  | { readonly text: string }
  | { readonly thinking: string }
  | { readonly tool: string; readonly input: Record<string, unknown> };

let toolIds = 0;

/** What Anthropic counts for a request: tokens in, read from its cache, and out. */
interface Counted {
  readonly input: number;
  readonly cacheRead?: number;
  readonly output: number;
}

/** What Anthropic streams for an answer, as server-sent events. */
function stream(blocks: readonly Block[], usage: Counted = { input: 10, output: 20 }): string {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input,
            cache_read_input_tokens: usage.cacheRead ?? 0,
            output_tokens: 1,
          },
        },
      },
    ],
  ];
  blocks.forEach((block, index) => {
    if ("thinking" in block) {
      events.push(
        [
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "thinking_delta", thinking: block.thinking },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "signature_delta", signature: "sig" },
          },
        ],
      );
    } else if ("text" in block) {
      events.push(
        [
          "content_block_start",
          { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        ],
        [
          "content_block_delta",
          { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
        ],
      );
    } else {
      const id = `toolu_${++toolIds}`;
      events.push(
        [
          "content_block_start",
          {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id, name: block.tool, input: {} },
          },
        ],
        [
          "content_block_delta",
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          },
        ],
      );
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  const tools = blocks.some((block) => "tool" in block);
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: tools ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: usage.output },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const answer = (route: Route, blocks: readonly Block[], usage?: Counted) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body: stream(blocks, usage),
  });

/** What Anthropic says when it refuses a request, as it says it. */
const refusal = (route: Route, status: number, type: string, message: string) =>
  route.fulfill({
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify({ type: "error", error: { type, message } }),
  });

/** Opens the process of the last turn that is done, which comes folded. */
async function openProcess(page: Page) {
  const process = chat(page).getByTestId("chat-process").last();
  await process.getByRole("button").first().click();
  await expect(process.getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
}

interface Sent {
  readonly system?: unknown;
  readonly tools: readonly { readonly name: string }[];
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}

/** The id of the first video track, from what aq_timeline_read said. */
const videoTrackIn = (text: string) =>
  /tracks[^:]*: (?:.*\| )?(\S+)(?: "[^"]*")? video/.exec(text)?.[1];

/** What the tools said to the last answer, as the service gets it. */
function toolResults(sent: Sent): string[] {
  const last = sent.messages.at(-1);
  if (!last || !Array.isArray(last.content)) return [];
  return last.content.flatMap((part: { type?: string; content?: unknown }) => {
    if (part.type !== "tool_result") return [];
    const inner = part.content;
    if (typeof inner === "string") return [inner];
    return Array.isArray(inner) ? inner.map((piece: { text?: string }) => piece.text ?? "") : [];
  });
}

/** Failed requests show in the console as errors, which is what these tests are about. */
function expectedInConsole(problems: string[]) {
  const left = problems.filter((problem) => !/Failed to load resource/.test(problem));
  problems.splice(0, problems.length, ...left);
}

test("AI changes the timeline, and the whole task goes back in one step", async ({ page }) => {
  // Setting up a service, a task of four rounds, taking it back and doing it again, and a reload:
  // on a busy machine that is more than the half a minute a test gets.
  test.setTimeout(60_000);
  const requests: Request[] = [];
  await page.route(ANTHROPIC, async (route) => {
    const request = route.request();
    requests.push(request);
    const sent = request.postDataJSON() as Sent;
    switch (requests.length) {
      case 1:
        return answer(route, [
          { thinking: "先看看项目里有什么。" },
          { text: "我先看一下项目。" },
          { tool: "aq_project_status", input: {} },
        ]);
      case 2:
        return answer(route, [{ tool: "aq_timeline_read", input: {} }]);
      case 3: {
        const track = videoTrackIn(toolResults(sent)[0] ?? "");
        return answer(route, [
          {
            tool: "aq_edit",
            input: {
              summary: "加一个蓝色片段和一个标记",
              operations: [
                {
                  op: "clip.add",
                  timeline: "main",
                  track,
                  start: "0",
                  duration: "3",
                  source: { kind: "color", color: "#3366ff" },
                },
                { op: "marker.add", timeline: "main", time: "1", name: "AI" },
              ],
            },
          },
        ]);
      }
      default:
        return answer(route, [{ text: "加了一个蓝色片段和一个标记。" }]);
    }
  });
  await setUpService(page);
  await send(page, "加一个蓝色片段");

  // Four rounds with the service, the first after its library loads: more than a moment when busy.
  await expect(chat(page).getByText("加了一个蓝色片段和一个标记。")).toBeVisible({
    timeout: 15_000,
  });
  await expect(clips(page)).toHaveCount(1);
  // Done, the process folds into one line: what it took, open to every step.
  const process = chat(page).getByTestId("chat-process");
  await expect(process).toContainText("过程 · 1 次思考 · 3 次工具");
  const tools = chat(page).getByTestId("chat-tool");
  await expect(tools).toHaveCount(0);
  await openProcess(page);
  await expect(tools).toHaveCount(3);
  await expect(tools.nth(0)).toContainText("读项目概况");
  await expect(tools.nth(1)).toContainText("读时间轴");
  await expect(tools.nth(2)).toContainText("改项目");
  await expect(tools.nth(2)).toHaveAttribute("data-state", "ok");
  // A line in words for each call: what it was about, not its JSON.
  await expect(tools.nth(2).getByTestId("chat-tool-summary")).toHaveText(
    "加一个蓝色片段和一个标记 · 2 个操作",
  );
  await tools.nth(2).getByRole("button").first().click();
  const body = tools.nth(2).getByTestId("chat-tool-body");
  await expect(body).toContainText("summary：加一个蓝色片段和一个标记");
  await expect(body).toContainText("clip.add");
  await expect(body).not.toContainText('{"op"');
  // What the model said of its thinking, for people to follow, folded.
  await expect(chat(page).getByTestId("chat-thinking").first()).toContainText("思考");

  // The card of the turn: what AI said the batch does, and each object, with where it is.
  await expect(chat(page).getByTestId("chat-card")).toContainText("改了 2 处");
  const changes = chat(page).getByTestId("chat-changes");
  await expect(changes).toContainText("加一个蓝色片段和一个标记");
  const rows = changes.getByTestId("chat-change");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "新加片段" })).toHaveCount(1);
  // A clip without a name has what people call it elsewhere, never its inner id.
  await expect(rows.filter({ hasText: "新加片段" })).toContainText(/新加片段「.+」/);
  await expect(rows.filter({ hasText: "新加片段" })).not.toContainText("clip_");
  await expect(rows.filter({ hasText: "新加标记「AI」" })).toHaveCount(1);
  await rows.filter({ hasText: "新加片段" }).getByRole("button", { name: "定位" }).click();

  // Straight to the service, with the key, the tools of AnimaQuill and the system prompt in parts.
  const first = requests[0] as Request;
  expect(first.url()).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages\b/);
  expect(await first.headerValue("x-api-key")).toBe(KEY);
  const firstSent = first.postDataJSON() as Sent;
  // pi adds a placeholder of its own for Anthropic's cache, which the model never sees.
  const offered = firstSent.tools
    .map((tool) => tool.name)
    .filter((name) => !name.startsWith("__pi_"));
  expect(offered).toHaveLength(12);
  expect(offered).toContain("aq_edit");
  expect(offered).toContain("aq_selection_read");
  expect(offered).not.toContain("clip_add");
  expect(JSON.stringify(firstSent.system)).toContain("You are the AI assistant inside AnimaQuill");

  await chat(page).getByRole("button", { name: "撤销这次任务", exact: true }).click();
  await expect(clips(page)).toHaveCount(0);
  await expect(rows.first().getByRole("button")).toBeDisabled();
  await chat(page).getByRole("button", { name: "重做这次任务", exact: true }).click();
  await expect(clips(page)).toHaveCount(1);

  // The conversation is still there after a reload, with its summary; the key never shows.
  await page.reload();
  await tab(page, "chat").click();
  await expect(chat(page).getByText("加了一个蓝色片段和一个标记。")).toBeVisible();
  await expect(chat(page).getByTestId("chat-change")).toHaveCount(2);
  expect(await page.content()).not.toContain("SECRET");
});

test("AI asks a question, the turn stops, and a pick goes as the next message", async ({
  page,
}) => {
  const requests: Request[] = [];
  await page.route(ANTHROPIC, async (route) => {
    requests.push(route.request());
    if (requests.length === 1) {
      return answer(route, [
        {
          tool: "aq_propose",
          input: {
            kind: "question",
            question: "标题用哪种颜色？",
            options: [{ label: "蓝色", detail: "冷一点" }, { label: "红色" }],
          },
        },
      ]);
    }
    return answer(route, [{ text: "好，用蓝色。" }]);
  });
  await setUpService(page);
  await send(page, "改一下标题的颜色");
  const question = chat(page).getByTestId("chat-question");
  await expect(question).toContainText("标题用哪种颜色？");
  // The turn waits for the answer: nothing more went to the service.
  await expect(chat(page).getByRole("button", { name: "停止" })).toBeHidden();
  expect(requests).toHaveLength(1);
  await question.getByRole("button", { name: /蓝色/ }).click();
  await expect(chat(page).getByText("好，用蓝色。")).toBeVisible();
  const sent = requests[1]?.postDataJSON() as Sent;
  expect(JSON.stringify(sent.messages.at(-1))).toContain("蓝色");
  // Answered: the question of the turn before cannot be picked again.
  await expect(chat(page).getByTestId("chat-question")).toHaveCount(0);
});

test("an earlier conversation with the tools before goes on, with those calls as text", async ({
  page,
}) => {
  const requests: Request[] = [];
  await page.route(ANTHROPIC, async (route) => {
    requests.push(route.request());
    if (requests.length === 1) {
      return answer(route, [{ tool: "aq_project_status", input: {} }]);
    }
    return answer(route, [{ text: requests.length === 2 ? "看过了。" : "接着来。" }]);
  });
  await setUpService(page);
  await send(page, "看看项目");
  await expect(chat(page).getByText("看过了。")).toBeVisible();
  // As the tools before these kept it: a call of project_overview, which is no more.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("animaquill-chats");
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
    const store = database.transaction("chats", "readwrite").objectStore("chats");
    const all = await new Promise<Record<string, unknown>[]>((resolve) => {
      const request = store.getAll();
      request.addEventListener("success", () =>
        resolve(request.result as Record<string, unknown>[]),
      );
    });
    const write = database.transaction("chats", "readwrite").objectStore("chats");
    for (const kept of all) {
      const entries = (kept.entries as Record<string, unknown>[]).map((entry) => {
        if (entry.role === "assistant") {
          const { toolset: _toolset, texts: _texts, ...rest } = entry;
          const calls = (rest.calls as Record<string, unknown>[]).map((call) => ({
            ...call,
            name: "project_overview",
          }));
          return { ...rest, calls };
        }
        if (entry.role === "tool") {
          const { data: _data, ...rest } = entry;
          return { ...rest, name: "project_overview", text: '{"timelines":[]}' };
        }
        return entry;
      });
      const { caller: _caller, ...rest } = kept;
      write.put({ ...rest, entries });
    }
    await new Promise((resolve) => write.transaction.addEventListener("complete", resolve));
  });
  await page.reload();
  await tab(page, "chat").click();
  await openProcess(page);
  await expect(chat(page).getByTestId("chat-tool")).toContainText("读项目结构");
  await send(page, "继续");
  await expect(chat(page).getByText("接着来。")).toBeVisible();
  const sent = requests.at(-1)?.postDataJSON() as Sent;
  const text = JSON.stringify(sent.messages);
  expect(text).toContain("Earlier tool calls with the old tool set");
  expect(text).toContain("- project_overview {}");
  expect(text).not.toContain('"type":"tool_use"');
});

test("the words to compare with are a hidden pack: shown on asking, used once chosen for a model", async ({
  page,
}) => {
  const requests: Request[] = [];
  await page.route(ANTHROPIC, async (route) => {
    requests.push(route.request());
    return answer(route, [{ text: "好的。" }]);
  });
  await setUpService(page);
  await openSettingsPage(page, "模型适配包");
  const settings = content(page, "settings");
  const packs = settings.getByTestId("model-packs");
  const choice = packs.getByRole("combobox", { name: "claude-test 用的适配包" });
  // Hidden until people ask to see it: not in the list, and no model gets it on its own.
  await expect(choice.locator("option", { hasText: "2026.1 旧写法" })).toHaveCount(0);
  await expect(settings.getByText("开发者选项")).toHaveCount(0);
  await packs.getByTestId("pack-show-hidden").check();
  await expect(choice.locator("option:checked")).toHaveText(
    "推荐（自动）：通用（没有专门的适配包）",
  );
  await choice.selectOption({ label: "2026.1 旧写法（对照）（内置）" });
  // Hidden again, the choice stays and is still shown.
  await packs.getByTestId("pack-show-hidden").uncheck();
  await expect(choice.locator("option:checked")).toHaveText("2026.1 旧写法（对照）（内置）");
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-pack")).toHaveText(
    "适配包：2026.1 旧写法（对照）（内置）",
  );
  await send(page, "你好");
  await expect(chat(page).getByText("好的。")).toBeVisible();
  const sent = requests[0]?.postDataJSON() as Omit<Sent, "tools"> & {
    readonly tools: readonly { readonly description: string }[];
  };
  expect(JSON.stringify(sent.system)).toContain("so run it after you change code");
  expect(sent.tools.map(({ description }) => description).join("\n")).toContain(
    "Call it at the start of a task",
  );
  // Back to the one recommended: the conversation keeps its words, also after a reload.
  await openSettingsPage(page, "模型适配包");
  await choice.selectOption({ label: "推荐（自动）：通用（没有专门的适配包）" });
  await page.reload();
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-pack")).toHaveText(
    "适配包：2026.1 旧写法（对照）（内置）",
  );
});

test("keeps the last answer when the page goes right after it came", async ({ page }) => {
  await page.route(ANTHROPIC, (route) => answer(route, [{ text: "这是最后一句。" }]));
  await setUpService(page);
  await send(page, "说一句话");
  await expect(chat(page).getByText("这是最后一句。")).toBeVisible();
  await page.reload();
  await tab(page, "chat").click();
  await expect(chat(page).getByText("这是最后一句。")).toBeVisible();
});

test("stopping ends the task right away, and the chat goes on", async ({ page }) => {
  const waiting: Route[] = [];
  await page.route(ANTHROPIC, async (route) => {
    const sent = route.request().postDataJSON() as Sent;
    // A service that takes its time: the answer to this never comes. The route stays open without
    // holding up the next one.
    if (JSON.stringify(sent.messages.at(-1)).includes("慢慢来")) waiting.push(route);
    else await answer(route, [{ text: "这次很快。" }]);
  });
  await setUpService(page);
  await send(page, "慢慢来");
  const stop = chat(page).getByRole("button", { name: "停止" });
  await expect(stop).toBeVisible();
  // What it does now, and for how long, above the input.
  await expect(chat(page).getByTestId("chat-phase")).toContainText("等模型回答…");
  await stop.click();
  await expect(chat(page).getByTestId("chat-stopped")).toHaveText(
    "已停止。到这里为止的改动都保留了，可以撤销这次任务。",
  );
  await expect(stop).toBeHidden();
  await expect(chat(page).getByTestId("chat-phase")).toBeHidden();

  await send(page, "再来");
  await expect(chat(page).getByText("这次很快。")).toBeVisible();

  // Esc in the input stops too.
  await send(page, "还是慢慢来");
  await expect(chat(page).getByTestId("chat-phase")).toBeVisible();
  await chat(page)
    .getByRole("textbox", { name: /给 AI 发消息/ })
    .press("Escape");
  await expect(chat(page).getByTestId("chat-stopped")).toHaveCount(2);
  await expect(chat(page).getByTestId("chat-phase")).toBeHidden();
  for (const route of waiting) await route.abort().catch(() => {});
});

test("says what to do when the service cannot be reached, or refuses the key", async ({
  page,
  problems,
}) => {
  let refuse = false;
  await page.route(ANTHROPIC, async (route) => {
    if (!refuse) return route.abort("failed");
    return route.fulfill({
      status: 401,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` },
      }),
    });
  });
  await setUpService(page);
  await send(page, "你好");
  // Each task keeps what went wrong in it: the newest is last.
  const failure = chat(page).getByTestId("chat-failure").last();
  await expect(failure).toContainText("连不上服务");
  await expect(failure).toContainText("平台转发");

  refuse = true;
  await send(page, "再试一次");
  await expect(failure).toContainText("服务拒绝了这个 key");
  // What the service said is folded away, without the key; the way out is a button.
  await expect(failure).toContainText("401");
  await expect(failure.getByRole("button", { name: "去设置" })).toBeVisible();
  expect(await page.content()).not.toContain("SECRET");
  expectedInConsole(problems);
});

test("a turn of six tools folds once done, a failed one shows open, and the answer is Markdown", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const reads: Block[] = [
    { tool: "aq_project_status", input: {} },
    { tool: "aq_timeline_read", input: { from: "0", to: "30" } },
    { tool: "aq_object_read", input: { ids: ["clip_nope"] } },
    { tool: "aq_search", input: { query: "标题" } },
    { tool: "aq_selection_read", input: {} },
    { tool: "aq_guide", input: { topic: "ops/clip.move" } },
  ];
  let count = 0;
  await page.route(ANTHROPIC, async (route) => {
    const next = reads[count++];
    if (next) return answer(route, [next]);
    return answer(route, [
      {
        text: [
          "看完了：",
          "",
          "- 项目里**没有**片段",
          "- 时间轴是空的",
          "",
          "| 项目 | 数 |",
          "| --- | --- |",
          "| 片段 | 0 |",
          "",
          '<img src="x" onerror="window.hacked = 1">',
          "",
          "![图](https://example.com/a.png) [说明](https://example.com/doc) [坏的](javascript:alert(1))",
        ].join("\n"),
      },
    ]);
  });
  await setUpService(page);
  await send(page, "看看项目");
  const answerBlock = chat(page).getByTestId("chat-answer");
  await expect(answerBlock.locator("li")).toHaveCount(2, { timeout: 15_000 });
  await expect(answerBlock.locator("strong")).toHaveText("没有");
  await expect(answerBlock.locator("table td").first()).toHaveText("片段");
  // Never HTML of its own, never an image that loads by itself, links that keep the page apart.
  await expect(answerBlock).toContainText('<img src="x"');
  await expect(answerBlock.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as { hacked?: number }).hacked)).toBeUndefined();
  const doc = answerBlock.getByRole("link", { name: "说明" });
  await expect(doc).toHaveAttribute("rel", "noopener noreferrer");
  await expect(doc).toHaveAttribute("target", "_blank");
  await expect(answerBlock.getByRole("link", { name: "坏的" })).toHaveCount(0);

  const process = chat(page).getByTestId("chat-process");
  await expect(process).toContainText("6 次工具 · 1 次失败");
  // Folded, only the failed call shows, and open: why, in words, the words for AI folded away.
  const tools = chat(page).getByTestId("chat-tool");
  await expect(tools).toHaveCount(1);
  await expect(tools.first()).toHaveAttribute("data-state", "failed");
  await expect(tools.first().getByTestId("chat-tool-error")).toContainText("没有成功");
  await expect(tools.first().getByText("给 AI 的原文")).toBeVisible();
  await openProcess(page);
  await expect(tools).toHaveCount(6);
  await expect(tools.nth(1).getByTestId("chat-tool-summary")).toContainText("0:00–0:30");
  await expect(tools.nth(3).getByTestId("chat-tool-summary")).toHaveText("「标题」");
});

test("a failed task is tried again from where it was, as the same task", async ({
  page,
  problems,
}) => {
  let refusing = true;
  await page.route(ANTHROPIC, async (route) => {
    if (refusing) return refusal(route, 401, "authentication_error", "invalid x-api-key");
    return answer(route, [{ text: "这次成了。" }]);
  });
  await setUpService(page);
  await send(page, "你好");
  const failure = chat(page).getByTestId("chat-failure");
  await expect(failure).toContainText("服务拒绝了这个 key");
  refusing = false;
  await failure.getByRole("button", { name: "重试" }).click();
  await expect(chat(page).getByText("这次成了。")).toBeVisible();
  await expect(failure).toHaveCount(0);
  // Still one turn: what people said went once.
  await expect(chat(page).getByTestId("chat-user")).toHaveCount(1);
  expectedInConsole(problems);
});

test("a busy service is tried again by itself, and the chat says so meanwhile", async ({
  page,
  problems,
}) => {
  let requests = 0;
  await page.route(ANTHROPIC, async (route) => {
    requests += 1;
    if (requests === 1) return refusal(route, 429, "rate_limit_error", "Too many requests");
    return answer(route, [{ text: "等了一下，好了。" }]);
  });
  await setUpService(page);
  await send(page, "你好");
  const phase = chat(page).getByTestId("chat-phase");
  await expect(phase).toContainText("服务太忙（429），正在重试 1/3");
  await expect(phase).toHaveAttribute("data-state", "retry");
  await expect(chat(page).getByText("等了一下，好了。")).toBeVisible({ timeout: 10_000 });
  await expect(chat(page).getByTestId("chat-failure")).toHaveCount(0);
  expect(requests).toBe(2);
  expectedInConsole(problems);
});

test("what a conversation took: in the bar on top, and a line under each turn", async ({
  page,
}) => {
  await page.route(ANTHROPIC, (route) =>
    answer(route, [{ text: "好的。" }], { input: 6000, cacheRead: 374_000, output: 1100 }),
  );
  await addAnthropic(page, KEY, "claude-opus-5");
  await tab(page, "chat").click();
  await send(page, "你好");
  await expect(chat(page).getByText("好的。")).toBeVisible();
  // 380k of the 1M Claude Opus 5 takes in, at its listed prices.
  const total = chat(page).getByTestId("chat-usage-total");
  await expect(total).toHaveText("38% · $0.24");
  const line = chat(page).getByTestId("chat-usage");
  await expect(line).toContainText("Claude Opus 5");
  await expect(line).toContainText("↑380k ↓1.1k");
  await expect(line).toContainText("$0.24");
  await total.click();
  const panel = chat(page).getByTestId("chat-usage-panel");
  await expect(panel).toContainText("380k / 1M");
  await expect(panel).toContainText("按公开价格估算");
});

/** The widths of the chat the states are looked at in: a group at the side, and a narrow one. */
const WIDTHS = [420, 320];

/** Pictures of the chat in a state, at each width, for people to look at (in the test's output). */
async function shoot(page: Page, name: string) {
  const panel = chat(page).getByTestId("chat");
  for (const width of WIDTHS) {
    // The group of the chat is wider than this in the window the test makes: the chat is made so.
    await page.addStyleTag({
      content: `[data-testid="chat"] { width: ${width}px !important; }`,
    });
    await expect.poll(async () => (await panel.boundingBox())?.width).toBe(width);
    await panel.screenshot({ path: test.info().outputPath(`cm2-${name}-${width}.png`) });
  }
}

test("the states of a turn, at 420 and 320 wide: done, open, running, stopped, failed, at the limit", async ({
  page,
  problems,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 2000, height: 1000 });
  const waiting: Route[] = [];
  let step = 0;
  await page.route(ANTHROPIC, async (route) => {
    const sent = route.request().postDataJSON() as Sent;
    const said = JSON.stringify(sent.messages);
    const usage = { input: 6000, cacheRead: 120_000 + step * 4000, output: 300 };
    if (said.includes("一直读")) return answer(route, [{ tool: "aq_project_status", input: {} }]);
    if (said.includes("加一个蓝色片段"))
      return refusal(route, 401, "authentication_error", "invalid x-api-key");
    if (said.includes("结尾加一段黑场")) {
      if (said.includes("tool_result")) return void waiting.push(route);
      return answer(route, [
        { thinking: "先看看结尾在哪、最后一个片段有没有转场。" },
        { tool: "aq_timeline_read", input: { from: "50", to: "62" } },
      ]);
    }
    step += 1;
    switch (step) {
      case 1:
        return answer(
          route,
          [
            { thinking: "先读时间轴，看看开场有哪几个片段。\n然后把它们拉长。" },
            { tool: "aq_timeline_read", input: { from: "0", to: "30" } },
          ],
          usage,
        );
      case 2:
        return answer(
          route,
          [
            { text: "时间轴上还没有片段，我先加一个开场片段。" },
            { tool: "aq_object_read", input: { ids: ["clip_open"] } },
          ],
          usage,
        );
      case 3: {
        // What aq_timeline_read said, two calls before.
        const track = videoTrackIn(said);
        return answer(
          route,
          [
            {
              tool: "aq_edit",
              input: {
                summary: "加开场片段和标记",
                operations: [
                  {
                    op: "clip.add",
                    timeline: "main",
                    track,
                    start: "0",
                    duration: "6",
                    source: { kind: "color", color: "#3366ff" },
                  },
                  { op: "marker.add", timeline: "main", time: "2", name: "开场" },
                ],
              },
            },
          ],
          usage,
        );
      }
      default:
        return answer(
          route,
          [
            {
              text: [
                "加好了开场，**6 秒**，并在 2 秒处做了标记：",
                "",
                "- 片段：蓝色，0:00–0:06",
                "- 标记「开场」：0:02",
                "",
                "| 对象 | 开始 | 时长 |",
                "| --- | --- | --- |",
                "| 开场片段 | 0:00 | 0:06 |",
              ].join("\n"),
            },
          ],
          usage,
        );
    }
  });
  await addAnthropic(page, KEY, "claude-opus-5");
  await tab(page, "chat").click();

  // Done: the process folded, the failed call open, the answer, the card, what it took.
  await send(page, "把开场放慢一点，字幕跟着对齐");
  await expect(chat(page).getByTestId("chat-usage")).toBeVisible({ timeout: 15_000 });
  await expect(chat(page).getByTestId("chat-card")).toContainText("改了 2 处");
  await shoot(page, "done");
  await openProcess(page);
  await shoot(page, "done-open");

  // Running: each step as it comes, what it does now, and stop in place of send.
  await newConversation(page);
  await send(page, "结尾加一段黑场");
  await expect(chat(page).getByTestId("chat-tool")).toHaveAttribute("data-state", "ok");
  await expect(chat(page).getByTestId("chat-phase")).toContainText("等模型回答…");
  await shoot(page, "running");
  await chat(page).getByRole("button", { name: "停止" }).click();
  await expect(chat(page).getByTestId("chat-stopped")).toBeVisible();
  await shoot(page, "stopped");

  // Failed: what to do first, buttons, what the service said folded away.
  await newConversation(page);
  await send(page, "加一个蓝色片段");
  await expect(chat(page).getByTestId("chat-failure")).toContainText("服务拒绝了这个 key");
  await shoot(page, "failed");

  // At the limit of tools: it says so, with a way to go on.
  await openSettingsPage(page, "AI 模型");
  await settingsOf(page).getByLabel("一次任务最多调用工具").fill("3");
  await tab(page, "chat").click();
  await newConversation(page);
  await send(page, "一直读");
  const limit = chat(page).getByTestId("chat-limit");
  await expect(limit).toContainText("这次任务调用了 3 次工具，停下了。");
  await expect(limit.getByRole("button", { name: "继续" })).toBeVisible();
  await shoot(page, "limit");
  for (const route of waiting) await route.abort().catch(() => {});
  expectedInConsole(problems);
});
