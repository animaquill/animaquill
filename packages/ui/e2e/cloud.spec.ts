import type { BrowserContext, Page } from "@playwright/test";
import { footer } from "./folder-support.ts";
import { openCard, sidebar, statusOf } from "./start-support.ts";
import { closeSettings, openSettingsPage, settingsOf } from "./ai-support.ts";
import { createProject, devPageOnly, editorReady, expect, test } from "./support.ts";

/**
 * The start page, the dialog that makes a project and the panel of the platform in the online mode,
 * as people go through them (docs/design/online-offline.md of AnimaQuill Cloud, 1.2). The development page
 * has a platform in the tab for it with `?account=fake&cloud=fake`, see dev/cloud.ts, which a test
 * sets up through `window.aqCloud`; the real one is tested where it is, in AnimaQuill Cloud.
 * Pictures of every state go to the output of each test, for people to look at.
 */

devPageOnly("a platform in the tab, with ?cloud=fake");
test.use({ withProject: false });

const ADDRESS = "/?account=fake&cloud=fake";

interface Lab {
  platform: {
    projects: Map<string, { name: string; head: number }>;
    removed: string[];
    faults: { unreachable?: boolean; silent: boolean };
    drop(): void;
    workingCopy(id: string): {
      getState(): { manifest: { name: string }; files: Record<string, string> };
    };
    mergeFromRepository(id: string, commands: unknown[], batch?: string): void;
  };
  repositories: {
    choices: unknown[];
    taken: Set<string>;
    linkMs: number;
    archiveMs: number;
    refuseLink: string | undefined;
    statuses: Map<string, { repository?: { fullName: string } }>;
    pause(project: string, reason: string, more?: object): void;
    archived(project: string, at?: number): void;
  };
  seed(name: string, options?: { repository?: string; ago?: number; listed?: object }): string;
}

/**
 * Runs `work` in the page with what the development page has for setting the platform up. It
 * goes there as its text: nothing of this file is there with it but `lab` and `arg`.
 */
const withLab = <T, A = undefined>(
  page: Page,
  work: (lab: Lab, arg: A) => T,
  arg?: A,
): Promise<T> =>
  page.evaluate(`(${work.toString()})(window.aqCloud, ${JSON.stringify(arg)})`) as Promise<T>;

