import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Locator, Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  addModel,
  anthropicSays,
  closeSettings,
  isConnectionTest,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { clips, goTo } from "./property-helpers.ts";
import { canCapture, chooseFolder, openForScenes, openScene } from "./scene-support.ts";
import { content, editorReady, expect, tab, test, showTab } from "./support.ts";

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
  readonly system?: unknown;
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
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-test");
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

/** Makes the chat wider by the edge between it and what is left of it, as people drag it. */
async function widen(page: Page, width: number) {
  const edge = await chat(page).getByTestId("chat").boundingBox();
  if (!edge) return;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(edge.x - 1, y);
  await page.mouse.down();
  await page.mouse.move(edge.x - 1 - (width - edge.width), y, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await chat(page).getByTestId("chat").boundingBox())?.width ?? 0)
    .toBeGreaterThan(400);
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
  // Nothing selected: the item of "+" cannot be chosen, and says where to select.
  const objects = chat(page).getByTestId("chat-plus-selection");
  await chat(page).getByTestId("chat-plus").click();
  await expect(objects).toBeDisabled();
  await expect(objects).toHaveAttribute("title", "先在时间轴、预览或资源里选中");
  await expect(chat(page).getByTestId("chat-plus-time")).toHaveText(/^插入播放头时间 0:00\/00/);
  await page.keyboard.press("Escape");
  // Nothing selected: the playhead alone goes with the message.
  await expect(chat(page).getByTestId("chat-carry")).toHaveAccessibleName("带上：播放头 0:00/00");
  await expect(chat(page).getByTestId("chat-carry-clips")).toHaveCount(0);
  // All of the first track and the caption.
  await showTab(page, "timeline");
  await stage(page).focus();
  await page.keyboard.press("Control+a");
  await goTo(page, "0:01/00");
  await showTab(page, "chat");
  // "带上" says what the next message keeps of the editor; in full where the chat is not narrow.
  await widen(page, 440);
  await expect(chat(page).getByTestId("chat-carry-clips")).toHaveText("选中的 4 个片段", {
    useInnerText: true,
  });
  await expect(chat(page).getByTestId("chat-carry-playhead")).toHaveText("播放头 0:01/00", {
    useInnerText: true,
  });
  await chat(page).getByTestId("chat-plus").click();
  await expect(objects).toBeEnabled();
  await expect(objects).toHaveText(/^插入选中的 4 个/);
  await page.keyboard.press("Escape");

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
  await showTab(page, "timeline");
  await stage(page).focus();
  await page.keyboard.press("Escape");
  await showTab(page, "chat");
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
  // In the conversation the words keep their blocks; "⋯" shows what AI got.
  const user = chat(page).getByTestId("chat-user");
  await expect(user.getByTestId("chat-chip")).toHaveCount(5);
  await user.hover();
  await chat(page).getByTestId("chat-user-more").click();
  await chat(page).getByRole("menuitem", { name: "看 AI 收到的原文" }).click();
  await expect(chat(page).getByTestId("chat-user-sent").locator("pre")).toHaveText(words);
  await shoot(page, "C3-sent", chat(page).getByTestId("chat"));
  // A click goes to the clip, and to the moment.
  await user.getByTestId("chat-chip").nth(3).click();
  await expect(clips(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await user.getByTestId("chat-chip").first().click();
  await expect(timeShown(page)).toContainText("0:01/00");
});

/** What the tools said to the last answer, as Anthropic gets it. */
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

/** A clip by what the list of clips calls it. */
const clipNamed = (page: Page, name: RegExp) =>
  content(page, "timeline")
    .getByRole("listbox", { name: "时间轴片段", exact: true })
    .getByRole("option", { name });

/** Selects a clip, the way people do: a click on it, where the list of clips says it is. */
async function clickClip(page: Page, name: RegExp) {
  await showTab(page, "timeline");
  const place = await clipNamed(page, name).boundingBox();
  if (!place) throw new Error(`no clip ${String(name)}`);
  await page.mouse.click(place.x + 12, place.y + 10);
}

