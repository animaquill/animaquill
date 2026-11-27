import { mkdirSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  addModel,
  anthropicCalls,
  anthropicSays,
  closeSettings,
  goToSettingsGroup,
  isConnectionTest,
  openSettingsPage,
  settingsOf,
} from "./ai-support.ts";
import { dirOf, scene, sceneBothThemes } from "./shots-support.ts";
import { content, expect, test, showTab } from "./support.ts";

/**
 * The chat as people see it, in each step of its new design (docs/design/chat-panel.md of
 * AnimaQuill Cloud, 11): each scene in light and dark colours, about 320, 420 and 560 wide. Nothing
 * of the chat may stick out of it at any of them, which is what this checks; the pictures it takes
 * go to `test-results/chat-shots/<step>/`, for people to look at.
 */

const KEY = "sk-ant-test-0123456789abcdef";

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

for (const theme of ["light", "dark"] as const) {
  test.describe(`in ${theme} colours`, () => {
    test.use({ colorScheme: theme });

    test("the input card: empty, written, with pictures and queued, held", async ({ page }) => {
      test.setTimeout(180_000);
      mkdirSync(dirOf("1"), { recursive: true });
      await page.setViewportSize({ width: 1600, height: 1000 });
      const waiting: Route[] = [];
      await page.route(ANTHROPIC, (route) => {
        const said = (text: string) =>
          route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
            body: anthropicSays(text),
          });
        if (isConnectionTest(route)) return said("OK");
        if (JSON.stringify(route.request().postDataJSON()).includes("慢慢来"))
          return void waiting.push(route);
        return said("好的。");
      });
      await addAnthropic(page, KEY, "claude-test");
      await addModel(page, "claude-eyes");
      await closeSettings(page);
      await showTab(page, "chat");
      const send = chat(page).getByTestId("chat-send");
      await expect(send).toHaveAttribute("data-state", "empty");
      // Still a button: those who listen hear why there is nothing to send.
      await expect(send).toHaveAttribute("aria-label", "发送，先写要说的话");
      await expect(send).toBeEnabled();
      // Nothing selected: nothing to say of what goes with the message.
      await expect(chat(page).getByTestId("chat-carry")).toHaveCount(0);
      await scene(page, theme, "1-empty");

      // Written, with "先出方案" on: the pill, and send lit.
      await box(page).fill("把片头的标题往上挪一点，再加一个淡入");
      await chat(page).getByTestId("chat-plus").click();
      await chat(page).getByTestId("chat-plus-plan").click();
      await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "ready");
      await scene(page, theme, "2-written-plan");
      await scene(page, theme, "3-plus-menu", async () => {
        await chat(page).getByTestId("chat-plus").click();
        await expect(chat(page).getByTestId("chat-plus-menu")).toBeVisible();
      });
      await expect(chat(page).getByTestId("chat-plus-menu")).toBeHidden();
      await chat(page).getByTestId("chat-mode-plan-off").click();

      // A task runs: stop; two messages queued; more written, to queue; a picture in the card.
      await box(page).fill("慢慢来");
      await box(page).press("Enter");
      await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "stop");
      for (const words of [
        "再把字幕颜色换成黄的",
        "最后检查一下有没有超出画面的字",
        "还有配乐",
        "片尾加上制作人员名单",
      ]) {
        await box(page).fill(words);
        await box(page).press("Enter");
      }
      await expect(chat(page).getByTestId("chat-queued-item")).toHaveCount(3);
      await expect(chat(page).getByTestId("chat-queued-more")).toHaveText("还有 1 条");
      await box(page).fill("顺便把结尾留白 1 秒");
      await box(page).evaluate((element) => {
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==";
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "参考.png", { type: "image/png" }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      });
      await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-state", "ready");
      await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "queue");
      await scene(page, theme, "4-running-queued");
      await chat(page).getByTestId("chat-queued-more").click();
      await scene(page, theme, "5-queued-all");
      for (let left = 4; left > 0; left -= 1)
        await chat(page).getByTestId("chat-queued-drop").first().click();
      await chat(page).getByTestId("chat-picture-remove").click();
      await box(page).fill("");
      for (const route of waiting.splice(0))
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
          body: anthropicSays("慢的回答"),
        });
      await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "empty");

      // The model of the conversation turned off: a thin line says so, with what to do.
      await chat(page).getByTestId("chat-model").click();
      const bubble = chat(page).getByTestId("chat-model-bubble");
      await bubble.locator('[data-model="claude-test"]').getByRole("option").click();
      await openSettingsPage(page, "AI 模型");
      await settingsOf(page)
        .getByTestId("ai-service")
        .locator('[data-testid="ai-model"][data-model="claude-test"]')
        .getByRole("switch")
        .uncheck();
      await closeSettings(page);
      await showTab(page, "chat");
      await box(page).fill("还在吗");
      await box(page).press("Enter");
      const hold = chat(page).getByTestId("chat-hold");
      await expect(hold).toHaveAttribute("data-why", "modelOff");
      await expect(hold.getByRole("button", { name: "换一个模型" })).toBeVisible();
      await scene(page, theme, "6-held");
    });

    test("the model tag, its bubble, and the information of the conversation", async ({ page }) => {
      test.setTimeout(180_000);
      mkdirSync(dirOf("2"), { recursive: true });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.route(ANTHROPIC, (route) =>
        route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
          body: anthropicSays(isConnectionTest(route) ? "OK" : "好的，我把标题往上挪了 40 像素。"),
        }),
      );
      await addAnthropic(page, KEY, "claude-test");
      await addModel(page, "claude-eyes");
      await closeSettings(page);
      await showTab(page, "chat");
      const tag = chat(page).getByTestId("chat-model");
      const bubble = chat(page).getByTestId("chat-model-bubble");
      await expect(tag).toContainText("claude-test");
      await scene(page, theme, "1-tag", undefined, "2");
      // The bubble: how hard it reasons on top, the models, the line of the general words.
      await scene(
        page,
        theme,
        "2-bubble",
        async () => {
          await tag.click();
          await expect(bubble).toBeVisible();
        },
        "2",
      );
      // Favorites first, the first of them what a new conversation uses; a step chosen.
      await tag.click();
      const eyes = bubble.locator('[data-testid="chat-model-option"][data-model="claude-eyes"]');
      await eyes.hover();
      await eyes.getByTestId("chat-model-fav").click();
      await expect(
        bubble.locator('[data-group="favorites"] [data-model="claude-test"]'),
      ).toBeVisible();
      await chat(page).locator('[data-testid="chat-effort-option"][data-level="high"]').click();
      await expect(chat(page).getByTestId("chat-effort-default")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tag).toContainText("· 高");
      await scene(
        page,
        theme,
        "3-bubble-favorites",
        async () => {
          await tag.click();
          await expect(bubble.locator('[data-group="favorites"]')).toBeVisible();
        },
        "2",
      );
      // An answer: the pie of the context, and the information it opens.
      await box(page).fill("把标题往上挪一点");
      await box(page).press("Enter");
      await expect(chat(page).getByTestId("chat-answer")).toBeVisible({ timeout: 15_000 });
      await scene(
        page,
        theme,
        "4-info",
        async () => {
          await chat(page).getByTestId("chat-context").click();
          await expect(chat(page).getByTestId("chat-info")).toBeVisible();
        },
        "2",
      );
      await scene(
        page,
        theme,
        "5-info-packs",
        async () => {
          await chat(page).getByTestId("chat-context").click();
          await chat(page).getByTestId("chat-info-pack-choose").click();
          await expect(chat(page).getByTestId("chat-pack-menu")).toBeVisible();
        },
        "2",
      );
    });
  });
}

