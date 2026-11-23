import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";
import { editorReady, expect, tab, test } from "./support.ts";
import { createOnline, entrySignIn } from "./online-support.ts";

/**
 * Projects whose working copy the platform makes from their repository, on the real sites through
 * the gateway, with the API, the worker and the fake GitHub, see scripts/e2e-edge and
 * docs/design/start-and-cloud.md 1 and 9: a repository that has a project becomes a project of the
 * platform again ("从这个仓库恢复"), or says why it cannot; and a project whose working copy the
 * platform let go of (the admin's `project release`) opens again, with what this browser has that
 * the repository does not taken back onto the new copy, by itself or as people choose. Pictures go
 * to the output of each test, for people to look at.
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

const userParam = (user: GitHubUser) => `user=${user.id}.${user.login}`;

const signedInToGitHub = (context: BrowserContext, user: GitHubUser) =>
  context.addCookies([{ name: "fake_user", value: `${user.id}.${user.login}`, url: GITHUB }]);

const admin = (...args: string[]) =>
  execFileSync("node", ["/work/apps/api/src/admin.ts", ...args], {
    encoding: "utf8",
  });

const newInvite = () => {
  const code = /邀请码：(\S+)/.exec(admin("invite", "create", "--note", "rebuild test"))?.[1];
  if (!code) throw new Error("no invite code");
  return code;
};

/**
 * Lets go of the working copy of a project, as the platform will once nobody opened it for a week:
 * once no window is connected to it any more, which takes the platform a moment to see.
 */
async function release(project: string) {
  let said = "";
  await expect
    .poll(
      () => {
        try {
          said = admin("project", "release", project);
          return true;
        } catch (error) {
          said = String((error as { stdout?: string }).stdout ?? error);
          return false;
        }
      },
      { timeout: 60_000, message: `release ${project}: ${said}` },
    )
    .toBe(true);
  expect(said).toContain("已删掉");
}

/**
 * What a browser on a network says about it. This container has no network but the computer's own,
 * and a browser there says it is offline from the start, so the test says it instead, and offline
 * when the test takes the network away, with the events a browser sends then.
 */
const ON_A_NETWORK = () => {
  let online = true;
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => online,
    configurable: true,
  });
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
  await expect(page).toHaveTitle(`${name} - AnimaQuill`);
}

const cloudStatus = (page: Page) => page.locator("footer [data-cloud-level]");
const panel = (page: Page) => page.getByRole("dialog", { name: /^在线 · / });
const newDialog = (page: Page) => page.locator("dialog[data-create-phase]");
const readOnlyBar = (page: Page) => page.locator("[data-read-only]");
/** The one project card there is: each test is a person of their own. */
const theCard = (page: Page) => page.getByRole("main").locator("li[data-project]").first();

/** A picture of the page, in the output of the test. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** A call of the API from the page, with its session, as the editor makes them. */
const api = (page: Page, path: string, method = "GET") =>
  page.evaluate(
    async ({ path, method }) => {
      const response = await fetch(path, {
        method,
        ...(method !== "GET" && {
          headers: { "x-animaquill": "1", "content-type": "application/json" },
          body: "{}",
        }),
      });
      return {
        status: response.status,
        json: (await response.json().catch(() => null)) as any,
      };
    },
    { path, method },
  );

/** Takes out of `problems` what a test meant to happen: the browser logs every answer that says no. */
const meant = (problems: string[], pattern: RegExp) => {
  const kept = problems.filter((problem) => !pattern.test(problem));
  problems.splice(0, problems.length, ...kept);
};

/** Signs in for the first time, with the GitHub App on the account already. */
async function signUp(page: Page, context: BrowserContext, request: APIRequestContext) {
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const user = someone();
  expect((await request.post(`${GITHUB}/_fake/install?${userParam(user)}`)).ok()).toBe(true);
  await signedInToGitHub(context, user);
  // From the way back from signing in on.
  await page.addInitScript(ON_A_NETWORK);
  await signInButton(page).click();
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(accountMenu(page, user)).toBeVisible();
  return user;
}

