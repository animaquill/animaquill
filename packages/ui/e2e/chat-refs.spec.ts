import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Locator, Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  addModel,
  anthropicSays,
  closeSettings,
  isConnectionTest,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { clips, goTo } from "./property-helpers.ts";
import { canCapture, chooseFolder, openForScenes, openScene } from "./scene-support.ts";
import { content, editorReady, expect, tab, test } from "./support.ts";

/**
 * What people point at in their words to AI (docs/design/settings-and-properties.md of AnimaQuill
 * Cloud, 10): the moment of the playhead, the objects selected and a frame of the playhead, as
 * blocks in the box and links or pictures to the model; AI's links as blocks; a model that takes no
 * pictures; the notice when AI is done in the background; and the small things of the box.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
const stage = (page: Page) =>
  content(page, "timeline").getByRole("group", { name: "时间轴", exact: true });
const timeShown = (page: Page) =>
  page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" });

/** Where the screenshots of the design's checks go. */
const SHOTS = "sc1";

/** A project of colors and a caption, 1920×1080, with ids a test can name. */
function colorProject(count = 3): string {
  const project = createProject({ name: "颜色项目" });
  const files = writeProject(project);
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { id: string; kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  const colors = ["#e5484d", "#3366ff", "#30a46c", "#ffb224", "#8e4ec6", "#12a594"];
  (timeline.tracks[0] as { clips: unknown[] }).clips = Array.from({ length: count }, (_, at) => ({
    id: `clip_${at}`,
    start: String(at * 2),
    duration: "2",
    name: at === 0 ? "城市" : undefined,
    source: { kind: "color", color: colors[at % colors.length] },
  }));
  timeline.tracks.push({
    id: "subs",
    kind: "caption",
    clips: [
      {
        id: "cap_1",
        start: "0",
        duration: "3",
        source: { kind: "caption", text: "欢迎来到这座城市看看" },
      },
    ],
  });
  files.set(path, JSON.stringify(timeline));
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-chat-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

interface Sent {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}

/** The parts of what people said last in a request, as Anthropic gets them. */
function lastUser(sent: Sent): readonly { type: string; text?: string; source?: never }[] {
  const last = sent.messages.findLast((message) => message.role === "user");
  const parts = last?.content;
  return typeof parts === "string" ? [{ type: "text", text: parts }] : (parts as never);
}

const answer = (route: Route, text: string) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body: anthropicSays(text),
  });

/** Answers every request with what `say` gives, and keeps what was sent. */
async function pretend(page: Page, say: (sent: Sent) => string = () => "好的。") {
  const sent: Sent[] = [];
  await page.route(ANTHROPIC, (route) => {
    if (isConnectionTest(route)) return answer(route, "OK");
    const body = route.request().postDataJSON() as Sent;
    sent.push(body);
    return answer(route, say(body));
  });
  return sent;
}

async function setUp(page: Page, count = 3) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  // A project without code opens as it is.
  await chooseFolder(page, colorProject(count));
  await expect(tab(page, "preview")).toBeVisible();
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test");
}

/** Saves a picture of the chat at each width the design asks for: 420 and 300. */
async function shoot(page: Page, name: string, target?: Locator) {
  const panel = chat(page).getByTestId("chat");
  for (const width of [420, 300]) {
    await page.addStyleTag({ content: `[data-testid="chat"] { width: ${width}px !important; }` });
    await expect.poll(async () => (await panel.boundingBox())?.width).toBe(width);
    await (target ?? panel).screenshot({
      path: test.info().outputPath(`${SHOTS}-${name}-${width}.png`),
    });
  }
  await page.addStyleTag({ content: `[data-testid="chat"] { width: auto !important; }` });
}

/** The width and height of a JPEG, from its frame header. */
function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1] as number;
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

test.use({ withProject: false });

