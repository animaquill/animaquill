/**
 * Projects of the browser, from before projects were folders, that move into a folder on the disk:
 * from the start page and from the file menu, what people see when it works and when it does not,
 * the copies of their files that stay in the browser until people let them go, and a browser that
 * cannot write folders at all. Chosen folders come from the private storage of the site, see
 * `folder-support.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { dialog, footer, installChosen, privateText } from "./folder-support.ts";
import { content, createProject, expect, resourcesIn, tab, test } from "./support.ts";

test.use({
  folders: true,
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const VIDEO = readFileSync(fileURLToPath(new URL("./fixtures/red.webm", import.meta.url)));
const NAME = "搬家的片子";

const keyOf = (page: Page) => new URL(page.url()).searchParams.get("project") as string;

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

/** Has the next page keep projects in the browser, as before projects were folders, or not. */
async function projectsInBrowser(page: Page, inBrowser: boolean) {
  await page.evaluate((keep) => {
    if (keep) localStorage.setItem("animaquill.projectsInBrowser", "yes");
    else localStorage.removeItem("animaquill.projectsInBrowser");
  }, inBrowser);
  await page.reload();
}

/**
 * A project of the browser with a video and a picture, made before projects were folders, which
 * stays open once they are: the page comes back to it.
 */
async function projectOfTheBrowser(page: Page): Promise<string> {
  await projectsInBrowser(page, true);
  await createProject(page, NAME);
  await tab(page, "assets").click();
  const chooser = page.waitForEvent("filechooser");
  await content(page, "assets").getByRole("button", { name: "导入" }).click();
  await (
    await chooser
  ).setFiles([
    { name: "红色.webm", mimeType: "video/webm", buffer: VIDEO },
    { name: "封面.png", mimeType: "image/png", buffer: PNG },
  ]);
  await expect(resourcesIn(page, "assets")).toHaveCount(2);
  await expect(footer(page).getByText("已保存")).toBeVisible();
  await installChosen(page);
  await projectsInBrowser(page, false);
  await expect(footer(page).getByText(NAME)).toBeVisible();
  return keyOf(page);
}

/** The files of a folder in the private storage of the site, by path. */
const privateFiles = (page: Page, root: string) =>
  page.evaluate(async (path) => {
    let folder = await navigator.storage.getDirectory();
    for (const part of path.split("/")) folder = await folder.getDirectoryHandle(part);
    const found: Record<string, number> = {};
    const walk = async (current: FileSystemDirectoryHandle, prefix: string) => {
      for await (const handle of current.values()) {
        if (handle.kind === "directory") await walk(handle, `${prefix}${handle.name}/`);
        else found[`${prefix}${handle.name}`] = (await handle.getFile()).size;
      }
    };
    await walk(folder, "");
    return found;
  }, root);

/** The files people brought into a project that the browser keeps, apart from what it made. */
const copiesOf = (page: Page, key: string) =>
  page.evaluate(
    (project) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("animaquill");
        request.addEventListener("error", () => reject(request.error));
        request.addEventListener("success", () => {
          const database = request.result;
          const media = database.transaction("media").objectStore("media");
          const keys = media.index("project").getAllKeys(project);
          keys.addEventListener("success", () => {
            database.close();
            const names = (keys.result as [string, string][]).map(([, name]) => name);
            resolve(names.filter((name) => name.startsWith("sha256-")).length);
          });
        });
      }),
    key,
  );

const browserProjects = (page: Page) => page.getByRole("listitem").filter({ hasText: NAME });

