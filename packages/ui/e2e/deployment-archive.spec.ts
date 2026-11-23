import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { createOnline, entrySignIn } from "./online-support.ts";
import { expect, test } from "./support.ts";

/**
 * Saving a project to GitHub as people do it in the editor, on the real sites through the gateway,
 * with the API, the worker (its own process, as in its own container) and the fake GitHub:
 * a new project of the platform gets a new private repository, "archive now" takes a change there,
 * an edit on GitHub pauses archiving until people go on with the editor's content, and the panel
 * of the platform takes the project to another repository at any time. Choosing among the
 * repositories people have is in the dialog of a new project (deployment-create.spec.ts). Pictures of the dialogs and the panel
 * go to the output of each test, for people to look at.
 */

const EDITOR = "https://app.animaquill.com";
const GITHUB = "http://127.0.0.1:8400";
/** What run.sh gives the API, which webhooks are signed with. */
const WEBHOOK_SECRET = "deployment-test-secret";
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

const newInvite = () => {
  const said = execFileSync(
    "node",
    ["/work/apps/api/src/admin.ts", "invite", "create", "--note", "archive test"],
    { encoding: "utf8" },
  );
  const code = /邀请码：(\S+)/.exec(said)?.[1];
  if (!code) throw new Error(`no invite code in: ${said}`);
  return code;
};

/**
 * What a browser on a network says about it: this container has no network but the computer's own,
 * and a browser there says it is offline from the start, see deployment-sync.spec.ts.
 */
const ON_A_NETWORK = () => {
  Object.defineProperty(Navigator.prototype, "onLine", {
    get: () => true,
    configurable: true,
  });
};

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

/** How the open project stands with the platform: "仅本机" for one that is not connected. */
const cloudStatus = (page: Page) => page.locator("footer [data-cloud-level]");
/** The status of the repository on GitHub: "已同步", "待同步", or what went wrong. */
const githubStatus = (page: Page) => page.locator("footer [data-github]");
const panel = (page: Page) => page.getByRole("dialog", { name: /^在线 · / });
/** The panel of the platform, opened. */
async function openPanel(page: Page) {
  if (!(await panel(page).isVisible())) await cloudStatus(page).click();
  await expect(panel(page)).toBeVisible();
  return panel(page);
}
async function closePanel(page: Page) {
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
}
const row = (page: Page, id: string) => panel(page).locator(`[data-cloud-row="${id}"]`);
/** What a row of the panel says, without what is below it. */
const rowText = (page: Page, id: string) => row(page, id).getByRole("status");

/** A call of the API from the page, with its session, as the editor makes them. */
const api = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const response = await fetch(path);
    return (await response.json()) as any;
  }, path);

/** Installs the App on the person's account, and signs in, to the start page of the online mode. */
async function signIn(page: Page, context: BrowserContext, request: APIRequestContext) {
  await page.route("https://avatars.githubusercontent.com/**", (route) =>
    route.fulfill({ body: PICTURE, contentType: "image/png" }),
  );
  const user = someone();
  expect((await request.post(`${GITHUB}/_fake/install?${userParam(user)}`)).ok()).toBe(true);
  await signedInToGitHub(context, user);
  // From the way back from signing in on.
  await page.addInitScript(ON_A_NETWORK);
  await entrySignIn(page).click();
  await page.getByLabel("邀请码").fill(newInvite());
  await page.getByRole("button", { name: "继续" }).click();
  await expect(
    page.locator("header").getByRole("button", { name: `账号：${user.login}` }),
  ).toBeVisible();
  return user;
}

/** Takes out of `problems` what a test meant to happen: the browser logs every answer that says no. */
const meant = (problems: string[], pattern: RegExp) => {
  const kept = problems.filter((problem) => !pattern.test(problem));
  problems.splice(0, problems.length, ...kept);
};