test("the work of a turn: running, folded, open with a step that failed, stopped", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const waiting: Route[] = [];
  await page.route(ANTHROPIC, (route) => {
    const sent = route.request().postDataJSON() as { messages?: { content: unknown }[] };
    const body = JSON.stringify(sent?.messages?.at(-1)?.content ?? "");
    const fulfil = (text: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body: text,
      });
    if (isConnectionTest(route)) return fulfil(anthropicSays("OK"));
    if (body.includes("慢慢来") && !body.includes("tool_result")) return void waiting.push(route);
    if (!body.includes("tool_result"))
      return fulfil(
        anthropicCalls([
          { name: "aq_timeline_read", input: {} },
          { name: "aq_object_read", input: { ids: ["clip_none"] } },
          { name: "aq_search", input: { query: "标题" } },
        ]),
      );
    return fulfil(
      anthropicSays("看过了：时间轴上还没有片段，标题也没找到。要我先做一个片名场景吗？"),
    );
  });
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await showTab(page, "chat");
  const work = chat(page).getByTestId("chat-work");

  // Done: one line, folded; open, the steps on their line, the one that failed red.
  await box(page).fill("看看标题在哪");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-answer")).toBeVisible({ timeout: 15_000 });
  await expect(work).toHaveAttribute("data-state", "done");
  await expect(work).toContainText("做了 3 步");
  await sceneBothThemes(page, "1-done", "3a");
  await work.getByRole("button").first().click();
  await expect(chat(page).getByTestId("chat-steps")).toBeVisible();
  await sceneBothThemes(page, "2-done-open", "3a");
  await work.getByRole("button").first().click();

  // Running: what it does now, and for how long; open, the steps as they come.
  await box(page).fill("慢慢来");
  await box(page).press("Enter");
  const now = chat(page).locator('[data-testid="chat-work"][data-tone]');
  await expect(now).toContainText("等模型回答…");
  await sceneBothThemes(page, "3-running", "3a");
  // Stopped: the line says so, and what it did.
  await chat(page).getByTestId("chat-send").click();
  await expect(chat(page).locator('[data-testid="chat-work"][data-state="stopped"]')).toBeVisible();
  await sceneBothThemes(page, "4-stopped", "3a");
  for (const route of waiting) await route.abort().catch(() => {});
});

