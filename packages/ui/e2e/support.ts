import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Frame,
  type Page,
} from "@playwright/test";

export { expect };

export const tab = (page: Page, type: string) => page.locator(`[data-tab="${type}"]`);
export const content = (page: Page, type: string) => page.locator(`[data-panel="${type}"]`);
/**
 * What a tab of resources lists, each once: those used lately show again in a group of their own
 * first, which this leaves out.
 */
export const resourcesIn = (page: Page, type: string) =>
  content(page, type).locator('[role="group"]:not([data-group="recent"]) [role="option"]');
/**
 * Whether a tab scrolls as a whole, up to the view of its group, which only happens when something in
 * it does not fit: its lists scroll on their own.
 */
export const tabScrolls = (page: Page, type: string) =>
  content(page, type).evaluate((element) => {
    for (let at: HTMLElement | null = element as HTMLElement; at; at = at.parentElement) {
      if (at.scrollHeight > at.clientHeight + 1 || at.scrollWidth > at.clientWidth + 1) return true;
      if (at.classList.contains("dv-view")) return false;
    }
    return false;
  });
/** The layout menu, which is named after the layout on screen. */
export const layoutMenu = (page: Page, name: string) =>
  page.getByRole("button", { name: `布局：${name}`, exact: true });

/**
 * The keyframes and the timeline side by side, each alone in a group with its tabs across the
 * top, for what needs both on screen. The layouts that come with the editor have them in one group.
 */
export async function animateBesideTimeline(page: Page) {
  await tab(page, "timeline").click({ button: "right" });
  await page.getByRole("menuitemradio", { name: "选项卡在上方" }).click();
  const from = await tab(page, "keyframes").boundingBox();
  const target = await group(page, "timeline").boundingBox();
  if (!from || !target) throw new Error("no keyframes");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8, { steps: 3 });
  await page.mouse.move(target.x + target.width - 12, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(content(page, "keyframes")).toBeVisible();
  // The timeline alone in its group, so that closing it gives the keyframes all the room.
  await tab(page, "problems").click({ button: "middle" });
  await expect(content(page, "timeline")).toBeVisible();
  const timeline = await group(page, "timeline").boundingBox();
  const keyframes = await group(page, "keyframes").boundingBox();
  expect(timeline && keyframes && timeline.x < keyframes.x).toBe(true);
}

/** Switches layouts from the title bar. */
export async function chooseLayout(page: Page, name: string) {
  await page.getByRole("button", { name: /^布局：/ }).click();
  await page.getByRole("menu").getByRole("menuitemradio", { name, exact: true }).click();
  await expect(layoutMenu(page, name)).toBeVisible();
}

export const group = (page: Page, type: string) =>
  page.locator(".dv-groupview").filter({ has: tab(page, type) });

const previews = new WeakMap<Page, Frame>();

/**
 * The compositor of the preview, once it has loaded. Thumbnails and sounds have compositors of
 * their own, at the same address, so the address does not say which one it is: the element does.
 * There is none for a moment while a project opens, after a reload, or when a new one takes over.
 */
export async function findCompositor(page: Page): Promise<Frame | undefined> {
  // Tests read the picture over and over while it moves, so finding it again has to cost nothing.
  // A frame stays the same while its element does, and goes away with it.
  let frame = previews.get(page);
  if (!frame || frame.isDetached()) {
    frame = await previewFrame(page);
    if (frame) previews.set(page, frame);
  }
  // Until it has loaded it is an empty page, where nothing a test reads is.
  return frame?.url().includes("compositor") ? frame : undefined;
}