test.describe("a project of the browser", () => {
  test("moves from the start page into the folder people choose, and opens as that folder", async ({
    page,
  }) => {
    const key = await projectOfTheBrowser(page);
    await chooseFrom(page, "文件", "关闭项目");
    await expect(page.getByRole("heading", { name: "浏览器里的项目" })).toBeVisible();
    await page.getByRole("button", { name: `把“${NAME}”移到文件夹…` }).click();

    const done = dialog(page);
    await expect(done.getByRole("heading", { name: "已移到文件夹" })).toBeVisible();
    await expect(done).toContainText(`“${NAME}”现在就是文件夹“选的”`);
    await expect(done).toContainText("浏览器里还留着素材文件的副本");
    await done.getByRole("button", { name: "先留着" }).click();

    // It is a project folder now, listed as one, and no project of the browser any more.
    await expect(page.getByRole("heading", { name: "浏览器里的项目" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: new RegExp(`${NAME}.*文件夹：选的`) }),
    ).toBeVisible();
    const files = await privateFiles(page, "选的");
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["animaquill.json", "assets.json", "timelines/main/timeline.json"]),
    );
    expect(Object.values(files)).toEqual(expect.arrayContaining([VIDEO.length, PNG.length]));
    expect(Object.keys(files)).not.toContain("导出未完成.txt");
    expect(await copiesOf(page, key)).toBe(2);

    await page.getByRole("button", { name: new RegExp(`${NAME}.*文件夹：选的`) }).click();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    expect(keyOf(page)).toBe(key);
    await tab(page, "assets").click();
    await expect(resourcesIn(page, "assets")).toHaveCount(2);
    await tab(page, "problems").click();
    await expect(content(page, "problems")).not.toContainText("素材文件");
  });

  test("moves from the file menu while it is open, and goes on as that folder", async ({
    page,
    devPage,
  }) => {
    test.skip(!devPage, "only the development page has window.aqExecute");
    const key = await projectOfTheBrowser(page);
    await chooseFrom(page, "文件", "移到文件夹…");
    await dialog(page).getByRole("button", { name: "先留着" }).click();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    expect(keyOf(page)).toBe(key);
    // What changes from now on goes into the folder.
    await page.evaluate(() =>
      (window as unknown as { aqExecute: (call: unknown) => unknown }).aqExecute({
        type: "project.rename",
        params: { name: "搬家以后" },
      }),
    );
    await expect
      .poll(async () => JSON.parse((await privateText(page, "选的/animaquill.json")) ?? "{}").name)
      .toBe("搬家以后");
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "移到文件夹…" })).toBeDisabled();
    await page.keyboard.press("Escape");
    // After a reload it is the folder too.
    await page.reload();
    await expect(footer(page).getByText("搬家以后")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
  });

  test("stays in the browser where the folder is not what was written, and the folder stays", async ({
    page,
  }) => {
    const key = await projectOfTheBrowser(page);
    // The folder gives back something else than what was written, as a disk can.
    await page.evaluate(() => {
      const { arrayBuffer } = Blob.prototype;
      File.prototype.arrayBuffer = async function changed(this: File) {
        const buffer = await arrayBuffer.call(this);
        if (this.name !== "assets.json") return buffer;
        const text = new TextDecoder().decode(buffer).replace("红色", "绿色");
        return new TextEncoder().encode(text).buffer;
      };
    });
    await chooseFrom(page, "文件", "移到文件夹…");
    const said = dialog(page);
    await expect(said.getByRole("heading", { name: `“${NAME}”没有移到文件夹` })).toBeVisible();
    await expect(said).toContainText("项目还在浏览器里，没有改动");
    await expect(said).toContainText("assets.json：内容和写进去的不一样");
    await said.getByRole("button", { name: "留着看看" }).click();

    // The project goes on in the browser, as it was.
    expect(keyOf(page)).toBe(key);
    expect(await copiesOf(page, key)).toBe(2);
    expect(Object.keys(await privateFiles(page, "选的"))).toContain("导出未完成.txt");
    await chooseFrom(page, "文件", "关闭项目");
    await expect(page.getByRole("heading", { name: "浏览器里的项目" })).toBeVisible();
    await expect(page.getByRole("button", { name: `把“${NAME}”移到文件夹…` })).toBeVisible();
  });

  test("moves while another window has it open, which goes on with the folder", async ({
    page,
    context,
    devPage,
  }) => {
    test.skip(!devPage, "only the development page has window.aqExecute");
    const key = await projectOfTheBrowser(page);
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(footer(other).getByText(NAME)).toBeVisible();

    await chooseFrom(page, "文件", "移到文件夹…");
    await expect(dialog(page)).toContainText(`另外还有 1 个窗口开着“${NAME}”`);
    await dialog(page).getByRole("button", { name: "一起切换" }).click();
    await dialog(page).getByRole("button", { name: "先留着" }).click();

    // The other window hears of it, and goes on as the folder: one of them writes it.
    await expect(other.getByText(`“${NAME}”在另一个窗口里移到了文件夹“选的”`)).toBeVisible();
    await expect(footer(other).getByText("另一个窗口在写这个文件夹")).toBeVisible({
      timeout: 10_000,
    });
    await other.evaluate(() =>
      (window as unknown as { aqExecute: (call: unknown) => unknown }).aqExecute({
        type: "project.rename",
        params: { name: "另一个窗口改的" },
      }),
    );
    await expect
      .poll(async () => JSON.parse((await privateText(page, "选的/animaquill.json")) ?? "{}").name)
      .toBe("另一个窗口改的");
    expect(keyOf(other)).toBe(key);
  });

  test("lets go of the copies of its files in the browser once people say so", async ({ page }) => {
    const key = await projectOfTheBrowser(page);
    await chooseFrom(page, "文件", "移到文件夹…");
    await dialog(page).getByRole("button", { name: "先留着" }).click();
    await chooseFrom(page, "文件", "关闭项目");
    const release = page.getByRole("button", { name: /^释放副本/ });
    await expect(release).toBeVisible();
    await release.click();
    await expect(dialog(page)).toContainText("文件夹里的素材文件不受影响");
    await dialog(page)
      .getByRole("button", { name: /^释放 / })
      .click();
    await expect(page.getByText(/^释放了 /)).toBeVisible();
    await expect(release).toHaveCount(0);
    expect(await copiesOf(page, key)).toBe(0);
    // The project has its files from the folder.
    await page.getByRole("button", { name: new RegExp(`${NAME}.*文件夹：选的`) }).click();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    await tab(page, "problems").click();
    await expect(content(page, "problems")).not.toContainText("素材文件");
  });

  test("whose files were not in the browser says so, and moves all the rest", async ({ page }) => {
    await projectsInBrowser(page, true);
    const folder = fileURLToPath(new URL("../../schema/fixtures/v1", import.meta.url));
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入项目文件夹" }).click();
    await (await chooser).setFiles(folder);
    await dialog(page).getByRole("button", { name: "知道了，打开项目" }).click();
    await expect(dialog(page).getByRole("heading", { name: "项目已导入" })).toBeVisible();
    await dialog(page).getByRole("button", { name: "关闭" }).click();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
    await installChosen(page);
    await projectsInBrowser(page, false);
    await expect(footer(page).getByText("原子是什么")).toBeVisible();

    await chooseFrom(page, "文件", "移到文件夹…");
    const done = dialog(page);
    await expect(done.getByRole("heading", { name: "已移到文件夹" })).toBeVisible();
    await expect(done).toContainText("这些素材的文件移之前就不在浏览器里，文件夹里也没有（7）");
    await expect(done).toContainText("采访");
    await done.getByRole("button", { name: "关闭" }).click();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    expect(await privateText(page, "选的/scenes/title/index.html")).toBe(
      readFileSync(`${folder}/scenes/title/index.html`, "utf8"),
    );
    // The folder does not have them either, which the list of problems says.
    await tab(page, "problems").click();
    await expect(content(page, "problems")).toContainText("素材文件不在这里了");
  });
});

