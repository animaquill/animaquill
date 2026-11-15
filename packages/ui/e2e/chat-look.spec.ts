import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  isConnectionTest,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { chooseFolder } from "./scene-support.ts";
import { content, expect, tab, test } from "./support.ts";

/**
 * AI looks at the picture itself (mcp.md 8, 6.11a of AnimaQuill Cloud): aq_render_frames renders
 * frames as the export does, and the chat shows them right under the call, with their times and
 * boxes, open large, with the playhead moved there; comparisons, overviews and parts shown large;
 * the line over the input while it waits for people to stop playing or come back to the page; a
 * frame that cannot be rendered, red, with why; and a model that cannot see.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

/** Where the screenshots for the design's checks go, see `shoot`. */
const SHOTS = "look1";

/**
 * A 1920×1080 project of colors, with a title that goes 140 past the right edge and a logo that
 * overlaps it; `extra` clips go on a track of their own.
 */
function colorProject(extra: readonly unknown[] = []): string {
  const project = createProject({ name: "看画面" });
  const files = writeProject(project);
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { id: string; kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    {
      id: "clip_bg",
      name: "背景",
      start: "0",
      duration: "30",
      source: { kind: "color", color: "#2a3550" },
    },
  ];
  timeline.tracks.push({
    id: "track_top",
    kind: "video",
    clips: [
      {
        id: "clip_title",
        name: "标题",
        start: "0",
        duration: "30",
        source: { kind: "color", color: "#e5484d" },
        properties: { "transform.width": 400, "transform.height": 200, "transform.x": 900 },
      },
    ],
  });
  timeline.tracks.push({
    id: "track_logo",
    kind: "video",
    clips: [
      {
        id: "clip_logo",
        name: "Logo",
        start: "0",
        duration: "30",
        source: { kind: "color", color: "#3366ff" },
        properties: {
          "transform.width": 200,
          "transform.height": 200,
          "transform.x": 750,
          "transform.y": -50,
        },
      },
    ],
  });
  if (extra.length > 0)
    timeline.tracks.push({ id: "track_more", kind: "video", clips: [...extra] });
  files.set(path, JSON.stringify(timeline));
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-look-")), "项目");
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

const stream = (route: Route, body: string) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body,
  });

/**
 * Answers each request with the next of `answers`: calls of tools, or words. Keeps what was sent.
 * `hold` keeps an answer back until it resolves.
 */
async function pretend(
  page: Page,
  answers: readonly (
    | {
        readonly calls: readonly {
          readonly name: string;
          readonly input: Record<string, unknown>;
        }[];
      }
    | string
  )[],
  hold?: Promise<void>,
) {
  const sent: Sent[] = [];
  await page.route(ANTHROPIC, async (route) => {
    if (isConnectionTest(route)) return stream(route, anthropicSays("OK"));
    const body = route.request().postDataJSON() as Sent;
    sent.push(body);
    const next = answers[sent.length - 1] ?? "好的。";
    if (typeof next === "string") return stream(route, anthropicSays(next));
    if (hold) await hold;
    // Each answer's calls have ids of their own, as a service gives them.
    return stream(route, anthropicCalls(next.calls).replaceAll("toolu_", `toolu_${sent.length}_`));
  });
  return sent;
}

