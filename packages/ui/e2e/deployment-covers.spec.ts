import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { cardMenu, openCard, projectCard, showView } from "./start-support.ts";
import { content, editorReady, expect, tab, test } from "./support.ts";
import { entrySignIn } from "./online-support.ts";

/**
 * The covers of projects on the start page, on the real sites through the gateway
 * (docs/design/start-and-cloud.md, 6.3 and 6.4): a project that people changed gets a frame of its
 * main timeline as its cover once they leave it, with how long that is, kept in this browser and on
 * the platform; another browser of the same person shows them from there. 16:9 boxes, portrait and
 * square pictures whole in them. The API with its database, the worker and a fake GitHub, see
 * scripts/e2e-edge. Pictures go to the output of the test, for people to look at.
 */

const GITHUB = "http://127.0.0.1:8400";
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

const someone = (): GitHubUser => {
  const id = randomInt(1_000_000, 2_000_000_000);
  return { id, login: `user-${id}` };
};

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "cover test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

/** This container has no network but the computer's own: the page says it is on one. */
const ON_A_NETWORK = () => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => true,
    configurable: true,
  });
};

/** A browser that cannot open folders: its projects of the platform stay in it. */
const NO_FOLDERS = () => {
  delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
};

const newDialog = (page: Page) => page.locator("dialog[data-create-phase]");
const accountMenu = (page: Page, user: GitHubUser) =>
  page.locator("header").getByRole("button", { name: `账号：${user.login}` });
const signInButton = (page: Page) => entrySignIn(page);

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const api = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const response = await fetch(path);
    return (await response.json()) as any;
  }, path);

/** A browser of the person, signed in to GitHub, not to the platform yet, on the start page. */
async function browserOf(browser: Browser, user: GitHubUser) {
  const context: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 860 },
  });
  await context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);
  const page = await context.newPage();
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await page.addInitScript(ON_A_NETWORK);
  await page.addInitScript(NO_FOLDERS);
  await page.goto("/");
  await editorReady(page);
  return { context, page, problems };
}

/** A new project of the platform, of a shape, opened; then one change, and back to the start page. */
async function makeChangeAndLeave(page: Page, name: string, shape: string) {
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const making = newDialog(page);
  await making.getByRole("textbox", { name: "项目名称" }).fill(name);
  await making.getByRole("combobox", { name: "画幅" }).selectOption(shape);
  await making.getByRole("button", { name: "新建", exact: true }).click();
  await expect(making).toHaveAttribute("data-create-phase", /archiving|done/, {
    timeout: 60_000,
  });
  await making.getByRole("button", { name: /^(关闭|完成)$/ }).click();
  await expect(making).toHaveCount(0);
  await expect(tab(page, "preview")).toBeVisible();
  await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  // From the moment people leave: what comes onto the page, as it comes and while it is there.
  await page.evaluate(() => {
    const seen: { what: string; visible: boolean }[] = [];
    const look = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const visible =
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) > 0 &&
        box.width > 0 &&
        box.height > 0;
      const what = `${element.tagName.toLowerCase()}${
        element instanceof HTMLElement && element.dataset["compositor"]
          ? `[data-compositor=${element.dataset["compositor"]}]`
          : ""
      }`;
      seen.push({ what, visible });
    };
    const watching = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) if (node instanceof Element) look(node);
    });
    watching.observe(document.body, { childList: true });
    // And again while it draws.
    const timer = setInterval(() => {
      for (const element of document.querySelectorAll("body > iframe")) look(element);
    }, 50);
    (window as unknown as { aqCovers: () => typeof seen }).aqCovers = () => {
      watching.disconnect();
      clearInterval(timer);
      return seen;
    };
  });
  await page.getByRole("menu").getByRole("menuitem", { name: "关闭项目", exact: true }).click();
}

/** What came onto the page while people left a project and its cover was made. */
const addedWhileLeaving = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        aqCovers: () => { what: string; visible: boolean }[];
      }
    ).aqCovers(),
  );

