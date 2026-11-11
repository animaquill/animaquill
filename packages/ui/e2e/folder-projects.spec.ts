/**
 * Projects that are folders, the way people go about them in the editor: new in a folder they
 * choose, opened from a folder, dropped in, changed outside, opened again after a reload, found again
 * after it moved, and open in two windows. See `folder-support.ts` for how folders get chosen and
 * dropped in a test.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agreeToCode,
  exampleProject,
  dialog,
  drop,
  footer,
  installChosen,
  nameIn,
  openDropped,
  privateText,
  projectOnDisk,
  putPrivate,
  rename,
  text,
} from "./folder-support.ts";
import { expect, needsDevPage, tab, test } from "./support.ts";

test.use({
  folders: true,
  withProject: false,
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});

test.describe("a project folder", () => {
  test("is where a new project goes, and gets all of it", async ({ page, devPage }) => {
    await installChosen(page);
    await page.reload();
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.getByRole("textbox", { name: "项目名称" }).fill("新的片子");
    if (devPage) {
      // No platform: the name, and then the folder.
      await expect(dialog(page)).toContainText("下一步选一个放项目的文件夹");
      await dialog(page).getByRole("button", { name: "选文件夹…" }).click();
    } else {
      // The site asks which kind first: nobody is signed in, so one of this computer.
      await expect(page.getByRole("radio", { name: /^本地项目/ })).toBeChecked();
      await page.getByRole("button", { name: "新建", exact: true }).click();
    }
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => JSON.parse((await privateText(page, "选的/animaquill.json")) ?? "{}").name)
      .toBe("新的片子");
  });

  test("opens from where people choose, and stays as it was written", async ({ page }) => {
    await installChosen(page);
    await page.reload();
    const files = exampleProject();
    await putPrivate(page, "选的", files);
    await page.getByRole("button", { name: /^打开文件夹/ }).click();
    await agreeToCode(page);
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    // Opening writes nothing that did not change.
    expect(await privateText(page, "选的/notes.json")).toBe(files["notes.json"]);
  });

  test("opens when people drop it, and takes in what changes outside", async ({ page }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    const notes = JSON.parse(text(disk, "notes.json"));
    const before = notes.notes[0].text;
    notes.notes[0].text = "外面改的";
    writeFileSync(join(disk, "notes.json"), JSON.stringify(notes, null, 4));
    const notice = page.getByText("外面改了 1 个文件，已并入。");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    // What came in can be taken back as a whole, and the folder gets that too.
    await page.getByRole("button", { name: "撤销这次" }).click();
    await expect(page.getByText("已撤销这次并入")).toBeVisible();
    await expect.poll(() => JSON.parse(text(disk, "notes.json")).notes[0].text).toBe(before);
  });

  test("opens again after a reload, and after the browser asks once more", async ({ page }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    await page.reload();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    // As after the browser was closed: it has to ask, which takes one press.
    await page.addInitScript(() => {
      const asked = { done: false };
      Object.assign(FileSystemHandle.prototype, {
        queryPermission: async () => (asked.done ? "granted" : "prompt"),
        requestPermission: async () => {
          asked.done = true;
          return "granted";
        },
      });
    });
    await page.reload();
    await expect(tab(page, "preview")).toHaveCount(0);
    await expect(page.getByText("每次访问都允许").first()).toBeVisible();
    await page.getByRole("button", { name: "继续打开“原子是什么”" }).click();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
  });

  test("that moved is found again, with what was not written yet", async ({ page, devPage }) => {
    test.skip(!devPage, needsDevPage("window.aqExecute"));
    const disk = projectOnDisk();
    await openDropped(page, disk);
    const moved = `${disk}-搬走`;
    renameSync(disk, moved);
    // People go on meanwhile, and that cannot be written: it stays until the folder is back.
    await rename(page, "搬走以后改的");
    await expect(footer(page).getByText("找不到文件夹")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByText("找不到“原子是什么”的文件夹")).toBeVisible();
    await drop(page, moved);
    await expect(dialog(page)).toContainText("这是移动过的“原子是什么”吗");
    await dialog(page).getByRole("button", { name: "是，接上原来的" }).click();
    await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => nameIn(moved)).toBe("搬走以后改的");
  });

  test("is written by one window, while another one works on it too", async ({
    page,
    context,
    devPage,
  }) => {
    test.skip(!devPage, needsDevPage("window.aqExecute"));
    const disk = projectOnDisk();
    await openDropped(page, disk);
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(footer(other).getByText("另一个窗口在写这个文件夹")).toBeVisible({
      timeout: 10_000,
    });
    await rename(other, "另一个窗口改的");
    await expect.poll(() => nameIn(disk), { timeout: 10_000 }).toBe("另一个窗口改的");
    await expect(footer(page).getByText("另一个窗口改的")).toBeVisible();
  });
});

test.describe("the list of project folders", () => {
  test("shows them at once while their folders are looked at, and never as projects of the browser", async ({
    page,
  }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "关闭项目" }).click();
    // Looking at a folder takes a while, as on a network drive, or a disk that sleeps.
    await page.addInitScript(() => {
      const prototype = FileSystemHandle.prototype as unknown as {
        queryPermission: (...args: unknown[]) => Promise<PermissionState>;
      };
      const original = prototype.queryPermission;
      prototype.queryPermission = function (this: unknown, ...args: unknown[]) {
        return new Promise((resolve) =>
          setTimeout(() => resolve(original.apply(this, args)), 8000),
        );
      };
    });
    await page.reload();
    await expect(page.getByRole("link", { name: /^原子是什么.*本地 · / })).toBeVisible({
      timeout: 4000,
    });
    await expect(page.locator('main li[data-kind="onlyHere"]')).toHaveCount(0);
  });

  test("opens one by its address after its log went, once the page can ask about its code", async ({
    page,
  }) => {
    const disk = projectOnDisk();
    await openDropped(page, disk);
    const url = page.url();
    const key = new URL(url).searchParams.get("project") as string;
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menuitem", { name: "关闭项目" }).click();
    // The log goes, as when the data of the site is cleared: the folder is the project.
    await page.evaluate(
      (id) =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("animaquill");
          request.addEventListener("error", () => reject(request.error));
          request.addEventListener("success", () => {
            const db = request.result;
            const transaction = db.transaction(["projects", "updates"], "readwrite");
            transaction.objectStore("projects").delete(id);
            const updates = transaction.objectStore("updates");
            const keys = updates.index("project").getAllKeys(id);
            keys.addEventListener("success", () => {
              for (const each of keys.result) updates.delete(each);
            });
            transaction.addEventListener("complete", () => {
              db.close();
              resolve();
            });
            transaction.addEventListener("error", () => reject(transaction.error));
          });
        }),
      key,
    );
    await page.goto(url);
    await agreeToCode(page);
    await expect(tab(page, "preview")).toBeVisible();
    await expect(footer(page).getByText("原子是什么")).toBeVisible();
  });
});