/** The parts of the last tool result of a request, as Anthropic gets them. */
function lastToolResult(
  sent: Sent,
): readonly { type: string; text?: string; source?: { data: string; media_type: string } }[] {
  const last = sent.messages.at(-1);
  const parts = Array.isArray(last?.content)
    ? (last.content as { type: string; content?: unknown }[])
    : [];
  const result = parts.findLast((part) => part.type === "tool_result");
  if (typeof result?.content === "string") return [{ type: "text", text: result.content }];
  return Array.isArray(result?.content) ? (result.content as never) : [];
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

async function setUp(page: Page, folder = colorProject(), width = 1440, problems = false) {
  await page.setViewportSize({ width, height: 900 });
  await chooseFolder(page, folder);
  await expect(tab(page, "preview")).toBeVisible();
  // A project with something this editor does not do says so as it comes in.
  if (problems) {
    const imported = page.getByRole("dialog", { name: "项目已导入" });
    await imported.getByRole("button", { name: "关闭" }).click();
    await expect(imported).toBeHidden();
  }
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await tab(page, "chat").click();
  await expect(chat(page).getByTestId("chat-model")).toHaveText("claude-test");
}

async function ask(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

/** A screenshot for the design's checks, of the whole page or of a part of it. */
async function shoot(page: Page, name: string, target?: ReturnType<Page["locator"]>) {
  await (target ?? page).screenshot({ path: test.info().outputPath(`${SHOTS}-${name}.png`) });
}

const look = (page: Page) => chat(page).locator('[data-testid="chat-tool"][data-look]');

test.use({ withProject: false });

test("AI looks at frames: small pictures with their times and boxes, a line of what it found, large with and without boxes, the playhead there", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sent = await pretend(page, [
    { calls: [{ name: "aq_render_frames", input: { times: ["1", "2.5", "4"], annotate: true } }] },
    "标题超出了画面右边。",
  ]);
  await setUp(page);
  await ask(page, "看看标题有没有超出画面");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("标题超出了画面右边。", {
    timeout: 60_000,
  });

  // What the model got: three pictures before the words of the result, 1024 wide, medium.
  const parts = lastToolResult(sent[1] as Sent);
  expect(parts.map(({ type }) => type)).toEqual(["image", "image", "image", "text"]);
  const first = parts[0]?.source;
  expect(first?.media_type).toBe("image/jpeg");
  expect(jpegSize(Buffer.from(first?.data ?? "", "base64"))).toEqual({ width: 1024, height: 576 });
  const words = parts.at(-1)?.text ?? "";
  expect(words).toContain("3 pictures of 1024×576 come before this text");
  expect(words).toContain('clip_title "标题" color=#e5484d box 700,-100 400×200');
  expect(words).toContain("past the edge: right 140");

  // The row shows its pictures without opening, even with the process folded.
  const row = look(page);
  await expect(row).toHaveAttribute("data-look", "frames");
  await expect(row.getByTestId("chat-tool-summary")).toHaveText(
    /^0:01、0:02\.5、0:04（3 张） · 约 2\.4k token$/,
  );
  const pictures = row.getByTestId("chat-look-picture");
  await expect(pictures).toHaveCount(3);
  await expect(pictures.first()).toContainText("0:01");
  const findings = row.getByTestId("chat-look-findings");
  await expect(findings).toContainText("「标题」右边超出画面 140 像素");
  await expect(findings).toContainText(/「(标题|Logo)」和「(Logo|标题)」重叠/);
  await expect(pictures.first().locator("img")).toHaveJSProperty("naturalWidth", 1024);
  await shoot(page, "L1-look");
  await shoot(page, "L1-look-chat", chat(page).getByTestId("chat"));

  // Large: with its boxes, then without; the playhead goes there.
  await pictures.nth(1).click();
  const large = page.getByTestId("chat-look-large");
  await expect(large).toBeVisible();
  await expect(large).toContainText("AI 看的画面 · 主线 0:02.5 · 1024×576");
  await expect(large.getByTestId("chat-look-large-picture")).toHaveAttribute("data-role", "frame");
  await shoot(page, "L2-large");
  await large.getByTestId("chat-look-marks").uncheck();
  await expect(large.getByTestId("chat-look-large-picture")).toHaveAttribute("data-role", "clean");
  await shoot(page, "L2-large-clean");
  await large.getByTestId("chat-look-playhead").click();
  await expect(large).toBeHidden();
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }),
  ).toContainText("0:02/15");

  // The same row at the width of a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await tab(page, "chat").click();
  await shoot(page, "L1-look-390");
});

