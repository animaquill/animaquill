import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject, type SoundManifest } from "@animaquill/schema";
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
  openWork,
} from "./ai-support.ts";
import { chooseFolder } from "./scene-support.ts";
import { content, expect, tab, test, showTab } from "./support.ts";

/**
 * AI hears the sound itself, and the conversation makes room when it fills up (mcp.md 8, 6.11a of
 * AnimaQuill Cloud): aq_audio_analyze mixes as the export does, and the chat shows the loudness, a
 * small picture of the level with the clips red and the silences grey, a click there moves the
 * playhead; a sound alone says its attack and decay. A request too long for the model sums up the
 * earlier conversation first, with the line that says so, the summary to read, the button to sum up
 * now, and where nothing more fits, a new conversation from here.
 */

const KEY = "sk-ant-test-0123456789abcdefSECRET";
const SHOTS = "look2";
const RATE = 48_000;

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

/** A WAV file of 16-bit mono samples at 48 kHz, from what `sample` says of each moment, −1 to 1. */
function wav(seconds: number, sample: (t: number) => number): Buffer {
  const count = Math.round(seconds * RATE);
  const data = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const value = Math.max(-1, Math.min(1, sample(index / RATE)));
    data.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * 30 s of music at −12 dBFS that clips at 11.4 and 22.1 s and is silent from 18.6 to 19.5 s, and
 * a short sound made by code at 12 s (`DING`). The safe limiter of the master is off, or it would
 * keep the clips from clipping.
 */
function soundProject(): string {
  const project = {
    ...createProject({ name: "听声音" }),
    sounds: new Map([["ding", { name: "叮", entry: "sound.js", runtime: 1 } as SoundManifest]]),
  };
  const files: Map<string, string | Buffer> = writeProject(project);
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { id: string; kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  Object.assign(timeline, { mix: { master: { properties: { "limit.on": false } } } });
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    {
      id: "clip_bg",
      name: "背景",
      start: "0",
      duration: "30",
      source: { kind: "color", color: "#203040" },
    },
  ];
  timeline.tracks.push(
    {
      id: "track_music",
      kind: "audio",
      clips: [
        {
          id: "clip_music",
          name: "片头音乐",
          start: "0",
          duration: "30",
          source: { kind: "audio", media: { asset: "music" } },
        },
      ],
    },
    {
      id: "track_fx",
      kind: "audio",
      clips: [
        {
          id: "clip_ding",
          name: "叮",
          start: "12",
          duration: "1.5",
          source: { kind: "sound", sound: "ding" },
          properties: { "param.duration": 1.5 },
        },
      ],
    },
  );
  files.set(path, JSON.stringify(timeline));
  files.set(
    "assets.json",
    JSON.stringify({
      assets: {
        music: { name: "片头音乐", kind: "audio", path: "assets/music.wav", storage: "git" },
      },
    }),
  );
  const clipsAt = (t: number) => (t >= 11.4 && t < 11.42) || (t >= 22.1 && t < 22.13);
  files.set(
    "assets/music.wav",
    wav(30, (t) => {
      if (t >= 18.6 && t < 19.5) return 0;
      if (clipsAt(t)) return Math.sin(2 * Math.PI * 440 * t) >= 0 ? 1 : -1;
      return 0.25 * Math.sin(2 * Math.PI * 440 * t);
    }),
  );
  // The short sound is made by code, as AI writes one: up in 15 ms, down by e every 0.17 s.
  files.set("sounds/ding/sound.js", DING);
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-listen-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

interface Sent {
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
  readonly tools?: readonly unknown[];
}

const stream = (route: Route, body: string) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body,
  });

const TOO_LONG = "prompt is too long: 215000 tokens > 200000 maximum";

const tooLong = (route: Route) =>
  route.fulfill({
    status: 400,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: TOO_LONG },
    }),
  });