test("the time and the objects selected go in as blocks, and AI gets them as links, word for word", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sent = await pretend(page);
  await setUp(page);
  // Nothing selected: the button says where to select.
  const objects = chat(page).getByTestId("chat-tool-selection");
  await expect(objects).toHaveAttribute("aria-disabled", "true");
  // All of the first track and the caption.
  await tab(page, "timeline").click();
  await stage(page).focus();
  await page.keyboard.press("Control+a");
  await goTo(page, "0:01/00");
  await tab(page, "chat").click();
  await expect(objects).not.toHaveAttribute("aria-disabled");
  await expect(objects).toContainText("4");

  await box(page).click();
  await box(page).pressSequentially("把 ");
  await page.keyboard.press("Alt+t");
  const chips = box(page).getByTestId("chat-chip");
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toHaveText("0:01/00");
  // A backspace takes the space after it, the next one the whole block.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(chips).toHaveCount(0);
  await expect(box(page)).toHaveText("把 ");
  await page.keyboard.press("Alt+t");
  await box(page).pressSequentially("之后的");
  await page.keyboard.press("Alt+o");
  await box(page).pressSequentially("放慢一点");
  await expect(chips).toHaveCount(5);
  await expect(chips.nth(1)).toHaveText("字幕「欢迎来到这座城市看看」");
  await expect(chips.nth(2)).toHaveText("片段「城市」");
  await expect(chips.nth(3)).toHaveText("片段「纯色」");
  await shoot(page, "C1-input", chat(page).getByTestId("chat"));

  // A block lights up what it points at, in the preview, and goes there.
  const overlay = content(page, "preview").locator("[data-outlined]");
  await tab(page, "timeline").click();
  await stage(page).focus();
  await page.keyboard.press("Escape");
  await tab(page, "chat").click();
  await chips.nth(2).hover();
  await expect(overlay).toHaveAttribute("data-outlined", /clip_0/);
  await box(page).hover({ position: { x: 2, y: 2 } });
  await expect(overlay).toHaveAttribute("data-outlined", "");

  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  const words = lastUser(sent[0] as Sent)
    .map((part) => part.text ?? "")
    .join("");
  expect(words).toBe(
    "把 [0:01/00](aq://time?timeline=main&t=1) 之后的 [字幕「欢迎来到这座城市看看」](aq://object/cap_1?timeline=main) [片段「城市」](aq://object/clip_0?timeline=main) [片段「纯色」](aq://object/clip_1?timeline=main) [片段「纯色」](aq://object/clip_2?timeline=main) 放慢一点",
  );
  // In the conversation the words keep their blocks; "附带" opens to what AI got.
  const user = chat(page).getByTestId("chat-user");
  await expect(user.getByTestId("chat-chip")).toHaveCount(5);
  await chat(page).getByTestId("chat-sent-with").getByRole("button").first().click();
  await expect(chat(page).getByTestId("chat-sent-text")).toHaveText(words);
  await shoot(page, "C3-sent", chat(page).getByTestId("chat"));
  // A click goes to the clip, and to the moment.
  await user.getByTestId("chat-chip").nth(3).click();
  await expect(clips(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await user.getByTestId("chat-chip").first().click();
  await expect(timeShown(page)).toContainText("0:01/00");
});

test("more than eight objects are the first three and one block for the rest", async ({ page }) => {
  test.setTimeout(90_000);
  const sent = await pretend(page);
  await setUp(page, 10);
  await tab(page, "timeline").click();
  await stage(page).focus();
  await page.keyboard.press("Control+a");
  await tab(page, "chat").click();
  await chat(page).getByTestId("chat-tool-selection").click();
  const chips = box(page).getByTestId("chat-chip");
  await expect(chips).toHaveCount(4);
  await expect(chips.last()).toHaveText("还有 8 个");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  expect(lastUser(sent[0] as Sent)[0]?.text).toContain(
    "[还有 8 个](aq://objects?timeline=main&ids=clip_2,clip_3,clip_4,clip_5,clip_6,clip_7,clip_8,clip_9)",
  );
  // The last block goes to all it stands for.
  await chat(page).getByTestId("chat-user").getByTestId("chat-chip").last().click();
  await expect(clips(page).nth(10)).toHaveAttribute("aria-selected", "true");
});

test("a frame of the playhead goes as a JPEG 1568 wide, with the line that says what it is", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sent = await pretend(page);
  await setUp(page);
  await goTo(page, "0:01/00");
  await tab(page, "chat").click();
  await box(page).click();
  const started = Date.now();
  await page.keyboard.press("Alt+s");
  const picture = chat(page).getByTestId("chat-picture");
  await expect(picture).toHaveAttribute("data-state", "ready");
  console.log(`a 1080p frame for the chat took ${Date.now() - started} ms`);
  await expect(chat(page).getByTestId("chat-picture-info")).toHaveText(
    /^画面 0:01\/00 · 1568×882 · \d+ KB$/,
  );
  // Nobody said whether claude-test takes pictures: it goes, and the chat says so.
  await expect(chat(page).getByTestId("chat-pictures-unsure")).toBeVisible();
  await box(page).pressSequentially("标题是不是太靠下了");
  await shoot(page, "C1-frame", chat(page).getByTestId("chat"));
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  const parts = lastUser(sent[0] as Sent) as readonly {
    type: string;
    text?: string;
    source?: { type: string; media_type: string; data: string };
  }[];
  expect(parts[0]?.text).toBe(
    '标题是不是太靠下了\n\n[image 1: the frame of timeline "主线" (main) at t=1 (0:01/00), as the export renders it, 1568×882]',
  );
  const image = parts.find((part) => part.type === "image");
  expect(image?.source?.media_type).toBe("image/jpeg");
  expect(jpegSize(Buffer.from(image?.source?.data ?? "", "base64"))).toEqual({
    width: 1568,
    height: 882,
  });
  // The picture stays with the message, and opens large.
  await chat(page).getByTestId("chat-sent-picture").click();
  await expect(page.getByTestId("chat-picture-large")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-picture-large")).toBeHidden();

  // The same from the toolbar of the preview, and pictures pasted or chosen.
  await content(page, "preview").getByRole("button", { name: "发送当前画面到聊天" }).click();
  await expect(picture).toHaveCount(1);
  await expect(picture).toHaveAttribute("data-state", "ready");
  await content(page, "preview")
    .locator('[role="toolbar"]')
    .screenshot({ path: test.info().outputPath(`${SHOTS}-preview-button.png`) });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==",
    "base64",
  );
  await box(page).evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "红.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, png.toString("base64"));
  await expect(picture).toHaveCount(2);
  const chooser = page.waitForEvent("filechooser");
  await chat(page).getByTestId("chat-tool-picture").click();
  await (await chooser).setFiles({ name: "选的.png", mimeType: "image/png", buffer: png });
  await expect(picture).toHaveCount(3);
  await box(page).evaluate((element, data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "拖的.png", { type: "image/png" }));
    element.dispatchEvent(
      new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  }, png.toString("base64"));
  await expect(picture).toHaveCount(4);
  await expect(chat(page).getByTestId("chat-picture-info").nth(1)).toHaveText(/^红\.png · 16×16/);
  // They stay with the draft through a reload.
  await page.reload();
  await tab(page, "chat").click();
  await expect(picture).toHaveCount(4);
  await chat(page).getByTestId("chat-picture-remove").first().click();
  await expect(picture).toHaveCount(3);
});