/** The picture on the card of a project, once it has loaded. */
const coverOf = (page: Page, name: string) => projectCard(page, name).locator("img").first();

async function hasLoaded(page: Page, name: string) {
  await expect(coverOf(page, name)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => coverOf(page, name).evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
}

/** The colour in the middle of the picture on the card of a project, as red, green and blue. */
const colorOf = (page: Page, name: string) =>
  coverOf(page, name).evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const painter = canvas.getContext("2d")!;
    painter.drawImage(image, 0, 0);
    const [red, green, blue] = painter.getImageData(
      canvas.width >> 1,
      canvas.height >> 1,
      1,
      1,
    ).data;
    return [red!, green!, blue!];
  });
const isRed = async (page: Page, name: string) => {
  const [red, green, blue] = await colorOf(page, name).catch(() => [0, 0, 0]);
  return red! > 200 && green! < 80 && blue! < 80;
};

/** A large red picture, as PNG, made by the browser. */
const redPicture = async (page: Page) =>
  Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1920;
      canvas.height = 1080;
      const painter = canvas.getContext("2d")!;
      painter.fillStyle = "#e01010";
      painter.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }),
    "base64",
  );

/** What the platform's list says of the cover of a project. */
const listedCover = async (page: Page, name: string) =>
  (
    (await api(page, "/api/projects")).projects as {
      name: string;
      cover?: { etag: string; chosen?: true };
    }[]
  ).find((project) => project.name === name)?.cover;

const SHAPES = [
  ["横屏的片子", "landscape", 16 / 9],
  ["竖屏的片子", "portrait", 9 / 16],
  ["方形的片子", "square", 1],
] as const;