test("a comparison shows before, after and what differs; an overview its one picture; a part shown large, where it is", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sent = await pretend(page, [
    { calls: [{ name: "aq_object_read", input: { ids: ["clip_title"] } }] },
    {
      calls: [
        {
          name: "aq_edit",
          input: {
            operations: [
              {
                op: "property.edit",
                timeline: "main",
                edits: [
                  { owner: { clip: "clip_title" }, path: "transform.x", op: "set", value: -300 },
                ],
              },
            ],
            summary: "把标题挪进画面",
          },
        },
      ],
    },
    { calls: [{ name: "aq_render_frames", input: { times: ["1"], compare: "task_start" } }] },
    { calls: [{ name: "aq_render_frames", input: { range: { from: "0", to: "30" }, count: 12 } }] },
    {
      calls: [
        {
          name: "aq_render_frames",
          input: { times: ["1"], region: { x: -960, y: 0, width: 960, height: 540 } },
        },
      ],
    },
    "挪好了。",
  ]);
  await setUp(page);
  await ask(page, "把标题挪进画面，然后对比一下");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("挪好了。", { timeout: 60_000 });

  const rows = look(page);
  await expect(rows).toHaveCount(3);
  const compared = rows.nth(0);
  await expect(compared).toHaveAttribute("data-look", "compare");
  await expect(compared.getByTestId("chat-look-picture")).toHaveCount(3);
  await expect(compared.getByTestId("chat-look-picture").nth(2)).toContainText("差异");
  await expect(compared.getByTestId("chat-tool-summary")).toHaveText(
    /^0:01 · 变了 \d+(\.\d)?%（.+） · 约 2\.4k token$/,
  );
  const compare = lastToolResult(sent[3] as Sent);
  expect(compare.map(({ type }) => type)).toEqual(["image", "image", "image", "text"]);
  expect(compare.at(-1)?.text).toMatch(
    /changed since task_start: [\d.]+% of the pixels, within box/,
  );

  const overview = rows.nth(1);
  await expect(overview).toHaveAttribute("data-look", "overview");
  await expect(overview.getByTestId("chat-tool-summary")).toHaveText(
    /^0:00–0:30（12 格） · 约 \d+ token$/,
  );
  await expect(overview.getByTestId("chat-look-picture")).toHaveCount(1);

  const zoom = rows.nth(2);
  await expect(zoom).toHaveAttribute("data-look", "zoom");
  await expect(zoom.getByTestId("chat-tool-summary")).toHaveText(/^0:01 的左下角 · 约 787 token$/);
  await expect(zoom.getByTestId("chat-look-region")).toBeVisible();
  await shoot(page, "L1-compare-overview-zoom", chat(page).getByTestId("chat"));
  await compared.getByTestId("chat-look-picture").nth(2).click();
  await shoot(page, "L1-compare-diff-large");
  await page.keyboard.press("Escape");
  await overview.getByTestId("chat-look-picture").click();
  await shoot(page, "L1-overview-large");
  await page.keyboard.press("Escape");
  await zoom.getByTestId("chat-look-picture").click();
  await shoot(page, "L1-zoom-large");
  await page.keyboard.press("Escape");
});

test("while people play, AI waits for them to stop, and says so", async ({ page }) => {
  test.setTimeout(180_000);
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  await pretend(
    page,
    [{ calls: [{ name: "aq_render_frames", input: { times: ["1"] } }] }, "看到了。"],
    hold,
  );
  await setUp(page);
  const preview = content(page, "preview");
  await preview.getByRole("button", { name: "播放", exact: true }).click();
  await ask(page, "看一眼");
  release();
  const phase = chat(page).getByTestId("chat-phase");
  await expect(phase).toHaveText(/你在播放，AI 等你停下再看画面/);
  await expect(phase).toHaveAttribute("data-look", "playing");
  await shoot(page, "L2-phase-playing", chat(page).getByTestId("chat"));
  // Nothing renders meanwhile.
  await page.waitForTimeout(1000);
  await expect(look(page).getByTestId("chat-look-picture")).toHaveCount(0);
  await preview.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("看到了。", { timeout: 60_000 });
  await expect(look(page).getByTestId("chat-look-picture")).toHaveCount(1);
});

test("with the page in the background, AI waits for it to show", async ({ page }) => {
  test.setTimeout(180_000);
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  await pretend(
    page,
    [{ calls: [{ name: "aq_render_frames", input: { times: ["1"] } }] }, "看到了。"],
    hold,
  );
  await setUp(page);
  await ask(page, "看一眼");
  // The page goes to the background, as far as it can tell.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  release();
  const phase = chat(page).getByTestId("chat-phase");
  await expect(phase).toHaveText(/等你回到这个页面才能看画面/);
  await shoot(page, "L2-phase-hidden", chat(page).getByTestId("chat"));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("看到了。", { timeout: 60_000 });
  await expect(look(page).getByTestId("chat-look-picture")).toHaveCount(1);
});