test("the work of a turn waiting: a busy service, a quiet model; an answer cut short", async ({
  page,
  problems,
}) => {
  test.setTimeout(240_000);
  await page.clock.install();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const waiting: Route[] = [];
  let busy = 0;
  await page.route(ANTHROPIC, (route) => {
    const sent = route.request().postDataJSON() as { messages?: { content: unknown }[] };
    const said = JSON.stringify(sent?.messages?.at(-1)?.content ?? "");
    const fulfil = (text: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body: text,
      });
    if (isConnectionTest(route)) return fulfil(anthropicSays("OK"));
    if (said.includes("忙")) {
      busy += 1;
      if (busy === 1)
        return route.fulfill({
          status: 429,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Too many requests" },
          }),
        });
      return void waiting.push(route);
    }
    if (said.includes("长"))
      return fulfil(
        anthropicSays("这是一段很长的回答，写到一半就到了单次回答的上限……").replace(
          '"stop_reason":"end_turn"',
          '"stop_reason":"max_tokens"',
        ),
      );
    return void waiting.push(route);
  });
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await showTab(page, "chat");
  const now = chat(page).locator('[data-testid="chat-work"][data-tone]');

  // A busy service: why, which try, and the countdown, which is never cut short.
  await box(page).fill("服务忙的时候");
  await box(page).press("Enter");
  await expect(now).toHaveAttribute("data-state", "retry");
  await expect(chat(page).getByTestId("chat-work-tail")).toBeVisible();
  await sceneBothThemes(page, "7-retry", "3a");
  await chat(page).getByTestId("chat-send").click();

  // Quiet for a minute: says so, with waiting on and stopping.
  await box(page).fill("等着");
  await box(page).press("Enter");
  await expect(now).toHaveAttribute("data-state", "waiting");
  await page.clock.fastForward("01:05");
  await expect(now).toHaveAttribute("data-state", "quiet");
  await sceneBothThemes(page, "8-quiet", "3a");
  await chat(page).getByTestId("chat-send").click();

  // Cut short: one line, and a way on.
  await box(page).fill("写长一点");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-length")).toBeVisible({ timeout: 15_000 });
  await sceneBothThemes(page, "9-length", "3a");
  for (const route of waiting) await route.abort().catch(() => {});
  // The busy service, as the browser says it.
  problems.splice(
    0,
    problems.length,
    ...problems.filter((line) => !line.includes("status of 429")),
  );
});

