import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  noAutoTitle,
  openWork,
} from "./ai-support.ts";
import { content, devPageOnly, editorReady, expect, test, showTab } from "./support.ts";

/**
 * Conversations of one project in several tabs of a browser (docs/design/ai-teamwork.md of
 * AnimaQuill Cloud, 3; chat6 technical design, 6.2): a conversation sees the one of another tab
 * and sends to it, which answers there; a message for one whose tab was closed waits, and it gets
 * it once a tab opens it again; of two tabs that have the same one open, only the one that has it
 * first takes a message, and the other takes over when that one crashes. Pictures go to the output
 * of the test, and to /root/aq-work/chat-shots/6c/ from there.
 */

devPageOnly("window.aqExecute and window.aqState");

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
const title = (page: Page) => chat(page).getByTestId("chat-title");
const row = (page: Page, text: string) =>
  chat(page).getByTestId("chat-switcher-row").filter({ hasText: text });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`6c-${name}.png`) });

type Calls = Parameters<typeof anthropicCalls>[0];
interface Asked {
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}
type Answer = Calls | string;

const sendTo = (to: string, message: string) => ({ name: "aq_send", input: { to, message } });

/**
 * A pretend model for the tab of a page, that answers each conversation from its own script, by
 * the words its first message starts with ("A：", "B："); and the words of the last message of each
 * request, to count what each tab was asked.
 */
async function pretend(page: Page, scripts: Record<string, readonly Answer[]>) {
  const at: Record<string, number> = {};
  const asked: string[] = [];
  await page.route(ANTHROPIC, async (route: Route) => {
    const body = route.request().postDataJSON() as Asked & {
      max_tokens?: number;
      tools?: unknown;
    };
    if (body.max_tokens === 16) return route.fallback();
    const fulfil = (text: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body: text,
      });
    if (body.tools === undefined) return fulfil(anthropicSays("标题"));
    asked.push(JSON.stringify(body.messages.at(-1)?.content ?? ""));
    const first = JSON.stringify(body.messages.find((each) => each.role === "user")?.content);
    const who = Object.keys(scripts).find((key) => first.includes(`${key}：`)) ?? "";
    const answer = scripts[who]?.[at[who] ?? 0];
    at[who] = (at[who] ?? 0) + 1;
    const n = Object.values(at).reduce((sum, each) => sum + each, 0);
    return fulfil(
      answer === undefined || typeof answer === "string"
        ? anthropicSays(answer ?? "好了。")
        : anthropicCalls(answer).replaceAll("toolu_", `toolu_${who}${n}_`),
    );
  });
  return { asked };
}

/** Another tab of the browser with the project of `page` open, and its chat shown. */
async function anotherTab(page: Page): Promise<Page> {
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await other.goto(page.url());
  await editorReady(other);
  await showTab(other, "chat");
  return other;
}

/** What in the chat scrolls sideways: nothing should. */
const sideways = (page: Page) =>
  chat(page).evaluate((panel) =>
    [panel, ...panel.querySelectorAll("*")]
      .filter((each) => {
        const { overflowX } = getComputedStyle(each);
        return (
          (overflowX === "auto" || overflowX === "scroll") &&
          each.scrollWidth > each.clientWidth + 1
        );
      })
      .map((each) => each.getAttribute("data-testid") ?? each.className),
  );

async function send(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

async function newConversation(page: Page) {
  await chat(page).getByTestId("chat-new").click();
  await expect(chat(page).getByTestId("chat-task")).toHaveCount(0);
}

async function openRow(page: Page, text: string) {
  await title(page).click();
  await row(page, text).click();
  await expect(title(page)).toHaveText(new RegExp(text));
}

/** The first tab with the service set up, its chat shown. */
async function setUp(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");
  await noAutoTitle(page);
  await closeSettings(page);
  await showTab(page, "chat");
}

test("to one in another tab: it answers there; once that tab is closed, a message waits until it opens again", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await setUp(page);
  await pretend(page, {
    A: [
      [sendTo("B：配乐", "配乐还会换吗？我在按它剪开场。")],
      "问过了，等它回。",
      [sendTo("B：配乐", "回来以后看看开场的配乐。")],
      "留了言。",
    ],
  });
  const second = await anotherTab(page);
  await pretend(second, { B: ["配乐交给我。", "不换了，就用现在这首。"] });
  await send(second, "B：配乐");
  await expect(chat(second).getByText("配乐交给我。")).toBeVisible({ timeout: 15_000 });

  await send(page, "A：剪开场，问问配乐");
  await expect(chat(page).getByText("问过了，等它回。")).toBeVisible({ timeout: 15_000 });
  await openWork(chat(page));
  await expect(chat(page).getByTestId("chat-tool")).toContainText("给「B：配乐」发了消息");
  // B answered in its own tab, from A; the first tab did not open it.
  const from = chat(second).getByTestId("chat-agent-message");
  await expect(from).toContainText("来自「A：剪开场，问问配乐」");
  await expect(from).toContainText("配乐还会换吗？我在按它剪开场。");
  await expect(chat(second).getByText("不换了，就用现在这首。")).toBeVisible({ timeout: 15_000 });
  await shot(second, "1-answered-in-its-tab");

  // Its tab is closed: the message waits.
  await second.close();
  await send(page, "A：再问一次");
  await expect(chat(page).getByText("留了言。")).toBeVisible({ timeout: 15_000 });
  await openWork(chat(page));
  await expect(chat(page).getByTestId("chat-tool").last()).toContainText("给「B：配乐」留了言");
  // A long step is one line that ends in "…", and says all of itself on hover: nothing scrolls
  // sideways.
  await expect(
    chat(page).getByTestId("chat-tool").last().locator("[title]").first(),
  ).toHaveAttribute("title", /给「B：配乐」留了言/);
  expect(await sideways(page)).toEqual([]);
  await shot(page, "2-left-for-closed-tab");

  // A tab opens it again: it gets the message, and answers.
  const third = await anotherTab(page);
  await pretend(third, { B: ["看到留言了，开场的配乐不动。"] });
  await openRow(third, "B：配乐");
  const left = chat(third).getByTestId("chat-agent-message").last();
  await expect(left).toContainText("来自「A：剪开场，问问配乐」");
  await expect(left).toContainText("回来以后看看开场的配乐。");
  await expect(chat(third).getByText("看到留言了，开场的配乐不动。")).toBeVisible({
    timeout: 15_000,
  });
  await shot(third, "3-got-it-when-opened");
  await third.close();
});