test.describe("a browser that cannot write folders", () => {
  test.beforeEach(async ({ page }) => {
    // What Firefox and Safari do not have, as far as the editor goes. They can write the private
    // folder of the site, so handles there can write.
    await page.addInitScript(() => {
      Object.assign(window, {
        showDirectoryPicker: undefined,
        showOpenFilePicker: undefined,
        showSaveFilePicker: undefined,
        FileSystemObserver: undefined,
      });
      Object.assign(DataTransferItem.prototype, { getAsFileSystemHandle: undefined });
    });
    await page.reload();
  });

  test("says that projects stay in the browser, and has no way to move one", async ({ page }) => {
    await expect(
      page.getByText(
        "这个浏览器不能直接打开电脑上的文件夹，项目存在浏览器里，清除浏览器数据会删掉它们。用 Chrome 或 Edge 可以把项目放在文件夹里。",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "打开项目文件夹…" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "导入项目文件夹" })).toBeVisible();
    await expect(page.getByText("也可以把项目文件夹拖到这里")).toHaveCount(0);

    // A new project is one of the browser, as before.
    await createProject(page, NAME);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "移到文件夹…" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "导入项目文件夹" })).toBeVisible();
    await page.keyboard.press("Escape");

    // It still goes out as a zip file.
    const download = page.waitForEvent("download");
    await chooseFrom(page, "文件", "另存一份…");
    expect((await download).suggestedFilename()).toBe(`${NAME}.zip`);
    await expect(dialog(page).getByText(`打包成了“${NAME}.zip”`)).toBeVisible();
    await dialog(page).getByRole("button", { name: "关闭" }).click();

    await chooseFrom(page, "文件", "关闭项目");
    await expect(page.getByRole("heading", { name: "最近的项目" })).toBeVisible();
    await expect(browserProjects(page)).toHaveCount(1);
    await expect(page.getByRole("button", { name: /移到文件夹/ })).toHaveCount(0);
  });
});
