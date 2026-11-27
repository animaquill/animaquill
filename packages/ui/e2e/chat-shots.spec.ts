import { mkdirSync } from "node:fs";
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
import { content, expect, test, showTab } from "./support.ts";

/**
 * The chat as people see it, in each step of its new design (docs/design/chat-panel.md of
 * AnimaQuill Cloud, 11): each scene in light and dark colours, about 320, 420 and 560 wide. Nothing
 * of the chat may stick out of it at any of them, which is what this checks; the pictures it takes
 * go to `test-results/chat-shots/<step>/`, for people to look at.
 */

const WIDTHS = [320, 420, 560] as const;
const STEP = "1";
const DIR = `test-results/chat-shots/${STEP}`;
const KEY = "sk-ant-test-0123456789abcdef";

const chat = (page: Page) => content(page, "chat");
const box = (page: Page) => chat(page).getByRole("textbox", { name: /给 AI 发消息/ });

/** What of an area sticks out of it, or whose words stick out of their box without "…". */
const overflowing = (area: Locator) =>
  area.evaluate((element) => {
    const edge = element.getBoundingClientRect().right + 1;
    return [...element.querySelectorAll<HTMLElement>("*")]
      .filter((each) => {
        const style = getComputedStyle(each);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.position === "absolute" && style.clipPath !== "none") return false;
        const place = each.getBoundingClientRect();
        if (place.width === 0) return false;
        // Out of the chat, or its own words out of their box where they do not end in "…".
        if (place.right > edge) return true;
        if (style.overflowX === "auto" || style.overflowX === "scroll") return false;
        if (style.textOverflow === "ellipsis" || style.overflowX === "hidden") return false;
        const words = [...each.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        return words && each.scrollWidth > each.clientWidth + 1 && each.clientWidth > 0;
      })
      .map((each) => `${each.tagName}.${each.className} ${each.textContent?.slice(0, 30)}`);
  });

/** Makes the chat a width, by the edge between it and what is left of it, as people drag it. */
async function widen(page: Page, width: number) {
  const panel = chat(page).getByTestId("chat");
  for (let tries = 0; tries < 3; tries += 1) {
    const edge = await panel.boundingBox();
    if (!edge || Math.abs(edge.width - width) <= 2) return;
    const y = edge.y + edge.height / 2;
    await page.mouse.move(edge.x - 1, y);
    await page.mouse.down();
    await page.mouse.move(edge.x - 1 - (width - edge.width), y, { steps: 5 });
    await page.mouse.up();
  }
  await expect
    .poll(async () => Math.abs(((await panel.boundingBox())?.width ?? 0) - width))
    .toBeLessThanOrEqual(2);
}

/**
 * One scene at each width: nothing sticks out, and a picture of the chat. What only shows until a
 * click elsewhere, such as a menu, is opened by `open` once the chat has its width.
 */
async function scene(page: Page, theme: string, name: string, open?: () => Promise<void>) {
  const panel = chat(page).getByTestId("chat");
  for (const width of WIDTHS) {
    await widen(page, width);
    await open?.();
    expect(await overflowing(panel), `${name} at ${width}`).toEqual([]);
    await panel.screenshot({ path: `${DIR}/${theme}-${width}-${name}.png` });
    if (open) await page.keyboard.press("Escape");
  }
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`in ${theme} colours`, () => {
    test.use({ colorScheme: theme });

    test("the input card: empty, written, with pictures and queued, held", async ({ page }) => {
      test.setTimeout(180_000);
      mkdirSync(DIR, { recursive: true });
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
      await page.keyboard.press("Escape");
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
  });
}
