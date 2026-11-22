import type { Page } from "@playwright/test";
import { dialog, footer } from "./folder-support.ts";
import { openCard, projectCard } from "./start-support.ts";
import { devPageOnly, editorReady, expect, test } from "./support.ts";

/**
 * Merging what changed on GitHub, as people see it in the editor (the design of the start page of
 * AnimaQuill Cloud, 10): the notice of a merge, the list of operations, the panel and the status
 * bar, the list of conflicts and what people choose there, files that did not go in, a history on
 * GitHub that was rewritten, files GitHub took away, which side merges keep first, and opening a
 * project step by step. On the platform in the tab (`?cloud=fake`, see dev/cloud.ts), which says
 * what a platform with merges on says; the real one is tested in AnimaQuill Cloud.
 */

devPageOnly("a platform in the tab, with ?cloud=fake");
test.use({ withProject: false });

const ADDRESS = "/?account=fake&cloud=fake";

interface Conflict {
  id: string;
  file: string;
  path: string[];
  label: string;
  kind: string;
  lines?: { from: number; to: number };
  around?: { before?: string; after?: string };
  ours?: unknown;
  theirs?: unknown;
  lost: string;
  state: string;
  at: number;
  oursAt?: number;
  theirsAt?: number;
  theirsSha?: string;
  theirsUrl?: string;
}

interface Lab {
  platform: {
    projects: Map<string, { head: number }>;
    faults: { silent: boolean };
    workingCopy(id: string): {
      getState(): { manifest: { name: string }; files: Record<string, string> };
    };
    mergeFromRepository(id: string, commands: unknown[], batch?: string, files?: number): void;
  };
  repositories: {
    archiveMs: number;
    statuses: Map<string, Record<string, unknown>>;
    conflictsOf: Map<string, Conflict[]>;
    asked: { project: string; replace?: string; drop?: string[] }[];
    resolved: { ids: string[]; keep: string; seq?: number }[];
    pause(project: string, reason: string, more?: object): void;
  };
  seed(name: string, options?: { repository?: string; ago?: number; listed?: object }): string;
}

const withLab = <T, A = undefined>(
  page: Page,
  work: (lab: Lab, arg: A) => T,
  arg?: A,
): Promise<T> =>
  page.evaluate(`(${work.toString()})(window.aqCloud, ${JSON.stringify(arg)})`) as Promise<T>;

async function arrive(page: Page, address = ADDRESS) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    if (sessionStorage.getItem("animaquill.fakeAccount") === null)
      sessionStorage.setItem(
        "animaquill.fakeAccount",
        JSON.stringify({ signedIn: true, installed: true }),
      );
  });
  await page.goto(address);
  await editorReady(page);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

const githubStatus = (page: Page) => footer(page).locator("[data-github]");
const cloudStatus = (page: Page) => footer(page).locator("[data-cloud-level]");
const panel = (page: Page) => page.getByRole("dialog", { name: /^在线 · / });
const row = (page: Page, id: string) => panel(page).locator(`[data-cloud-row="${id}"]`);
const conflictsDialog = (page: Page) => page.locator("dialog[data-conflicts]");
const execute = (page: Page, call: object) =>
  page.evaluate(
    (each) => (window as never as { aqExecute: (c: object) => { ok: boolean } }).aqExecute(each).ok,
    call,
  );
const stateOf = (page: Page) =>
  page.evaluate(() =>
    (
      window as never as {
        aqState: () => { manifest: { name: string }; files: Record<string, string> };
      }
    ).aqState(),
  );

/** Has the window ask how archiving goes now, as it does when it comes back to the front. */
const lookAgain = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

/** A project of the platform with a repository, open in this browser. Returns its id. */
async function opened(page: Page, name = "片头动画"): Promise<string> {
  await arrive(page);
  const id = await withLab(
    page,
    (lab, called) => lab.seed(called, { repository: "opening" }),
    name,
  );
  await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "打开在线项目…", exact: true })
    .click();
  await openCard(page, name);
  await expect(page).toHaveTitle(`${name} - AnimaQuill`);
  await expect(cloudStatus(page)).toHaveText("已同步");
  return id;
}