/**
 * Connects the open project into a new repository of this name, and waits for its first archive.
 * Resolves to the project's id on the platform and the repository's number.
 */
async function connect(page: Page, repository: string) {
  await createOnline(page, repository);
  await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
  const id = (await api(page, "/api/projects")).json.projects[0].id as string;
  await archived(page, id);
  const repo = (await api(page, `/api/projects/${id}/repository`)).json.repository.id as number;
  return { id, repo };
}

/** Has the platform archive the project, and waits until the repository has all of it. */
async function archived(page: Page, id: string) {
  await expect
    .poll(
      async () => {
        const { json } = await api(page, `/api/projects/${id}/repository`);
        if (json.head !== json.archivedSeq && !json.archiving)
          await api(page, `/api/projects/${id}/archive`, "POST");
        return json.head === json.archivedSeq && json.head > 0;
      },
      { timeout: 120_000, intervals: [2000] },
    )
    .toBe(true);
}

/** What the platform says of the working copy of a project. */
const copyOf = async (page: Page, id: string) => {
  const { json } = await api(page, `/api/projects/${id}/repository`);
  return { copy: json.copy as string, generation: json.generation as number };
};

/** What the default branch of a repository on the fake GitHub has. */
const filesOn = async (request: APIRequestContext, repo: number) =>
  (await (await request.get(`${GITHUB}/_fake/files?repo=${repo}`)).json()) as Record<
    string,
    string
  >;

/** A new private repository of the person on the fake GitHub, with these files. */
async function repositoryWith(
  request: APIRequestContext,
  user: GitHubUser,
  name: string,
  files: Record<string, string>,
) {
  const made = await request.post(`${GITHUB}/_fake/repo?${userParam(user)}&name=${name}`, {
    data: files,
  });
  expect(made.ok()).toBe(true);
}

/** A browser of its own, signed in as the same person, on the start page. */
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
  await editorReady(page);
  await signInButton(page).click();
  await expect(accountMenu(page, user)).toBeVisible();
  return { context, page, problems };
}

/** Restores a repository of the list of the new project dialog, as people choose it there. */
async function restoreFrom(page: Page, user: GitHubUser, name: string) {
  await chooseFrom(page, "文件", "新建项目");
  const making = newDialog(page);
  await making.getByRole("radio", { name: "用已有的仓库" }).check();
  const choice = making
    .getByRole("radiogroup", { name: "授权范围里的仓库" })
    .locator(`[data-repository="${user.login}/${name}"]`);
  await choice.getByRole("radio").click();
  await expect(choice).toContainText(
    "根目录已经有项目的文件：AGENTS.md、animaquill.json、timelines",
  );
  await expect(choice).toContainText("可以从这个仓库恢复成一个新的在线项目");
  await shot(page, `restore-${name}-choose`);
  await choice.getByRole("button", { name: "从这个仓库恢复" }).click();
  const asked = page.getByRole("dialog", {
    name: `从仓库 ${user.login}/${name} 恢复成在线项目？`,
  });
  await expect(asked).toBeVisible();
  await asked.getByRole("button", { name: "恢复", exact: true }).click();
}

