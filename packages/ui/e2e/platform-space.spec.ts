import type { Page } from "@playwright/test";
import { cardMenuItems, onlineProjects, projectCard, sidebar } from "./start-support.ts";
import { devPageOnly, editorReady, expect, tab, test } from "./support.ts";

/**
 * What people keep on the platform itself (docs/design/online-offline.md of AnimaQuill Cloud, 1.2
 * and 3.6): the storage page with its projects, letting go of one ("释放") and why one cannot be,
 * the dot of the side bar once it is nearly full, the item of the menu of a card, and the dialog
 * that says it is full as a new project is kept out, which makes room and goes on by itself.
 */

devPageOnly("a platform in the tab, with ?cloud=fake");
test.use({ withProject: false });

const CLOUD = "/?account=fake&cloud=fake";

interface Lab {
  seed(name: string, options?: { repository?: string; ago?: number }): string;
  platform: {
    limits: { storage: number | null; count: number | null };
    padding: Map<string, number>;
    bytesOf(id: string): number;
    space(user: string): { used: number };
    repositories: Map<
      string,
      { id: number; owner: string; name: string; state?: string; reason?: string }
    >;
  };
  repositories: { pause(project: string, reason: string): void };
}

const withLab = <T, A = undefined>(page: Page, work: (lab: Lab, arg: A) => T, arg?: A) =>
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
  await page.goto(CLOUD);
  await editorReady(page);
}

const GB = 1024 ** 3;

/**
 * Projects on the platform: two that can be let go of (the large one with `padding` more), one
 * without a repository and one whose archiving paused, which cannot. The limit is `limit` bytes.
 */
async function seedProjects(page: Page, limit: number | null, count: number | null = 500) {
  return withLab(
    page,
    (lab, arg) => {
      const film = lab.seed("宣传片 v2", { repository: "xuanchuanpian" });
      const wedding = lab.seed("婚礼快剪", { repository: "hunli", ago: 9 * 86_400_000 });
      const lone = lab.seed("草稿");
      const paused = lab.seed("年会开场", { repository: "annual", ago: 30 * 86_400_000 });
      lab.repositories.pause(paused, "archived");
      // ...as the platform's list says why, too.
      const repository = lab.platform.repositories.get(paused);
      if (repository) lab.platform.repositories.set(paused, { ...repository, reason: "archived" });
      lab.platform.padding.set(film, arg.film);
      lab.platform.padding.set(wedding, arg.wedding);
      lab.platform.padding.set(lone, arg.lone);
      lab.platform.padding.set(paused, arg.paused);
      lab.platform.limits.storage = arg.limit;
      lab.platform.limits.count = arg.count;
      return { film, wedding, lone, paused };
    },
    {
      film: 1.6 * GB,
      wedding: 1.1 * GB,
      lone: 0.4 * GB,
      paused: 0.3 * GB,
      limit,
      count,
    },
  );
}

const storageNav = (page: Page) => sidebar(page).getByRole("button", { name: /^存储空间/ });
const platformPart = (page: Page) => page.locator('[data-storage="platform"]');
const row = (page: Page, id: string) =>
  platformPart(page).locator(`[data-platform-project="${id}"]`);
const fullDialog = (page: Page) => page.locator("dialog[data-platform-full]");

