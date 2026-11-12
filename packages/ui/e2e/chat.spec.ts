import type { Page, Request, Route } from "@playwright/test";
import { clips } from "./property-helpers.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * The chat with AI in the browser, against a pretend Anthropic: the page talks to the real address
 * the way it would for people, and the test answers in its place with what the service streams.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";
const ANTHROPIC = "https://api.anthropic.com/**";

const chat = (page: Page) => content(page, "chat");

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

/** Sets up Anthropic with a key and a model, as people do in the settings. */
async function setUpService(page: Page) {
  await chooseFrom(page, "视图", "设置");
  const settings = content(page, "settings");
  await settings.getByRole("combobox", { name: "服务类型" }).selectOption("anthropic");
  await settings.getByRole("button", { name: "添加服务" }).click();
  const service = settings.getByTestId("ai-service");
  await service.getByLabel("Key").fill(KEY);
  await service.getByLabel("Key").press("Enter");
  await expect(service.getByLabel("Key")).toHaveAttribute("placeholder", "已保存（不显示）");
  await expect(service.getByLabel("Key")).toHaveValue("");
  await service.getByLabel("模型").fill("claude-test");
  await service.getByLabel("模型").press("Enter");
  await expect(settings.getByTestId("ai-keys-where")).toContainText("animaquill-keys");
  await tab(page, "chat").click();
  await expect(chat(page).getByRole("textbox", { name: /给 AI 发消息/ })).toBeVisible();
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

/** What Anthropic streams for an answer, as server-sent events. */
function stream(blocks: readonly Block[]): string {
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
          usage: { input_tokens: 10, output_tokens: 1 },
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
        usage: { output_tokens: 20 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const answer = (route: Route, blocks: readonly Block[]) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body: stream(blocks),
  });

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
  const tools = chat(page).getByTestId("chat-tool");
  await expect(tools).toHaveCount(3);
  await expect(tools.nth(0)).toContainText("读项目概况");
  await expect(tools.nth(1)).toContainText("读时间轴");
  await expect(tools.nth(2)).toContainText("改项目");
  await expect(tools.nth(2)).toHaveAttribute("data-state", "ok");
  // What the model said of its thinking, for people to follow, folded.
  await expect(chat(page).getByTestId("chat-thinking").first()).toContainText("思考");

  // The summary of the turn: what AI said the batch does, and each object, with where it is.
  await expect(chat(page).getByText("改了 2 处")).toBeVisible();
  const changes = chat(page).getByTestId("chat-changes");
  await expect(changes).toContainText("加一个蓝色片段和一个标记");
  const rows = changes.getByTestId("chat-change");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "新加片段" })).toHaveCount(1);
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

  await chat(page).getByRole("button", { name: "撤销这次任务的改动" }).click();
  await expect(clips(page)).toHaveCount(0);
  await expect(rows.first().getByRole("button")).toBeDisabled();
  await chat(page).getByRole("button", { name: "重做这次任务的改动" }).click();
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
  expect(JSON.stringify(sent.messages.at(-1))).toContain("选了：蓝色");
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
  await expect(chat(page).getByTestId("chat-tool")).toContainText("读项目结构");
  await send(page, "继续");
  await expect(chat(page).getByText("接着来。")).toBeVisible();
  const sent = requests.at(-1)?.postDataJSON() as Sent;
  const text = JSON.stringify(sent.messages);
  expect(text).toContain("[earlier tool call project_overview");
  expect(text).toContain("Results of earlier tool calls");
  expect(text).not.toContain('"type":"tool_use"');
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
  await expect(chat(page).getByText("正在想…")).toBeVisible();
  await stop.click();
  await expect(chat(page).getByText(/已停止/)).toBeVisible();
  await expect(stop).toBeHidden();

  await send(page, "再来");
  await expect(chat(page).getByText("这次很快。")).toBeVisible();
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
  await expect(failure).toContainText("401");
  expect(await page.content()).not.toContain("SECRET");
  expectedInConsole(problems);
});