test("the card of changes, a message and its menu, editing it, a failure of each kind", async ({
  page,
  problems,
}) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  /** What the model does with the next message: tools first, then its answer; or a failure. */
  let next: {
    readonly calls?: readonly { readonly name: string; readonly input: Record<string, unknown> }[];
    readonly answer?: string;
    readonly fail?: "network" | "key" | "notFound";
    /** It fails after its tools ran. */
    readonly failAfter?: boolean;
  } = {};
  let round = 0;
  await page.route(ANTHROPIC, (route) => {
    const fulfil = (body: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body,
      });
    const refuse = (status: number, type: string, message: string) =>
      route.fulfill({
        status,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify({ type: "error", error: { type, message } }),
      });
    if (isConnectionTest(route)) return fulfil(anthropicSays("OK"));
    const sent = route.request().postDataJSON() as { messages?: { content: unknown }[] };
    const after = JSON.stringify(sent?.messages?.at(-1)?.content ?? "").includes("tool_result");
    const failing = next.fail && (!next.failAfter || after);
    if (failing && next.fail === "network") return route.abort("failed");
    if (failing && next.fail === "key")
      return refuse(401, "authentication_error", "invalid x-api-key");
    if (failing) return refuse(404, "not_found_error", "model: claude-test not found");
    if (!after && next.calls) {
      round += 1;
      return fulfil(anthropicCalls(next.calls).replaceAll("toolu_", `toolu_${round}_`));
    }
    return fulfil(anthropicSays(next.answer ?? "好的。"));
  });
  await addAnthropic(page, KEY, "claude-test");
  // A second model, so that the first can be turned off, at the end.
  await addModel(page, "claude-eyes");
  await closeSettings(page);
  await showTab(page, "chat");
  const say = async (text: string) => {
    await box(page).fill(text);
    await box(page).press("Enter");
  };
  const fresh = async () => {
    await chat(page).getByTestId("chat-more").click();
    await chat(page).getByRole("menuitem", { name: "新对话" }).click();
  };
  const lastUser = () => chat(page).getByTestId("chat-user").last();

  // Two markers, then changed: the card says how, each row before and after.
  next = {
    calls: [
      {
        name: "aq_edit",
        input: {
          summary: "加片头和片尾两个标记",
          operations: [
            { op: "marker.add", timeline: "main", id: "m1", time: "1", name: "片头" },
            { op: "marker.add", timeline: "main", id: "m2", time: "8", name: "片尾" },
          ],
        },
      },
    ],
    answer: "加好了。",
  };
  await say("加两个标记");
  await expect(chat(page).getByText("加好了。")).toBeVisible({ timeout: 15_000 });
  next = {
    calls: [
      {
        name: "aq_edit",
        input: {
          summary: "片头标记往后挪半秒，片尾的改个名字",
          operations: [
            {
              op: "marker.update",
              timeline: "main",
              marker: "m1",
              changes: { time: "1.5" },
            },
            {
              op: "marker.update",
              timeline: "main",
              marker: "m2",
              changes: { name: "片尾字幕开始" },
            },
          ],
        },
      },
    ],
    answer: "挪好了：片头标记往后挪了半秒，片尾的标记改成了“片尾字幕开始”。",
  };
  await say("片头标记往后挪一点，片尾的改个名字");
  const card = chat(page).getByTestId("chat-card").last();
  await expect(card).toContainText("改了 2 处", { timeout: 15_000 });
  await expect(card.getByTestId("chat-card-said")).toHaveText("片头标记往后挪半秒，片尾的改个名字");
  await expect(card.getByTestId("chat-change-value")).toHaveCount(2);
  await sceneBothThemes(page, "1-card", "3b");
  const compare = card.getByTestId("chat-card-compare");
  await sceneBothThemes(page, "2-card-compare", "3b", async () => {
    if ((await compare.getAttribute("aria-pressed")) !== "true") await compare.click();
    await expect(card.getByTestId("chat-change-detail")).toHaveCount(2);
  });
  await compare.click();

  // A message: on hovering, copying, editing, "⋯"; in it, what AI got.
  await sceneBothThemes(page, "3-user-menu", "3b", async () => {
    await lastUser().hover();
    await chat(page).getByTestId("chat-user-more").last().click();
    await expect(chat(page).getByRole("menuitem", { name: "看 AI 收到的原文" })).toBeVisible();
  });
  await sceneBothThemes(page, "4-user-sent", "3b", async () => {
    await lastUser().hover();
    await chat(page).getByTestId("chat-user-more").last().click();
    await chat(page).getByRole("menuitem", { name: "看 AI 收到的原文" }).click();
    await expect(chat(page).getByTestId("chat-user-sent")).toBeVisible();
  });
  // Edited: a box in its place; sending takes back what the turn changed first, or keeps it.
  const editor = chat(page).getByTestId("chat-user-editor");
  const edit = async () => {
    if (await editor.isVisible()) return;
    await lastUser().hover();
    await chat(page).getByTestId("chat-user-edit").click();
    await expect(editor).toBeVisible();
  };
  await sceneBothThemes(page, "5-editing", "3b", edit);
  await sceneBothThemes(page, "6-editing-ways", "3b", async () => {
    await edit();
    const ways = editor.getByTestId("chat-user-resend-ways");
    if ((await ways.getAttribute("aria-expanded")) !== "true") await ways.click();
    await expect(editor.locator('[data-mode="keep"]')).toBeVisible();
  });
  if (await editor.isVisible()) await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await edit();
  await expect(editor.getByTestId("chat-user-resend").first()).toHaveText("撤销 2 处再重发");
  await editor.getByTestId("chat-user-editor-input").fill("片头标记往后挪一秒");
  next = { answer: "片头标记往后挪了一秒。" };
  await editor.getByTestId("chat-user-resend-ways").click();
  await editor.locator('[data-testid="chat-user-resend"][data-mode="keep"]').click();
  await expect(chat(page).getByText("片头标记往后挪了一秒。")).toBeVisible({ timeout: 15_000 });
  // The turn before folds into one line, which says its changes are still there.
  const folded = chat(page).getByTestId("chat-rewritten");
  await expect(folded).toContainText("已改写重发 · 原来的一轮 · 改动还在（2 处）");
  await expect(folded).toContainText("片头标记往后挪一点");
  await sceneBothThemes(page, "7-rewritten", "3b");

  // A message with a picture, edited: the picture under the words, to take away; what is left goes.
  await fresh();
  next = { answer: "看到了。" };
  await box(page).fill("看看这张图");
  await box(page).evaluate((element) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "参考.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-state", "ready");
  await box(page).press("Enter");
  await expect(chat(page).getByText("看到了。")).toBeVisible({ timeout: 15_000 });
  await expect(lastUser().getByTestId("chat-sent-picture")).toHaveCount(1);
  await sceneBothThemes(page, "12-editing-picture", "3b", async () => {
    await edit();
    await expect(editor.getByTestId("chat-picture")).toHaveCount(1);
  });
  await edit();
  await editor.getByTestId("chat-user-editor-input").fill("看看这张图的颜色");
  await editor.getByTestId("chat-picture-remove").click();
  // Another message goes from the box of the chat meanwhile: the edited one stays as it was.
  next = { answer: "好的，记下了。" };
  await say("顺便说一句");
  await expect(chat(page).getByText("好的，记下了。")).toBeVisible({ timeout: 15_000 });
  await expect(editor.getByTestId("chat-user-editor-input")).toHaveText("看看这张图的颜色");
  await expect(editor.getByTestId("chat-picture")).toHaveCount(0);
  next = { answer: "颜色偏暖。" };
  await editor.getByTestId("chat-user-resend").click();
  await expect(chat(page).getByText("颜色偏暖。")).toBeVisible({ timeout: 15_000 });
  await expect(lastUser()).toHaveText("看看这张图的颜色");
  await expect(lastUser().getByTestId("chat-sent-picture")).toHaveCount(0);

  // Failures, each kind its own sentence and way out.
  for (const [fail, name] of [
    ["network", "8-failure-network"],
    ["key", "9-failure-key"],
    ["notFound", "10-failure-model"],
  ] as const) {
    await fresh();
    next = { fail };
    await say("给片头加一个淡入");
    await expect(chat(page).getByTestId("chat-failure")).toHaveAttribute("data-kind", fail, {
      timeout: 15_000,
    });
    await sceneBothThemes(page, name, "3b");
  }
  // "换个模型" opens the bubble of the model, not the settings.
  await chat(page).getByTestId("chat-failure-model").click();
  await expect(chat(page).getByTestId("chat-model-bubble")).toBeVisible();
  await page.keyboard.press("Escape");

  // It changed something, then failed: trying again asks, in place, whether that goes back first.
  await fresh();
  next = {
    calls: [
      {
        name: "aq_edit",
        input: {
          summary: "加一个标记",
          operations: [{ op: "marker.add", timeline: "main", id: "m3", time: "3", name: "中段" }],
        },
      },
    ],
    fail: "network",
    failAfter: true,
  };
  await say("加个中段标记再看看");
  const failure = chat(page).getByTestId("chat-failure");
  await expect(failure).toHaveAttribute("data-kind", "network", { timeout: 15_000 });
  await failure.getByTestId("chat-failure-retry").click();
  const asking = failure.getByTestId("chat-retry-confirm");
  await expect(asking.getByRole("button").first()).toHaveText("撤销 1 处再重试");
  await expect(asking.getByRole("button").first()).toBeFocused();
  await expect(asking.getByRole("button").nth(1)).toHaveText("保留改动重试");
  await sceneBothThemes(page, "11-failure-retry", "3b");
  // "算了": the buttons as they were, the focus back on "重试".
  await asking.getByRole("button", { name: "算了" }).click();
  await expect(failure.getByTestId("chat-failure-retry")).toBeFocused();

  // What holds a message back is said in the box, and nothing of the turn is taken back.
  await openSettingsPage(page, "AI 模型");
  await settingsOf(page)
    .getByTestId("ai-service")
    .locator('[data-testid="ai-model"][data-model="claude-test"]')
    .getByRole("switch")
    .uncheck();
  await closeSettings(page);
  await showTab(page, "chat");
  await edit();
  await editor.getByTestId("chat-user-resend").first().click();
  await expect(editor.getByTestId("chat-user-editor-held")).toHaveText("这个对话的模型停用了");
  await expect(chat(page).getByTestId("chat-card").last()).toContainText("改了 1 处");
  await sceneBothThemes(page, "13-editing-held", "3b", edit);
  // The browser says what it could not reach.
  problems.splice(
    0,
    problems.length,
    ...problems.filter(
      (line) => !/Failed to load resource|net::ERR_FAILED|Failed to fetch/u.test(line),
    ),
  );
});