async function previewFrame(page: Page): Promise<Frame | undefined> {
  const element = await page.$('iframe[data-compositor="preview"]');
  if (!element) return undefined;
  const frame = await element.contentFrame().catch(() => null);
  await element.dispose().catch(() => {});
  return frame ?? undefined;
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

/**
 * Waits until the editor is on the page. `page.goto` and `page.reload` are over at the load event,
 * and the editor comes after that: it starts once what the browser keeps is read, see
 * `mountEditor`. Until it shows, nothing of it listens, so what a test drops in goes nowhere, and
 * the hooks of the development page are not there yet. On a busy machine that takes a while.
 */
export const editorReady = (page: Page) =>
  // Or the entry page, which is what a site with a backend shows before anybody signed in.
  expect(page.locator("header").first().or(page.getByTestId("entry"))).toBeVisible({ timeout: 0 });

/**
 * Chooses `item` from the menu `menu` of the title bar, also in a narrow window, where the menus are
 * in one button, "菜单".
 */
export async function chooseFromMenu(page: Page, menu: string, item: string) {
  const header = page.locator("header");
  const folded = header.getByRole("button", { name: "菜单", exact: true });
  if (await folded.isVisible()) {
    await folded.click();
    await page.getByRole("menu", { name: "菜单" }).getByRole("menuitem", { name: menu }).click();
    await page
      .getByRole("menu", { name: menu })
      .getByRole("menuitem", { name: item, exact: true })
      .click();
    return;
  }
  await header.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

/** Creates a project the way people do. */
export async function createProject(page: Page, name = "测试项目") {
  // Where there are projects already, the new card has the same name as the button above it.
  await page.getByRole("button", { name: "新建项目" }).first().click();
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(tab(page, "preview")).toBeVisible();
}

/** The requests to the outside that reached the network, by context. */
const outside = new WeakMap<BrowserContext, string[]>();
const MODELS_DEV = readFileSync(new URL("fixtures/models-dev.json", import.meta.url), "utf8");

/**
 * Answers models.dev with the copy in `fixtures/models-dev.json`, and notes every other request to
 * a host that is not this computer, the site under test, or one of `allowed`, to fail the test.
 * A route of a page comes before these, so a test that answers a request itself is not counted.
 */
async function watchOutside(
  context: BrowserContext,
  baseURL: string | undefined,
  allowed: readonly string[],
) {
  const seen: string[] = [];
  outside.set(context, seen);
  const own = baseURL ? new URL(baseURL).hostname : "";
  await context.route(
    (url) => {
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      const host = url.hostname;
      return !(
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === own ||
        allowed.includes(host)
      );
    },
    async (route) => {
      const url = route.request().url();
      if (url === "https://models.dev/api.json") {
        await route.fulfill({
          status: 200,
          headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
          body: MODELS_DEV,
        });
        return;
      }
      seen.push(`${route.request().method()} ${url}`);
      await route.continue();
    },
  );
}

/**
 * Opens the editor for every test, with a project unless the test says otherwise, and fails the
 * test when anything was logged as an error.
 */
export const test = base.extend<{
  problems: string[];
  withProject: boolean;
  offlineFirst: boolean;
  onDisk: boolean;
  trying: boolean;
  quality: "auto" | "full";
  devPage: boolean;
  folders: boolean;
  allowExternal: string[];
}>({
  /**
   * The hosts outside this computer that a test may reach for real. Any other request to the
   * outside fails the test, listed by address: a test must not depend on the internet, whose
   * answers change (models.dev did, in the evening of 2026-11-25). Answer it with `page.route`
   * (that one is not counted), or name the host here with `test.use`.
   */
  allowExternal: [[], { option: true }],
  withProject: [true, { option: true }],
  /**
   * Whether the offline mode is chosen on the entry page also without a project: `scripts/e2e-prod`
   * turns it on for the tests of this folder, which are all of the offline mode.
   */
  offlineFirst: [false, { option: true }],
  /**
   * Whether projects are folders on the disk, as in Chrome and Edge. Off for everything that is not
   * about that: then projects stay in the browser, as in Firefox, because a test cannot answer the
   * browser's dialog for a folder. See `PROJECTS_HERE_KEY` in the host.
   */
  folders: [false, { option: true }],
  /**
   * Whether this is the development page, which has things for tests that the site does not:
   * `window.aqExecute`, `window.aqAudio`, `?soundLimit=` and `?sceneStage=plain`, see
   * `dev/main.tsx`, and the version `dev`. `scripts/e2e-prod` turns this off, and what needs them
   * skips itself, see `needsDevPage`.
   */
  devPage: [true, { option: true }],
  /** Off for what is about controls and the project, where every change is written right away. */
  trying: [true, { option: true }],
  /**
   * Full by default: the automatic quality follows how fast the machine is, and a test that reads
   * pixels must not depend on that. Only a first value: what a test chooses stays through a reload.
   */
  quality: ["full", { option: true }],
  /**
   * Keeps what the browser saves on the disk, as for people. Normally a test runs in something like
   * a private window, with IndexedDB in memory and little room in it.
   */
  onDisk: [false, { option: true }],
  context: async ({ context, onDisk, baseURL, viewport, allowExternal }, use) => {
    if (!onDisk) {
      await watchOutside(context, baseURL, allowExternal);
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
    await watchOutside(persistent, baseURL, allowExternal);
    await use(persistent);
    await persistent.close();
    rmSync(folder, { recursive: true, force: true });
  },
  problems: [
    async ({ page, withProject, offlineFirst, trying, quality, folders }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        // Looking for the relay of AI tools on this computer finds closed ports, which the browser
        // says in the console whatever the page does (local-ai/bridge/bridge.ts).
        if (/^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/page\?/.test(text)) return;
        const { url } = message.location();
        if (/^http:\/\/127\.0\.0\.1:\d+\/ping$/.test(url)) return;
        // Which resource, where the browser only says that one failed.
        problems.push(text.startsWith("Failed to load resource") && url ? `${text} ${url}` : text);
      });
      // The console does not show every violation. This only finds something where the site sends
      // a Content-Security-Policy, which the development server does not: run these tests against
      // the deployed site to check it.
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (event) => {
          console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      if (!folders) {
        await page.addInitScript(() => {
          if (window !== window.top) return;
          // A scene opened directly has no origin and no storage: its sandbox works.
          try {
            localStorage.setItem("animaquill.projectsInBrowser", "yes");
            // People heard once that projects of the offline mode stay in this browser.
            localStorage.setItem("aq-offline-animaquill.offline.browserProjects", "1");
          } catch {}
          // The browser has agreed to keep the projects (the notice that it did not is no part of
          // the other tests; there is none to see in a test browser that has not been asked).
          try {
            navigator.storage.persisted = async () => true;
            navigator.storage.persist = async () => true;
          } catch {}
        });
      }
      if (!trying) {
        // This runs in every frame, and the sandbox of the compositor has no storage.
        await page.addInitScript(() => {
          if (window !== window.top) return;
          try {
            localStorage.setItem("aq-offline-animaquill.trial", '{"version":1,"enabled":false}');
          } catch {}
        });
      }
      if (quality !== "auto") {
        await page.addInitScript((choice) => {
          if (window !== window.top) return;
          const key = "aq-offline-animaquill.previewQuality";
          try {
            if (localStorage.getItem(key) === null) {
              localStorage.setItem(key, JSON.stringify({ version: 1, choice }));
            }
          } catch {
            // A page in a sandbox of its own, like a scene opened directly, has no storage at all.
          }
        }, quality);
      }
      await page.goto("/");
      await editorReady(page);
      // On a site with a backend (scripts/e2e-edge, scripts/e2e-prod) the page asks first. A test
      // with a project is of the offline mode, where nobody is signed in; so is every test of this
      // folder against the site (`offlineFirst`, 2026-11-23: there they all stopped at the entry
      // page), while those of the site itself sign in from it.
      const offline = page.getByTestId("entry").getByRole("button", {
        name: "不登录，使用离线模式",
      });
      if ((withProject || offlineFirst) && (await offline.isVisible())) {
        await offline.click();
        await expect(page.locator("header").first()).toBeVisible({ timeout: 0 });
      }
      if (withProject) await createProject(page);
      await use(problems);
      expect(problems).toEqual([]);
      expect(outside.get(page.context()) ?? [], "requests to the internet").toEqual([]);
    },
    { auto: true },
  ],
});

/** Why a test does not run against the site: `test.skip(!devPage, needsDevPage("…"))`. */
export const needsDevPage = (what: string) => `only the development page has ${what}`;

/** Skips the tests around it against the site, for what only the development page has. */
export function devPageOnly(what: string, when = true): void {
  test.skip(({ devPage }) => when && !devPage, needsDevPage(what));
}

/**
 * Waits until what the open project changed is in this browser. A project only in this browser says
 * nothing of being saved while it is (only the failing is told), so it is the log that is looked at:
 * its length stays the same for a moment.
 */
export async function waitSaved(page: Page) {
  let last = -1;
  await expect
    .poll(
      async () => {
        const count = await page.evaluate(async () => {
          const names = (await indexedDB.databases()).map((one) => one.name ?? "");
          const name = names.find((one) => /^aq-(offline|online-.*)-animaquill$/.test(one));
          if (name === undefined) return 0;
          return new Promise<number>((resolve) => {
            const open = indexedDB.open(name);
            open.addEventListener("error", () => resolve(0));
            open.addEventListener("success", () => {
              const database = open.result;
              if (!database.objectStoreNames.contains("updates")) {
                database.close();
                resolve(0);
                return;
              }
              const request = database.transaction("updates").objectStore("updates").count();
              request.addEventListener("success", () => {
                database.close();
                resolve(request.result);
              });
              request.addEventListener("error", () => {
                database.close();
                resolve(0);
              });
            });
          });
        });
        const same = count === last;
        last = count;
        return same;
      },
      { intervals: [400], timeout: 10_000 },
    )
    .toBe(true);
}