/** What a request is: the summary of the earlier conversation, or a request of the chat. */
const isSummary = (body: Sent) =>
  JSON.stringify(body.messages[0]?.content ?? "").includes("You are summarizing the earlier part");

type Answer =
  | string
  | {
      readonly calls: readonly { readonly name: string; readonly input: Record<string, unknown> }[];
    }
  | "too-long";

/**
 * Answers each request of the chat with the next of `answers`, and each request for a summary with
 * the next of `summaries` (an error where it is "too-long" or "error"). `hold` keeps a summary back
 * until it resolves. Keeps what was sent.
 */
async function pretend(
  page: Page,
  answers: readonly Answer[],
  summaries: readonly string[] = [],
  hold?: () => Promise<void>,
) {
  const sent: Sent[] = [];
  const summed: Sent[] = [];
  await page.route(ANTHROPIC, async (route) => {
    if (isConnectionTest(route)) return stream(route, anthropicSays("OK"));
    const body = route.request().postDataJSON() as Sent;
    if (isSummary(body)) {
      summed.push(body);
      await hold?.();
      const next = summaries[summed.length - 1] ?? "error";
      if (next === "error")
        return route.fulfill({
          status: 500,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }),
        });
      return stream(route, anthropicSays(next));
    }
    sent.push(body);
    const next = answers[sent.length - 1] ?? "好的。";
    if (next === "too-long") return tooLong(route);
    if (typeof next === "string") return stream(route, anthropicSays(next));
    return stream(route, anthropicCalls(next.calls).replaceAll("toolu_", `toolu_${sent.length}_`));
  });
  return { sent, summed };
}

async function setUp(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await chooseFolder(page, soundProject());
  // The sound is code: the editor says so once, before it opens the project.
  const code = page.getByRole("dialog", { name: "这个项目含有脚本" });
  await code.getByRole("button", { name: "知道了，打开项目" }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await showTab(page, "chat");
  await expect(chat(page).getByTestId("chat-model-name")).toHaveText("claude-test");
}

async function ask(page: Page, text: string) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

async function shoot(page: Page, name: string, target?: ReturnType<Page["locator"]>) {
  await (target ?? page).screenshot({ path: test.info().outputPath(`${SHOTS}-${name}.png`) });
}

/** The browser says so of each request the service refused, as these tests have it refuse. */
function expectedInConsole(problems: string[]) {
  const left = problems.filter((problem) => !/Failed to load resource/.test(problem));
  problems.splice(0, problems.length, ...left);
}

const DING = `aq.sound(({ frames, sampleRate }) => {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    const t = at / sampleRate;
    const shape = t < 0.015 ? t / 0.015 : Math.exp(-(t - 0.015) / 0.17);
    samples[at] = 0.5 * shape * Math.sin(2 * Math.PI * 1320 * t);
  }
  return samples;
});`;

const listened = (page: Page) => chat(page).locator('[data-testid="chat-tool"][data-listen]');

test.use({ withProject: false });

test("AI hears the sound: loudness, peak, clips and silence over a small picture of the level, a click goes there; a short sound alone says its attack and decay", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { sent } = await pretend(page, [
    { calls: [{ name: "aq_audio_analyze", input: { range: { from: "0", to: "30" } } }] },
    { calls: [{ name: "aq_audio_analyze", input: { clip: "clip_ding" } }] },
    "配乐在 0:11 和 0:22 有两处削波；「叮」起音很快。",
  ]);
  await setUp(page);
  await ask(page, "配乐有没有爆音？「叮」听起来怎么样？");
  await expect(chat(page).getByTestId("chat-answer")).toContainText("两处削波", {
    timeout: 90_000,
  });

  // What the model got: the numbers of the mix as the export mixes it.
  const result = JSON.stringify(sent[1]?.messages.at(-1)?.content ?? "");
  expect(result).toContain("the mix of timeline main");
  expect(result).toMatch(/clipping: 2 place\(s\)/);
  expect(result).toMatch(/silence \(below -50 dBFS for 0.3 s or longer\): 18\.6\d*-19\.5/);
  const alone = JSON.stringify(sent[2]?.messages.at(-1)?.content ?? "");
  expect(alone).toContain('clip clip_ding \\"叮\\" alone');
  expect(alone).toMatch(/attack 1\d ms/);

  // Folded, the sound hangs nowhere: it is a step, open with the others.
  await expect(listened(page)).toHaveCount(0);
  await openWork(chat(page));
  const rows = listened(page);
  await expect(rows).toHaveCount(2);
  const mix = rows.nth(0);
  await expect(mix.getByTestId("chat-tool-summary")).toHaveText(
    /^0:00–0:30 · 响度 −\d+\.\d LUFS · 峰值 −?\d+\.\d dB · 2 处削波 · 1 段静音$/,
  );
  await expect(mix.getByTestId("chat-listen-clip")).toHaveCount(2);
  await expect(mix.getByTestId("chat-listen-silence")).toHaveCount(1);
  const ding = rows.nth(1);
  await expect(ding.getByTestId("chat-tool-summary")).toHaveText(
    /^「叮」 · 0:12–0:13\.5 · 起音 1\d 毫秒、衰减 0\.[6-9] 秒 · 峰值 −\d+\.\d dB$/,
  );
  await shoot(page, "L1-listen");
  await shoot(page, "L1-listen-chat", chat(page).getByTestId("chat"));
  await shoot(page, "L1-envelope", ding);

  // A click on a clip goes there on the timeline.
  await mix.getByTestId("chat-listen-clip").nth(1).click();
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }),
  ).toContainText("0:22/03");

  await page.setViewportSize({ width: 390, height: 844 });
  await showTab(page, "chat");
  await mix.getByTestId("chat-tool-summary").scrollIntoViewIfNeeded();
  await expect(mix.getByTestId("chat-tool-summary")).toBeInViewport();
  await shoot(page, "L1-listen-390");
});