test("a model that takes no pictures: held, with another model or without them as ways on", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const sent = await pretend(page);
  await setUp(page);
  // claude-test does not take pictures, as people said; claude-eyes does.
  await openSettingsPage(page, "AI 模型");
  const service = settingsOf(page).getByTestId("ai-service");
  await addModel(page, "claude-eyes");
  const say = async (model: string, sees: boolean) => {
    await service
      .locator(`[data-testid="ai-model"][data-model="${model}"]`)
      .getByTestId("ai-model-open")
      .click();
    const image = settingsOf(page)
      .getByTestId("ai-model-detail")
      .getByRole("checkbox", { name: /能看图/ });
    await image.check();
    if (!sees) await image.uncheck();
    await settingsOf(page)
      .getByTestId("ai-model-detail")
      .getByRole("button", { name: "Anthropic" })
      .click();
    await expect(service).toBeVisible();
  };
  await say("claude-test", false);
  await say("claude-eyes", true);
  await closeSettings(page);
  await tab(page, "chat").click();
  await goTo(page, "0:01/00");
  await tab(page, "chat").click();
  await box(page).click();
  await page.keyboard.press("Alt+s");
  await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-state", "ready");
  await box(page).pressSequentially("按截图看，标题是不是太靠下了");
  const blocked = chat(page).getByTestId("chat-pictures-blocked");
  await expect(blocked).toHaveText(
    "这个模型看不了图，图片不会发出去。 换个能看图的模型 · 去掉图片发送",
  );
  await expect(chat(page).getByTestId("chat-picture-info")).toHaveText("claude-test 看不了图");
  await expect(chat(page).getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  await box(page).press("Enter");
  expect(sent).toHaveLength(0);
  await shoot(page, "C2-blocked", chat(page).getByTestId("chat"));

  // Another model: only those that take pictures light up.
  await blocked.getByRole("button", { name: "换个能看图的模型" }).click();
  const bubble = chat(page).getByTestId("chat-model-bubble");
  await expect(bubble.getByTestId("chat-picker-pictures")).toBeVisible();
  await expect(bubble.locator('[data-model="claude-test"]')).toHaveAttribute("data-dim", "");
  await expect(bubble.locator('[data-model="claude-eyes"]')).not.toHaveAttribute("data-dim", "");
  await bubble.locator('[data-model="claude-eyes"]').getByRole("option").click();
  await expect(blocked).toBeHidden();
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  expect(sent[0]?.model).toBe("claude-eyes");
  expect(lastUser(sent[0] as Sent).some((part) => part.type === "image")).toBe(true);

  // Back to the one that takes none: the turn says its pictures do not go, and they do not.
  await chat(page).getByTestId("chat-model").click();
  await bubble.locator('[data-model="claude-test"]').getByRole("option").click();
  await expect(chat(page).getByTestId("chat-pictures-not-sent")).toHaveText(
    "这些图片没有发给 claude-test（它看不了图）",
  );
  await box(page).fill("那现在呢");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveCount(2);
  expect(sent[1]?.model).toBe("claude-test");
  expect(JSON.stringify(sent[1]?.messages)).not.toContain('"type":"image"');
  expect(JSON.stringify(sent[1]?.messages)).toContain("[image 1: the frame of timeline");

  // Without them: what was written goes alone.
  await page.keyboard.press("Alt+s");
  await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-state", "ready");
  await box(page).pressSequentially("不带图");
  await blocked.getByRole("button", { name: "去掉图片发送" }).click();
  await expect(chat(page).getByTestId("chat-answer")).toHaveCount(3);
  expect(
    lastUser(sent[2] as Sent)
      .map((part) => part.text ?? "")
      .join(""),
  ).toBe("不带图");
  await expect(chat(page).getByTestId("chat-picture")).toHaveCount(0);
});

