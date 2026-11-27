import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicSays,
  closeSettings,
  isConnectionTest,
} from "./ai-support.ts";
import { goTo } from "./property-helpers.ts";
import { chooseFolder } from "./scene-support.ts";
import { sceneBothThemes } from "./shots-support.ts";
import { content, expect, tab, test, showTab } from "./support.ts";

/**
 * `/` and `@` in the input box of the chat (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3):
 * commands at the start of what is written, also as `、` from Chinese input; blocks of what the
 * project has, by their names, from a menu where the caret is.
 */

const KEY = "sk-ant-test-0123456789abcdef";

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
const menu = (page: Page) => chat(page).getByTestId("chat-complete");
const options = (page: Page) => chat(page).getByTestId("chat-complete-option");
const stage = (page: Page) =>
  content(page, "timeline").getByRole("group", { name: "时间轴", exact: true });

/** Clips with names and without, a caption, a marker; `plain` more colours without names. */
function project(plain = 2): string {
  const made = createProject({ name: "引用项目" });
  const files = writeProject(made);
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { id: string; kind: string; clips: unknown[] }[];
    markers?: unknown[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  const named = [
    { id: "title", name: "片头标题" },
    { id: "night", name: "城市夜景" },
  ];
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    ...named.map((clip, at) => ({
      ...clip,
      start: String(at * 2),
      duration: "2",
      source: { kind: "color", color: "#3366ff" },
    })),
    ...Array.from({ length: plain }, (_, at) => ({
      id: `plain_${at}`,
      start: String(4 + at * 2),
      duration: "2",
      source: { kind: "color", color: "#30a46c" },
    })),
  ];
  timeline.tracks.push({
    id: "subs",
    kind: "caption",
    clips: [
      {
        id: "cap",
        start: "0",
        duration: "3",
        source: { kind: "caption", text: "欢迎来到这座城市" },
      },
    ],
  });
  timeline.markers = [{ id: "peak", time: "5", name: "高潮" }];
  files.set(path, JSON.stringify(timeline));
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-complete-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

interface Sent {
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}

/** Answers every request "好的。", and keeps what was sent. */
async function pretend(page: Page) {
  const sent: Sent[] = [];
  await page.route(ANTHROPIC, (route: Route) => {
    const fulfil = (text: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body: anthropicSays(text),
      });
    if (isConnectionTest(route)) return fulfil("OK");
    sent.push(route.request().postDataJSON() as Sent);
    return fulfil("好的。");
  });
  return sent;
}

async function setUp(page: Page, plain = 2) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await chooseFolder(page, project(plain));
  await expect(tab(page, "preview")).toBeVisible();
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-test");
}

/** Text as an input method puts it in: Chinese punctuation, words it composed. */
async function typeAsInput(page: Page, text: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.insertText", { text });
}

const said = (sent: Sent) => {
  const last = sent.messages.findLast((message) => message.role === "user")?.content;
  return typeof last === "string" ? last : JSON.stringify(last);
};

test.use({ withProject: false });