test("AI reads what was selected as a message was sent, though people selected another since, and what is selected now", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const sent: Sent[] = [];
  let selectedAgain: () => void = () => {};
  const again = new Promise<void>((resolve) => (selectedAgain = resolve));
  await page.route(ANTHROPIC, async (route) => {
    if (isConnectionTest(route)) return answer(route, "OK");
    const body = route.request().postDataJSON() as Sent;
    sent.push(body);
    if (sent.length > 1) return answer(route, "看到了。");
    // The first answer waits until people selected something else.
    await again;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: anthropicCalls([
        { name: "aq_selection_read", input: { at: "sent" } },
        { name: "aq_selection_read", input: { at: "now" } },
      ]),
    });
  });
  await setUp(page);
  await clickClip(page, /^城市，/);
  await expect(clipNamed(page, /^城市，/)).toHaveAttribute("aria-selected", "true");
  await showTab(page, "chat");
  await box(page).fill("把这个放慢一点");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-user")).toContainText("把这个放慢一点");
  // Another one while AI works.
  await clickClip(page, /^纯色，.*0:02\/00 到/);
  await expect(clipNamed(page, /^纯色，.*0:02\/00 到/)).toHaveAttribute("aria-selected", "true");
  selectedAgain();
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("看到了。");

  // The words went as they were, without what was selected.
  expect(JSON.stringify(lastUser(sent[0] as Sent))).not.toContain("clip_0");
  const [then, now] = toolResults(sent[1] as Sent);
  expect(then).toContain('at "sent", messages_back 0: as the user sent "把这个放慢一点"');
  expect(then).toContain("selected clips (1): clip_0");
  expect(then).not.toContain("clip_1");
  expect(now).toContain('at "now"');
  expect(now).toContain("selected clips (1): clip_1");
  expect(now).not.toContain("clip_0");

  // Each call says which it read.
  const process = chat(page).getByTestId("chat-work").last();
  await process.getByRole("button").first().click();
  const summaries = chat(page).getByTestId("chat-tool-summary");
  await expect(summaries).toHaveText(["「把这个放慢一点」发出时的", "现在的"]);
  await shoot(page, "SEL-calls", chat(page).getByTestId("chat"));
});