test.describe("restoring a repository as a project of the platform", () => {
  // The entry page, then the start page of the online mode: projects are made there.
  test.use({ withProject: false });

  test("makes the project from what the repository has, opens it, and says why where it cannot", async ({
    page,
    context,
    request,
    problems,
  }) => {
    test.setTimeout(300_000);
    const user = await signUp(page, context, request);
    const { repo } = await connect(page, `source-${user.id}`);
    // What GitHub has of a project, in repositories of their own: as it is, broken, and newer.
    const files = await filesOn(request, repo);
    const manifest = JSON.parse(files["animaquill.json"] ?? "{}");
    await repositoryWith(request, user, "kept", {
      ...files,
      "animaquill.json": JSON.stringify({ ...manifest, name: "从仓库恢复的" }, null, 2),
    });
    const document = Object.keys(files).find((path) => /^timelines\/.+\.json$/.test(path));
    if (!document) throw new Error(`no timeline in ${Object.keys(files).join(", ")}`);
    await repositoryWith(request, user, "broken", {
      ...files,
      [document]: "{ not json",
    });
    await repositoryWith(request, user, "newer", {
      ...files,
      "animaquill.json": JSON.stringify({ ...manifest, formatVersion: 999 }, null, 2),
    });

    // One that reads: it comes, and opens, only in this browser, syncing.
    await restoreFrom(page, user, "kept");
    await expect(page).toHaveTitle("从仓库恢复的 - AnimaQuill", {
      timeout: 120_000,
    });
    await expect(tab(page, "preview")).toBeVisible();
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    const listed = (await api(page, "/api/projects")).json.projects as {
      id: string;
      name: string;
      repository?: { fullName: string };
    }[];
    expect(listed.find(({ name }) => name === "从仓库恢复的")).toMatchObject({
      repository: { fullName: `${user.login}/kept` },
    });
    await shot(page, "restore-opened");
    // ...and it is the person's project like any other: changes go to the platform.
    await renameTo(page, "恢复以后改的");
    await expect
      .poll(async () =>
        ((await api(page, "/api/projects")).json.projects as { name: string }[]).map(
          ({ name }) => name,
        ),
      )
      .toContain("恢复以后改的");

    // One with a document that does not read: which one, and nothing stays.
    await restoreFrom(page, user, "broken");
    const failed = page.getByRole("dialog", {
      name: `没能从仓库 ${user.login}/broken 恢复`,
    });
    // Which ones: the document, and what refers to it.
    await expect(failed).toContainText("仓库里有读不懂的文件：", { timeout: 120_000 });
    await expect(failed).toContainText(document);
    await shot(page, "restore-unreadable");
    await failed.getByRole("button", { name: "关闭" }).click();
    // One of a newer editor.
    await restoreFrom(page, user, "newer");
    const newer = page.getByRole("dialog", {
      name: `没能从仓库 ${user.login}/newer 恢复`,
    });
    await expect(newer).toContainText("仓库里的项目是更新的编辑器做的", {
      timeout: 120_000,
    });
    await shot(page, "restore-too-new");
    await newer.getByRole("button", { name: "关闭" }).click();
    expect(
      ((await api(page, "/api/projects")).json.projects as unknown[]).length,
      "nothing stays of what could not be restored",
    ).toBe(2);
    // The project that was open stays open.
    await expect(page).toHaveTitle("恢复以后改的 - AnimaQuill");
    meant(problems, /status of 4\d\d|Failed to load resource/);
  });
});