test("a frame that cannot be rendered is no picture: the row is red and says why, as AI was told", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const sent = await pretend(page, [
    { calls: [{ name: "aq_render_frames", input: { times: ["1"] } }] },
    "这一帧画不出来。",
  ]);
  await setUp(
    page,
    colorProject([
      {
        id: "clip_wipe",
        name: "擦除",
        start: "0",
        duration: "5",
        source: { kind: "color", color: "#ffffff" },
        properties: { "transform.width": 100, "transform.height": 100 },
        enter: { type: "plugin.wipe", duration: "2" },
      },
    ]),
    1440,
    true,
  );
  await ask(page, "看一眼");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("这一帧画不出来。", {
    timeout: 60_000,
  });
  const row = look(page);
  await expect(row).toHaveAttribute("data-state", "failed");
  await expect(row.getByTestId("chat-tool-summary")).toHaveText(
    "0:01 画不出来：片段「擦除」的转场这个版本还画不了",
  );
  await expect(row.getByTestId("chat-look-picture")).toHaveCount(0);
  const parts = lastToolResult(sent[1] as Sent);
  expect(parts.map(({ type }) => type)).toEqual(["text"]);
  expect(parts[0]?.text).toBe(
    'error render-failed: t=1 cannot be rendered: clip clip_wipe "擦除" has a transition this editor cannot draw yet. A picture with something missing would not be what the export renders, so nothing was rendered.',
  );
  await shoot(page, "L2-failed", chat(page).getByTestId("chat"));
});

test("a model that cannot see gets the list only, and the row says so", async ({ page }) => {
  test.setTimeout(180_000);
  const sent = await pretend(page, [
    { calls: [{ name: "aq_render_frames", input: { times: ["1"] } }] },
    "清单里标题超出了右边。",
  ]);
  await setUp(page);
  await openSettingsPage(page, "AI 模型");
  const service = settingsOf(page).getByTestId("ai-service");
  await service
    .locator('[data-testid="ai-model"][data-model="claude-test"]')
    .getByTestId("ai-model-open")
    .click();
  const image = settingsOf(page)
    .getByTestId("ai-model-detail")
    .getByRole("checkbox", { name: /能看图/ });
  await image.check();
  await image.uncheck();
  await closeSettings(page);
  await tab(page, "chat").click();
  await ask(page, "看一眼");
  await expect(chat(page).getByTestId("chat-answer")).toHaveText("清单里标题超出了右边。", {
    timeout: 60_000,
  });
  // Without pictures the row folds away with the process, as other calls do.
  await chat(page).getByTestId("chat-process").getByRole("button").first().click();
  const row = look(page);
  await expect(row.getByTestId("chat-tool-summary")).toHaveText(
    "（这个模型不能看图，只收到了画面里有什么的清单）",
  );
  await expect(row.getByTestId("chat-look-picture")).toHaveCount(0);
  const parts = lastToolResult(sent[1] as Sent);
  expect(parts.map(({ type }) => type)).toEqual(["text"]);
  expect(parts[0]?.text).toContain("pictures not attached: this model cannot see pictures");
  await shoot(page, "L2-blind", chat(page).getByTestId("chat"));
});

test("the settings have how large AI's pictures are and whether it waits for playing", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setUp(page);
  await openSettingsPage(page, "AI 聊天");
  const settings = settingsOf(page);
  await expect(settings.getByText("AI 看画面时用多大的图")).toBeVisible();
  await expect(settings.getByRole("radio", { name: "中 · 约 800 token" })).toBeChecked();
  await settings.getByRole("radio", { name: "小 · 约 200 token" }).click();
  const waits = settings.getByRole("switch", { name: "AI 看画面时等你停下播放" });
  await expect(waits).toBeChecked();
  await shoot(page, "L2-settings");
  await waits.uncheck();
  await expect(waits).not.toBeChecked();
  await expect(settings.getByRole("radio", { name: "小 · 约 200 token" })).toBeChecked();
});
