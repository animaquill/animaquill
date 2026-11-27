import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  goToSettingsGroup,
  noAutoTitle,
  settingsOf,
} from "./ai-support.ts";
import { content, devPageOnly, expect, test, showTab } from "./support.ts";
import { execute, reload } from "./undo-support.ts";

/**
 * Several conversations at once (docs/design/ai-teamwork.md of AnimaQuill Cloud, 1): one runs on
 * while people open another and send there; both change the project, also the same marker, where
 * the one that read it before the other changed it is refused and reads it again; each takes back
 * only what it changed, and says who changed what stayed; after a reload both conversations and
 * their cards are there. A conversation not shown that waits for people to allow a change says so
 * in the corner and with a dot. Pictures go to the output of the test.
 */

devPageOnly("window.aqExecute, window.aqState and the undo hooks");

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
const title = (page: Page) => chat(page).getByTestId("chat-title");
const row = (page: Page, text: string) =>
  chat(page).getByTestId("chat-switcher-row").filter({ hasText: text });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`6a-${name}.png`) });

/** The markers of the main timeline: their names, by id. */
const markers = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as {
        aqState: () => {
          timelines: Record<string, { markers?: Record<string, { name: string }> }>;
        };
      }
    ).aqState();
    return Object.fromEntries(
      Object.entries(state.timelines["main"]?.markers ?? {}).map(([id, { name }]) => [id, name]),
    );
  });

type Calls = Parameters<typeof anthropicCalls>[0];
/** One answer of the pretend model: calls of tools, or words; "hold" waits until let go. */
type Answer = Calls | string | "hold";

const read = { name: "aq_timeline_read", input: { timeline: "main" } };
const rename = (name: string, id: string) => ({
  name: "aq_edit",
  input: {
    operations: [
      { op: "marker.update", timeline: "main", marker: "m0", changes: { name } },
      { op: "marker.add", timeline: "main", id, time: id === "mA" ? "5" : "6", name: id },
    ],
  },
});

/**
 * A pretend model that answers each conversation from its own script, by the words its first
 * message starts with ("A：", "B："); an answer "hold" waits until `go` lets it, then gives the next.
 */
async function pretend(page: Page, scripts: Record<string, readonly Answer[]>, askFirst = false) {
  const at: Record<string, number> = {};
  const held: (() => void)[] = [];
  await page.route(ANTHROPIC, async (route: Route) => {
    const asked = route.request().postDataJSON() as {
      max_tokens?: number;
      tools?: unknown;
      messages?: { role: string; content: unknown }[];
    };
    if (asked.max_tokens === 16) return route.fallback();
    const fulfil = (body: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body,
      });
    if (asked.tools === undefined) return fulfil(anthropicSays("标题"));
    const first = JSON.stringify(asked.messages?.find((each) => each.role === "user")?.content);
    const who = Object.keys(scripts).find((key) => first.includes(`${key}：`)) ?? "";
    const script = scripts[who] ?? [];
    let answer = script[at[who] ?? 0];
    at[who] = (at[who] ?? 0) + 1;
    if (answer === "hold") {
      await new Promise<void>((resolve) => held.push(resolve));
      answer = script[at[who] ?? 0];
      at[who] = (at[who] ?? 0) + 1;
    }
    const n = Object.values(at).reduce((sum, each) => sum + each, 0);
    return fulfil(
      answer === undefined || typeof answer === "string"
        ? anthropicSays(answer ?? "好了。")
        : anthropicCalls(answer).replaceAll("toolu_", `toolu_${who}${n}_`),
    );
  });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");
  await noAutoTitle(page);
  if (askFirst) {
    await goToSettingsGroup(page, "AI 聊天");
    await settingsOf(page).getByRole("switch", { name: "AI 改项目前先问我" }).check();
  }
  await closeSettings(page);
  const made = { timeline: "main", id: "m0", time: "1", name: "片头" };
  expect(await execute(page, { type: "marker.add", params: made })).toBe(true);
  await showTab(page, "chat");
  return { go: () => held.shift()?.() };
}