test('"带上" is a tag over the words; taken off, messages keep nothing, AI is told so, and it stays off', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sent: Sent[] = [];
  await page.route(ANTHROPIC, async (route) => {
    if (isConnectionTest(route)) return answer(route, "OK");
    const body = route.request().postDataJSON() as Sent;
    sent.push(body);
    if (sent.length % 2 === 0) return answer(route, "看到了。");
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: anthropicCalls([{ name: "aq_selection_read", input: { at: "sent" } }]),
    });
  });
  await setUp(page);
  await clickClip(page, /^城市，/);
  await goTo(page, "0:01/00");
  await showTab(page, "chat");
  await widen(page, 440);
  const carry = chat(page).getByTestId("chat-carry");
  const clipsTag = chat(page).getByTestId("chat-carry-clips");
  const playheadTag = chat(page).getByTestId("chat-carry-playhead");
  // On by default: in the card, over the words, an icon and a short name for each.
  await expect(carry).toHaveAccessibleName("带上：选中的 1 个片段、播放头 0:01/00");
  await expect(carry).toHaveAttribute("title", "带上：选中的 1 个片段、播放头 0:01/00");
  await expect(clipsTag).toHaveText("选中的 1 个片段", { useInnerText: true });
  await expect(playheadTag).toHaveText("播放头 0:01/00", { useInnerText: true });
  await expect(clipsTag.locator("svg")).toHaveCount(1);
  const card = await chat(page).getByTestId("chat-compose").boundingBox();
  const tag = await carry.boundingBox();
  const words = await box(page).boundingBox();
  expect(tag && card && tag.y > card.y && tag.y + tag.height <= (words?.y ?? 0)).toBe(true);
  // Pointed at, the clips light up in the preview.
  const overlay = content(page, "preview").locator("[data-outlined]");
  await clipsTag.hover();
  await expect(overlay).toHaveAttribute("data-outlined", /clip_0/);
  // × takes it off: the tag stays, slanted and struck through, and a click on it puts it back.
  // Lit as a whole under the pointer, with a line between its two parts: the × is for all of it.
  const off = chat(page).getByRole("button", { name: "不带选中和播放头", exact: true });
  await expect(off).toHaveAttribute("title", "不带选中和播放头");
  await expect(playheadTag).not.toHaveCSS("border-left-width", "0px");
  await page.mouse.move(0, 0);
  await expect(carry).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const quiet = await carry.evaluate((element) => getComputedStyle(element).backgroundColor);
  await off.hover();
  await expect(carry).not.toHaveCSS("background-color", quiet);
  await off.click();
  await expect(carry).toHaveAttribute("data-off", "");
  await expect(carry).toHaveAccessibleName("不带：选中的 1 个片段、播放头 0:01/00");
  const name = clipsTag.locator("span:visible").first();
  await expect(name).toHaveCSS("font-style", "italic");
  await expect(name).toHaveCSS("text-decoration-line", "line-through");
  await chat(page).screenshot({ path: test.info().outputPath("carry-off-440.png") });
  await chat(page)
    .getByRole("button", { name: "带上：选中的 1 个片段、播放头 0:01/00", exact: true })
    .click();
  await expect(carry).not.toHaveAttribute("data-off");
  await expect(name).toHaveCSS("font-style", "normal");
  await chat(page).screenshot({ path: test.info().outputPath("carry-on-440.png") });
  await chat(page).getByTestId("chat-carry-off").click();
  // The words keep the keyboard.
  await box(page).fill("这个先别看");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("看到了。");
  expect(toolResults(sent[1] as Sent)[0]).toContain("the user did not share the selection");
  expect(toolResults(sent[1] as Sent)[0]).not.toContain("clip_0");
  // It stays off for the next message, in a new conversation, and after a reload.
  await expect(carry).toHaveAttribute("data-off", "");
  await chat(page).getByTestId("chat-new").click();
  await expect(carry).toHaveAttribute("data-off", "");
  await page.reload();
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-carry")).toHaveAttribute("data-off", "");
  await clickClip(page, /^城市，/);
  await goTo(page, "0:01/00");
  await showTab(page, "chat");
  await chat(page).getByTestId("chat-carry-on").click();
  await expect(carry).not.toHaveAttribute("data-off");
  await box(page).fill("现在看");
  await box(page).press("Enter");
  await expect.poll(() => sent.length).toBe(4);
  expect(toolResults(sent[3] as Sent)[0]).toContain("selected clips (1): clip_0");
  // Narrow, it says less, on one line in the card.
  await page.addStyleTag({ content: `[data-testid="chat"] { width: 320px !important; }` });
  await expect(clipsTag).toHaveText("1 个片段", { useInnerText: true });
  await expect(playheadTag).toHaveText("0:01/00", { useInnerText: true });
  const narrow = await carry.boundingBox();
  const narrowCard = await chat(page).getByTestId("chat-compose").boundingBox();
  expect(narrow?.height).toBeLessThan(24);
  expect((narrow?.x ?? 0) + (narrow?.width ?? 0)).toBeLessThanOrEqual(
    (narrowCard?.x ?? 0) + (narrowCard?.width ?? 0),
  );
  await page.mouse.move(0, 0);
  await chat(page)
    .getByTestId("chat-compose")
    .screenshot({
      path: test.info().outputPath("carry-on-320.png"),
    });
  await chat(page).getByTestId("chat-carry-off").click();
  await page.mouse.move(0, 0);
  await chat(page)
    .getByTestId("chat-compose")
    .screenshot({
      path: test.info().outputPath("carry-off-320.png"),
    });
});

