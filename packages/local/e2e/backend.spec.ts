/**
 * `npx animaquill` with its backend, in Chrome and Firefox (design O4 of AnimaQuill Cloud, sections
 * 2 and 7): the terminal's address signs in once and leaves the address bar and the history at
 * once, a reload stays signed in, a browser without the address gets no online mode but the
 * offline one, a project made online is there after a restart, the sites of scenes reach none
 * of the API, and "设置 › 服务器" saves a copy of the master key once and says where the data is.
 * Each browser has a backend of its own, see backend-support.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Backend } from "./backend-support.ts";

test.describe.configure({ mode: "serial" });

const PORTS: Readonly<Record<string, number>> = {
  "backend-chromium": 7658,
  "backend-firefox": 7657,
};

let backend: Backend;

// oxlint-disable-next-line eslint/no-empty-pattern -- Playwright gives the fixtures first
test.beforeAll(async ({}, info) => {
  test.setTimeout(180_000);
  backend = new Backend(PORTS[info.project.name] ?? 7656);
  await backend.remove();
  await backend.start();
});

test.afterAll(async () => {
  await backend?.remove();
});

/** What the page logged as errors, which fail the test. */
const watch = (page: Page) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  return problems;
};

/** The start page of the online mode, signed in as the person of this machine. */
const signedIn = async (page: Page) => {
  await expect(page.locator("[data-cloud-list]").first()).toHaveAttribute(
    "data-cloud-list",
    "ready",
    { timeout: 30_000 },
  );
  await expect(page.getByRole("button", { name: "账号：本机" }).first()).toBeVisible();
};

test("the address of the terminal signs in once, and is gone from the address and the history at once", async ({
  page,
}) => {
  const problems = watch(page);
  const address = await backend.addressToOpen();
  await page.goto(address);
  await signedIn(page);
  expect(page.url()).toBe(`${backend.editor}/`);
  expect(await page.evaluate(() => location.hash)).toBe("");
  // A reload: signed in still.
  await page.reload();
  await signedIn(page);
  // Back leads to no entry with the token: the page before is what was there before it.
  await page.goBack();
  expect(page.url()).not.toContain("aq-token");
  expect(problems).toEqual([]);
});