/** Opens the page as somebody who is signed in, or not, with or without the GitHub App. */
async function arrive(page: Page, who: { installed?: boolean } = {}) {
  const state = { signedIn: true, installed: who.installed ?? true };
  await page.addInitScript((kept) => {
    if (window !== window.top) return;
    if (sessionStorage.getItem("animaquill.fakeAccount") === null)
      sessionStorage.setItem("animaquill.fakeAccount", JSON.stringify(kept));
  }, state);
  await page.goto(ADDRESS);
  await editorReady(page);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** The status of syncing, or of a project that does not sync. */
const cloudStatus = (page: Page) => footer(page).locator("[data-cloud-level]");
/** The status of the repository on GitHub: "已同步", "待同步", or what went wrong. */
const githubStatus = (page: Page) => footer(page).locator("[data-github]");
const panel = (page: Page) => page.getByRole("dialog", { name: /^在线 · / });
const row = (page: Page, id: string) => panel(page).locator(`[data-cloud-row="${id}"]`);
/** How the start page has the list of the platform: "ready", "signedOut", "unreadable"… */
const cloudList = (page: Page) => page.locator("[data-cloud-list]").first();

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

test.describe("the start page", () => {
  test("clears this computer only once people know what is only here", async ({ page }) => {
    await arrive(page);
    await withLab(page, (lab) => lab.seed("年会视频", { repository: "annual" }));
    await chooseFrom(page, "文件", "打开在线项目…");
    await openCard(page, "年会视频");
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    // The platform stops answering, and people go on.
    await withLab(page, ({ platform }) => {
      platform.faults.silent = true;
      platform.drop();
    });
    await renameTo(page, "年会视频 改过");
    await expect(page).toHaveTitle("年会视频 改过 - AnimaQuill");
    await chooseFrom(page, "文件", "关闭项目");
    await expect(statusOf(page, "年会视频 改过")).toHaveText(/^有改动还没同步/);
    // The platform answers again, but the change is still only here: it says so.
    await withLab(page, ({ platform }) => {
      platform.faults.silent = false;
      platform.faults.unreachable = false;
    });
    await openSettingsPage(page, "存储和数据");
    const clear = settingsOf(page).locator('[data-setting="storage.clear"]');
    await clear.getByRole("button", { name: "清掉这台电脑上的数据…" }).click();
    const asked = page.getByRole("dialog", { name: "这台电脑上有服务器还没有的东西" });
    await expect(asked).toContainText("「年会视频 改过」：有 1 个改动还没同步到服务器。");
    await expect(asked.getByRole("button", { name: "仍然清掉" })).toBeVisible();
    await shot(page, "clear-unsynced");
    await asked.getByRole("button", { name: "先不清" }).click();
    await expect(asked).toBeHidden();
    // It stays, with what is only here.
    await closeSettings(page);
    await expect(statusOf(page, "年会视频 改过")).toHaveText(/^有改动还没同步/);
  });

  test("lists what this browser has where the platform's list cannot be read", async ({ page }) => {
    await arrive(page);
    await withLab(page, (lab) => lab.seed("年会视频", { repository: "annual" }));
    await chooseFrom(page, "文件", "打开在线项目…");
    await openCard(page, "年会视频");
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
    await withLab(page, (lab) => {
      lab.platform.faults.unreachable = true;
    });
    await chooseFrom(page, "文件", "关闭项目");
    await expect(cloudList(page)).toHaveAttribute("data-cloud-list", "unreadable");
    await expect(page.getByText(/服务器的项目列表读不出来.*列表不是最新的。/)).toBeVisible();
    await expect(statusOf(page, "年会视频")).toHaveText(/^octo\/annual/);
    await shot(page, "start-unreadable");
    // It opens without the platform, and reads the list again when asked.
    await withLab(page, (lab) => {
      lab.platform.faults.unreachable = false;
    });
    await page.getByRole("main").getByRole("button", { name: "再读一次" }).click();
    await expect(cloudList(page)).toHaveAttribute("data-cloud-list", "ready");
  });
});

test.describe("making a new project", () => {
  const making = (page: Page) => page.locator("dialog[data-create-phase]");

  test("makes one of the platform in one press, in the shape people chose, its repository in pinyin", async ({
    page,
  }) => {
    await arrive(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const box = making(page);
    await expect(box).toHaveAccessibleName("新建项目");
    await box.getByRole("textbox", { name: "项目名称" }).fill("原子是什么");
    await box.getByRole("combobox", { name: "画幅" }).selectOption("portrait");
    await expect(box.getByRole("textbox", { name: "仓库名" })).toHaveValue("yuan-zi-shi-shen-me");
    await expect(box.getByText("这个名字可以用")).toBeVisible();
    await shot(page, "new-cloud");
    await box.getByRole("button", { name: "新建", exact: true }).click();
    await expect(box).toHaveAttribute("data-create-phase", /archiving|done/);
    await expect(box.locator('[data-step="place"]')).toHaveAttribute("data-state", "done");
    await shot(page, "new-cloud-steps");
    await box.getByRole("button", { name: /^(关闭|完成)$/ }).click();
    await expect(page).toHaveTitle("原子是什么 - AnimaQuill");
    await expect(cloudStatus(page)).toHaveText("已同步");
    await expect(page.getByLabel("项目分辨率：1080×1920")).toBeVisible();
    expect(
      await withLab(page, ({ platform }) =>
        [...platform.projects.values()].map((each) => each.name),
      ),
    ).toEqual(["原子是什么"]);
  });

  test("custom size, checked as the format says", async ({ page }) => {
    await arrive(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const box = making(page);
    await box.getByRole("combobox", { name: "画幅" }).selectOption("custom");
    await box.getByRole("textbox", { name: "宽" }).fill("0");
    await expect(box.getByText("宽和高要填正整数（像素）。")).toBeVisible();
    await expect(box.getByRole("button", { name: "新建", exact: true })).toBeDisabled();
    await box.getByRole("textbox", { name: "宽" }).fill("1280");
    await box.getByRole("textbox", { name: "高" }).fill("720");
    await box.getByRole("combobox", { name: "帧率" }).selectOption("60");
    await shot(page, "new-custom");
    await box.getByRole("button", { name: "新建", exact: true }).click();
    await expect(page.getByLabel("项目分辨率：1280×720")).toBeVisible();
    await expect(footer(page).getByText("60 帧")).toBeVisible();
  });
});

test.describe("opening from a repository", () => {
  const opening = (page: Page) => page.getByRole("dialog", { name: "从仓库打开" });
  const choice = (id: number, name: string, more: object = {}) => ({
    id,
    owner: "octo",
    name,
    fullName: `octo/${name}`,
    private: true,
    pushable: true,
    empty: false,
    archived: false,
    linked: false,
    ...more,
  });

  test("opens a project of one's own, and makes a new one in an empty repository", async ({
    page,
  }) => {
    await arrive(page);
    const own = await withLab(page, (lab) => lab.seed("旧片子", { repository: "old-film" }));
    await withLab(
      page,
      (lab, choices) => {
        lab.repositories.choices = choices;
      },
      [
        choice(1, "old-film", { linked: true, linkedProject: { id: own, name: "旧片子" } }),
        choice(2, "someone-elses", { linked: true }),
        choice(3, "read-only", { pushable: false }),
        choice(4, "empty-one", { empty: true }),
      ],
    );
    // Three ways in, as the online mode has them.
    await expect(page.locator("[data-new]")).toHaveCount(3);
    await page.locator('[data-new="openRepository"]').click();
    const box = opening(page);
    await expect(box.getByRole("option")).toHaveCount(4);
    await expect(box.getByRole("option", { name: /someone-elses/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(box.getByRole("option", { name: /read-only/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    // Grey ones are no choice: a click selects nothing.
    await box.getByRole("option", { name: /someone-elses/ }).click({ force: true });
    await expect(box.getByRole("button", { name: "打开", exact: true })).toBeDisabled();
    await box.getByRole("option", { name: /empty-one/ }).click();
    await expect(box.getByRole("button", { name: "在这里新建项目" })).toBeEnabled();
    await shot(page, "open-repository");
    await box.getByRole("option", { name: /old-film/ }).dblclick();
    await expect(page).toHaveTitle("旧片子 - AnimaQuill");

    // The menu has it too; an empty repository gets a new project, saved to it.
    await chooseFrom(page, "文件", "从仓库打开…");
    await opening(page)
      .getByRole("option", { name: /empty-one/ })
      .click();
    await opening(page).getByRole("button", { name: "在这里新建项目" }).click();
    const making = page.locator("dialog[data-create-phase]");
    await expect(making.locator('[data-repository="octo/empty-one"]')).toBeVisible();
    await expect(making.getByRole("textbox", { name: "仓库名" })).toHaveCount(0);
    await shot(page, "new-in-repository");
    await making.getByRole("textbox", { name: "项目名称" }).fill("新片子");
    await making.getByRole("button", { name: "新建", exact: true }).click();
    await expect(making).toHaveAttribute("data-create-phase", /archiving|done/);
    await making.getByRole("button", { name: /^(关闭|完成)$/ }).click();
    await expect(page).toHaveTitle("新片子 - AnimaQuill");
    expect(
      await withLab(page, ({ repositories }) =>
        [...repositories.statuses.values()].map((each) => each.repository?.fullName),
      ),
    ).toContain("octo/empty-one");
  });

  test("lets a new project have only a new repository", async ({ page }) => {
    await arrive(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const box = page.locator("dialog[data-create-phase]");
    await expect(box.getByRole("textbox", { name: "仓库名" })).toBeVisible();
    await expect(box.getByRole("radio", { name: "用已有的仓库" })).toHaveCount(0);
    await expect(box.getByRole("button", { name: "从文件夹导入" })).toHaveCount(0);
  });
});

test.describe("the panel of the platform", () => {
  /** A new project of the platform, made in the dialog. */
  async function connected(page: Page) {
    await arrive(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const box = page.locator("dialog[data-create-phase]");
    await box.getByRole("textbox", { name: "项目名称" }).fill("测试项目");
    await box.getByRole("button", { name: "新建", exact: true }).click();
    await expect(box).toHaveAttribute("data-create-phase", /archiving|done/);
    await box.getByRole("button", { name: /^(关闭|完成)$/ }).click();
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "online");
  }

  test("says how many changes wait while there is no network", async ({ page, context }) => {
    await connected(page);
    await goOffline(context, page);
    await expect(cloudStatus(page)).toHaveText("离线");
    await renameTo(page, "离线时的名字");
    await expect(cloudStatus(page)).toHaveText("离线");
    await expect(footer(page).getByRole("button", { name: "同步：离线" })).toBeVisible();
    await expect(cloudStatus(page)).toHaveAttribute("data-cloud", "offline");
    await cloudStatus(page).click();
    await expect(row(page, "sync")).toContainText("离线，1 个改动待发，联网后自动发送");
    await shot(page, "panel-offline");
    await page.keyboard.press("Escape");
    await context.setOffline(false);
    // The change got to the platform, and its repository does not have it yet: on its way there,
    // which does not stand out.
    await expect(cloudStatus(page)).toHaveText("已同步", { timeout: 20_000 });
    await expect(githubStatus(page)).toHaveText("GitHub 仓库待同步");
    await expect(githubStatus(page)).toHaveAttribute("data-github", "pending");
    await githubStatus(page).click();
    await expect(row(page, "archive").getByRole("status")).toContainText("有新改动");
    await shot(page, "panel-unsaved");
    await row(page, "archive").getByRole("button", { name: "现在存档" }).click();
    await expect(row(page, "archive").getByRole("status")).toHaveText("刚刚存过", {
      timeout: 15_000,
    });
    await page.keyboard.press("Escape");
    await expect(cloudStatus(page)).toHaveText("已同步");
    await expect(githubStatus(page)).toHaveText("GitHub 仓库已同步");
  });

  test("stands out where archiving paused, with why and what helps", async ({ page }) => {
    await connected(page);
    await withLab(page, (lab) => {
      const [project] = [...lab.platform.projects.keys()];
      lab.repositories.pause(project!, "protected", {
        detail: "Changes must be made through a pull request.",
      });
    });
    // The window comes back to the front: the editor looks again.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    // Syncing goes on; saving into GitHub stands out, and says why.
    await expect(cloudStatus(page)).toHaveText("已同步");
    await expect(cloudStatus(page)).toHaveAttribute("data-archive", "paused");
    await expect(githubStatus(page)).toHaveText("GitHub 仓库同步失败");
    await expect(githubStatus(page)).toHaveAttribute("data-github", "error");
    await expect(githubStatus(page)).toHaveAttribute(
      "aria-description",
      /^存进 GitHub 失败：GitHub 不让存档写进这个仓库/,
    );
    // Hovering says the same.
    await githubStatus(page).hover();
    await expect(page.getByRole("tooltip")).toContainText("存进 GitHub 失败");
    await shot(page, "github-error-tip");
    await githubStatus(page).click();
    await expect(panel(page).locator('[data-cloud-section="github"]')).toHaveAttribute(
      "data-focused",
      "true",
    );
    await expect(row(page, "archive")).toContainText("存档先停着：GitHub 不让存档写进这个仓库");
    await expect(row(page, "archive")).toContainText(
      "GitHub 的原话：Changes must be made through a pull request.",
    );
    await expect(row(page, "archive").getByRole("button", { name: "现在存档" })).toBeVisible();
    await expect(row(page, "sync")).toContainText("在线，改动都已发送");
    await shot(page, "panel-attention");
  });

  test("says how a repository is gone, and has the way out where it says so", async ({ page }) => {
    await connected(page);
    // Deleted on GitHub: another repository is the way out, right in the line about archiving.
    await withLab(page, (lab) => {
      const [project] = [...lab.platform.projects.keys()];
      lab.repositories.pause(project!, "gone", { gone: "deleted" });
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(githubStatus(page)).toHaveText("GitHub 仓库同步失败");
    await githubStatus(page).click();
    await expect(row(page, "archive")).toContainText("存档先停着：仓库在 GitHub 上被删除了");
    await expect(row(page, "archive")).toContainText("换一个仓库，项目会重新存一份进去");
    await expect(row(page, "archive").getByRole("button", { name: "换一个仓库…" })).toBeVisible();
    // Once, not again at the end.
    await expect(panel(page).getByRole("button", { name: "换一个仓库…" })).toHaveCount(1);
    await shot(page, "panel-gone-deleted");
    await page.keyboard.press("Escape");

    // Out of what the App may reach: putting it back is the way out, and archiving tries again.
    await withLab(page, (lab) => {
      const [project] = [...lab.platform.projects.keys()];
      lab.repositories.pause(project!, "gone", { gone: "unauthorized" });
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("存档先停着：AnimaQuill 不能再访问这个仓库");
    await expect(row(page, "archive").getByRole("button", { name: "现在存档" })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "换一个仓库…" })).toHaveCount(1);
  });
});

/** The network goes away, as the browser finds out. */
async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
}

test.describe("the offline mode of a site without a backend", () => {
  test("the start page and the menu say nothing about one", async ({ page }) => {
    await page.goto("/");
    await editorReady(page);
    await expect(page.getByRole("button", { name: /^新建在线项目/ })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "筛选" })).toHaveCount(0);
    await createProject(page);
    await expect(footer(page).locator(`[data-save-status="sync"]`)).toHaveCount(0);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "在线面板…" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "打开在线项目…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await chooseFrom(page, "文件", "关闭项目");
    await expect(sidebar(page)).toBeVisible();
    await expect(page.getByRole("link", { name: /^测试项目/ })).toBeVisible();
  });
});
