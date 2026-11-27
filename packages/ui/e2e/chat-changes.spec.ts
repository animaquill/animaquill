import type { Locator, Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  isConnectionTest,
} from "./ai-support.ts";
import { content, devPageOnly, expect, test, showTab } from "./support.ts";

/**
 * The card of a task opens each line to what it changed, before and after (S-D1 of the design of
 * changes and gates): a property as two values, keys as two curves, code line by line and side by
 * side in the code editor, and the picture before and after. From the undo log of the task, so
 * also after a reload and once it was taken back; not where this device has no log of it.
 */

devPageOnly("window.aqExecute, window.aqState and the undo hooks");

const chat = (page: Page) => content(page, "chat");
const card = (page: Page) => chat(page).getByTestId("chat-card").last();
const row = (page: Page, text: string) =>
  card(page).getByTestId("chat-change").filter({ hasText: text });
const opener = (line: Locator) => line.locator("button[aria-expanded]");

/** Where the pictures for the design's checks go, besides the output of the test. */
const shoot = (target: Page | Locator, name: string) =>
  target.screenshot({ path: test.info().outputPath(`sd1-${name}.png`) });

const CODE = Array.from({ length: 30 }, (_, index) => `export const n${index + 1} = ${index + 1};`);
const NEW_CODE = CODE.map((line, index) =>
  index === 9 ? "export const n10 = 100;" : index === 24 ? "export const n25 = 250;" : line,
).join("\n");

const execute = (page: Page, call: object, options?: object) =>
  page.evaluate(
    ([given, how]) => {
      const run = (
        window as unknown as { aqExecute: (call: unknown, options?: unknown) => { ok: boolean } }
      ).aqExecute;
      return run(given, how).ok;
    },
    [call, options] as const,
  );

/** Two color clips on the first video track and a file of code, as people made them. */
async function prepare(page: Page) {
  const track = await page.evaluate(() => {
    const state = (
      window as unknown as {
        aqState: () => { timelines: Record<string, { tracks: Record<string, { kind: string }> }> };
      }
    ).aqState();
    const tracks = state.timelines["main"]?.tracks ?? {};
    return Object.keys(tracks).find((id) => tracks[id]?.kind === "video");
  });
  const clip = (id: string, name: string, start: string, color: string) => ({
    type: "clip.add",
    params: {
      timeline: "main",
      track,
      id,
      name,
      start,
      duration: "5",
      source: { kind: "color", color },
      properties: { "transform.width": 600, "transform.height": 300 },
    },
  });
  expect(await execute(page, clip("clip_title", "标题", "0", "#e5484d"))).toBe(true);
  expect(await execute(page, clip("clip_logo", "Logo", "5", "#3366ff"))).toBe(true);
  expect(
    await execute(page, {
      type: "file.write",
      params: { path: "code/helper.js", text: `${CODE.join("\n")}\n` },
    }),
  ).toBe(true);
}

const stream = (route: Route, body: string) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
    body,
  });

/**
 * AI reads the clips and the file, then in one task moves the title and fades it in with keys,
 * makes the logo shorter, and rewrites two lines of the code.
 */
async function aiChanges(page: Page) {
  const answers = [
    [
      { name: "aq_object_read", input: { ids: ["clip_title", "clip_logo"] } },
      { name: "aq_file_read", input: { path: "code/helper.js" } },
    ],
    [
      {
        name: "aq_edit",
        input: {
          summary: "挪标题、加淡入、缩短 Logo",
          operations: [
            {
              op: "property.edit",
              timeline: "main",
              edits: [
                { owner: { clip: "clip_title" }, path: "transform.x", op: "set", value: -300 },
                {
                  owner: { clip: "clip_title" },
                  path: "opacity",
                  op: "putKeys",
                  keys: [
                    { time: "0", value: 0 },
                    { time: "2", value: 1 },
                  ],
                },
              ],
            },
            { op: "clip.trim", timeline: "main", clip: "clip_logo", end: "8" },
          ],
        },
      },
      { name: "aq_file_write", input: { path: "code/helper.js", text: `${NEW_CODE}\n` } },
    ],
  ];
  let round = 0;
  await page.route(ANTHROPIC, (route: Route) => {
    if (isConnectionTest(route)) return stream(route, anthropicSays("OK"));
    const calls = answers[round];
    round += 1;
    return stream(
      route,
      calls
        ? anthropicCalls(calls).replaceAll("toolu_", `toolu_${round}_`)
        : anthropicSays("改好了。"),
    );
  });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");
  await closeSettings(page);
  await showTab(page, "chat");
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill("把标题挪进来，淡入，Logo 短一点，常量改一下");
  await box.press("Enter");
  await expect(chat(page).getByText("改好了。")).toBeVisible({ timeout: 30_000 });
  await expect(card(page).getByTestId("chat-change")).toHaveCount(3);
}