/** Pictures of the page as it is: dark and light, and in a narrow window. */
async function shots(page: Page, name: string, { narrow = true } = {}) {
  const dir = test.info().outputPath();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // The colors change over a moment.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}-${scheme}.png` });
  }
  if (narrow) {
    const size = page.viewportSize();
    await page.setViewportSize({ width: 760, height: size?.height ?? 900 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/${name}-narrow.png` });
    if (size) await page.setViewportSize(size);
  }
  await page.emulateMedia({ colorScheme: null });
}

test.describe("what people keep on the platform", () => {
  test("the storage page lists it, lets go of a copy, and says why one cannot be", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await arrive(page);
    const ids = await seedProjects(page, 5 * GB);
    await onlineProjects(page);
    // 3.4 GB of 5: nothing to see in the side bar yet.
    await expect(storageNav(page).locator("[data-storage-dot]")).toHaveCount(0);
    await storageNav(page).click();
    const part = platformPart(page);
    await expect(part.getByRole("heading", { name: "平台上的项目" })).toBeVisible();
    await expect(part).toContainText(/3\.\d GB \/ 5 GB/);
    await expect(part).toContainText("4 / 500 个项目");
    // The largest first.
    await expect(part.locator("[data-platform-project]")).toHaveCount(4);
    const order = await part
      .locator("[data-platform-project]")
      .evaluateAll((rows) => rows.map((each) => each.getAttribute("data-platform-project")));
    expect(order).toEqual([ids.film, ids.wedding, ids.lone, ids.paused]);
    // What cannot be let go of: greyed, why on hovering, what helps beside it.
    const lone = row(page, ids.lone);
    await expect(lone.getByRole("button", { name: "释放" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(lone.getByRole("button", { name: "保存到文件夹…" })).toBeVisible();
    const paused = row(page, ids.paused);
    await expect(paused.getByRole("button", { name: "去处理" })).toBeVisible();
    await paused.getByRole("button", { name: "释放" }).hover();
    await expect(page.getByRole("tooltip")).toContainText("存进 GitHub 停了：");
    await expect(page.getByRole("tooltip")).not.toContainText("?");
    await shots(page, "storage-page-unreleasable");
    await page.mouse.move(0, 0);

    // Letting go of one: asked first, then it says it comes back from GitHub as it is opened.
    await row(page, ids.film).getByRole("button", { name: "释放" }).click();
    const asked = page.getByRole("dialog", { name: "释放“宣传片 v2”在平台上的空间？" });
    await expect(asked).toContainText("下次打开时从 GitHub 取回（慢几秒）");
    await shots(page, "release-confirm", { narrow: false });
    await asked.getByRole("button", { name: "释放", exact: true }).click();
    await expect(row(page, ids.film)).toHaveAttribute("data-platform-state", "released");
    await expect(row(page, ids.film)).toContainText("已释放 · 打开时从 GitHub 取回");
    await expect(row(page, ids.film).getByRole("button", { name: "释放" })).toHaveCount(0);
    await expect(part).toContainText(/1\.\d GB \/ 5 GB/);
    await expect(page.getByText(/已释放“宣传片 v2”，空出 1\.6 GB/)).toBeVisible();
    await shots(page, "storage-page");
    // The card says so too, as the list does.
    await onlineProjects(page);
    await expect(projectCard(page, "宣传片 v2")).toBeVisible();
  });

  test("a dot in the side bar once it is nearly full, and the item of the menu of a card", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await arrive(page);
    // 3.4 GB of 3.6.
    await seedProjects(page, 3.6 * GB);
    await onlineProjects(page);
    const dot = storageNav(page).locator("[data-storage-dot]");
    await expect(dot).toHaveAttribute("data-storage-dot", "near");
    await storageNav(page).hover();
    await expect(page.getByRole("tooltip")).toContainText("平台存储快满了");
    await shots(page, "sidebar-dot");
    await page.mouse.move(600, 600);

    // Of the person's own, where there is a limit: before deleting.
    const items = await cardMenuItems(page, "宣传片 v2");
    expect(items.slice(-2)).toEqual(["释放平台空间…", "删除项目…"]);
    await projectCard(page, "草稿").getByRole("button", { name: "“草稿”的更多操作" }).click();
    const item = page.getByRole("menu").getByRole("menuitem", { name: /释放平台空间…/ });
    await expect(item).toBeDisabled();
    await expect(item).toContainText("没有仓库");
    await expect(item).not.toContainText("释放了就取不回来");
    await shots(page, "card-menu", { narrow: false });
    await page.keyboard.press("Escape");
  });

  test("full: a new project waits, people let go of one, and it is made at once", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await arrive(page);
    // 3.4 GB kept of 3.4: one more byte does not fit.
    const ids = await seedProjects(page, null);
    await withLab(page, (lab) => {
      lab.platform.limits.storage = lab.platform.space("octo").used;
    });
    await onlineProjects(page);
    await expect(storageNav(page).locator("[data-storage-dot]")).toHaveAttribute(
      "data-storage-dot",
      "near",
    );

    await page.getByRole("button", { name: "新建项目" }).first().click();
    const create = page.locator("dialog[data-create-phase]");
    await create.getByRole("textbox", { name: "项目名称" }).fill("新片子");
    await create.getByRole("button", { name: "新建", exact: true }).click();
    const full = fullDialog(page);
    await expect(full).toHaveAttribute("data-platform-full", "storage");
    await expect(full.getByRole("heading", { level: 2 })).toHaveText(
      /^平台存储满了（3\.\d GB \/ 3\.\d GB）$/,
    );
    await expect(full).toContainText("释放或删除别的项目，腾出空间后自动接着做。");
    // The largest; what cannot be let go of says why on its row, with a way out.
    await expect(full.locator("[data-platform-project]")).toHaveCount(4);
    const lone = full.locator(`[data-platform-project="${ids.lone}"]`);
    await expect(lone.getByRole("button", { name: "释放" })).toBeDisabled();
    await expect(lone).toContainText("这个项目没有仓库");
    await expect(lone.getByRole("button", { name: "保存到文件夹…" })).toBeVisible();
    await expect(lone.getByRole("button", { name: "删除" })).toBeVisible();
    await shots(page, "full-storage");
    // Nothing was made meanwhile.
    expect(await withLab(page, (lab) => lab.platform.space("octo").used)).toBeGreaterThan(0);

    await full
      .locator(`[data-platform-project="${ids.wedding}"]`)
      .getByRole("button", { name: "释放" })
      .click();
    // On by itself: the dialog of the new project comes back, and the project is made.
    await expect(full).toHaveCount(0);
    await expect(create).toHaveAttribute("data-create-phase", /working|archiving|done/);
    await expect(create).toHaveAttribute("data-create-phase", /archiving|done/, {
      timeout: 30_000,
    });
    await create.getByRole("button", { name: /^(关闭|完成)$/ }).click();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(page).toHaveTitle("新片子 - AnimaQuill");
    expect(await withLab(page, (lab, wedding) => lab.platform.bytesOf(wedding), ids.wedding)).toBe(
      0,
    );
  });

  test("full of projects: says so apart, lists those changed longest ago, to delete", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await arrive(page);
    const ids = await seedProjects(page, 5 * GB, 4);
    await onlineProjects(page);
    await page.getByRole("button", { name: "新建项目" }).first().click();
    const create = page.locator("dialog[data-create-phase]");
    await create.getByRole("textbox", { name: "项目名称" }).fill("新片子");
    await create.getByRole("button", { name: "新建", exact: true }).click();
    const full = fullDialog(page);
    await expect(full).toHaveAttribute("data-platform-full", "count");
    await expect(full.getByRole("heading", { level: 2 })).toHaveText("在线项目数满了（4 / 4）");
    await expect(full).toContainText("释放不减少项目数");
    // Releasing does not make room here: only deleting.
    await expect(full.getByRole("button", { name: "释放" })).toHaveCount(0);
    const first = full.locator("[data-platform-project]").first();
    await expect(first).toHaveAttribute("data-platform-project", ids.paused);
    await expect(first.getByRole("button", { name: "删除" })).toBeVisible();
    await shots(page, "full-count");
    // Closed: the dialog of the new project says why it stopped, and nothing was made.
    await full.getByRole("button", { name: "关闭" }).click();
    await expect(full).toHaveCount(0);
    await expect(create).toContainText("释放或删除别的项目后再试");
    await expect(create).toHaveAttribute("data-create-phase", "choosing");
  });
});