test("more than eight objects are the first three and one block for the rest", async ({ page }) => {
  test.setTimeout(90_000);
  const sent = await pretend(page);
  await setUp(page, 10);
  await showTab(page, "timeline");
  await stage(page).focus();
  await page.keyboard.press("Control+a");
  await showTab(page, "chat");
  await chat(page).getByTestId("chat-plus").click();
  await chat(page).getByTestId("chat-plus-selection").click();
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
  await showTab(page, "chat");
  await box(page).click();
  const started = Date.now();
  await page.keyboard.press("Alt+s");
  const picture = chat(page).getByTestId("chat-picture");
  await expect(picture).toHaveAttribute("data-state", "ready");
  console.log(`a 1080p frame for the chat took ${Date.now() - started} ms`);
  await expect(chat(page).getByTestId("chat-picture-info")).toHaveText(
    /^画面 0:01\/00 · 1568×882 · \d+ KB$/,
  );
  // Nobody said whether claude-test takes pictures: it goes, and the chat says so, faintly.
  await expect(chat(page).getByTestId("chat-pictures-warn")).toHaveAttribute("data-why", "unsure");
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
  await chat(page).getByTestId("chat-plus").click();
  await chat(page).getByTestId("chat-plus-picture").click();
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
  await showTab(page, "chat");
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
    await settingsOf(page).getByTestId("ai-service-item").click();
    await expect(service).toBeVisible();
  };
  await say("claude-test", false);
  await say("claude-eyes", true);
  await closeSettings(page);
  await showTab(page, "chat");
  await goTo(page, "0:01/00");
  await showTab(page, "chat");
  await box(page).click();
  await page.keyboard.press("Alt+s");
  await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-state", "ready");
  await box(page).pressSequentially("按截图看，标题是不是太靠下了");
  const blocked = chat(page).getByTestId("chat-pictures-warn");
  await expect(blocked).toHaveAttribute("data-why", "blind");
  await expect(blocked).toHaveAttribute("title", "claude-test 看不了图");
  await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-blind", "");
  await expect(chat(page).getByTestId("chat-picture-info")).toHaveText("claude-test 看不了图");
  // Neither Enter nor the button sends: the triangle shakes, to say why.
  await box(page).press("Enter");
  await chat(page).getByTestId("chat-send").click();
  await expect(blocked).toHaveAttribute("data-shake", "");
  expect(sent).toHaveLength(0);
  await shoot(page, "C2-blocked", chat(page).getByTestId("chat"));

  // Another model: only those that take pictures light up.
  await blocked.click();
  await chat(page).getByTestId("chat-pictures-vision").click();
  const bubble = chat(page).getByTestId("chat-model-bubble");
  await expect(bubble.getByTestId("chat-picker-pictures")).toBeVisible();
  await expect(bubble.locator('[data-model="claude-test"]')).toHaveAttribute("data-dim", "");
  await expect(bubble.locator('[data-model="claude-eyes"]')).not.toHaveAttribute("data-dim", "");
  await bubble.locator('[data-model="claude-eyes"]').getByRole("option").click();
  await expect(blocked).toBeHidden();
  // Chosen, the bubble closes, the caret back in the box.
  await expect(bubble).toBeHidden();
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  expect(sent[0]?.model).toBe("claude-eyes");
  expect(lastUser(sent[0] as Sent).some((part) => part.type === "image")).toBe(true);

  // Back to the one that takes none: the turn says its pictures do not go, and they do not.
  await chat(page).getByTestId("chat-model").click();
  await bubble.locator('[data-model="claude-test"]').getByRole("option").click();
  await expect(bubble).toBeHidden();
  await expect(chat(page).getByTestId("chat-pictures-not-sent")).toHaveText(
    "这些图片没有发给 claude-test（它看不了图）",
  );
  await box(page).fill("那现在呢");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveCount(2);
  expect(sent[1]?.model).toBe("claude-test");
  expect(JSON.stringify(sent[1]?.messages)).not.toContain('"type":"image"');
  expect(JSON.stringify(sent[1]?.messages)).toContain(
    "1568×882 — not attached: this model cannot receive pictures]",
  );
  // The system prompt says as much, instead of that the user can attach pictures.
  const system = JSON.stringify(sent[1]?.system);
  expect(system).toContain("This model cannot see pictures");
  expect(system).not.toContain("The user can attach pictures");
  expect(JSON.stringify(sent[0]?.system)).toContain("The user can attach pictures");

  // Without them: what was written goes alone.
  await page.keyboard.press("Alt+s");
  await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-state", "ready");
  await box(page).pressSequentially("不带图");
  await blocked.click();
  await chat(page).getByTestId("chat-pictures-remove-all").click();
  await expect(blocked).toBeHidden();
  await box(page).press("Enter");
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
  await showTab(page, "chat");
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
  await chat(page).getByTestId("chat-switcher-search").fill("第一句");
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

test("blocks: Ctrl+Z takes one back, copied ones paste as blocks, a moment shows on the timeline", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await pretend(page);
  await setUp(page);
  await goTo(page, "0:01/00");
  await showTab(page, "chat");
  await box(page).click();
  await box(page).pressSequentially("看");
  await page.keyboard.press("Alt+t");
  const chips = box(page).getByTestId("chat-chip");
  await expect(chips).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(chips).toHaveCount(0);
  await expect(box(page)).toHaveText("看");
  await page.keyboard.press("Alt+t");
  await expect(chips).toHaveCount(1);
  // Copied out of the box and pasted back in: a block again, and plain words for elsewhere.
  const copied = await box(page).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const transfer = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    selection?.collapseToEnd();
    const paste = new DataTransfer();
    for (const type of transfer.types) paste.setData(type, transfer.getData(type));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }),
    );
    return transfer.getData("text/plain");
  });
  expect(copied).toBe("看 0:01/00 ");
  await expect(chips).toHaveCount(2);
  // A block of a moment marks it on the timeline while the pointer is on it.
  const stageGroup = stage(page);
  await chips.first().hover();
  await expect(stageGroup).toHaveAttribute("data-pointed-at", "1");
  await box(page).hover({ position: { x: 2, y: 2 } });
  await expect(stageGroup).not.toHaveAttribute("data-pointed-at");
});