/** Keeps what changed and its undo logs, as a page that goes away a moment later does. */
async function reload(page: Page) {
  await page.evaluate(async () => {
    const hooks = window as unknown as {
      aqSave: () => Promise<unknown>;
      aqUndoSaved: () => Promise<unknown>;
    };
    await hooks.aqSave();
    await hooks.aqUndoSaved();
  });
  await page.reload();
  await showTab(page, "chat");
}

/** Opens a line and resolves to what it shows. */
async function openLine(line: Locator): Promise<Locator> {
  await expect(opener(line)).toHaveAttribute("aria-expanded", "false");
  await opener(line).click();
  await expect(opener(line)).toHaveAttribute("aria-expanded", "true");
  const detail = line.getByTestId("chat-change-detail");
  await expect(detail).toBeVisible();
  return detail;
}

async function checkLogo(page: Page): Promise<Locator> {
  const detail = await openLine(row(page, "Logo"));
  const duration = detail.locator('[data-field="duration"]');
  await expect(duration).toContainText("时长");
  await expect(duration).toContainText(/0:05\/00\s*→\s*0:03\/00/);
  return detail;
}

test("each line opens to before and after: a value, keys, code, the picture", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page);
  await aiChanges(page);

  // A value: the time as the properties panel writes it.
  const logo = await checkLogo(page);
  // Only how long it is: the middle of it looks the same before and after, so no pictures.
  await expect(logo.getByTestId("chat-change-pictures")).toHaveCount(0);
  await logo.scrollIntoViewIfNeeded();
  await shoot(page, "properties");
  await opener(row(page, "Logo")).click();
  await expect(logo).toBeHidden();

  // Keys: two curves over the clock of the clip, the one before dashed, each key a dot; and the
  // other property of the same clip as a value.
  const title = await openLine(row(page, "标题"));
  const keys = title.locator('[data-field="properties.opacity"]');
  await expect(keys.locator("svg polyline")).toHaveCount(2);
  await expect(keys.locator("svg circle")).toHaveCount(2);
  await expect(title.locator('[data-field="properties.transform.x"]')).toContainText(
    /0\s*→\s*-300/,
  );

  // The picture before and after, rendered now, at the middle of the clip.
  const pictures = title.getByTestId("chat-change-pictures");
  await expect(pictures.locator('button[data-state="ready"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(pictures.locator("figcaption")).toHaveText(["前", "后"]);
  await expect(pictures.locator("img").first()).not.toHaveJSProperty("naturalWidth", 0);
  await keys.scrollIntoViewIfNeeded();
  await shoot(page, "keys");
  await pictures.scrollIntoViewIfNeeded();
  await shoot(page, "pictures");
  await pictures.getByRole("button", { name: "后" }).click();
  await expect(
    page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }),
  ).toContainText("0:02/15");

  // Code: the lines that changed with two around each, red and green; side by side in the editor.
  await showTab(page, "chat");
  await opener(row(page, "标题")).click();
  await expect(title).toBeHidden();
  const file = await openLine(row(page, "文件「code/helper.js」代码"));
  const lines = file.getByTestId("chat-change-code").locator("[data-kind]");
  await expect(file.getByTestId("chat-change-code").locator('[data-kind="removed"]')).toHaveText([
    "10export const n10 = 10;",
    "25export const n25 = 25;",
  ]);
  await expect(file.getByTestId("chat-change-code").locator('[data-kind="added"]')).toHaveText([
    "10export const n10 = 100;",
    "25export const n25 = 250;",
  ]);
  await expect(lines).toHaveCount(2 * (2 + 2 + 2));
  // Between the two pieces, a line that says lines were left out. The line says which file it is.
  await expect(file.getByTestId("chat-change-code")).toContainText("⋯");
  await expect(file.getByTitle("code/helper.js")).toHaveCount(0);
  await file.scrollIntoViewIfNeeded();
  await shoot(page, "code");
  await file.getByRole("button", { name: "打开对比" }).click();
  const compare = page.locator('[data-compare="code/helper.js"]');
  await expect(compare.locator(".monaco-diff-editor")).toBeVisible({ timeout: 30_000 });
  // Side by side, with what went on the left and what came on the right.
  await expect(compare.locator(".editor.original .line-delete")).toHaveCount(2);
  await expect(compare.locator(".editor.modified .line-insert")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "helper.js 对比" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await shoot(page, "compare");

  // The width of a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await showTab(page, "chat");
  await opener(row(page, "文件「code/helper.js」代码")).click();
  await opener(row(page, "标题")).click();
  await row(page, "标题").getByTestId("chat-change-pictures").scrollIntoViewIfNeeded();
  await shoot(page, "390");
});

