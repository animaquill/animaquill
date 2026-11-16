import type { Page } from "@playwright/test";
import { dialog, footer } from "./folder-support.ts";
import { cardMenu, openCard, projectCard, showView, statusOf } from "./start-support.ts";
import { devPageOnly, editorReady, expect, test } from "./support.ts";

/**
 * What people see of the platform's copies that go a week after they were last opened (the design
 * of the start page of AnimaQuill Cloud, 1, "实时副本 7 天删除"): a copy that comes back from GitHub
 * says why it takes a moment, on its card and as it opens; a card says when the project was last
 * opened; an error with changes GitHub does not have says in how many days they go; a project with
 * no repository says that it goes as a whole, with the way out right under it; and taking a copy
 * out of the browser says what is lost then. On the platform in the tab (dev/cloud.ts), as the
 * platform says these, see `CloudProjectSummary.releaseAt`. Pictures go to the output of each test.
 */

devPageOnly("a platform in the tab, with ?cloud=fake");
test.use({ withProject: false });

const ADDRESS = "/?account=fake&cloud=fake";
const DAY = 24 * 3600_000;

/** The lab of the development page, as far as these tests use it, see dev/cloud.ts. */
interface Lab {
  platform: {
    wake(user: string, id: string): unknown;
    listed: Map<string, object>;
  };
  repositories: { statuses: Map<string, Record<string, unknown>> };
  seed(name: string, options?: { repository?: string; ago?: number; listed?: object }): string;
}

const withLab = <T, A = undefined>(
  page: Page,
  work: (lab: Lab, arg: A) => T,
  arg?: A,
): Promise<T> =>
  page.evaluate(`(${work.toString()})(window.aqCloud, ${JSON.stringify(arg)})`) as Promise<T>;

async function arrive(page: Page) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    if (sessionStorage.getItem("animaquill.fakeAccount") === null)
      sessionStorage.setItem(
        "animaquill.fakeAccount",
        JSON.stringify({ signedIn: true, installed: true }),
      );
  });
  await page.goto(ADDRESS);
  await editorReady(page);
}

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const githubStatus = (page: Page) => footer(page).locator("[data-github]");
const panel = (page: Page) => page.getByRole("dialog", { name: /^云端 · / });
const row = (page: Page, id: string) => panel(page).locator(`[data-cloud-row="${id}"]`);

test("the cards say what goes, when, and what helps", async ({ page }) => {
  await arrive(page);
  await withLab(
    page,
    (lab, day) => {
      const now = Date.now();
      lab.seed("宣传片 v2", { repository: "promo", listed: { openedAt: now - 2 * 3600_000 } });
      lab.seed("婚礼快剪", {
        repository: "wedding",
        listed: { copy: "restoring", releasedAt: now - day, openedAt: now - 9 * day },
      });
      lab.seed("原子动画", {
        repository: "atoms",
        listed: {
          attention: "conflicts",
          repository: {
            id: 9,
            owner: "ada",
            name: "atoms",
            fullName: "ada/atoms",
            private: true,
            url: "https://github.com/ada/atoms",
            state: "paused",
            reason: "conflicts",
          },
          archive: { seq: 1, behind: true },
          openedAt: now - 4 * day - 3600_000,
          releaseAt: now + 3 * day - 60_000,
        },
      });
      lab.seed("旧项目（没有仓库）", {
        listed: { attention: "noRepository", releaseAt: now + 5 * day, openedAt: now - 2 * day },
      });
      // An hour more than nine days: the page counts from when it last looked at the time.
      lab.seed("课程第 3 集", {
        repository: "course",
        listed: { openedAt: now - 9 * day - 3600_000 },
      });
    },
    DAY,
  );
  await chooseFrom(page, "文件", "打开云端的项目…");

  // Coming back from GitHub, and why.
  await expect(statusOf(page, "婚礼快剪")).toHaveText(/^云端 · 正在从 GitHub 取回…/);
  await expect(statusOf(page, "婚礼快剪")).toHaveAttribute(
    "title",
    /^正在从 GitHub 取回…（平台上的临时内容 7 天没用已清掉）/,
  );
  // When it was last opened, on any computer, on hovering.
  await expect(statusOf(page, "课程第 3 集")).toHaveAttribute("title", "上次打开：9 天前");
  // An error says in how many days what GitHub does not have goes, on hovering only.
  await expect(statusOf(page, "原子动画")).toHaveText(/^GitHub 同步失败/);
  await expect(statusOf(page, "原子动画")).toHaveAttribute(
    "title",
    /如果一直不打开，平台上的这些改动 3 天后清掉。\n上次打开：4 天前$/,
  );
  // One with no repository stands out, with the way out right under it.
  const lone = projectCard(page, "旧项目（没有仓库）");
  await expect(statusOf(page, "旧项目（没有仓库）")).toHaveText(
    /没有 GitHub 仓库，7 天没打开会被删除/,
  );
  await expect(lone.locator("[data-alert]")).toHaveAttribute("data-alert", "true");
  await expect(lone.getByRole("button", { name: "选一个仓库…" })).toBeVisible();
  await shot(page, "p3-cards");

  // Choosing one opens the project, and the dialog that connects it.
  await lone.getByRole("button", { name: "选一个仓库…" }).click();
  await expect(page.locator("dialog[data-connect-phase]")).toBeVisible();
  await shot(page, "p3-choose-repository");
});