test("/ at the start: the commands, found by name, pinyin or English; 、 as Chinese input types it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sent = await pretend(page);
  await setUp(page);
  await box(page).click();
  await box(page).pressSequentially("/");
  await expect(menu(page)).toBeVisible();
  // Nothing to sum up and no name yet in a new conversation: those two say so, greyed.
  await expect(options(page)).toHaveText([
    /\/方案\s*打开先出方案/,
    /\/新对话\s*开一个新对话/,
    /\/压缩\s*还没有可以压缩的对话/,
    /\/画面\s*截取当前画面/,
    /\/重命名\s*先发一条消息/,
  ]);
  await expect(options(page).nth(2)).toHaveAttribute("aria-disabled", "true");
  await expect(options(page).nth(4)).toHaveAttribute("aria-disabled", "true");
  // The focus stays in the box, which says which one is chosen.
  await expect(box(page)).toBeFocused();
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  const active = await box(page).getAttribute("aria-activedescendant");
  expect(active).toBe(await options(page).first().getAttribute("id"));
  await page.keyboard.press("ArrowUp");
  await expect(options(page).last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await box(page).press("Backspace");
  await expect(menu(page)).toBeHidden();

  // A slash alone is not a command yet: Enter does nothing, sends nothing, keeps the slash.
  await box(page).pressSequentially("/");
  await page.keyboard.press("Enter");
  await expect(box(page)).toHaveText("/");
  await expect(chat(page).getByTestId("chat-mode-plan")).toBeHidden();
  await expect(menu(page)).toBeVisible();
  // One that cannot be used now: Enter does not send it either, and its line says why.
  await box(page).pressSequentially("压");
  await expect(options(page)).toHaveText([/\/压缩\s*还没有可以压缩的对话/]);
  await page.keyboard.press("Enter");
  await expect(box(page)).toHaveText("/压");
  expect(sent).toHaveLength(0);
  await box(page).press("Backspace");

  // The first letters of the pinyin: Enter does it, and takes the command out of the box.
  await box(page).pressSequentially("fa");
  await expect(options(page)).toHaveText([/\/方案/]);
  await page.keyboard.press("Enter");
  await expect(chat(page).getByTestId("chat-mode-plan")).toBeVisible();
  await expect(box(page)).toHaveText("");
  await expect(menu(page)).toBeHidden();
  expect(sent).toHaveLength(0);

  // 、 is what / types in Chinese input; Tab picks as Enter does; "关掉" now that it is on.
  await typeAsInput(page, "、");
  await expect(options(page).first()).toHaveText(/\/方案\s*关掉先出方案/);
  await page.keyboard.press("Tab");
  await expect(chat(page).getByTestId("chat-mode-plan")).toBeHidden();
  await expect(box(page)).toHaveText("");

  // A word the input method composes waits: the menu follows once it is written.
  await typeAsInput(page, "、");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "hua", selectionStart: 3, selectionEnd: 3 });
  await expect(options(page)).toHaveCount(5);
  // Its keys are its own: Enter picks its word, never a command.
  await box(page).evaluate((element) => {
    for (const key of ["ArrowDown", "Enter", "Tab"]) {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  });
  await expect(options(page).first()).toHaveAttribute("aria-selected", "true");
  await expect(chat(page).getByTestId("chat-mode-plan")).toBeHidden();
  await ime.send("Input.insertText", { text: "画" });
  await expect(options(page)).toHaveText([/\/画面/]);

  // Esc closes it and leaves what was typed; typing on does not open it again.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await box(page).pressSequentially("m");
  await expect(menu(page)).toBeHidden();
  await expect(box(page)).toHaveText("、画m");
  // Nothing a command could be: words, no menu, and Enter sends them.
  await box(page).fill("");
  await box(page).pressSequentially("/你好");
  await expect(menu(page)).toBeHidden();
  await box(page).fill("一、先把片头做好");
  await expect(menu(page)).toBeHidden();
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  expect(said(sent[0] as Sent)).toContain("一、先把片头做好");

  // Saved now: /重命名 changes the name in the title, and the focus comes back to the box.
  await box(page).pressSequentially("/cmm");
  await expect(options(page)).toHaveText([/\/重命名\s*改这个对话的名字/]);
  await page.keyboard.press("Enter");
  const rename = chat(page).getByTestId("chat-title-rename");
  await expect(rename).toBeFocused();
  await rename.fill("片头的事");
  await rename.press("Enter");
  await expect(chat(page).getByTestId("chat-title")).toHaveText("片头的事");
  await expect(box(page)).toBeFocused();

  // Written out in full and sent: /新对话 and what comes after it, which goes on in the new one.
  await box(page).pressSequentially("/新对话 再做个片尾");
  await expect(menu(page)).toBeHidden();
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-title")).not.toHaveText("片头的事");
  await expect(box(page)).toHaveText("再做个片尾");
  await expect(box(page)).toBeFocused();
  expect(sent).toHaveLength(1);
});

test("/压缩 once there is something to sum up", async ({ page }) => {
  test.setTimeout(120_000);
  const sent = await pretend(page);
  await setUp(page);
  for (const [index, words] of ["第一件事", "第二件事", "第三件事"].entries()) {
    await box(page).fill(words);
    await box(page).press("Enter");
    await expect(chat(page).getByTestId("chat-answer")).toHaveCount(index + 1);
  }
  await box(page).click();
  await box(page).pressSequentially("/ys");
  await expect(options(page)).toHaveText([/\/压缩\s*压缩较早的对话/]);
  await page.keyboard.press("Enter");
  // The model sums it up: one more request, and nothing of it goes as a message.
  await expect.poll(() => sent.length).toBe(4);
  await expect(chat(page).getByTestId("chat-summed").first()).toBeVisible();
  await expect(box(page)).toHaveText("");
});

