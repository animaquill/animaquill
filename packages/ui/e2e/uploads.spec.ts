import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { footer } from "./folder-support.ts";
import { createOnline } from "./online-support.ts";
import { devPageOnly, editorReady, expect, tab, test } from "./support.ts";

/**
 * Files of assets into the large file storage of GitHub, as people go through it
 * (docs/design/asset-storage.md of AnimaQuill Cloud, 4.3): where each file is, putting one there,
 * choosing many, how it goes, what goes wrong and what helps, leaving while it goes, and the storage
 * page of the start page. The development page has a platform in the tab for it with
 * `?account=fake&cloud=fake`, see dev/cloud.ts and dev/lfs.ts; the real one is tested in AnimaQuill
 * Cloud (deploy/test/deployment-lfs.spec.ts). Pictures of every state go to the output of each test.
 */

devPageOnly("a platform in the tab, with ?cloud=fake");
test.use({ withProject: false });

const ADDRESS = "/?account=fake&cloud=fake";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
const files = {
  video: {
    name: "采访.mp4",
    mimeType: "video/mp4",
    buffer: readFileSync(new URL("./fixtures/clip.mp4", import.meta.url)),
  },
  other: {
    name: "红蓝.webm",
    mimeType: "video/webm",
    buffer: readFileSync(new URL("./fixtures/red-blue.webm", import.meta.url)),
  },
  image: { name: "封面.png", mimeType: "image/png", buffer: PNG },
};

const shot = (page: Page, name: string) =>
  page.screenshot({ path: test.info().outputPath(`${name}.png`) });

/** A picture in the dark and in the light. */
async function shots(page: Page, name: string) {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: null });
}

interface Lab {
  lfs: {
    pieceMs: number;
    chunk: number;
    pushingFor: number;
    faults: string[];
    pieces: number[];
  };
  lfsAccount: {
    acknowledgedAt: number | undefined;
    repositories: unknown[];
  };
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
  await page.goto(ADDRESS);
  await editorReady(page);
}

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

async function importFiles(page: Page, ...list: (typeof files)[keyof typeof files][]) {
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入" }).click();
  await (await chooser).setFiles(list);
  await expect(page.getByRole("option", { name: list.at(-1)!.name }).first()).toBeVisible();
}

/** The explorer, with the assets of the project. */
async function explorer(page: Page) {
  await tab(page, "explorer").click();
}

const place = (page: Page) => page.getByRole("region", { name: "存放位置" });
const github = (page: Page) => footer(page).locator('[data-save-status="github"]');
const notice = (page: Page, text: string | RegExp) =>
  page.getByRole("status").filter({ hasText: text }).or(page.getByText(text)).first();

/** What the notification that asks first says, before anybody said they know. */
const ASKS = /会放进这个项目的 GitHub 大文件存储/;

/** New assets of an online project, before people said they know: kept here, as people may. */
async function keepHere(page: Page) {
  await expect(notice(page, ASKS)).toBeVisible();
  await page.getByRole("button", { name: "这个项目只放在这个浏览器里" }).click();
  await expect(notice(page, ASKS)).toHaveCount(0);
}

async function properties(page: Page) {
  await chooseFrom(page, "文件", "项目属性…");
  const shown = page.getByTestId("project-properties");
  await shown
    .getByRole("navigation", { name: "项目属性的分组" })
    .getByRole("button", { name: "存放和同步" })
    .click();
  return shown;
}

const defaultStorage = (page: Page) =>
  page.getByTestId("project-properties").getByRole("combobox", { name: "默认存储空间" });

