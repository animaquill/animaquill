import type { Page, Route } from "@playwright/test";
import {
  ANTHROPIC,
  addAnthropic,
  anthropicCalls,
  anthropicSays,
  closeSettings,
} from "./ai-support.ts";
import { content, expect, tab } from "./support.ts";

/**
 * What the tests of taking back AI tasks share: AI that adds markers, one task for each message;
 * the markers of the project; changes as people make them; and a reload that keeps the undo logs.
 */

const chat = (page: Page) => content(page, "chat");

export interface Marker {
  readonly name: string;
}

export const markers = (page: Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as { aqState: () => { timelines: Record<string, unknown> } }
    ).aqState();
    const main = state.timelines["main"] as { markers?: Record<string, Marker> };
    return Object.fromEntries(
      Object.entries(main.markers ?? {}).map(([id, { name }]) => [id, name]),
    );
  });

export const execute = (page: Page, call: object, options?: object) =>
  page.evaluate(
    ([given, how]) => {
      const run = (
        window as unknown as { aqExecute: (call: unknown, options?: unknown) => { ok: boolean } }
      ).aqExecute;
      return run(given, how).ok;
    },
    [call, options] as const,
  );

/** Keeps what changed and its undo logs, as a page that goes away a moment later does. */
export const reload = async (page: Page) => {
  await page.evaluate(async () => {
    const hooks = window as unknown as {
      aqSave: () => Promise<unknown>;
      aqUndoSaved: () => Promise<unknown>;
    };
    await hooks.aqSave();
    await hooks.aqUndoSaved();
  });
  await page.reload();
  await tab(page, "chat").click();
};

/** AI answers each message with one task that adds these markers, then says it is done. */
export async function aiAdds(page: Page, tasks: readonly (readonly [string, string])[][]) {
  let round = 0;
  await page.route(ANTHROPIC, (route: Route) => {
    const task = tasks[Math.floor(round / 2)] ?? [];
    const body =
      round % 2 === 0
        ? anthropicCalls([
            {
              name: "aq_edit",
              input: {
                summary: "加标记",
                operations: task.map(([id, name], index) => ({
                  op: "marker.add",
                  timeline: "main",
                  id,
                  time: String(index + 1),
                  name,
                })),
              },
            },
          ])
        : anthropicSays("加好了。");
    round += 1;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body,
    });
  });
  await addAnthropic(page, "sk-ant-test-0123456789abcdef", "claude-test");
  await closeSettings(page);
  await tab(page, "chat").click();
}

export async function send(page: Page, text: string) {
  const done = await chat(page).getByText("加好了。").count();
  const box = chat(page).getByRole("textbox", { name: /给 AI 发消息/ });
  await box.fill(text);
  await box.press("Enter");
  await expect(chat(page).getByText("加好了。")).toHaveCount(done + 1, { timeout: 15_000 });
}