test("@ anywhere after a space: what is selected and the playhead, then clips and markers by name", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sent = await pretend(page);
  await setUp(page, 6);
  await goTo(page, "0:01/00");
  await showTab(page, "chat");
  await box(page).click();
  await box(page).pressSequentially("看看@");
  // Right after a word: an address, not a block.
  await expect(menu(page)).toBeHidden();
  await box(page).fill("");
  await box(page).pressSequentially("看看 @");
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole("group", { name: "现在" })).toHaveText(/播放头 0:01\/00/);
  // The first five clips by time, and how many more; then the marker.
  const clips = menu(page).getByRole("group", { name: "片段" });
  await expect(clips.getByTestId("chat-complete-option")).toHaveCount(6);
  await expect(clips.getByTestId("chat-complete-option").last()).toHaveText("还有 4 个");
  // Of the same name, each says when it is; those of a name of their own say nothing more.
  await expect(clips.getByTestId("chat-complete-option").nth(0)).toHaveText("片段「片头标题」");
  await expect(clips.getByTestId("chat-complete-option").nth(3)).toHaveText(/片段「纯色」\s*0:04/);
  await expect(clips.getByTestId("chat-complete-option").nth(4)).toHaveText(/片段「纯色」\s*0:06/);
  await expect(menu(page).getByRole("group", { name: "标记" })).toHaveText(/标记「高潮」/);
  // "还有 4 个" shows them all.
  await clips.getByTestId("chat-complete-option").last().click();
  await expect(clips.getByTestId("chat-complete-option")).toHaveCount(9);
  await expect(box(page)).toBeFocused();

  // Words an input method composes after @: its Enter picks its word, never a block; once it is
  // written, the menu finds by it.
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "cheng", selectionStart: 5, selectionEnd: 5 });
  await box(page).evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await expect(box(page).getByTestId("chat-chip")).toHaveCount(0);
  await ime.send("Input.insertText", { text: "城" });
  await expect(options(page)).toHaveText(["片段「城市夜景」", "字幕「欢迎来到这座城市」"]);
  await box(page).press("Backspace");

  // By name, any part of it: names that start with it first.
  await box(page).pressSequentially("城市");
  await expect(options(page)).toHaveText(["片段「城市夜景」", "字幕「欢迎来到这座城市」"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const chips = box(page).getByTestId("chat-chip");
  await expect(chips).toHaveText(["字幕「欢迎来到这座城市」"]);
  await expect(box(page)).toHaveText("看看 字幕「欢迎来到这座城市」 ");
  await expect(menu(page)).toBeHidden();
  // Ctrl+Z gives back what was typed, selected; the caret back after it, the menu is there again.
  await page.keyboard.press("Control+z");
  await expect(chips).toHaveCount(0);
  await expect(box(page)).toHaveText("看看 @城市");
  await page.keyboard.press("End");
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(box(page)).toHaveText("看看 @城市");
  // Nothing of that name: it says so, and Enter is sending again.
  await box(page).fill("");
  await box(page).pressSequentially("@没有这个");
  await expect(menu(page)).toHaveText("没有叫“没有这个”的");
  await box(page).fill("");

  // Words pasted in are not typed: no menu for them, and Enter after them sends.
  const paste = (text: string) =>
    box(page).evaluate((element, words) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", words);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, text);
  await paste("看看 @城");
  await expect(box(page)).toHaveText("看看 @城");
  await expect(menu(page)).toBeHidden();
  // Typing on is typing: the menu is there for it.
  await box(page).pressSequentially("市");
  await expect(options(page)).toHaveCount(2);
  await page.keyboard.press("Escape");
  await box(page).fill("");

  // What is selected: the clips as blocks, as "插入选中的" puts them in.
  await showTab(page, "timeline");
  await stage(page).focus();
  await page.keyboard.press("Control+a");
  await showTab(page, "chat");
  await box(page).click();
  // "+" puts "@" where the caret is, which opens the menu.
  await chat(page).getByTestId("chat-plus").click();
  await chat(page).getByTestId("chat-plus-mention").click();
  await expect(options(page).first()).toHaveText("选中的 9 个片段");
  await page.keyboard.press("Enter");
  await expect(chips).toHaveCount(4);
  await expect(chips.last()).toHaveText("还有 6 个");
  await box(page).fill("");

  // A block chosen goes to AI as its link.
  await box(page).pressSequentially("把 @高潮");
  await page.keyboard.press("Enter");
  await box(page).pressSequentially("前面的字放大");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  expect(said(sent[0] as Sent)).toContain(
    "把 [标记「高潮」](aq://object/peak?timeline=main) 前面的字放大",
  );
});

test("@ typed fast: ↓ and Enter before the project is looked through go by what was typed", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await pretend(page);
  await setUp(page);
  await box(page).click();
  // No wait between the keys: what the menu had a moment ago ("@" alone, or "@城") is not what ↓
  // moves in, nor what Enter picks from.
  await box(page).pressSequentially("看看 @城市", { delay: 0 });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(box(page).getByTestId("chat-chip")).toHaveText(["字幕「欢迎来到这座城市」"]);
  // Once found, the option chosen stays chosen as long as it is there.
  await box(page).fill("");
  await box(page).pressSequentially("看看 @城");
  await expect(options(page)).toHaveText(["片段「城市夜景」", "字幕「欢迎来到这座城市」"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(box(page).getByTestId("chat-chip")).toHaveText(["字幕「欢迎来到这座城市」"]);
});

test("the menus of / and @ in light and dark, about 320, 420 and 560 wide", async ({ page }) => {
  test.setTimeout(240_000);
  await pretend(page);
  await setUp(page, 6);
  await box(page).click();
  await sceneBothThemes(page, "1-slash", "7", async () => {
    await box(page).fill("");
    await box(page).click();
    await box(page).pressSequentially("/");
    await expect(menu(page)).toBeVisible();
  });
  await sceneBothThemes(page, "2-at", "7", async () => {
    await box(page).fill("把片头的字放大，和 ");
    await box(page).click();
    await page.keyboard.press("End");
    await box(page).pressSequentially("@");
    await expect(options(page).first()).toBeVisible();
  });
  await sceneBothThemes(page, "3-at-found", "7", async () => {
    await box(page).fill("");
    await box(page).click();
    await box(page).pressSequentially("@城");
    await expect(options(page)).toHaveCount(2);
  });
  await sceneBothThemes(page, "4-plus", "7", async () => {
    await chat(page).getByTestId("chat-plus").click();
    await expect(chat(page).getByTestId("chat-plus-mention")).toBeVisible();
  });
});
