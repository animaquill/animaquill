import { mkdirSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  addModel,
  anthropicCalls,
  anthropicSays,
  closeSettings,
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