test("pictures dropped anywhere on the chat; a lost one holds the message; formats it cannot read", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const sent = await pretend(page);
  await setUp(page);
  await showTab(page, "chat");
  // A 2×1 PNG whose second pixel is transparent: it goes as PNG, keeping that.
  const clear = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4nGP4z8AARAwMAAz8Af9c/RSVAAAAAElFTkSuQmCC",
    "base64",
  );
  const dropOn = (target: Locator, name: string, type: string, data: Buffer) =>
    target.evaluate(
      (element, file) => {
        const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], file.name, { type: file.type }));
        for (const kind of ["dragenter", "dragover", "drop"]) {
          element.dispatchEvent(
            new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true }),
          );
        }
      },
      { name, type, data: data.toString("base64") },
    );
  const picture = chat(page).getByTestId("chat-picture");
  await dropOn(chat(page).getByTestId("chat-title"), "透明.png", "image/png", clear);
  await expect(picture).toHaveAttribute("data-state", "ready");
  await dropOn(chat(page).getByTestId("chat-title"), "照片.heic", "image/heic", Buffer.from("not"));
  await expect(page.getByText("这种图片格式读不了，可以先转成 PNG 或 JPEG。")).toBeVisible();
  await expect(picture).toHaveCount(1);
  await box(page).fill("透明的");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  const image = lastUser(sent[0] as Sent).find((part) => part.type === "image") as
    { source?: { media_type: string } } | undefined;
  expect(image?.source?.media_type).toBe("image/png");

  // The pictures of the browser are cleared while the window keeps the draft: nothing goes.
  await dropOn(chat(page).getByTestId("chat-title"), "透明.png", "image/png", clear);
  await expect(picture).toHaveAttribute("data-state", "ready");
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("aq-offline-animaquill-chat-images");
        open.addEventListener("error", () => reject(open.error));
        open.addEventListener("success", () => {
          const transaction = open.result.transaction("images", "readwrite");
          transaction.objectStore("images").clear();
          transaction.addEventListener("complete", () => resolve());
        });
      }),
  );
  await box(page).fill("这张呢");
  await box(page).press("Enter");
  await expect(picture).toHaveAttribute("data-state", "failed");
  await expect(chat(page).getByTestId("chat-picture-info")).toHaveText("图片不在这台设备上");
  await expect(chat(page).getByTestId("chat-pictures-warn")).toHaveAttribute("data-why", "failed");
  expect(sent).toHaveLength(1);
});