test.describe("covers of projects", () => {
  test.use({ withProject: false });

  test("a project people changed gets a cover with its length, here and in another browser", async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    const user = someone();
    expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
      true,
    );
    const { context, page, problems } = await browserOf(browser, user);
    await signInButton(page).click();
    await page.getByLabel("邀请码").fill(newInvite());
    await page.getByRole("button", { name: "继续" }).click();
    await expect(accountMenu(page, user)).toBeVisible();

    for (const [name, shape] of SHAPES) {
      await makeChangeAndLeave(page, name, shape);
      // Made as people left it: the card has it at once, with how long the main timeline is.
      await hasLoaded(page, name);
      // Drawn by a compositor nobody sees, which is gone again: nothing new showed on the page.
      const added = await addedWhileLeaving(page);
      expect(added.some(({ what }) => what === "iframe[data-compositor=cover]")).toBe(true);
      expect(added.filter(({ visible }) => visible)).toEqual([]);
      await expect(page.locator('iframe[data-compositor="cover"]')).toHaveCount(0);
      await expect(projectCard(page, name).getByText(/^\d+:\d{2}$/)).toBeVisible();
    }
    // Each picture whole in its 16:9 box, as its own shape.
    for (const [name, , ratio] of SHAPES) {
      const box = await projectCard(page, name).locator("[data-picture]").first().boundingBox();
      expect(Math.abs(box!.width / box!.height - 16 / 9)).toBeLessThan(0.02);
      const [width, height] = await coverOf(page, name).evaluate((image: HTMLImageElement) => [
        image.naturalWidth,
        image.naturalHeight,
      ]);
      expect(Math.abs(width! / height! - ratio)).toBeLessThan(0.02);
      expect(Math.max(width!, height!)).toBe(480);
    }
    await shot(page, "covers-wall");
    await showView(page, "全部项目");
    await page
      .getByRole("group", { name: "显示方式" })
      .getByRole("button", { name: "列表" })
      .click();
    for (const [name] of SHAPES) await hasLoaded(page, name);
    await shot(page, "covers-list");

    // The platform has each of them, which another computer of the person gets.
    await expect
      .poll(
        async () =>
          (
            (await api(page, "/api/projects")).projects as {
              cover?: unknown;
              durationMs?: number;
            }[]
          ).filter((project) => project.cover !== undefined && project.durationMs !== undefined)
            .length,
        { timeout: 60_000 },
      )
      .toBe(3);
    const other = await browserOf(browser, user);
    try {
      await signInButton(other.page).click();
      await expect(accountMenu(other.page, user)).toBeVisible();
      const fetched: string[] = [];
      other.page.on("request", (asked) => {
        if (/\/api\/projects\/[^/]+\/cover$/.test(asked.url())) fetched.push(asked.url());
      });
      for (const [name] of SHAPES) {
        await hasLoaded(other.page, name);
        await expect(projectCard(other.page, name).getByText(/^\d+:\d{2}$/)).toBeVisible();
      }
      await shot(other.page, "covers-other-browser");
      // Kept by their etags: a new look at the list fetches none again.
      const before = fetched.length;
      await other.page.reload();
      await editorReady(other.page);
      for (const [name] of SHAPES) await hasLoaded(other.page, name);
      expect(fetched.length).toBe(before);

      // People choose a picture of their own for one: here at once, and on the platform as theirs.
      const NAME = "横屏的片子";
      const choosing = page.waitForEvent("filechooser");
      await cardMenu(page, NAME, "设置封面…");
      await (
        await choosing
      ).setFiles({
        name: "封面.png",
        mimeType: "image/png",
        buffer: await redPicture(page),
      });
      await expect.poll(() => isRed(page, NAME), { timeout: 15_000 }).toBe(true);
      await expect
        .poll(async () => (await listedCover(page, NAME))?.chosen, {
          timeout: 30_000,
        })
        .toBe(true);
      const chosen = (await listedCover(page, NAME))!.etag;
      // The other browser has it.
      await other.page.reload();
      await editorReady(other.page);
      await expect.poll(() => isRed(other.page, NAME), { timeout: 30_000 }).toBe(true);
      await shot(other.page, "covers-chosen-other-browser");

      // Editing the project afterwards does not put a frame in its place.
      await openCard(page, NAME);
      await expect(tab(page, "preview")).toBeVisible();
      await content(page, "timeline").getByRole("button", { name: "纯色片段" }).click();
      await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
      await page.getByRole("menu").getByRole("menuitem", { name: "关闭项目", exact: true }).click();
      await showView(page, "全部项目");
      await expect.poll(() => isRed(page, NAME)).toBe(true);
      await page.waitForTimeout(3000);
      expect(await isRed(page, NAME)).toBe(true);
      expect(await listedCover(page, NAME)).toMatchObject({
        etag: chosen,
        chosen: true,
      });
      await shot(page, "covers-chosen");

      // Back to the editor's: here at once, then on the platform and the other browser.
      await cardMenu(page, NAME, "恢复自动封面");
      await expect.poll(() => isRed(page, NAME)).toBe(false);
      await hasLoaded(page, NAME);
      await expect
        .poll(
          async () => {
            const cover = await listedCover(page, NAME);
            return cover !== undefined && cover.chosen === undefined && cover.etag !== chosen;
          },
          { timeout: 90_000 },
        )
        .toBe(true);
      await other.page.reload();
      await editorReady(other.page);
      await hasLoaded(other.page, NAME);
      await expect.poll(() => isRed(other.page, NAME), { timeout: 30_000 }).toBe(false);
      expect(other.problems).toEqual([]);
    } finally {
      await other.context.close();
    }
    // What the browser logs of two answers that were meant: the platform takes the editor's cover
    // a minute after the last one only, which is sent again then; and the list from just before
    // people went back still names the one they chose, which is not there any more.
    const meant = [/status of 429/, /status of 404/];
    expect(problems.filter((problem) => !meant.some((pattern) => pattern.test(problem)))).toEqual(
      [],
    );
    await context.close();
  });
});
