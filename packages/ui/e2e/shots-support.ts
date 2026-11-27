import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { content, expect } from "./support.ts";

/**
 * Pictures of the chat for people to look at, in each step of its new design (docs/design/
 * chat-panel.md of AnimaQuill Cloud, 11): each scene about 320, 420 and 560 wide, made so by the
 * edge of the chat as people drag it. Nothing of the chat may stick out of it at any width, which
 * this checks; the pictures go to `test-results/chat-shots/<step>/`.
 */

const chat = (page: Page) => content(page, "chat");

const WIDTHS = [320, 420, 560] as const;
/** Where the pictures of a step go. */
export const dirOf = (step: string) => `test-results/chat-shots/${step}`;

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
export async function scene(
  page: Page,
  theme: string,
  name: string,
  open?: () => Promise<void>,
  step = "1",
) {
  mkdirSync(dirOf(step), { recursive: true });
  const panel = chat(page).getByTestId("chat");
  for (const width of WIDTHS) {
    await widen(page, width);
    await open?.();
    expect(await overflowing(panel), `${name} at ${width}`).toEqual([]);
    await panel.screenshot({ path: `${dirOf(step)}/${theme}-${width}-${name}.png` });
    if (open) await page.keyboard.press("Escape");
  }
}

/** A scene in light colours, then in dark, as the system says. */
export async function sceneBothThemes(
  page: Page,
  name: string,
  step: string,
  open?: () => Promise<void>,
) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await scene(page, theme, name, open, step);
  }
}