test("links of the editor in an answer are blocks that go where they point, grey once gone", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await pretend(
    page,
    () =>
      "[片段「纯色」](aq://object/clip_2?timeline=main) 在 [0:04/00](aq://time?timeline=main&t=4) 开始，见 [片段「城市」](aq://object/clip_0?timeline=main)。",
  );
  await setUp(page);
  await box(page).fill("哪个片段在 4 秒开始");
  await box(page).press("Enter");
  const links = chat(page).getByTestId("chat-answer").getByTestId("chat-chip");
  await expect(links).toHaveCount(3);
  await links.first().click();
  await expect(clips(page).nth(3)).toHaveAttribute("aria-selected", "true");
  await links.nth(1).click();
  await expect(timeShown(page)).toContainText("0:04/00");
  // The clip goes: its block is grey and goes nowhere.
  await links.nth(2).click();
  await expect(clips(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await stage(page).focus();
  await page.keyboard.press("Delete");
  await tab(page, "chat").click();
  await expect(links.nth(2)).toHaveAttribute("data-gone", "");
  await expect(links.nth(2)).toContainText("已删除");
  await shoot(page, "answer-links", chat(page).getByTestId("chat"));
});

test("AI done while the page is in the background: a notice, and ● on the tab until people come back", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await pretend(page);
  await setUp(page);
  await page.evaluate(() => {
    const seen: { title: string; body?: string }[] = [];
    (window as unknown as { notices: typeof seen }).notices = seen;
    class Notice {
      static permission = "granted";
      static requestPermission = async () => "granted";
      constructor(title: string, options?: { body?: string }) {
        seen.push({ title, ...(options?.body && { body: options.body }) });
      }
      addEventListener() {}
      close() {}
    }
    (window as unknown as { Notification: unknown }).Notification = Notice;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  });
  await box(page).fill("做完告诉我");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { notices: unknown }).notices))
    .toEqual([{ title: "AI 做完了", body: "颜色项目" }]);
  await expect.poll(() => page.title()).toBe("● 颜色项目 - AnimaQuill");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.title()).toBe("颜色项目 - AnimaQuill");
});