test('"+" is one menu at every width, from the mouse and from the keyboard', async ({ page }) => {
  test.setTimeout(60_000);
  await pretend(page);
  await setUp(page);
  await page.addStyleTag({ content: `[data-testid="chat"] { width: 300px !important; }` });
  const plus = chat(page).getByTestId("chat-plus");
  await plus.click();
  const menu = chat(page).getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    /截取当前画面\s*Alt\+S/,
    /添加图片…/,
    /插入播放头时间 0:00\/00\s*Alt\+T/,
    /插入选中的对象\s*Alt\+O/,
    /引用片段、素材、场景…\s*@/,
  ]);
  await chat(page).screenshot({ path: test.info().outputPath(`${SHOTS}-C1-menu-300.png`) });
  await menu.getByRole("menuitem", { name: /插入播放头时间/ }).click();
  await expect(box(page).getByTestId("chat-chip")).toHaveText(["0:00/00"]);

  // From the keyboard, as the other menus: Enter opens it on the first item, ↑ ↓ go round what
  // can be chosen (nothing is selected, so that one is left out), Esc goes back to the button.
  await plus.focus();
  await page.keyboard.press("Enter");
  const items = menu.getByRole("menuitem");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(4)).toBeFocused();
  // Last comes "先出方案", an item to tick, with its command.
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitemcheckbox")).toHaveText(/先出方案\s*\/方案/);
  await expect(menu.getByRole("menuitemcheckbox", { name: "先出方案" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(plus).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(box(page).getByTestId("chat-chip")).toHaveCount(2);

  // Alt+A from the box opens it, and Esc goes back to the box.
  await box(page).focus();
  await page.keyboard.press("Alt+a");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(box(page)).toBeFocused();

  // "先出方案" ticked: a pill on the row, whose × switches it off.
  await plus.click();
  await menu.getByRole("menuitemcheckbox", { name: "先出方案" }).click();
  const pill = chat(page).getByTestId("chat-mode-plan");
  await expect(pill).toBeVisible();
  await chat(page).getByTestId("chat-mode-plan-off").click();
  await expect(pill).toBeHidden();
});

test("an input method: Enter picks a word and sends nothing, a block waits for the word", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const sent = await pretend(page);
  await setUp(page);
  await goTo(page, "0:01/00");
  await showTab(page, "chat");
  await box(page).click();
  await box(page).pressSequentially("看");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "ni", selectionStart: 2, selectionEnd: 2 });
  await expect(box(page)).toHaveText("看ni");
  // Enter while it composes is the input method's: nothing goes, no history, no shortcut.
  await box(page).evaluate((element) => {
    for (const key of ["Enter", "ArrowUp", "Backspace"]) {
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
  // The time from "+" meanwhile: the block waits for the word.
  await chat(page).getByTestId("chat-plus").click();
  await chat(page).getByTestId("chat-plus-time").click();
  await expect(box(page).getByTestId("chat-chip")).toHaveCount(0);
  await ime.send("Input.insertText", { text: "你" });
  const chips = box(page).getByTestId("chat-chip");
  await expect(chips).toHaveCount(1);
  await expect(box(page)).toHaveText("看你 0:01/00 ");
  expect(sent).toHaveLength(0);
  // Composing again and taking it back with Ctrl+Z leaves the words and the block as they were.
  await ime.send("Input.imeSetComposition", { text: "ha", selectionStart: 2, selectionEnd: 2 });
  await ime.send("Input.insertText", { text: "哈" });
  await expect(box(page)).toHaveText("看你 0:01/00 哈");
  await page.keyboard.press("Control+z");
  await expect(box(page)).toHaveText("看你 0:01/00 ");
  await expect(chips).toHaveCount(1);
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("好的。");
  expect(lastUser(sent[0] as Sent)[0]?.text).toBe("看你 [0:01/00](aq://time?timeline=main&t=1) ");
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
  await showTab(page, "chat");
  await box(page).click();
  const started = Date.now();
  await page.keyboard.press("Alt+s");
  const picture = chat(page).getByTestId("chat-picture");
  await expect(picture).not.toHaveAttribute("data-state", "working", { timeout: 20_000 });
  const took = Date.now() - started;
  console.log(`a 1080p scene frame for the chat took ${took} ms`);
  await expect(picture).toHaveAttribute("data-state", "ready");
  expect(took).toBeLessThanOrEqual(2000);
  // It is the scene as the export draws it: its background in a corner, its white words inside.
  const colors = await picture.locator("img").evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const painter = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    painter.drawImage(image, 0, 0);
    const at = (x: number, y: number) =>
      Array.from(painter.getImageData(x, y, 1, 1).data.slice(0, 3));
    let white = 0;
    const data = painter.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data;
    for (let i = 0; i < data.length; i += 4) if ((data[i] as number) > 230) white += 1;
    return { size: [image.naturalWidth, image.naturalHeight], corner: at(5, 5), white };
  });
  console.log(`the scene frame: ${JSON.stringify(colors)}`);
  expect(colors.size).toEqual([1568, 882]);
  expect(colors.corner.every((value, index) => Math.abs(value - [17, 34, 51][index]!) < 12)).toBe(
    true,
  );
  expect(colors.white).toBeGreaterThan(1000);
});