test("a request too long for the model sums up the earlier conversation: the line, the summary to read, and the button to sum up now", async ({
  page,
  problems,
}) => {
  test.setTimeout(180_000);
  let release: () => void = () => {};
  let held = true;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { sent, summed } = await pretend(
    page,
    ["改好了第一处。", "改好了第二处。", "改好了第三处。", "too-long", "降了 2 dB。", "好的。"],
    [
      "1. What the user wants: three fixes to the titles.\n2. What was decided: keep the colors.",
      "1. What the user wants: three fixes and a quieter music.",
    ],
    async () => {
      if (held) await waiting;
    },
  );
  await setUp(page);
  for (const [index, text] of ["改第一处", "改第二处", "改第三处"].entries()) {
    await ask(page, text);
    await expect(chat(page).getByTestId("chat-answer").nth(index)).toBeVisible({ timeout: 60_000 });
  }
  await ask(page, "把配乐降 2 dB");
  // While the model sums up, the line over the input says so.
  const phase = chat(page).locator('[data-testid="chat-work"][data-tone]');
  await expect(phase).toHaveAttribute("data-state", "compacting", { timeout: 60_000 });
  await expect(phase).toContainText("正在压缩较早的对话…");
  await shoot(page, "L2-compacting", chat(page).getByTestId("chat"));
  held = false;
  release();
  await expect(chat(page).getByTestId("chat-answer").nth(3)).toHaveText("降了 2 dB。", {
    timeout: 60_000,
  });

  // The request after it has the summary first and the last two turns as they were.
  const after = JSON.stringify(sent[4]?.messages ?? []);
  expect(after).toContain("three fixes to the titles");
  expect(after).not.toContain("改第一处");
  expect(after).toContain("改第三处");
  expect(after).toContain("把配乐降 2 dB");
  expect(summed).toHaveLength(1);

  // People still see all of it, with the line where it was summed up.
  const divider = chat(page).getByTestId("chat-summed");
  await expect(divider).toHaveCount(1);
  await expect(divider).toContainText(/^较早的 4 条已压缩成一段摘要(，省下 .+)? · 看摘要$/);
  await expect(chat(page).getByTestId("chat-user").getByText("改第一处")).toBeVisible();
  await shoot(page, "L2-divider", chat(page).getByTestId("chat"));
  await divider.getByTestId("chat-summed-open").click();
  const dialog = page.getByTestId("chat-summed-dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAccessibleName("AI 读到的摘要");
  await expect(dialog.getByTestId("chat-summed-text")).toContainText("three fixes to the titles");
  await shoot(page, "L2-summary");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(divider.getByTestId("chat-summed-open")).toBeFocused();

  // One more turn, and there is something to sum up again: the information of the conversation
  // does it now, from the pie of the context.
  await ask(page, "再看一遍");
  await expect(chat(page).getByTestId("chat-answer").nth(4)).toHaveText("好的。", {
    timeout: 60_000,
  });
  await chat(page).getByTestId("chat-context").click();
  const compact = chat(page).getByTestId("chat-compact");
  await expect(compact).toHaveText("压缩");
  await shoot(page, "L2-usage-compact", chat(page).getByTestId("chat"));
  await compact.click();
  await expect(divider).toHaveCount(2, { timeout: 60_000 });
  expect(summed).toHaveLength(2);
  // The second summary goes on from the first.
  expect(JSON.stringify(summed[1]?.messages ?? [])).toContain("three fixes to the titles");
  expectedInConsole(problems);
});

test("where nothing more fits, the chat says so, and a new conversation goes on from its summary", async ({
  page,
  problems,
}) => {
  test.setTimeout(150_000);
  await pretend(
    page,
    ["改好了第一处。", "改好了第二处。", "改好了第三处。", "too-long", "too-long"],
    ["1. What the user wants: three fixes to the titles."],
  );
  await setUp(page);
  for (const [index, text] of ["改第一处", "改第二处", "改第三处"].entries()) {
    await ask(page, text);
    await expect(chat(page).getByTestId("chat-answer").nth(index)).toBeVisible({ timeout: 60_000 });
  }
  // Summed up, it still does not fit: the context is full.
  await ask(page, "把整部片子的声音都检查一遍");
  const failure = chat(page).getByTestId("chat-failure");
  await expect(failure).toHaveAttribute("data-kind", "contextFull", { timeout: 60_000 });
  await expect(failure.locator("p").first()).toHaveText("上下文满了。");
  await expect(failure.getByTestId("chat-fresh")).toHaveText("从这里开新对话");
  await shoot(page, "L2-full", chat(page).getByTestId("chat"));
  await failure.getByTestId("chat-fresh").click();
  await expect(chat(page).getByTestId("chat-failure")).toHaveCount(0);
  await expect(chat(page).getByTestId("chat-forked")).toBeVisible();
  await expect(box(page)).toContainText("把整部片子的声音都检查一遍");
  // It goes on from the summary of the one before, which says so, not how many it stands for.
  const carried = chat(page).getByTestId("chat-summed");
  await expect(carried).toHaveText("带着上一段对话的摘要 · 看摘要");
  await shoot(page, "L2-fresh", chat(page).getByTestId("chat"));
  expectedInConsole(problems);
});

test("the settings have whether the earlier conversation is summed up by itself, on at first", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setUp(page);
  await openSettingsPage(page, "AI 聊天");
  const settings = settingsOf(page);
  const auto = settings.getByRole("switch", { name: "上下文快满时自动压缩" });
  await expect(auto).toBeChecked();
  await auto.scrollIntoViewIfNeeded();
  await shoot(page, "L3-settings");
  await auto.uncheck();
  await expect(auto).not.toBeChecked();
});