test.describe("saving to GitHub", () => {
  // The entry page, then the start page of the online mode: the project is made there.
  test.use({ withProject: false });

  test("a project connects into a new repository, archives now, pauses for an edit on GitHub, and goes on with the editor's content", async ({
    page,
    context,
    request,
    problems,
  }) => {
    test.setTimeout(300_000);
    const user = await signIn(page, context, request);
    const shot = (name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

    // Making the project chooses the repository: a new private one, by a name GitHub takes.
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const connecting = page.locator("dialog[data-create-phase]");
    await connecting.getByRole("textbox", { name: "项目名称" }).fill("测试项目");
    const name = connecting.getByRole("textbox", { name: "仓库名" });
    await expect(name).not.toHaveValue("");
    await name.fill("我的片子");
    await expect(
      connecting.getByText("仓库名只能用英文字母、数字和 - _ .，不能有空格或中文。"),
    ).toBeVisible();
    await expect(connecting.getByRole("button", { name: "新建", exact: true })).toBeDisabled();
    const repoName = `film-${user.id}`;
    await name.fill(repoName);
    await expect(
      connecting.getByText(`会建在你的 GitHub 账号下：${user.login}/${repoName}`),
    ).toBeVisible();
    await shot("dialog-create");
    await connecting.getByRole("button", { name: "新建", exact: true }).click();
    // The first archive, and the dialog says so.
    await expect(connecting).toHaveAttribute("data-create-phase", "done", {
      timeout: 60_000,
    });
    await connecting.getByRole("button", { name: "完成" }).click();
    await expect(connecting).toHaveCount(0);

    // ...and so does the panel.
    await openPanel(page);
    await expect(rowText(page, "repository")).toContainText(`${user.login}/${repoName}（私有）`);
    await expect(rowText(page, "archive")).toHaveText("刚刚存过");
    await shot("status-archived");
    const { json: listed } = { json: await api(page, "/api/projects") };
    const id = listed.projects[0].id as string;
    const repo = (await api(page, `/api/projects/${id}/repository`)).repository.id as number;
    const files = async () =>
      (await (await request.get(`${GITHUB}/_fake/files?repo=${repo}`)).json()) as Record<
        string,
        string
      >;
    expect(Object.keys(await files()).toSorted()).toEqual([
      ".gitattributes",
      "AGENTS.md",
      "animaquill.json",
      "timelines/main/timeline.json",
    ]);
    await closePanel(page);

    // A change waits for a quiet moment...
    await chooseFrom(page, "文件", "重命名项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("存到 GitHub 的名字");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => {
        const status = await api(page, `/api/projects/${id}/repository`);
        return status.head > status.archivedSeq;
      })
      .toBe(true);
    await openPanel(page);
    await expect(rowText(page, "archive")).toHaveText(/存过。有新改动，约 \d 分钟后再存$/);
    await shot("status-waiting");

    // ...or goes now, where people see it: the panel stays.
    await row(page, "archive").getByRole("button", { name: "现在存档" }).click();
    await expect
      .poll(async () => (await files())["animaquill.json"] ?? "", {
        timeout: 60_000,
      })
      .toContain("存到 GitHub 的名字");
    await expect(panel(page)).toBeVisible();
    await expect(rowText(page, "archive")).toHaveText("刚刚存过", {
      timeout: 30_000,
    });
    await closePanel(page);

    // Someone changes the timeline on GitHub and adds a file where the project's go: GitHub tells
    // the platform, which looks, and pauses.
    const timeline = (await files())["timelines/main/timeline.json"]!;
    await request.post(`${GITHUB}/_fake/commit?${userParam(user)}&repo=${repo}`, {
      data: {
        "timelines/main/timeline.json": timeline.replace("{", '{\n  "edited": "on GitHub",'),
        "code/from-github.js": "export const x = 1;\n",
      },
    });
    const deliveries = (await (
      await request.post(`${GITHUB}/_fake/deliveries?repo=${repo}&secret=${WEBHOOK_SECRET}`)
    ).json()) as { body: string; headers: Record<string, string> }[];
    expect(deliveries.length).toBeGreaterThan(0);
    for (const delivery of deliveries) {
      const answer = await request.post(`${EDITOR}/api/github/webhook`, {
        headers: delivery.headers,
        data: delivery.body,
      });
      expect(answer.status()).toBeLessThan(300);
    }
    await expect
      .poll(async () => (await api(page, `/api/projects/${id}/repository`)).reason, {
        timeout: 60_000,
      })
      .toBe("diverged");
    // The status bar says so at the next look, at the latest when the window comes back.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(cloudStatus(page)).toHaveAttribute("data-archive", "paused", {
      timeout: 70_000,
    });
    // Saving into GitHub stands out: why and what helps, on
    // hovering and in the panel. Syncing goes on as it does.
    await expect(cloudStatus(page)).toHaveText("已同步");
    await expect(githubStatus(page)).toHaveText("GitHub 仓库同步失败");
    await expect(githubStatus(page)).toHaveAttribute("data-github", "error");
    await githubStatus(page).hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "存进 GitHub 失败：GitHub 上有人改了项目的 2 个文件",
    );
    await shot("s1-status-error-tip");
    await githubStatus(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(rowText(page, "archive")).toHaveText(
      "存档先停着：GitHub 上有人改了项目的 2 个文件",
    );
    await shot("status-paused");

    // People go on with the editor's content, after seeing what that does to which files.
    await row(page, "archive").getByRole("button", { name: "以编辑器的内容接着存…" }).click();
    const confirm = page.getByRole("dialog", {
      name: "以编辑器的内容接着存？",
    });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("heading", { name: "会被覆盖的文件" })).toBeVisible();
    await expect(confirm.getByText("timelines/main/timeline.json")).toBeVisible();
    await expect(
      confirm.getByRole("heading", {
        name: "会被删除的文件（GitHub 上有，项目里没有）",
      }),
    ).toBeVisible();
    await expect(confirm.getByText("code/from-github.js")).toBeVisible();
    await shot("confirm-diverged");
    await confirm.getByRole("button", { name: "接着存" }).click();
    // The platform takes one archive a minute: it goes once it may, by itself.
    await expect
      .poll(async () => Object.keys(await files()), { timeout: 120_000 })
      .not.toContain("code/from-github.js");
    expect((await files())["timelines/main/timeline.json"]).toBe(timeline);
    await openPanel(page);
    await expect(rowText(page, "archive")).toHaveText("刚刚存过", {
      timeout: 30_000,
    });
    await expect(cloudStatus(page)).toHaveAttribute("data-archive", "ready");
    // Put right: back to "已同步", and nothing stands out.
    await closePanel(page);
    await expect(githubStatus(page)).toHaveText("GitHub 仓库已同步");
    await expect(githubStatus(page)).toHaveAttribute("data-github", "synced");
    await shot("s1-status-synced-again");
    // "Archive now" a moment after the last one: the platform said to wait, and the editor did.
    meant(problems, /status of 429/);
  });

  test("the panel takes the project to another repository, while archiving into the one it has goes as it should", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(180_000);
    const user = await signIn(page, context, request);
    const first = `first-${user.id}`;
    await createOnline(page, first);

    const other = (
      await (await request.post(`${GITHUB}/_fake/repo?${userParam(user)}&name=other-one`)).json()
    ).id as number;
    await openPanel(page);
    await panel(page).getByRole("button", { name: "换一个仓库…" }).click();
    const switching = page.getByRole("dialog", { name: "换一个仓库" });
    await expect(
      switching.getByText("以后存进新选的仓库，原来那个仓库里的存档留在那里。"),
    ).toBeVisible();
    await switching.getByRole("radio", { name: "用已有的仓库" }).check();
    const list = switching.getByRole("radiogroup", {
      name: "授权范围里的仓库",
    });
    const choice = (name: string) => list.locator(`[data-repository="${user.login}/${name}"]`);
    // The one it has cannot be chosen again.
    await expect(choice(first)).toContainText("现在存进的就是这个仓库");
    await expect(choice(first).getByRole("radio")).toBeDisabled();
    await choice("other-one").getByRole("radio").check();
    await page.screenshot({
      path: test.info().outputPath("dialog-switch.png"),
    });
    await switching.getByRole("button", { name: "存进这个仓库" }).click();
    await expect(switching).toHaveCount(0);
    await expect(page.getByText(`已存到 GitHub：${user.login}/other-one。`)).toBeVisible();

    // The project is archived there from now on.
    await expect
      .poll(
        async () =>
          Object.keys(
            (await (await request.get(`${GITHUB}/_fake/files?repo=${other}`)).json()) as object,
          ),
        { timeout: 60_000 },
      )
      .toContain("animaquill.json");
    await openPanel(page);
    await expect(rowText(page, "repository")).toContainText(`${user.login}/other-one（私有）`);
    await expect(cloudStatus(page)).toHaveAttribute("data-archive", "ready");
  });
});