test("after a reload, once the task was taken back, and in a conversation opened again, lines still open", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await prepare(page);
  await aiChanges(page);
  await reload(page);
  await expect(card(page).getByRole("button", { name: "撤销这一轮" })).toBeVisible();
  await checkLogo(page);

  await card(page).getByRole("button", { name: "撤销这一轮" }).click();
  await expect(card(page).getByRole("button", { name: "重做这一轮" })).toBeVisible();
  // Taken back, the line shows what the task did, as before.
  await opener(row(page, "Logo")).click();
  await checkLogo(page);
  await reload(page);
  await checkLogo(page);

  // Another conversation, then this one again from the list.
  await chat(page).getByTestId("chat-more").click();
  await chat(page).getByRole("menuitem", { name: "新对话" }).click();
  await expect(chat(page).getByTestId("chat-card")).toHaveCount(0);
  await chat(page).getByTestId("chat-title").click();
  await chat(page)
    .getByTestId("chat-list")
    .getByRole("button", { name: /^把标题挪进来/ })
    .click();
  await checkLogo(page);
});

test("without the undo log of a task, as on another device, nothing opens", async ({ page }) => {
  test.setTimeout(150_000);
  await prepare(page);
  await aiChanges(page);
  await expect(opener(card(page).getByTestId("chat-change"))).toHaveCount(3);

  // Another device has the conversation and none of the logs.
  await page.evaluate(() =>
    (window as unknown as { aqUndoElsewhere: () => Promise<unknown> }).aqUndoElsewhere(),
  );
  await expect(card(page).getByTestId("chat-change")).toHaveCount(3);
  await expect(opener(card(page).getByTestId("chat-change"))).toHaveCount(0);
  await expect(card(page).getByTestId("chat-change").first()).toContainText(/标题|Logo|helper/);
});

test("past the newest 50 tasks and batches, the oldest does not open any more", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await prepare(page);
  await aiChanges(page);
  await expect(opener(card(page).getByTestId("chat-change"))).toHaveCount(3);
  for (let index = 0; index < 50; index++) {
    expect(
      await execute(
        page,
        { type: "marker.add", params: { timeline: "main", time: String(index), name: `${index}` } },
        { origin: `ai:filler-${index}` },
      ),
    ).toBe(true);
    // Each saved on its own, as tasks are.
    await page.evaluate(() =>
      (window as unknown as { aqUndoSaved: () => Promise<unknown> }).aqUndoSaved(),
    );
  }
  await expect(opener(card(page).getByTestId("chat-change"))).toHaveCount(0);
  await expect(card(page).getByTestId("chat-change")).toHaveCount(3);
});
