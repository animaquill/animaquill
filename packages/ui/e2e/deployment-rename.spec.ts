import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createOnline, entrySignIn } from "./online-support.ts";
import { cardMenu, projectCard } from "./start-support.ts";
import { expect, test } from "./support.ts";

/**
 * Renaming a project of the platform from the start page without opening it, on the real sites
 * through the gateway (oss/packages/server/src/sync/hub.ts, `rename`): the card shows the new name
 * at once, another computer's start page has it at once too, as the platform tells its pages
 * (`GET /api/me/events`, through the gateway), and so has an editor that has the project open,
 * whose list of operations says what it was and takes it back. Where the platform does not take it,
 * the old name is back and people are told; without a network, it is not offered. The API with its
 * database, the worker and a fake GitHub, see scripts/e2e-edge. Pictures of each step, dark and
 * light, go to the output of the test.
 */

const EDITOR = "https://app.animaquill.com";
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

const signedInToGitHub = (context: BrowserContext, user: GitHubUser) =>
  context.addCookies([
    { name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB },
  ]);

const newInvite = () => {
  const said = execFileSync(
    "node",
    [
      "/work/apps/api/src/admin.ts",
      "invite",
      "create",
      "--note",
      "rename test",
    ],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

const accountMenu = (page: Page, user: GitHubUser) =>
  page.locator("header").getByRole("button", { name: `账号：${user.login}` });

/** See deployment-sync.spec.ts: the container has no network, so the page is told it has one. */
const ON_A_NETWORK = () => {
  let online = true;
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => online,
    configurable: true,
  });
  (window as unknown as { aqOnline: (next: boolean) => void }).aqOnline = (
    next,
  ) => {
    online = next;
    dispatchEvent(new Event(next ? "online" : "offline"));
  };
};

const setNetwork = (page: Page, online: boolean) =>
  page.evaluate(
    (next) =>
      (window as unknown as { aqOnline: (next: boolean) => void }).aqOnline(
        next,
      ),
    online,
  );

/** A picture of the page as it is, dark and light. */
async function shots(page: Page, name: string) {
  for (const colorScheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: test.info().outputPath(`${name}-${colorScheme}.png`),
    });
  }
  await page.emulateMedia({ colorScheme: "dark" });
}