async function send(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

test("two conversations at once: each goes on, changes the same marker in turn, and takes back its own", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { go } = await pretend(page, {
    // A reads the marker, then waits; meanwhile B changes it: A's change is refused, A reads again.
    A: [[read], "hold", [rename("A 改的", "mA")], [read], [rename("A 改的", "mA")], "A 好了。"],
    B: [[read], [rename("B 改的", "mB")], "B 好了。"],
  });
  await send(page, "A：改片头标记，再加一个");
  await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "stop");
  // Another conversation while A runs: ✎ opens it at once.
  await chat(page).getByTestId("chat-new").click();
  await expect(chat(page).getByTestId("chat-task")).toHaveCount(0);
  await expect(page.getByTestId("status-runs")).toHaveText("「A：改片头标记，再加一个」在跑");
  await send(page, "B：也改片头标记，再加一个");
  await expect(chat(page).getByText("B 好了。")).toBeVisible({ timeout: 15_000 });
  expect(await markers(page)).toEqual({ m0: "B 改的", mB: "mB" });
  // A still runs, in the list with its spinner.
  await title(page).click();
  await expect(row(page, "A：").getByTestId("chat-conversation-running")).toBeVisible();
  await shot(page, "1-switcher-running");
  await page.keyboard.press("Escape");
  await page.getByTestId("status-runs").click();
  await expect(page.getByTestId("status-run")).toHaveCount(1);
  await shot(page, "2-status-runs");
  await page.keyboard.press("Escape");

  // A goes on: what B changed since A read it is refused, and A reads again and changes it.
  go();
  await expect(page.getByTestId("status-runs")).toBeHidden({ timeout: 15_000 });
  expect(await markers(page)).toEqual({ m0: "A 改的", mA: "mA", mB: "mB" });
  // Done while not shown: a dot on it, and before the title of the one shown.
  await expect(chat(page).getByTestId("chat-others-call")).toBeVisible();
  await title(page).click();
  await expect(row(page, "A：").getByTestId("chat-conversation-asking")).toBeVisible();
  await page.keyboard.press("Escape");

  // B takes back its own: its marker goes, the name A gave after stays, and says who gave it.
  await chat(page).getByRole("button", { name: "撤销这一轮" }).click();
  await expect(
    page.getByText("1 处后来被「A：改片头标记，再加一个」改过，保留了它的改动。"),
  ).toBeVisible();
  expect(await markers(page)).toEqual({ m0: "A 改的", mA: "mA" });
  await shot(page, "3-undo-kept-by");

  // After a reload both are there, with their cards; A takes back its own.
  await reload(page);
  await title(page).click();
  await expect(chat(page).getByTestId("chat-switcher-row")).toHaveCount(2);
  await row(page, "A：").click();
  await expect(chat(page).getByText("A 好了。")).toBeVisible();
  const cardA = chat(page).getByTestId("chat-card");
  await expect(cardA).toContainText("改了 2 处");
  // The refused one is a step of its work: A read again and changed it then.
  await cardA.getByRole("button", { name: "撤销这一轮" }).click();
  await expect.poll(() => markers(page)).toEqual({ m0: "B 改的" });
  await title(page).click();
  await row(page, "B：").click();
  await expect(chat(page).getByText("B 好了。")).toBeVisible();
  await expect(chat(page).getByRole("button", { name: "重做这一轮" })).toBeVisible();
});

test("a conversation not shown that waits for people: a word in the corner, a dot, and the card where it is", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await pretend(
    page,
    {
      A: [
        [
          {
            name: "aq_edit",
            input: {
              operations: [{ op: "marker.add", timeline: "main", id: "mA", time: "5", name: "mA" }],
            },
          },
        ],
        "A 好了。",
      ],
      B: ["B 好了。"],
    },
    true,
  );
  await send(page, "A：加一个标记");
  await expect(chat(page).getByTestId("chat-approve")).toBeVisible({ timeout: 15_000 });
  // Away from it before it is answered: it waits there, with a dot.
  await chat(page).getByTestId("chat-new").click();
  await expect(chat(page).getByTestId("chat-approve")).toBeHidden();
  await expect(chat(page).getByTestId("chat-others-call")).toBeVisible();
  await send(page, "B：随便聊聊");
  await expect(chat(page).getByText("B 好了。")).toBeVisible({ timeout: 15_000 });
  expect(await markers(page)).toEqual({ m0: "片头" });
  // The status bar says it waits for people, not that it runs.
  await expect(page.getByTestId("status-runs")).toHaveText("「A：加一个标记」等你允许");
  await shot(page, "4-waiting-elsewhere");
  // Back to it: the card where it was, and the change goes once allowed.
  await title(page).click();
  await row(page, "A：").click();
  await chat(page).getByTestId("chat-approve-once").click();
  await expect(chat(page).getByText("A 好了。")).toBeVisible({ timeout: 15_000 });
  expect(await markers(page)).toEqual({ m0: "片头", mA: "mA" });
});

test("a conversation not shown that starts to wait for people says so in the corner, with the way there", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const add = {
    name: "aq_edit",
    input: {
      operations: [{ op: "marker.add", timeline: "main", id: "mA", time: "5", name: "mA" }],
    },
  };
  const { go } = await pretend(page, { A: ["hold", [add], "A 好了。"] }, true);
  await send(page, "A：加一个标记");
  await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "stop");
  await chat(page).getByTestId("chat-new").click();
  go();
  const notice = page.getByText("「A：加一个标记」要改 1 处，等你允许");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await shot(page, "5-notice");
  await page.getByRole("button", { name: "去看看" }).click();
  await expect(chat(page).getByTestId("chat-approve")).toBeVisible();
  await chat(page).getByTestId("chat-approve-once").click();
  await expect(chat(page).getByText("A 好了。")).toBeVisible({ timeout: 15_000 });
});