test("of two tabs that have it open, only the first takes a message; the other takes over when that one crashes", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await setUp(page);
  const first = await pretend(page, {
    A: [
      [sendTo("B：配乐", "两边都开着，谁收？")],
      "发了。",
      [sendTo("B：配乐", "那边没了，你在这边接着。")],
      "好。",
    ],
    B: ["这边接着做。"],
  });
  const second = await anotherTab(page);
  const other = await pretend(second, { B: ["配乐交给我。", "我收到了，只有一次。"] });
  await send(second, "B：配乐");
  await expect(chat(second).getByText("配乐交给我。")).toBeVisible({ timeout: 15_000 });
  // The first tab has it open too.
  await openRow(page, "B：配乐");
  await expect(chat(page).getByText("配乐交给我。")).toBeVisible();
  // The second tab has it: here it is only to read.
  await expect(chat(page).getByTestId("chat-elsewhere")).toContainText(
    "这个对话在另一个标签页里开着",
  );
  await expect(chat(page).getByTestId("chat-input")).toHaveCount(0);
  await newConversation(page);
  await send(page, "A：问问 B");
  await expect(chat(page).getByText("发了。")).toBeVisible({ timeout: 15_000 });
  await expect(chat(second).getByText("我收到了，只有一次。")).toBeVisible({ timeout: 15_000 });
  // Asked once, in the tab that had it first.
  const once = (asked: readonly string[]) =>
    asked.filter((each) => each.includes("两边都开着，谁收？")).length;
  await page.waitForTimeout(1500);
  expect(once(other.asked)).toBe(1);
  expect(once(first.asked)).toBe(0);
  await shot(second, "4-once-in-first-tab");

  // The second tab goes without a word, as a crash: the browser lets go of what it held, and
  // nothing of the page runs. (A crash of its renderer would take the first tab with it, which is
  // of the same site.) The first one has B now, read again with what the second did.
  await second.goto("about:blank");
  await showTab(page, "chat");
  await send(page, "A：再问");
  await expect(chat(page).getByText("好。")).toBeVisible({ timeout: 15_000 });
  await openRow(page, "B：配乐");
  await expect(chat(page).getByText("我收到了，只有一次。")).toBeVisible();
  await expect(chat(page).getByText("这边接着做。")).toBeVisible({ timeout: 15_000 });
  await expect(chat(page).getByTestId("chat-agent-message").last()).toContainText(
    "那边没了，你在这边接着。",
  );
  await shot(page, "5-took-over");
  await second.close();
});

test("one tab at a time has a conversation: another reads it, and takes it there when people ask", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setUp(page);
  await pretend(page, { B: ["这边接着说。"] });
  const second = await anotherTab(page);
  await pretend(second, { B: ["配乐交给我。"] });
  await send(second, "B：配乐");
  await expect(chat(second).getByText("配乐交给我。")).toBeVisible({ timeout: 15_000 });
  await openRow(page, "B：配乐");
  const elsewhere = chat(page).getByTestId("chat-elsewhere");
  await expect(elsewhere).toBeVisible();
  await shot(page, "6-open-in-another-tab");
  await elsewhere.getByRole("button", { name: "在这里接着" }).click();
  // Here now; there only to read.
  await expect(chat(page).getByTestId("chat-elsewhere")).toHaveCount(0, { timeout: 15_000 });
  await expect(chat(second).getByTestId("chat-elsewhere")).toBeVisible();
  await send(page, "接着");
  await expect(chat(page).getByText("这边接着说。")).toBeVisible({ timeout: 15_000 });
  await shot(second, "7-taken-to-the-other-tab");
  await second.close();
});