test.describe("a project whose working copy the platform let go of", () => {
  test.use({ withProject: false });

  test("opens again from GitHub, and what this browser had that GitHub did not comes back by itself", async ({
    page,
    context,
    request,
    problems,
  }) => {
    test.setTimeout(300_000);
    const user = await signUp(page, context, request);
    const { id } = await connect(page, `rebuild-${user.id}`);
    expect(await copyOf(page, id)).toEqual({ copy: "live", generation: 1 });

    // Nobody has it open, and the platform lets go of its copy: the card opens it as ever.
    await chooseFrom(page, "文件", "关闭项目");
    await release(id);
    expect((await copyOf(page, id)).copy).toBe("released");
    await page.reload();
    await editorReady(page);
    await expect(theCard(page)).toBeVisible();
    await shot(page, "release-card");
    await theCard(page).locator("a, button").first().click();
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online", {
      timeout: 120_000,
    });
    expect(await copyOf(page, id)).toEqual({ copy: "live", generation: 2 });
    // Nothing to take back: nothing to say either, and it can be edited.
    await expect(readOnlyBar(page)).toHaveCount(0);
    await expect(page.getByText(/已经接回/)).toHaveCount(0);
    await shot(page, "release-reopened");

    // A change the platform never got: made offline, and the copy goes meanwhile.
    await setNetwork(context, page, false);
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "offline");
    await renameTo(page, "离线时改的名字");
    await chooseFrom(page, "文件", "关闭项目");
    await setNetwork(context, page, true);
    await release(id);
    await theCard(page).locator("a, button").first().click();
    await expect(
      page.getByText("“离线时改的名字”已经接回，这台电脑上 1 个文件的改动并回了服务器。"),
    ).toBeVisible({ timeout: 120_000 });
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    await expect(cloudStatus(page)).toHaveText("已同步");
    await shot(page, "release-taken-back");
    expect(await copyOf(page, id)).toEqual({ copy: "live", generation: 3 });
    await expect
      .poll(async () => (await api(page, "/api/projects")).json.projects[0].name)
      .toBe("离线时改的名字");
    // And it goes on as any project does.
    await renameTo(page, "接回以后改的");
    await expect
      .poll(async () => (await api(page, "/api/projects")).json.projects[0].name)
      .toBe("接回以后改的");
    meant(problems, /status of 4\d\d|Failed to load resource|ERR_INTERNET_DISCONNECTED/);
  });

  test("has people choose where another computer changed the same place, and does as they chose", async ({
    page,
    context,
    request,
    browser,
    problems,
  }) => {
    test.setTimeout(300_000);
    const user = await signUp(page, context, request);
    const { id } = await connect(page, `both-${user.id}`);
    const other = await anotherBrowser(browser, user);
    try {
      // This browser changes the name offline; the other one too, which the repository gets.
      await setNetwork(context, page, false);
      await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "offline");
      await renameTo(page, "这台电脑改的");
      await chooseFrom(page, "文件", "关闭项目");
      await theCard(other.page).locator("a, button").first().click();
      await expect(cloudStatus(other.page)).toHaveAttribute("data-cloud", "online", {
        timeout: 60_000,
      });
      await renameTo(other.page, "那台电脑改的");
      await expect
        .poll(async () => (await api(other.page, "/api/projects")).json.projects[0].name)
        .toBe("那台电脑改的");
      await archived(other.page, id);
      await chooseFrom(other.page, "文件", "关闭项目");
      await setNetwork(context, page, true);
      await release(id);

      // People choose; giving up changes nothing, and it can only be looked at meanwhile.
      await theCard(page).locator("a, button").first().click();
      const choosing = page.locator("dialog[data-reconcile]");
      await expect(choosing).toBeVisible({ timeout: 120_000 });
      await expect(choosing).toContainText("接回“这台电脑改的”");
      const row = choosing.locator('li[data-path="animaquill.json"]');
      await expect(row).toContainText("这台电脑和服务器都改了同一处");
      await shot(page, "release-both-dialog");
      await choosing.getByRole("button", { name: "取消" }).click();
      // The bar over it and the panel say the same.
      await expect(readOnlyBar(page)).toContainText("这台电脑上的改动还没接回");
      await cloudStatus(page).click();
      const sync = panel(page).locator('[data-cloud-row="sync"]');
      await expect(sync).toContainText("这台电脑上的改动还没接回");
      await shot(page, "release-both-waiting");
      await panel(page).locator('[data-cloud-action="takeBack"]').click();
      await expect(choosing).toBeVisible({ timeout: 60_000 });
      await row.getByRole("radio", { name: "用这台电脑的" }).check();
      await choosing.getByRole("button", { name: /^接回/ }).click();
      await expect(page.getByText(/“这台电脑改的”已经接回/)).toBeVisible({
        timeout: 60_000,
      });
      await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
      await expect(readOnlyBar(page)).toHaveCount(0);
      await expect
        .poll(async () => (await api(page, "/api/projects")).json.projects[0].name)
        .toBe("这台电脑改的");
      expect((await copyOf(page, id)).generation).toBe(2);
      await shot(page, "release-both-done");
      // The other computer opens what came of it.
      await theCard(other.page).locator("a, button").first().click();
      await expect(other.page).toHaveTitle("这台电脑改的 - AnimaQuill", {
        timeout: 60_000,
      });
      meant(problems, /status of 4\d\d|Failed to load resource|ERR_INTERNET_DISCONNECTED/);
      meant(other.problems, /status of 4\d\d|Failed to load resource/);
      expect(other.problems).toEqual([]);
    } finally {
      await other.context.close();
    }
  });
});