test.describe("merges of what changed on GitHub", () => {
  test("a merge without conflicts: a notice that goes, one operation, the panel says it", async ({
    page,
  }) => {
    const id = await opened(page);
    await withLab(
      page,
      (lab, project) => {
        lab.platform.mergeFromRepository(
          project,
          [{ type: "project.rename", params: { name: "GitHub 上改的名字" } }],
          "m1",
          2,
        );
        const kept = lab.repositories.statuses.get(project)!;
        lab.repositories.statuses.set(project, {
          ...kept,
          merge: { at: Date.now(), sha: "c".repeat(40), files: 2, url: "" },
        });
      },
      id,
    );
    const notice = page.getByText("合并了 GitHub 上的改动：2 个文件");
    await expect(notice).toBeVisible();
    await expect(page).toHaveTitle("GitHub 上改的名字 - AnimaQuill");
    await shot(page, "g1-merged-notice");
    // What it changed, to read.
    await page.getByRole("button", { name: "查看", exact: true }).click();
    await expect(dialog(page)).toContainText("GitHub 上的改动（2 个文件）");
    await expect(dialog(page)).toContainText("GitHub 上改的名字");
    await page.keyboard.press("Escape");
    // One operation, of GitHub's, which can be taken back as a whole (2E).
    await page
      .getByRole("contentinfo")
      .getByRole("button", { name: /^上次的操作：/ })
      .click();
    const list = page.getByRole("dialog", { name: "最近的操作" });
    await expect(list.getByRole("listitem").first()).toContainText("GitHub 上的改动（2 个文件）");
    await expect(list.getByRole("listitem").first()).toContainText("GitHub");
    await expect(list.getByRole("listitem").first().getByRole("button")).toHaveText("撤销这次");
    await page.keyboard.press("Escape");
    // The panel says so with the archive.
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("合并了 GitHub 上的改动（2 个文件），");
    // The notice goes by itself.
    await expect(notice).toHaveCount(0, { timeout: 15_000 });
  });

  test("taking a merge back as a whole: asked first, what came of it, done again, and why not", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const id = await opened(page);
    const original = (await stateOf(page)).manifest.name;
    await withLab(
      page,
      (lab, project) =>
        lab.platform.mergeFromRepository(
          project,
          [
            { type: "project.rename", params: { name: "GitHub 上改的名字" } },
            { type: "file.write", params: { path: "code/title.js", text: "const title = 2;\n" } },
          ],
          "m1",
          2,
        ),
      id,
    );
    await expect(page).toHaveTitle("GitHub 上改的名字 - AnimaQuill");
    // People change one of the places since: that one stays.
    expect(
      await execute(page, {
        type: "file.write",
        params: { path: "code/title.js", text: "const title = 3;\n" },
      }),
    ).toBe(true);
    await expect
      .poll(() =>
        withLab(
          page,
          (lab, project) => lab.platform.workingCopy(project).getState().files["code/title.js"],
          id,
        ),
      )
      .toBe("const title = 3;\n");
    const status = page.getByRole("contentinfo").getByRole("button", { name: /^上次的操作：/ });
    await status.click();
    const list = page.getByRole("dialog", { name: "最近的操作" });
    const merge = list.getByRole("listitem").filter({ hasText: "GitHub 上的改动（2 个文件）" });
    await expect(merge.getByRole("button", { name: "撤销这次" })).toBeVisible();
    await shot(page, "2e-history-undo");
    await merge.getByRole("button", { name: "撤销这次" }).click();
    // Asked first: GitHub goes back too.
    await expect(dialog(page)).toContainText("撤销 GitHub 上合并进来的改动（2 个文件）");
    await expect(dialog(page)).toContainText("下次存档时，GitHub 上也会改回来。");
    await shot(page, "2e-confirm");
    await dialog(page).getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page).toHaveTitle(`${original} - AnimaQuill`);
    expect((await stateOf(page)).files["code/title.js"]).toBe("const title = 3;\n");
    const notices = page.locator("[data-notifications]");
    await expect(notices).toContainText("撤销了 1 处");
    await expect(notices).toContainText("1 处你后来又改过，保留了你的。");
    await shot(page, "2e-partial");
    await notices.getByRole("button", { name: "查看是哪 1 处" }).click();
    await expect(dialog(page)).toContainText("保留了 1 处");
    await shot(page, "2e-partial-list");
    await page.keyboard.press("Escape");
    // The list says it, and does it again from there.
    await status.click();
    await expect(merge).toContainText("已撤销");
    await merge.getByRole("button", { name: "重做这次" }).click();
    await expect(page).toHaveTitle("GitHub 上改的名字 - AnimaQuill");
    // What cannot be taken back is grey, and says why.
    await withLab(
      page,
      (lab, project) => {
        lab.platform.mergeFromRepository(
          project,
          [{ type: "project.rename", params: { name: "很久以前" } }],
          "m2",
          1,
        );
        (lab.platform as unknown as { batchWhy: Map<string, string> }).batchWhy.set("m2", "age");
      },
      id,
    );
    await expect(page).toHaveTitle("很久以前 - AnimaQuill");
    await page.keyboard.press("Escape");
    await status.click();
    const old = list.getByRole("listitem").filter({ hasText: "GitHub 上的改动（1 个文件）" });
    const grey = old.getByRole("button", { name: "撤销这次" });
    await expect(grey).toHaveAttribute("aria-disabled", "true");
    await grey.hover();
    await expect(page.getByRole("tooltip")).toHaveText("撤销记录只留 30 天");
    await shot(page, "2e-grey-hover");
  });

  test("merges while the editor was away are told once as the project opens", async ({ page }) => {
    const id = await opened(page);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "关闭项目", exact: true }).click();
    await withLab(
      page,
      (lab, project) => {
        lab.platform.mergeFromRepository(
          project,
          [{ type: "project.rename", params: { name: "一" } }],
          "a",
          1,
        );
        lab.platform.mergeFromRepository(
          project,
          [{ type: "project.rename", params: { name: "二" } }],
          "b",
          3,
        );
      },
      id,
    );
    await openCard(page, "二");
    const said = "你不在时合并了 GitHub 上的改动（2 次，4 个文件）";
    await expect(page.locator("[data-notifications]").getByText(said)).toHaveCount(1);
    // ...and in the list of operations, as one.
    await expect(
      page.getByRole("contentinfo").getByRole("button", { name: /^上次的操作：/ }),
    ).toContainText(said);
  });

  test("conflicts: the status bar, the notice that stays, the panel, and the list where people choose", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await opened(page);
    expect(
      await execute(page, {
        type: "file.write",
        params: {
          path: "code/title.js",
          text: "const title = 1;\nel.style.fontSize = '84px';\nel.animate();\n",
        },
      }),
    ).toBe(true);
    await expect
      .poll(() =>
        withLab(
          page,
          (lab, project) => lab.platform.workingCopy(project).getState().files["code/title.js"],
          id,
        ),
      )
      .toBeDefined();
    await withLab(
      page,
      (lab, project) => {
        const at = Date.now();
        const sha = "d".repeat(40);
        const github = {
          theirsSha: sha,
          theirsUrl: `https://github.com/octo/opening/commit/${sha}`,
          theirsAt: at - 120_000,
        };
        lab.repositories.conflictsOf.set(project, [
          {
            id: "name",
            file: "animaquill.json",
            path: ["manifest", "name"],
            label: "项目的名字",
            kind: "value",
            ours: "片头动画",
            theirs: "GitHub 上的名字",
            lost: "batch",
            state: "open",
            at,
            oursAt: at - 300_000,
            ...github,
          },
          {
            id: "code",
            file: "code/title.js",
            path: ["files", "code/title.js"],
            label: "code/title.js 第 2 行",
            kind: "lines",
            lines: { from: 1, to: 2 },
            around: { before: "const title = 1;\n", after: "el.animate();\n" },
            ours: "el.style.fontSize = '84px';\n",
            theirs: "el.style.fontSize = '120px';\nel.style.letterSpacing = '4px';\n",
            lost: "batch",
            state: "open",
            at,
            ...github,
          },
          {
            id: "twice",
            file: "code/title.js",
            path: ["files", "code/title.js"],
            label: "code/title.js",
            kind: "check-duplicate",
            lost: "batch",
            state: "open",
            at,
          },
          {
            id: "old",
            file: "animaquill.json",
            path: ["manifest", "description"],
            label: "项目的说明",
            kind: "value",
            ours: "a",
            theirs: "b",
            lost: "batch",
            state: "stale",
            at: at - 1000,
          },
        ]);
        lab.repositories.pause(project, "conflicts", { conflicts: 3 });
      },
      id,
    );
    await lookAgain(page);
    await expect(githubStatus(page)).toHaveText("GitHub 仓库同步失败 · 3 处冲突");
    await expect(githubStatus(page)).toHaveAttribute("data-github-cause", "conflicts");
    await githubStatus(page).hover();
    await expect(
      page.getByText(/存进 GitHub 失败：有 3 处和 GitHub 上的改动冲突。/).first(),
    ).toBeVisible();
    const stays = page.getByText("GitHub 上的改动和这里有 3 处冲突");
    await expect(stays).toBeVisible();
    await shot(page, "g1-conflicts");
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("存档先停着：有 3 处和 GitHub 上的改动冲突");
    await row(page, "archive").getByRole("button", { name: "处理…" }).click();

    const list = conflictsDialog(page);
    await expect(list).toHaveAttribute("data-conflicts", "ready");
    await expect(list).toHaveAccessibleName("和 GitHub 上的改动冲突的地方（3 处）");
    const name = list.locator('[data-conflict="name"]');
    await expect(name.locator('[data-side="here"]')).toContainText("现在用");
    await expect(name.locator('[data-side="here"]')).toContainText("片头动画");
    await expect(name.locator('[data-side="github"]')).toContainText("GitHub 上的名字");
    await expect(
      name.locator('[data-side="github"]').getByRole("button", { name: /存档 ddddddd/ }),
    ).toBeVisible();
    await expect(list.locator('[data-conflict="code"] [data-side="github"]')).toContainText(
      "120px",
    );
    await expect(
      list.locator('[data-conflict="twice"]').getByRole("button", { name: "看过了" }),
    ).toBeVisible();
    await expect(
      list.locator('[data-conflict="twice"]').getByRole("button", { name: "换成 GitHub 的" }),
    ).toHaveCount(0);
    await expect(list.getByText("已处理 1 处")).toBeVisible();
    await shot(page, "g2-conflicts");

    // GitHub's side, as an edit of people's own: Ctrl+Z takes it back.
    await name.getByRole("button", { name: "换成 GitHub 的" }).click();
    await expect(list.locator('[data-conflict="name"]')).toHaveCount(0);
    await expect.poll(async () => (await stateOf(page)).manifest.name).toBe("GitHub 上的名字");
    await expect
      .poll(() => withLab(page, (lab) => lab.repositories.resolved.at(-1)))
      .toMatchObject({ ids: ["name"], keep: "theirs" });
    expect((await withLab(page, (lab) => lab.repositories.resolved.at(-1)))?.seq).toBeGreaterThan(
      0,
    );
    await expect(list.getByText("已处理 2 处")).toBeVisible();

    // Code compared in the code editor, both whole files side by side.
    await list.getByRole("button", { name: "在代码编辑器里对比" }).click();
    await expect(list.locator("[data-compare]")).toBeVisible();
    await expect(list.locator(".monaco-diff-editor")).toBeVisible({ timeout: 20_000 });
    // Monaco has compared them: what differs is marked.
    await expect(list.locator(".line-insert, .char-insert").first()).toBeVisible({
      timeout: 20_000,
    });
    await shot(page, "g2-compare");
    await list.getByRole("button", { name: "取消" }).click();

    // The rest at once.
    await list.getByRole("button", { name: "全部保留这里的" }).click();
    await expect(list.locator("[data-done]")).toContainText("都处理好了");
    await expect(page.getByText(/GitHub 上的改动和这里有 \d+ 处冲突/)).toHaveCount(0);
    await shot(page, "g2-done");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await page.keyboard.press("Control+KeyZ");
    await expect.poll(async () => (await stateOf(page)).manifest.name).toBe("片头动画");
  });

  test("the list of conflicts in a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await opened(page);
    await withLab(
      page,
      (lab, project) => {
        lab.repositories.conflictsOf.set(project, [
          {
            id: "name",
            file: "animaquill.json",
            path: ["manifest", "name"],
            label: "项目的名字",
            kind: "value",
            ours: "片头动画",
            theirs: "GitHub 上的名字",
            lost: "batch",
            state: "open",
            at: Date.now(),
          },
          {
            id: "color",
            file: "timelines/main/timeline.json",
            path: ["timelines", "main", "background"],
            label: "时间轴“主时间轴”的 background",
            kind: "value",
            ours: "#1d2b44",
            theirs: "#402020",
            lost: "batch",
            state: "open",
            at: Date.now(),
          },
        ]);
        lab.repositories.pause(project, "conflicts", { conflicts: 2 });
      },
      id,
    );
    await lookAgain(page);
    await page.getByRole("button", { name: "处理…" }).first().click();
    await expect(conflictsDialog(page)).toHaveAttribute("data-conflicts", "ready");
    await expect(conflictsDialog(page).locator('[data-conflict="color"]')).toContainText("#402020");
    await shot(page, "g2-narrow");
  });

  test("which side merges keep first: in the project's properties, people's only", async ({
    page,
  }) => {
    const id = await opened(page);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "项目属性…", exact: true }).click();
    const props = page.getByTestId("project-properties");
    await props
      .getByRole("navigation", { name: "项目属性的分组" })
      .getByRole("button", { name: "存放和同步", exact: true })
      .click();
    const prefer = props.getByRole("radiogroup", { name: "GitHub 上和这里改了同一处时，先用" });
    await expect(prefer.getByRole("radio", { name: "这里的" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await prefer.getByRole("radio", { name: "GitHub 上的" }).click();
    await expect(prefer.getByRole("radio", { name: "GitHub 上的" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      await withLab(page, (lab, project) => lab.repositories.statuses.get(project)?.["prefer"], id),
    ).toBe("github");
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "g3-prefer");
  });

  test("files on GitHub that did not go in: what was wrong, and the project's version over them", async ({
    page,
  }) => {
    const id = await opened(page);
    await withLab(
      page,
      (lab, project) =>
        lab.repositories.pause(project, "blocked", {
          blocked: [
            {
              path: "timelines/main/timeline.json",
              reason: "invalid",
              detail: "第 12 行：格式不对",
            },
          ],
        }),
      id,
    );
    await lookAgain(page);
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText(
      "GitHub 上的 timelines/main/timeline.json 没有并进来",
    );
    await row(page, "archive").getByRole("button", { name: "查看…" }).click();
    const asked = page.getByRole("dialog", { name: "GitHub 上有文件没有并进来" });
    await expect(asked).toContainText("第 12 行：格式不对");
    await expect(asked.getByRole("button", { name: /在 GitHub 上打开/ })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "g3-blocked");
    await asked.getByRole("button", { name: /用这里的覆盖…/ }).click();
    await dialog(page).getByRole("button", { name: "覆盖", exact: true }).click();
    await lookAgain(page);
    await expect(githubStatus(page)).not.toHaveAttribute("data-github", "error");
  });

  test("a history on GitHub that was rewritten: go on with this, merge GitHub's now, or another repository", async ({
    page,
  }) => {
    const id = await opened(page);
    expect(
      await execute(page, {
        type: "file.write",
        params: { path: "code/secret.js", text: "key\n" },
      }),
    ).toBe(true);
    const sha = "e".repeat(40);
    await withLab(
      page,
      (lab, [project, commit]) =>
        lab.repositories.pause(project!, "rewritten", {
          diverged: {
            sha: commit,
            files: ["code/secret.js"],
            deleted: ["code/secret.js"],
            base: "f".repeat(40),
          },
        }),
      [id, sha],
    );
    await lookAgain(page);
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("GitHub 上的历史被改写了");
    await row(page, "archive").getByRole("button", { name: "处理…" }).click();
    const asked = page.getByRole("dialog", { name: "GitHub 上的历史被改写了" });
    await expect(
      asked.getByRole("button", { name: "以这里的内容接着存（GitHub 上改写后的改动不会进来）" }),
    ).toBeVisible();
    // What going on would commit again is said where people choose that, file by file.
    await expect(asked).not.toContainText("重新提交");
    await expect(asked.getByRole("button", { name: "换一个仓库…" })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "g3-rewritten");
    await asked.getByRole("button", { name: "把 GitHub 上现在的版本并进来" }).click();
    await expect
      .poll(() => withLab(page, (lab) => lab.repositories.asked.at(-1)?.replace))
      .toBe(`merge-now:${sha}`);
  });

  test("files GitHub took away that the project still has: taken out first, never committed again", async ({
    page,
  }) => {
    const id = await opened(page);
    for (const [path, text] of [
      ["code/secret.js", "key\n"],
      ["code/kept.js", "k\n"],
    ])
      expect(await execute(page, { type: "file.write", params: { path, text } })).toBe(true);
    await expect
      .poll(() =>
        withLab(
          page,
          (lab, project) => Object.keys(lab.platform.workingCopy(project).getState().files).length,
          id,
        ),
      )
      .toBeGreaterThan(1);
    const sha = "e".repeat(40);
    await withLab(
      page,
      (lab, [project, commit]) =>
        lab.repositories.pause(project!, "unmerged", {
          diverged: {
            sha: commit,
            files: ["code/changed.js", "code/kept.js", "code/secret.js"],
            deleted: ["code/kept.js", "code/secret.js"],
            base: "f".repeat(40),
          },
        }),
      [id, sha],
    );
    await lookAgain(page);
    await cloudStatus(page).click();
    await expect(row(page, "archive")).toContainText("GitHub 上去掉的 2 个文件还在项目里");
    await row(page, "archive").getByRole("button", { name: "处理…" }).click();
    const asked = page.locator("dialog[data-reconcile]");
    await expect(asked).toContainText("接着存会把 GitHub 上已经去掉的这些文件重新提交。");
    await expect(asked.locator('[data-path="code/secret.js"]')).toBeVisible();
    // Only what GitHub took away is listed; nothing is chosen for people.
    await expect(asked.locator('[data-path="code/changed.js"]')).toHaveCount(0);
    await expect(asked.getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(asked.getByRole("button", { name: "接着存" })).toBeDisabled();
    // One is people's own after all: it goes back; the other goes out of the project first.
    await asked
      .locator('[data-path="code/kept.js"]')
      .getByRole("radio", { name: "重新提交" })
      .check();
    await expect(asked.getByRole("button", { name: "重新提交 1 个，接着存" })).toBeDisabled();
    await asked
      .locator('[data-path="code/secret.js"]')
      .getByRole("radio", { name: "从项目里去掉" })
      .check();
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "g3-unmerged");
    await asked.getByRole("button", { name: "去掉 1 个、重新提交 1 个，接着存" }).click();
    await expect
      .poll(() => withLab(page, (lab) => lab.repositories.asked.at(-1)))
      .toMatchObject({ replace: sha, drop: ["code/secret.js"] });
    await expect.poll(async () => (await stateOf(page)).files["code/secret.js"]).toBeUndefined();
    // People's own choice, said as such: not a change of GitHub's.
    await expect(
      page.locator("[data-notifications]").getByText("按你的选择从项目里去掉了 1 个文件"),
    ).toBeVisible();
    await expect(page.locator("[data-notifications]").getByText(/GitHub 上的改动/)).toHaveCount(0);
    expect((await stateOf(page)).files["code/kept.js"]).toBe("k\n");
  });

  test("the start page: a project whose merge waits for people stands out, saying why", async ({
    page,
  }) => {
    await arrive(page);
    await withLab(page, (lab) =>
      lab.seed("有冲突的", {
        repository: "clash",
        listed: { attention: "conflicts", repository: { state: "paused", reason: "conflicts" } },
      }),
    );
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "打开在线项目…", exact: true })
      .click();
    const card = projectCard(page, "有冲突的");
    await expect(card).toContainText("同步失败");
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "g1-card");
  });
});

test.describe("opening a project step by step", () => {
  test("ticks each step, and says where the platform is slow", async ({ page }) => {
    await arrive(page, `${ADDRESS}&catchUpMs=3000`);
    const id = await withLab(page, (lab) => lab.seed("慢的", { repository: "slow" }));
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "打开在线项目…", exact: true })
      .click();
    await openCard(page, "慢的");
    await expect(cloudStatus(page)).toHaveText("已同步");
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "关闭项目", exact: true }).click();
    // The platform does not answer: opening waits for it, then goes on.
    await withLab(page, (lab) => {
      lab.platform.faults.silent = true;
    });
    void id;
    await openCard(page, "慢的");
    const steps = page.locator("[data-opening]");
    await expect(steps).toBeVisible();
    await expect(steps.locator('[data-step="log"]')).toHaveAttribute("data-state", "done");
    await expect(steps.locator('[data-step="cloud"]')).toHaveAttribute("data-state", "running");
    await expect(footer(page).getByText("正在保存")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, "g4-opening");
    await expect(steps).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText("服务器响应慢，先打开了")).toBeVisible();
  });
});