test("a browser without the address gets no online mode, and the offline mode all the same", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${backend.editor}/`);
  await expect(page.getByTestId("entry-terminal")).toHaveText(
    "请从启动 AnimaQuill 的终端里打开那个网址，或者运行 npx animaquill open。",
  );
  await expect(page.getByRole("button", { name: "用 GitHub 登录" })).toHaveCount(0);
  // An address that was used already signs nobody in.
  const used = await backend.addressToOpen();
  const other = await browser.newContext();
  const first = await other.newPage();
  await first.goto(used);
  await signedIn(first);
  await page.goto(used);
  await expect(page.getByTestId("entry-terminal")).toBeVisible();
  await page.getByRole("button", { name: "不登录，使用离线模式" }).click();
  await expect(page).toHaveURL(`${backend.editor}/offline`);
  await expect(page.getByRole("button", { name: "新建项目" }).first()).toBeVisible();
  await context.close();
  await other.close();
});

test("with nothing online yet, the start page says where the projects of the offline mode are", async ({
  page,
}) => {
  await page.goto(`${backend.editor}/offline`);
  // A project of the offline mode in this browser, as people of the version before have them.
  await page.evaluate(
    () =>
      new Promise<void>((done, fail) => {
        const request = indexedDB.open("aq-offline-animaquill", 1);
        request.addEventListener("upgradeneeded", () => {
          request.result.createObjectStore("projects", { keyPath: "id" });
          request.result.createObjectStore("updates", { keyPath: "seq", autoIncrement: true });
        });
        request.addEventListener("error", () => fail(request.error));
        request.addEventListener("success", () => {
          const database = request.result;
          const writing = database.transaction("projects", "readwrite");
          writing.objectStore("projects").put({ id: "from-before", name: "以前的片子" });
          writing.addEventListener("complete", () => {
            database.close();
            done();
          });
        });
      }),
  );
  await page.goto(await backend.addressToOpen());
  await signedIn(page);
  const hint = page.getByTestId("offline-projects-hint");
  await expect(hint).toContainText("你之前的项目在离线模式里。");
  await hint.getByRole("button", { name: "切到离线模式" }).click();
  await expect(page).toHaveURL(`${backend.editor}/offline`);
  await page.goto(`${backend.editor}/`);
  await signedIn(page);
  await page.getByTestId("offline-projects-hint").getByRole("button", { name: "不再提示" }).click();
  await expect(page.getByTestId("offline-projects-hint")).toHaveCount(0);
  await page.reload();
  await signedIn(page);
  await expect(page.getByTestId("offline-projects-hint")).toHaveCount(0);
});

test("a project made online is there after a restart", async ({ page }) => {
  test.setTimeout(180_000);
  const problems = watch(page);
  await page.goto(await backend.addressToOpen());
  await signedIn(page);
  await page.getByRole("button", { name: "新建项目" }).first().click();
  const making = page.locator("dialog[data-create-phase]");
  await making.getByRole("textbox", { name: "项目名称" }).fill("本机的片子");
  await making.getByRole("button", { name: /^新建$/ }).click();
  const done = making.getByRole("button", { name: "完成" });
  await expect(done.or(page.locator("footer [data-cloud-level]"))).toBeVisible({ timeout: 60_000 });
  if (await done.isVisible()) await done.click();
  await expect(page).toHaveTitle("本机的片子 - AnimaQuill", { timeout: 30_000 });
  await expect(page.locator("footer [data-cloud-level]")).toHaveText("已同步", { timeout: 30_000 });

  await backend.stop();
  await backend.start();
  await page.goto(`${backend.editor}/`);
  await signedIn(page);
  await expect(page.getByText("本机的片子").first()).toBeVisible();
  expect(
    problems.filter(
      (each) => !/WebSocket|Failed to load resource|ERR_CONNECTION_REFUSED|NetworkError/.test(each),
    ),
  ).toEqual([]);
});

test("the sites of scenes reach nothing of the API", async ({ page }) => {
  await page.goto(await backend.addressToOpen());
  await signedIn(page);
  const scene = `http://animaquill-scene-0.localhost:${backend.port}`;
  await page.goto(`${scene}/scene.html`);
  const reached = await page.evaluate(async (editor) => {
    const own = await fetch("/api/auth/session").then(
      (response) => response.status,
      () => "failed",
    );
    const theirs = await fetch(`${editor}/api/auth/session`, { credentials: "include" }).then(
      async (response) => `read: ${await response.text()}`,
      () => "failed",
    );
    return { own, theirs };
  }, backend.editor);
  // Its own /api its policy does not even let it ask for; the editor's it cannot read.
  expect(reached).toEqual({ own: "failed", theirs: "failed" });
  for (const site of ["animaquill-scene-0", "animaquill-sandbox"])
    expect(
      (await backend.call("GET", "/api/auth/session", {}, `${site}.localhost:${backend.port}`))
        .status,
    ).toBe(404);
  // Nor this computer by another name, nor a page of another site that leads here.
  expect(
    (await backend.call("GET", "/api/auth/session", {}, `localhost:${backend.port}`)).status,
  ).toBe(421);
  expect(
    (await backend.call("GET", "/api/auth/session", {}, `evil.example:${backend.port}`)).status,
  ).toBe(421);
});

test("the settings of the server: a copy of the master key saved once, where the data is, and what a backup takes", async ({
  page,
}, info) => {
  const problems = watch(page);
  await page.goto(await backend.addressToOpen());
  await signedIn(page);
  await page.locator("header").getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByTestId("settings");
  await settings
    .getByRole("navigation", { name: "设置分组" })
    .getByRole("button", { name: "服务器", exact: true })
    .click();
  await expect(settings.getByTestId("server-database")).toHaveText(
    "PostgreSQL 18（随 AnimaQuill 带的）",
  );
  await expect(settings.getByTestId("server-data-dir")).toHaveText(backend.dataDir);
  await expect(settings.getByTestId("server-key-path")).toHaveText(
    join(backend.dataDir, "master.key"),
  );
  await expect(settings.getByTestId("server-key-unsaved")).toBeVisible();
  await expect(settings.getByText("npx animaquill server export <文件夹>")).toBeVisible();
  // As people see it, in both themes: kept with the results of the test.
  if (info.project.name === "backend-chromium")
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await settings.screenshot({ path: info.outputPath(`server-${colorScheme}.png`) });
    }

  const download = page.waitForEvent("download");
  await settings.getByTestId("server-key-save").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/^animaquill-master-[0-9a-f]{8}\.key$/);
  expect(readFileSync(await saved.path(), "utf8")).toBe(
    readFileSync(join(backend.dataDir, "master.key"), "utf8"),
  );
  // Asked once: from then on, how it stands, and another copy if wanted.
  await expect(settings.getByTestId("server-key-unsaved")).toHaveCount(0);
  await expect(settings.getByTestId("server-key-save")).toHaveText("再存一份…");
  await page.reload();
  await signedIn(page);
  await page.locator("header").getByRole("button", { name: "设置", exact: true }).click();
  await settings
    .getByRole("navigation", { name: "设置分组" })
    .getByRole("button", { name: "服务器", exact: true })
    .click();
  await expect(settings.getByTestId("server-key-save")).toHaveText("再存一份…");
  expect(problems).toEqual([]);
});