/** A file of a picture this large, dropped on the assets panel, made in the page. */
async function dropLarge(page: Page, name: string, bytes: number) {
  await tab(page, "assets").click();
  // Dropped where the import button is: it is in the panel, which takes what is dropped on it.
  await page.getByRole("button", { name: "导入" }).evaluate(
    (element, { file, length, png }) => {
      const head = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      // A picture, and nothing after its end that a decoder looks at.
      // Of its own content, by its name: the same bytes would be the asset there already.
      const tail = new Uint8Array(length);
      tail[0] = file.length;
      tail[1] = file.charCodeAt(0) % 256;
      transfer.items.add(new File([head, tail], file, { type: "image/png" }));
      for (const type of ["dragenter", "dragover", "drop"])
        element.dispatchEvent(
          new DragEvent(type, { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
    },
    { file: name, length: bytes, png: PNG.toString("base64") },
  );
  await expect(page.getByRole("option", { name }).first()).toBeVisible({ timeout: 30_000 });
}

test.describe("files of assets into the large file storage", () => {
  test("from where each file is, one or many, until they are there", async ({ page }) => {
    test.setTimeout(120_000);
    await arrive(page);
    await createOnline(page, "xuanchuanpian", "宣传片");
    await importFiles(page, files.video, files.other, files.image);
    await explorer(page);

    // Nobody said yet what it means: asked first, and here they stay.
    await keepHere(page);

    await page.getByRole("option", { name: "采访.mp4" }).click();
    await expect(place(page)).toContainText("清理浏览器数据会丢，换电脑、别人、云端 AI 都拿不到。");
    await expect(place(page).getByRole("button", { name: "放进 GitHub 大文件存储" })).toBeEnabled();
    await shot(page, "U1-place-here");

    // Two chosen, and the menu of both: "放在…", how many and how large.
    await page.getByRole("option", { name: "红蓝.webm" }).click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("option", { name: "红蓝.webm" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: /放在…/ }).hover();
    const lfsItem = page.getByRole("menuitem", { name: /GitHub 大文件存储…/ });
    await expect(lfsItem).toContainText("2 个");
    await expect(page.getByRole("menuitem", { name: /云端空间/ })).toBeDisabled();
    await expect(page.getByRole("menuitem", { name: /我的存储/ })).toBeDisabled();
    await shot(page, "U1-menu");
    await page.getByRole("menuitem", { name: "选素材放在哪…" }).click();

    // The dialog: what is chosen, what it comes to, and once what people have to know.
    const dialog = page.locator("dialog[data-places-dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "采访.mp4" })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: "封面.png" })).not.toBeChecked();
    await expect(dialog).toContainText("GitHub 大文件存储：新放进 2 个");
    const start = dialog.getByRole("button", { name: /^开始上传/ });
    await expect(start).toBeDisabled();
    await dialog.getByText("几种放法有什么区别").click();
    await shot(page, "U2-dialog");
    await dialog.getByRole("button", { name: "全部" }).click();
    await expect(dialog).toContainText("新放进 3 个");
    await dialog.getByRole("button", { name: "视频" }).click();
    await expect(dialog).toContainText("新放进 2 个");
    await dialog.getByRole("checkbox", { name: /我知道：放进去以后不能单独删掉/ }).check();
    // Slowly, so that how it goes can be seen.
    await withLab(page, (lab) => {
      lab.lfs.pieceMs = 300;
      lab.lfs.chunk = 4096;
      lab.lfs.pushingFor = 3;
    });
    await start.click();
    await expect(dialog).toHaveCount(0);

    // How it goes: on the status of the repository, and in the panel.
    await expect(github(page)).toContainText(/↑ 素材 \d+%/);
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await expect(place(page)).toContainText("正在放进 GitHub 大文件存储");
    await expect(place(page).getByRole("progressbar")).toBeVisible();
    await expect(page.locator('[data-upload-mark="uploading"]').first()).toBeVisible();
    await shot(page, "U1-uploading");
    await github(page).click();
    const section = page.getByRole("region", { name: "素材" });
    await expect(section).toContainText(/正在上传 \d 个/);
    await shot(page, "U3-panel");
    // Paused there, it stays paused, and goes on.
    const sending = section.locator('[data-upload-row][data-phase="sending"]').first();
    const asset = await sending.getAttribute("data-upload-row");
    const row = section.locator(`[data-upload-row="${asset}"]`);
    await row.getByRole("button", { name: "暂停" }).click();
    await expect(row).toHaveAttribute("data-phase", "paused");
    await shot(page, "U3-paused");
    await row.getByRole("button", { name: "继续" }).click();
    await withLab(page, (lab) => {
      lab.lfs.pieceMs = 0;
      lab.lfs.chunk = 256 * 1024;
    });
    await expect(section).toContainText("今天传完 2 个", { timeout: 30_000 });
    await expect(notice(page, "2 个素材已放进 GitHub 大文件存储")).toBeVisible();
    await shot(page, "U3-done");
    await page.keyboard.press("Escape");

    // There: where, and the picture says so.
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await expect(place(page)).toContainText("GitHub 大文件存储 · octo/xuanchuanpian");
    await expect(place(page).getByRole("link", { name: "在 GitHub 上看" })).toBeVisible();
    await expect(page.locator('[data-upload-mark="lfs"]')).toHaveCount(2);
    await shot(page, "U1-there");

    // Taking it away says the copy there stays.
    await page.getByRole("option", { name: "采访.mp4" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await expect(page.getByRole("dialog")).toContainText("GitHub 大文件存储里的那份不会删掉");
    await shot(page, "remove-note");
    await page.getByRole("button", { name: "取消" }).click();
  });

  test("what goes wrong says why and what helps; nothing goes on that people have to do something about", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await arrive(page);
    await createOnline(page, "shibai", "失败");
    await importFiles(page, files.video, files.other);
    await keepHere(page);
    await withLab(page, (lab) => {
      lab.lfsAccount.acknowledgedAt = Date.now();
      lab.lfs.faults = ["githubQuota"];
    });
    await explorer(page);
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await place(page).getByRole("button", { name: "放进 GitHub 大文件存储" }).click();
    await expect(place(page)).toContainText("GitHub 大文件存储的额度用完了，没传上去");
    await expect(place(page).getByRole("button", { name: /去 GitHub 看额度/ })).toBeVisible();
    await expect(github(page)).toHaveAttribute("data-uploads", "failed");
    await expect(page.locator('[data-upload-mark="failed"]')).toBeVisible();
    await shot(page, "failed-quota");
    await github(page).click();
    await shot(page, "failed-quota-panel");
    await page.keyboard.press("Escape");

    // The file is not the one of its hash: what helps is in the problems.
    await withLab(page, (lab) => {
      lab.lfs.faults = ["changed"];
    });
    await page.getByRole("option", { name: "红蓝.webm" }).click();
    await place(page).getByRole("button", { name: "放进 GitHub 大文件存储" }).click();
    await expect(place(page)).toContainText("文件在上传时变了");
    await expect(place(page).getByRole("button", { name: "打开问题" })).toBeVisible();
    await shot(page, "failed-changed");

    // No network and a busy platform are no failures: it goes on by itself.
    await withLab(page, (lab) => {
      lab.lfs.faults = ["unavailable", "busy"];
    });
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await place(page).getByRole("button", { name: "重试" }).click();
    await expect(place(page)).toContainText(/离线，联网后接着传|服务器忙，稍后自动继续/);
    await shot(page, "offline");
    await expect(place(page)).toContainText("GitHub 大文件存储 ·", { timeout: 30_000 });
  });

  test("leaving while files are on their way asks first; the start page says what is left, and opening goes on", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await arrive(page);
    await createOnline(page, "meichuanwan", "没传完");
    await importFiles(page, files.video);
    await keepHere(page);
    await withLab(page, (lab) => {
      lab.lfsAccount.acknowledgedAt = Date.now();
      lab.lfs.pieceMs = 2000;
      lab.lfs.chunk = 1024;
    });
    await explorer(page);
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await place(page).getByRole("button", { name: "放进 GitHub 大文件存储" }).click();
    await expect(place(page)).toContainText("正在放进 GitHub 大文件存储");
    await chooseFrom(page, "文件", "关闭项目");
    const asking = page.getByRole("dialog", { name: /还有 1 个素材在上传/ });
    await expect(asking).toContainText("关掉以后暂停，下次打开这个项目接着传。");
    await shot(page, "leave-confirm");
    await asking.getByRole("button", { name: "不关，接着传" }).click();
    await expect(place(page)).toContainText("正在放进 GitHub 大文件存储");
    await chooseFrom(page, "文件", "关闭项目");
    await page.getByRole("dialog").getByRole("button", { name: "关掉" }).click();

    // The start page says what is left; opening the project goes on.
    const card = page.locator("[data-card-uploads]");
    await expect(card).toContainText(/↑ \d 个素材没传完，打开后接着传/);
    await shot(page, "start-unfinished");
    await withLab(page, (lab) => {
      lab.lfs.pieceMs = 0;
      lab.lfs.chunk = 256 * 1024;
    });
    await page
      .locator("li[data-project]")
      .filter({ has: card })
      .locator("[data-card-name]")
      .click();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(github(page)).not.toHaveAttribute("data-uploads", /./, { timeout: 30_000 });
    await explorer(page);
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await expect(place(page)).toContainText("GitHub 大文件存储 ·", { timeout: 30_000 });
  });

  test("new assets of an online project go into its repository by themselves; another default moves nothing", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await arrive(page);
    await createOnline(page, "zidong", "自动");
    // Said once before, on another computer: nothing asks.
    await withLab(page, (lab) => {
      lab.lfsAccount.acknowledgedAt = Date.now();
    });
    await importFiles(page, files.video);
    await explorer(page);
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await expect(place(page)).toContainText("GitHub 大文件存储 ·", { timeout: 30_000 });
    await expect(notice(page, ASKS)).toHaveCount(0);
    // Where it is, said once: no folder, and nothing above the place says it again.
    await expect(page.getByText("来自哪里")).toHaveCount(0);

    // The default of the project, in its properties: the repository, and where the assets are.
    const shown = await properties(page);
    await expect(defaultStorage(page)).toHaveValue("lfs");
    await expect(defaultStorage(page).locator("option:checked")).toHaveText(
      "GitHub 大文件存储 · octo/zidong",
    );
    await expect(shown.getByTestId("project-assets")).toContainText(
      "已有的：1 个在 GitHub 大文件存储",
    );
    await shots(page, "properties-default-lfs");
    // Only this computer from now on: a step, which undo takes back.
    await defaultStorage(page).selectOption("local");
    await expect(shown).toContainText("新素材只放在这个浏览器里：清理浏览器数据会丢");
    await shots(page, "properties-default-local");
    await page.keyboard.press("Escape");
    await importFiles(page, files.image);
    await explorer(page);
    await page.getByRole("option", { name: "封面.png" }).click();
    await expect(place(page)).toContainText("只在这个浏览器里");
    await page.waitForTimeout(500);
    await expect(place(page)).toContainText("只在这个浏览器里");
    // What was there before stays there.
    await page.getByRole("option", { name: "采访.mp4" }).click();
    await expect(place(page)).toContainText("GitHub 大文件存储 ·");

    // Back to the repository: what is only here is put there too only where people say so.
    await properties(page);
    await defaultStorage(page).selectOption("lfs");
    await expect(page.getByTestId("project-assets")).toContainText("1 个只在这个浏览器里");
    await page.getByRole("button", { name: "把已有的也换过去…" }).click();
    const dialog = page.locator("dialog[data-places-dialog]");
    await expect(dialog.getByRole("checkbox", { name: "封面.png" })).toBeChecked();
    await shots(page, "properties-move-existing");
    await dialog.getByRole("button", { name: /^开始上传/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("project-assets")).toContainText(
      "已有的：2 个在 GitHub 大文件存储",
      { timeout: 30_000 },
    );
  });

  test("before people said they know: one notification asks, with the large files in it, and sends all", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await arrive(page);
    await createOnline(page, "xianwen", "先问");
    await importFiles(page, files.video);
    await dropLarge(page, "大图.png", 101 * 1024 * 1024);
    // One notification for both imports, the large file in it.
    const asking = notice(page, ASKS);
    await expect(asking).toContainText("新导入的 2 个素材");
    await expect(asking).toContainText("放进去以后不能单独删掉，只能删整个仓库");
    await expect(asking).toContainText("其中「大图.png」有 105.9 MB，会占不少额度。");
    await expect(asking).toContainText("没确认之前，它们只在这个浏览器里。");
    await expect(page.getByRole("status").filter({ hasText: ASKS })).toHaveCount(1);
    await shots(page, "ask-first");
    await explorer(page);
    await page.getByRole("option", { name: "采访.mp4" }).click();
    // Waiting, in this window: the place and the picture say so.
    await expect(place(page)).toContainText("只在这个浏览器里");
    await expect(place(page)).toContainText("等你确认后上传");
    await expect(page.locator('[data-upload-mark="waiting"]').first()).toBeVisible();
    await page.getByRole("button", { name: "知道了，放进去" }).click();
    expect(await withLab(page, (lab) => lab.lfsAccount.acknowledgedAt !== undefined)).toBe(true);
    await expect(place(page)).toContainText("GitHub 大文件存储 ·", { timeout: 30_000 });

    // Said once: a large file after that is told of on its own, and can stay here.
    await dropLarge(page, "又一张.png", 101 * 1024 * 1024);
    const large = notice(page, "会放进 GitHub 大文件存储，占你 GitHub 账号的大文件额度");
    await expect(large).toContainText("「又一张.png」有 105.9 MB");
    await expect(notice(page, ASKS)).toHaveCount(0);
    await shots(page, "large-notice");
    await page.getByRole("button", { name: "这个不放进去" }).click();
    await explorer(page);
    await page.getByRole("option", { name: "又一张.png" }).click();
    await expect(place(page)).toContainText("只在这个浏览器里", { timeout: 30_000 });
  });

  test("the storage page of the start page, and the properties of a project", async ({ page }) => {
    await arrive(page);
    await createOnline(page, "shuxing", "属性");
    await importFiles(page, files.video, files.image);
    await keepHere(page);
    const shown = await properties(page);
    await expect(shown.getByTestId("project-assets")).toContainText("已有的：2 个只在这个浏览器里");
    await page.keyboard.press("Escape");

    await withLab(page, (lab) => {
      lab.lfsAccount.repositories = [
        {
          repo: 1,
          fullName: "octo/xuanchuanpian",
          url: "https://github.com/octo/xuanchuanpian",
          project: { id: "p1", name: "宣传片 v2" },
          files: 7,
          bytes: 2.1 * 1024 ** 3,
        },
        {
          repo: 2,
          fullName: "octo/hunli",
          url: "https://github.com/octo/hunli",
          project: { id: "p2", name: "婚礼快剪" },
          files: 12,
          bytes: 3.3 * 1024 ** 3,
        },
      ];
    });
    await chooseFrom(page, "文件", "关闭项目");
    await page.getByRole("button", { name: "存储空间" }).click();
    const space = page.locator("[data-storage-space]");
    await expect(space.locator('[data-storage-repo="octo/hunli"]')).toContainText("婚礼快剪");
    await expect(space).toContainText("GitHub 不能单独删大文件，只能删整个仓库。");
    await expect(space.getByRole("link", { name: /额度和流量要到 GitHub 上看/ })).toBeVisible();
    await shot(page, "U4-storage");
    await page.setViewportSize({ width: 420, height: 800 });
    await shot(page, "U4-storage-narrow");
  });
});