test("↑ brings back what was said, a search lights up what it found, and a conversation downloads", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await pretend(page, (sent) => `收到：${sent.messages.length}`);
  await setUp(page);
  for (const text of ["第一句话", "第二句话"]) {
    await box(page).fill(text);
    await box(page).press("Enter");
    await expect(chat(page).getByTestId("chat-answer").last()).toContainText("收到");
  }
  await box(page).press("ArrowUp");
  await expect(box(page)).toHaveText("第二句话");
  await box(page).press("ArrowUp");
  await expect(box(page)).toHaveText("第一句话");
  await box(page).press("ArrowDown");
  await expect(box(page)).toHaveText("第二句话");
  await box(page).press("ArrowDown");
  await expect(box(page)).toHaveText("");

  await chat(page).getByTestId("chat-title").click();
  await chat(page).getByRole("textbox", { name: "搜这个项目的对话" }).fill("第一句");
  await chat(page).getByTestId("chat-search-hit").first().click();
  await expect(chat(page).locator("[data-found-turn]")).toHaveCount(1);
  await expect(chat(page).locator("[data-found-turn] [data-testid='chat-user']")).toHaveText(
    "第一句话",
  );

  await chat(page).getByTestId("chat-more").click();
  const download = page.waitForEvent("download");
  await chat(page).getByRole("menuitem", { name: "下载成 Markdown" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.md$/);
  const text = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(text).toString("utf8")).toContain("**你**:\n\n第一句话");
});

test("narrower than 320, the buttons of the box are one menu", async ({ page }) => {
  test.setTimeout(60_000);
  await pretend(page);
  await setUp(page);
  await page.addStyleTag({ content: `[data-testid="chat"] { width: 300px !important; }` });
  await expect(chat(page).getByTestId("chat-tools")).toBeHidden();
  await chat(page).getByTestId("chat-tools-more").click();
  const menu = chat(page).getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    /插入播放头的时间\s*Alt\+T/,
    /插入选中的对象\s*Alt\+O/,
    /截取播放头的画面\s*Alt\+S/,
    /添加图片/,
  ]);
  await chat(page).screenshot({ path: test.info().outputPath(`${SHOTS}-C1-menu-300.png`) });
  await menu.getByRole("menuitem", { name: /插入播放头的时间/ }).click();
  await expect(box(page).getByTestId("chat-chip")).toHaveText(["0:00/00"]);
});

test("a 1080p frame of a scene for the chat takes at most two seconds", async ({ page }) => {
  // A scene is in a frame only a browser that can capture draws, as for the export of a frame.
  test.skip(!canCapture, "needs a browser that can capture");
  test.setTimeout(90_000);
  await pretend(page);
  await openForScenes(page);
  await editorReady(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openScene(
    page,
    `<!doctype html><style>body{background:#123}h1{color:#fff;font:120px sans-serif;margin:300px}</style><h1>标题</h1>`,
  );
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await goTo(page, "0:01/00");
  await tab(page, "chat").click();
  await box(page).click();
  const started = Date.now();
  await page.keyboard.press("Alt+s");
  const picture = chat(page).getByTestId("chat-picture");
  await expect(picture).not.toHaveAttribute("data-state", "working", { timeout: 20_000 });
  const took = Date.now() - started;
  console.log(`a 1080p scene frame for the chat took ${took} ms`);
  await expect(picture).toHaveAttribute("data-state", "ready");
  expect(took).toBeLessThanOrEqual(2000);
});