test("a copy that comes back from GitHub says why it takes a moment as it opens", async ({
  page,
}) => {
  await arrive(page);
  await withLab(page, (lab) => {
    lab.seed("课程第 4 集", { repository: "course4", listed: { copy: "released" } });
    // The platform takes its time making it again.
    lab.platform.wake = (_user, id) => {
      lab.platform.listed.set(id, { ...lab.platform.listed.get(id), copy: "restoring" });
      return { copy: "restoring" };
    };
  });
  await chooseFrom(page, "文件", "打开云端的项目…");
  await expect(statusOf(page, "课程第 4 集")).toHaveText(/^云端 · 打开时从 GitHub 取回/);
  await openCard(page, "课程第 4 集");
  const coming = page.getByRole("dialog", {
    name: "正在从 GitHub 取回…（平台上的临时内容 7 天没用已清掉）",
  });
  await expect(coming).toBeVisible();
  await shot(page, "p3-loading");
  await coming.getByRole("button", { name: "取消" }).click();
  await expect(coming).toBeHidden();
});

test("in the project, an error says in how many days, and one with no repository that it goes", async ({
  page,
}) => {
  await arrive(page);
  const [atomsId, loneId] = await withLab(page, (lab) => [
    lab.seed("原子动画", { repository: "atoms" }),
    lab.seed("旧项目（没有仓库）", { listed: { attention: "noRepository" } }),
  ]);
  await withLab(
    page,
    (lab, { atoms, lone, day }) => {
      const kept = lab.repositories.statuses.get(atoms);
      lab.repositories.statuses.set(atoms, {
        ...kept,
        state: "paused",
        reason: "conflicts",
        conflicts: 2,
        head: 3,
        archivedSeq: 1,
        dirtySince: Date.now() - day,
        releaseAt: Date.now() + 3 * day - 60_000,
      });
      lab.repositories.statuses.set(lone, {
        state: "none",
        archiving: false,
        head: 1,
        archivedSeq: 0,
        releaseAt: Date.now() + 5 * day,
      });
    },
    { atoms: atomsId, lone: loneId, day: DAY },
  );
  await chooseFrom(page, "文件", "打开云端的项目…");
  await openCard(page, "原子动画");
  await expect(githubStatus(page)).toHaveAttribute("data-github", "error");
  await githubStatus(page).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "平台临时存储只保存 7 天，请尽快处理。如果一直不打开，平台上的这些改动 3 天后清掉。",
  );
  await shot(page, "p3-status-hover");
  await githubStatus(page).click();
  await expect(row(page, "archive")).toContainText("如果一直不打开，平台上的这些改动 3 天后清掉。");
  // The days, in place of the week in general.
  await expect(row(page, "archive")).not.toContainText("平台临时存储只保存 7 天");
  await shot(page, "p3-panel");
  await page.keyboard.press("Escape");

  // Out of the browser: what is lost then.
  await chooseFrom(page, "文件", "关闭项目");
  await cardMenu(page, "原子动画", "从这个浏览器移除…");
  const asked = dialog(page);
  await expect(asked.locator("[data-dialog-warning]")).toHaveText(
    "这个项目还有改动没存进 GitHub（有 2 处冲突）。平台上的临时内容 7 天没打开会清掉；把这个浏览器里的副本也移除以后，这些改动最多再留 7 天，之后就没了。建议先处理好再移除。",
  );
  await expect(asked.getByRole("button", { name: "先不移除" })).toBeFocused();
  await shot(page, "p3-remove");
  await asked.getByRole("button", { name: "先不移除" }).click();
  await expect(statusOf(page, "原子动画")).toBeVisible();

  // One with no repository, in the project.
  await showView(page, "全部项目");
  await openCard(page, "旧项目（没有仓库）");
  await expect(githubStatus(page)).toHaveText("GitHub 仓库没有仓库，7 天没打开会被删除");
  await githubStatus(page).click();
  await expect(row(page, "repository")).toContainText("没有 GitHub 仓库，7 天没打开会被删除");
  await expect(row(page, "repository").getByRole("button", { name: "选仓库…" })).toBeVisible();
  await shot(page, "p3-no-repository");
});