/** A browser of its own, signed in to GitHub as the same person, at the start page. */
async function anotherBrowser(browser: Browser, user: GitHubUser) {
  const context = await browser.newContext({
    baseURL: EDITOR,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  await signedInToGitHub(context, user);
  await context.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const page = await context.newPage();
  await page.addInitScript(ON_A_NETWORK);
  await page.goto("/");
  await entrySignIn(page).click();
  await expect(accountMenu(page, user)).toBeVisible();
  return { context, page };
}

/** Renames a project from its card, as people do. */
async function renameCard(page: Page, name: string, next: string) {
  await cardMenu(page, name, "重命名…");
  const field = page.getByRole("textbox", { name: `“${name}”的新名字` });
  await field.fill(next);
  await field.press("Enter");
}

test.describe("renaming a project of the platform from the start page", () => {
  test.use({ withProject: false });

  test("the new name is everywhere at once: the card, another computer, and an editor that has it open", async ({
    page,
    context,
    browser,
    request,
  }) => {
    test.slow();
    const user = someone();
    expect(
      (
        await request.post(
          `${GITHUB}/_fake/install?user=${user.id}.${user.login}`,
        )
      ).ok(),
    ).toBe(true);
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
    await signedInToGitHub(context, user);
    await page.addInitScript(ON_A_NETWORK);
    await entrySignIn(page).click();
    await expect(page).toHaveURL(`${EDITOR}/signup.html`);
    await page.getByLabel("邀请码").fill(newInvite());
    await page.getByRole("button", { name: "继续" }).click();
    await expect(accountMenu(page, user)).toBeVisible();
    await createOnline(page, `rename-${user.id}`);
    await page.goto("/");
    await expect(projectCard(page, "测试项目")).toBeVisible();

    const other = await anotherBrowser(browser, user);
    try {
      await expect(projectCard(other.page, "测试项目")).toBeVisible();

      // While the platform takes its time: the new name, and that it is on its way.
      let answer: () => void = () => {};
      await page.route("**/api/projects/*/name", async (route) => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        await route.continue();
      });
      await renameCard(page, "测试项目", "宣传片");
      const card = projectCard(page, "宣传片");
      await expect(card).toBeVisible();
      await expect(card.locator("[data-card-name]")).toHaveAttribute(
        "data-pending",
        "",
      );
      await expect(card).toContainText("正在改名");
      await shots(page, "01-renaming");
      answer();
      await expect(card.locator("[data-card-name]")).not.toHaveAttribute(
        "data-pending",
      );
      await page.unroute("**/api/projects/*/name");
      // The other computer has it at once, without reading the page again.
      await expect(projectCard(other.page, "宣传片")).toBeVisible({
        timeout: 10_000,
      });
      await expect(projectCard(other.page, "测试项目")).toHaveCount(0);

      // An editor that has it open on the other computer: the title follows, and the list of
      // operations says what it was, which takes it back.
      await projectCard(other.page, "宣传片")
        .locator("a, button")
        .first()
        .click();
      await expect(other.page).toHaveTitle("宣传片 - AnimaQuill");
      await renameCard(page, "宣传片", "年度宣传片");
      await expect(other.page).toHaveTitle("年度宣传片 - AnimaQuill", {
        timeout: 10_000,
      });
      const status = other.page.getByRole("button", { name: /^上次的操作：/ });
      await expect(status).toHaveAccessibleName(
        "上次的操作：在开始页改名为“年度宣传片”",
      );
      await status.click();
      const list = other.page.getByRole("dialog", { name: "最近的操作" });
      await expect(list).toContainText("在开始页改名为“年度宣传片”");
      await shots(other.page, "02-operation");
      await list.getByRole("button", { name: "撤销这次" }).first().click();
      await expect(other.page).toHaveTitle("宣传片 - AnimaQuill", {
        timeout: 10_000,
      });
      // ...which the start page of the first computer hears too.
      await expect(projectCard(page, "宣传片")).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await other.context.close();
    }
  });

  test("where the platform does not take it, the old name is back, and people are told; offline it is not offered", async ({
    page,
    context,
    request,
    problems,
  }) => {
    test.slow();
    const user = someone();
    expect(
      (
        await request.post(
          `${GITHUB}/_fake/install?user=${user.id}.${user.login}`,
        )
      ).ok(),
    ).toBe(true);
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
    await signedInToGitHub(context, user);
    await page.addInitScript(ON_A_NETWORK);
    await entrySignIn(page).click();
    await page.getByLabel("邀请码").fill(newInvite());
    await page.getByRole("button", { name: "继续" }).click();
    await expect(accountMenu(page, user)).toBeVisible();
    await createOnline(page, `rename-locked-${user.id}`);
    await page.goto("/");

    // The platform says no, as for a project that is locked: nothing to try again.
    await page.route("**/api/projects/*/name", (route) =>
      route.fulfill({ status: 409, json: { error: "locked" } }),
    );
    await renameCard(page, "测试项目", "改不了");
    await expect(projectCard(page, "测试项目")).toBeVisible();
    await expect(projectCard(page, "改不了")).toHaveCount(0);
    const notice = page.getByText(/“改不了”没改成名字：这个项目锁定了/);
    await expect(notice).toBeVisible();
    await expect(page.getByRole("button", { name: "再试" })).toHaveCount(0);
    await shots(page, "03-refused");
    // Or it does not answer as it should: tried again from the notice, which goes now.
    await page.unroute("**/api/projects/*/name");
    await page.route("**/api/projects/*/name", (route) =>
      route.fulfill({ status: 503, json: { error: "unavailable" } }),
    );
    await renameCard(page, "测试项目", "改不了");
    await expect(page.getByText(/“改不了”没改成名字：没能改名/)).toBeVisible();
    await page.unroute("**/api/projects/*/name");
    // The browser says so of the answers it got, as it should.
    problems.splice(
      0,
      problems.length,
      ...problems.filter((each) => !/status of (409|503)/.test(each)),
    );
    await page.getByRole("button", { name: "再试" }).click();
    await expect(projectCard(page, "改不了")).toBeVisible();

    // Without a network: not offered, and why.
    await setNetwork(page, false);
    await projectCard(page, "改不了")
      .getByRole("button", { name: "“改不了”的更多操作" })
      .click();
    const item = page
      .getByRole("menu")
      .getByRole("menuitem", { name: /^重命名…/ });
    await expect(item).toBeDisabled();
    await expect(item).toContainText("连上以后才能改");
    await shots(page, "04-offline");
    await page.keyboard.press("Escape");
    await setNetwork(page, true);
    await projectCard(page, "改不了")
      .getByRole("button", { name: "“改不了”的更多操作" })
      .click();
    await expect(
      page
        .getByRole("menu")
        .getByRole("menuitem", { name: "重命名…", exact: true }),
    ).toBeEnabled();
  });
});