test("what waits for people: a change to allow, words instead, a question, a plan", async ({
  page,
}) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  /** The answers of the model, in order: calls of tools, or words. */
  const answers: (readonly { name: string; input: Record<string, unknown> }[] | string)[] = [];
  let round = 0;
  await page.route(ANTHROPIC, (route) => {
    const fulfil = (body: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body,
      });
    if (isConnectionTest(route)) return fulfil(anthropicSays("OK"));
    const next = answers.shift() ?? "好的。";
    round += 1;
    return fulfil(
      typeof next === "string"
        ? anthropicSays(next)
        : anthropicCalls(next).replaceAll("toolu_", `toolu_${round}_`),
    );
  });
  await addAnthropic(page, KEY, "claude-test");
  await goToSettingsGroup(page, "AI 聊天");
  await settingsOf(page).getByRole("switch", { name: "AI 改项目前先问我" }).check();
  await closeSettings(page);
  await showTab(page, "chat");
  const say = async (text: string) => {
    await box(page).fill(text);
    await box(page).press("Enter");
  };
  const wait = chat(page).getByTestId("chat-wait");

  // A change to allow: the card under the turn, the line of the work says it waits.
  answers.push(
    [
      {
        name: "aq_edit",
        input: {
          summary: "加片头和片尾两个标记",
          operations: [
            { op: "marker.add", timeline: "main", id: "m1", time: "1", name: "片头" },
            { op: "marker.add", timeline: "main", id: "m2", time: "8", name: "片尾" },
          ],
        },
      },
    ],
    "好，片头标记放到 3 秒。",
  );
  await say("加两个标记");
  await expect(wait).toHaveAttribute("data-kind", "approve", { timeout: 15_000 });
  await sceneBothThemes(page, "1-approve", "4");
  // Words written meanwhile, a picture with them: they do not allow it and go to AI with that.
  await box(page).fill("片头的放到 3 秒，片尾的不要");
  await box(page).evaluate((element) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "参考.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(chat(page).getByTestId("chat-picture")).toHaveAttribute("data-state", "ready");
  await expect(chat(page).getByTestId("chat-approve-typing")).toBeVisible();
  await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "decline");
  await sceneBothThemes(page, "2-approve-typing", "4");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-declined-said")).toBeVisible({ timeout: 15_000 });
  await expect(chat(page).getByText("好，片头标记放到 3 秒。")).toBeVisible();
  // Only the words went: the picture stays, and the box says so.
  await expect(chat(page).getByTestId("chat-pictures-kept")).toHaveText("图片留着，没带上");
  await expect(chat(page).getByTestId("chat-picture")).toHaveCount(1);
  await sceneBothThemes(page, "3-declined", "4");
  await chat(page).getByTestId("chat-picture-remove").click();

  // A question of AI: its answers in a row; the box says people can answer there too.
  answers.push([
    {
      name: "aq_propose",
      input: {
        kind: "question",
        question: "片头要保留原来的配乐吗？",
        options: [
          { label: "保留", detail: "音量压低到 −12 dB" },
          { label: "换成新的" },
          { label: "去掉" },
        ],
      },
    },
  ]);
  await say("配乐怎么处理？");
  await expect(wait).toHaveAttribute("data-kind", "question", { timeout: 15_000 });
  await expect(box(page)).toHaveAttribute("data-placeholder", "或者直接回答…");
  await sceneBothThemes(page, "4-question", "4");

  // A plan asked for first: steps to change, "按这个做" on its own at the foot.
  await chat(page).getByTestId("chat-plus").click();
  await chat(page).getByTestId("chat-plus-plan").click();
  answers.push([
    {
      name: "aq_propose",
      input: {
        kind: "plan",
        title: "30 秒开场",
        steps: [
          { text: "黑场淡入，片名出现", from: "0", to: "3" },
          { text: "三个镜头快切，配鼓点", from: "3", to: "12" },
          { text: "主镜头慢推，字幕逐行", from: "12", to: "30" },
        ],
        length: "30",
        style: "快节奏",
      },
    },
  ]);
  await say("做一个 30 秒的开场");
  await expect(wait).toHaveAttribute("data-kind", "plan", { timeout: 15_000 });
  await sceneBothThemes(page, "5-plan", "4", async () => {
    await chat(page).getByTestId("chat-plan-step").nth(1).hover();
  });
  // Done with it: one line.
  answers.push("开场做好了。");
  await chat(page).getByTestId("chat-plan-accept").click();
  await expect(chat(page).getByText("开场做好了。")).toBeVisible({ timeout: 15_000 });
  await expect(
    chat(page).locator('[data-testid="chat-plan"][data-state="accepted"]'),
  ).toContainText("方案：30 秒开场 · 已按这个做");
  await sceneBothThemes(page, "6-plan-done", "4");
});

