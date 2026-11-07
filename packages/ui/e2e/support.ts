import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test as base, type Frame, type Page } from "@playwright/test";

export { expect };

export const tab = (page: Page, type: string) => page.locator(`[data-tab="${type}"]`);
export const content = (page: Page, type: string) => page.locator(`[data-panel="${type}"]`);
export const group = (page: Page, type: string) =>
  page.locator(".dv-groupview").filter({ has: tab(page, type) });

/**
 * The compositor of the preview, once it has loaded. Thumbnails and sounds have compositors of
 * their own, at the same address, so the address does not say which one it is: the element does.
 * There is none for a moment while a project opens, after a reload, or when a new one takes over.
 */
export async function findCompositor(page: Page): Promise<Frame | undefined> {
  const element = await page.$('iframe[data-compositor="preview"]');
  if (!element) return undefined;
  const frame = await element.contentFrame().catch(() => null);
  await element.dispose().catch(() => {});
  // Until it has loaded it is an empty page, where nothing a test reads is.
  return frame?.url().includes("compositor") ? frame : undefined;
}

/** Waits for the compositor of the preview, which takes a moment, as said above. */
export async function compositor(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(async () => (found = await findCompositor(page)) !== undefined, {
      message: "No compositor",
    })
    .toBe(true);
  return found as Frame;
}

/** Creates a project the way people do. */
export async function createProject(page: Page, name = "测试项目") {
  await page.getByRole("button", { name: "新建项目" }).click();
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(tab(page, "preview")).toBeVisible();
}

/**
 * Opens the editor for every test, with a project unless the test says otherwise, and fails the
 * test when anything was logged as an error.
 */
export const test = base.extend<{
  problems: string[];
  withProject: boolean;
  onDisk: boolean;
  trying: boolean;
}>({
  withProject: [true, { option: true }],
  /** Off for what is about controls and the project, where every change is written right away. */
  trying: [true, { option: true }],
  /**
   * Keeps what the browser saves on the disk, as for people. Normally a test runs in something like
   * a private window, with IndexedDB in memory and little room in it.
   */
  onDisk: [false, { option: true }],
  context: async ({ context, onDisk, baseURL, viewport }, use) => {
    if (!onDisk) {
      await use(context);
      return;
    }
    const folder = mkdtempSync(join(tmpdir(), "animaquill-profile-"));
    const persistent = await chromium.launchPersistentContext(folder, {
      channel: "chromium",
      acceptDownloads: true,
      ...(baseURL ? { baseURL } : {}),
      viewport,
    });
    await use(persistent);
    await persistent.close();
    rmSync(folder, { recursive: true, force: true });
  },
  problems: [
    async ({ page, withProject, trying }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") problems.push(message.text());
      });
      // The console does not show every violation. This only finds something where the site sends
      // a Content-Security-Policy, which the development server does not: run these tests against
      // the deployed site to check it.
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      if (!trying) {
        // This runs in every frame, and the sandbox of the compositor has no storage.
        await page.addInitScript(() => {
          if (window !== window.top) return;
          localStorage.setItem("animaquill.trial", '{"version":1,"enabled":false}');
        });
      }
      await page.goto("/");
      if (withProject) await createProject(page);
      await use(problems);
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});
