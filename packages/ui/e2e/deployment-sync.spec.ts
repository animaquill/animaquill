import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { createOnline, entrySignIn } from "./online-support.ts";
import { expect, test } from "./support.ts";
import { openCard } from "./start-support.ts";

/**
 * Projects kept in step with the platform, on the real sites through the gateway: making a
 * project, opening it in another browser, changes going both ways as they happen, and a browser that
 * was offline catching up. The API with its database, and a fake GitHub to sign in with, see
 * scripts/e2e-edge. Each test is a GitHub user of its own.
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
  context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "sync test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

const signInButton = (page: Page) => entrySignIn(page);
const accountMenu = (page: Page, user: GitHubUser) =>
  page.locator("header").getByRole("button", { name: `账号：${user.login}` });

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

async function renameTo(page: Page, name: string) {
  await chooseFrom(page, "文件", "重命名项目");
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
}

/** How the open project stands with the platform. */
const cloudStatus = (page: Page) => page.locator("footer [data-cloud-level]");

/**
 * What a browser on a network says about it. This container has no network but the computer's own,
 * and a browser there says it is offline from the start, so the test says it instead: online, and
 * offline when the test takes the network away, with the events a browser sends then.
 */
const ON_A_NETWORK = () => {
  let online = true;
  Object.defineProperty(Navigator.prototype, "onLine", { get: () => online, configurable: true });
  (window as unknown as { aqOnline: (next: boolean) => void }).aqOnline = (next) => {
    online = next;
    dispatchEvent(new Event(next ? "online" : "offline"));
  };
};

/** The network of a browser goes away, or comes back, as the browser finds out. */
async function setNetwork(context: BrowserContext, page: Page, online: boolean) {
  await context.setOffline(!online);
  await page.evaluate(
    (next) => (window as unknown as { aqOnline: (next: boolean) => void }).aqOnline(next),
    online,
  );
}

/** A browser of its own, signed in to GitHub as the same person, with the project list in it. */
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
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  await page.addInitScript(ON_A_NETWORK);
  await page.goto("/");
  return { context, page, problems };
}

test.describe("syncing with the platform", () => {
  // The entry page, then the start page of the online mode: the project is made there.
  test.use({ withProject: false });

  test.beforeEach(async ({ page }) => {
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ body: PICTURE, contentType: "image/png" }),
    );
  });

  test("a project of the platform is made, opens in another browser, and both stay in step, also after being offline", async ({
    page,
    context,
    browser,
    request,
  }) => {
    test.slow();
    const user = someone();
    // The GitHub App is on the account: a project of the platform always has a repository.
    expect((await request.post(`${GITHUB}/_fake/install?user=${user.id}.${user.login}`)).ok()).toBe(
      true,
    );
    await signedInToGitHub(context, user);
    // From the way back from signing in on.
    await page.addInitScript(ON_A_NETWORK);
    await signInButton(page).click();
    await expect(page).toHaveURL(`${EDITOR}/signup.html`);
    await page.getByLabel("邀请码").fill(newInvite());
    await page.getByRole("button", { name: "继续" }).click();
    await expect(accountMenu(page, user)).toBeVisible();

    // A new project is one of the platform, in a repository of its own.
    await createOnline(page, `sync-${user.id}`);
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");

    const other = await anotherBrowser(browser, user);
    try {
      await signInButton(other.page).click();
      await expect(accountMenu(other.page, user)).toBeVisible();
      // The start page lists it, and opens it as it is.
      await openCard(other.page, "测试项目");
      await expect(other.page).toHaveTitle("测试项目 - AnimaQuill");
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "online");

      // As they happen, both ways.
      await renameTo(page, "第一个名字");
      await expect(other.page).toHaveTitle("第一个名字 - AnimaQuill");
      await renameTo(other.page, "第二个名字");
      await expect(page).toHaveTitle("第二个名字 - AnimaQuill");

      // The other browser goes offline, and goes on working.
      await setNetwork(other.context, other.page, false);
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "offline");
      await renameTo(other.page, "离线时的名字");
      await expect(other.page).toHaveTitle("离线时的名字 - AnimaQuill");
      await other.page.waitForTimeout(1500);
      await expect(page).toHaveTitle("第二个名字 - AnimaQuill");

      // Back online: what waited goes.
      await setNetwork(other.context, other.page, true);
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "online");
      await expect(page).toHaveTitle("离线时的名字 - AnimaQuill");
      await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
      // And the connection works on.
      await renameTo(page, "最后的名字");
      await expect(other.page).toHaveTitle("最后的名字 - AnimaQuill");
      // Hovering says how syncing is, and that nothing waits.
      await cloudStatus(other.page).hover();
      await expect(other.page.getByRole("tooltip")).toContainText("在线，改动都已发送");
      // Asking the platform about the repository while there is no network fails, as it should.
      expect(other.problems.filter((text) => !text.includes("ERR_INTERNET_DISCONNECTED"))).toEqual(
        [],
      );
    } finally {
      await other.context.close();
    }
  });
});