test("the head: the switcher, the page of all conversations, ⋯, an empty one, before any service", async ({
  page,
}) => {
  test.setTimeout(480_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await showTab(page, "chat");
  // Before any service: where the key goes, the services to start with.
  await expect(chat(page).getByTestId("chat-onboarding")).toBeVisible();
  await sceneBothThemes(page, "1-onboarding", "5");

  const waiting: Route[] = [];
  await page.route(ANTHROPIC, (route) => {
    const fulfil = (text: string) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        body: anthropicSays(text),
      });
    if (isConnectionTest(route)) return fulfil("OK");
    if (JSON.stringify(route.request().postDataJSON()).includes("慢慢来"))
      return void waiting.push(route);
    return fulfil("好的。");
  });
  await addAnthropic(page, KEY, "claude-test");
  await closeSettings(page);
  await showTab(page, "chat");
  // An empty conversation: things to say, by how the project is, next to the box.
  await expect(chat(page).getByTestId("chat-suggestion").first()).toBeVisible();
  await sceneBothThemes(page, "2-empty", "5");

  const say = async (text: string) => {
    await box(page).fill(text);
    await box(page).press("Enter");
    await expect(chat(page).getByText("好的。").last()).toBeVisible({ timeout: 15_000 });
  };
  await say("把片头的字幕往上挪一点");
  await chat(page).getByTestId("chat-new").click();
  await say("开场放慢一点，配乐也跟着慢下来");
  await chat(page).getByTestId("chat-new").click();
  await say("看看项目里有什么问题");
  await sceneBothThemes(page, "3-head", "5");
  const title = chat(page).getByTestId("chat-title");
  await sceneBothThemes(page, "4-switcher", "5", async () => {
    await title.click();
    await expect(chat(page).getByTestId("chat-switcher-row")).toHaveCount(3);
  });
  await sceneBothThemes(page, "5-switcher-search", "5", async () => {
    await title.click();
    await chat(page).getByTestId("chat-switcher-search").fill("字幕");
    await expect(chat(page).getByTestId("chat-search-hit").first()).toBeVisible();
  });
  await sceneBothThemes(page, "6-more", "5", async () => {
    await chat(page).getByTestId("chat-more").click();
    await expect(chat(page).getByTestId("chat-more-remove")).toBeVisible();
  });
  // All of them: a page of its own, each with how much AI changed and the model it had.
  await title.click();
  await chat(page).getByTestId("chat-switcher-all").click();
  await expect(chat(page).getByTestId("chat-all")).toBeVisible();
  await expect(chat(page).getByTestId("chat-conversation").first()).toContainText("claude-test");
  await sceneBothThemes(page, "7-all", "5");
  await chat(page).getByTestId("chat-all-back").click();

  // While a task runs: the others wait for it, which the switcher says.
  await box(page).fill("慢慢来");
  await box(page).press("Enter");
  await expect(chat(page).getByTestId("chat-send")).toHaveAttribute("data-state", "stop");
  await expect(chat(page).getByTestId("chat-new")).toBeDisabled();
  await sceneBothThemes(page, "8-switcher-running", "5", async () => {
    await title.click();
    await expect(chat(page).getByTestId("chat-switcher")).toContainText("这一轮做完后可以切换");
  });
  for (const route of waiting) await route.abort().catch(() => {});
});
