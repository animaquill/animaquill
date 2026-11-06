import type { Page } from "@playwright/test";
import { content, createProject, expect, tab, test } from "./support.ts";

const statusName = (page: Page, name: string) =>
  page.locator("footer").getByRole("button", { name, exact: true });
const saved = (page: Page) => expect(page.locator("footer").getByText("已保存")).toBeVisible();

/** How many updates are saved in this browser. */
const countUpdates = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("animaquill");
        open.onsuccess = () => {
          const database = open.result;
          const request = database.transaction("updates").objectStore("updates").count();
          request.onsuccess = () => {
            database.close();
            resolve(request.result);
          };
        };
      }),
  );

async function chooseFrom(page: Page, menu: string, item: string) {
  await page.locator("header").getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

async function renameTo(page: Page, name: string) {
  await chooseFrom(page, "文件", "重命名项目");
  await page.getByRole("textbox", { name: "项目名称" }).fill(name);
  await page.keyboard.press("Enter");
  await expect(statusName(page, name)).toBeVisible();
}

test.describe("without a project", () => {
  test.use({ withProject: false });

  test("shows the start page, not empty panels", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "AnimaQuill" })).toBeVisible();
    await expect(page.getByText("还没有项目，新建一个开始吧。")).toBeVisible();
    await expect(page.getByText("未打开项目")).toBeVisible();
    await expect(tab(page, "preview")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "工作区" })).toHaveCount(0);
  });

  test("says where projects are kept", async ({ page }) => {
    await expect(page.getByText("项目保存在这个浏览器里")).toBeVisible();
  });

  test("offers only what makes sense", async ({ page }) => {
    await page.locator("header").getByRole("button", { name: "视图", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "时间轴", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+KeyP");
    await page.getByRole("combobox", { name: "命令面板" }).fill("时间轴");
    await expect(page.getByText("没有匹配的命令")).toBeVisible();
    await page.getByRole("combobox", { name: "命令面板" }).fill("新建项目");
    await expect(page.getByRole("option")).toHaveCount(1);
  });

  test("does nothing on shortcuts that need a project", async ({ page }) => {
    await page.keyboard.press("Alt+Digit2");
    await page.keyboard.press("Control+KeyZ");
    await expect(page.getByRole("heading", { name: "AnimaQuill" })).toBeVisible();
  });

  test("says so when the address names a project that is not there", async ({ page }) => {
    await page.goto("/?from=mail&project=project_missing#top");
    await expect(page.getByText("没有找到这个项目")).toBeVisible();
    await expect(page.getByText("还没有项目")).toBeVisible();
    expect(new URL(page.url()).search).toBe("?from=mail");
    expect(new URL(page.url()).hash).toBe("#top");

    await page.reload();
    await expect(page.getByText("还没有项目")).toBeVisible();
    await expect(page.getByText("没有找到这个项目")).toHaveCount(0);
  });

  test("creates a project and goes straight into the editor", async ({ page }) => {
    await createProject(page, "我的第一个项目");
    await expect(statusName(page, "我的第一个项目")).toBeVisible();
    await expect(page).toHaveTitle("我的第一个项目 - AnimaQuill");
    await expect(page.getByRole("heading", { name: "AnimaQuill" })).toHaveCount(0);
  });

  test("suggests a name, and needs one", async ({ page }) => {
    await page.getByRole("button", { name: "新建项目" }).click();
    const input = page.getByRole("textbox", { name: "项目名称" });
    await expect(input).toHaveValue("未命名项目");
    await expect(input).toBeFocused();
    await input.fill("   ");
    await expect(page.getByRole("button", { name: "创建" })).toBeDisabled();
    await page.keyboard.press("Enter");
    await expect(input).toBeVisible();
  });

  test("can cancel creating a project", async ({ page }) => {
    await page.getByRole("button", { name: "新建项目" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("还没有项目，新建一个开始吧。")).toBeVisible();
  });

  test("leaves Enter to the input method during composition", async ({ page }) => {
    await page.getByRole("button", { name: "新建项目" }).click();
    const input = page.getByRole("textbox", { name: "项目名称" });
    await input.evaluate((element) => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
      );
    });
    await expect(input).toBeVisible();
  });
});

test.describe("with a project", () => {
  test("comes back after a reload", async ({ page }) => {
    await renameTo(page, "改过的名字");
    await saved(page);
    await page.reload();
    await expect(statusName(page, "改过的名字")).toBeVisible();
    await expect(tab(page, "preview")).toBeVisible();
  });

  test("keeps a change even when the page reloads right after it", async ({ page }) => {
    await renameTo(page, "马上刷新");
    await page.reload();
    await expect(statusName(page, "马上刷新")).toBeVisible();
  });

  test("undoes and redoes with the keyboard", async ({ page }) => {
    await renameTo(page, "第二个名字");
    await page.keyboard.press("Control+KeyZ");
    await expect(statusName(page, "测试项目")).toBeVisible();
    await page.keyboard.press("Control+Shift+KeyZ");
    await expect(statusName(page, "第二个名字")).toBeVisible();
    await page.keyboard.press("Control+KeyZ");
    await page.keyboard.press("Control+KeyY");
    await expect(statusName(page, "第二个名字")).toBeVisible();
  });

  test("undoes from the menu, which knows when there is nothing to undo", async ({ page }) => {
    const edit = page.locator("header").getByRole("button", { name: "编辑", exact: true });
    await edit.click();
    await expect(page.getByRole("menuitem", { name: "撤销" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await renameTo(page, "第二个名字");
    await chooseFrom(page, "编辑", "撤销");
    await expect(statusName(page, "测试项目")).toBeVisible();
    await chooseFrom(page, "编辑", "重做");
    await expect(statusName(page, "第二个名字")).toBeVisible();
  });

  test("shows the shortcuts of undo and redo in the menu", async ({ page }) => {
    await page.locator("header").getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "撤销" })).toContainText("Ctrl+Z");
    await expect(page.getByRole("menuitem", { name: "重做" })).toContainText("Ctrl+Shift+Z");
  });

  test("leaves undo to a text box while typing in it", async ({ page }) => {
    await renameTo(page, "第二个名字");
    await page.keyboard.press("Control+Shift+KeyP");
    await page.keyboard.type("abc");
    await page.keyboard.press("Control+KeyZ");
    await expect(statusName(page, "第二个名字")).toBeVisible();
  });

  test("keeps Ctrl+S away from the browser, even inside a text box", async ({ page }) => {
    const pressed = () =>
      page.evaluate(() => {
        const w = window as unknown as { saveKey?: KeyboardEvent };
        return w.saveKey?.defaultPrevented;
      });
    await page.evaluate(() => {
      window.addEventListener("keydown", (event) => {
        (window as unknown as { saveKey: KeyboardEvent }).saveKey = event;
      });
    });
    await page.keyboard.press("Control+KeyS");
    expect(await pressed()).toBe(true);
    await page.keyboard.press("Control+Shift+KeyP");
    await page.keyboard.press("Control+KeyS");
    expect(await pressed()).toBe(true);
    await saved(page);
  });

  test("renames from the status bar", async ({ page }) => {
    await statusName(page, "测试项目").click();
    const input = page.getByRole("textbox", { name: "项目名称" });
    await expect(input).toHaveValue("测试项目");
    await input.fill("点状态栏改的");
    await page.getByRole("button", { name: "重命名" }).click();
    await expect(statusName(page, "点状态栏改的")).toBeVisible();
  });

  test("does not rename when cancelled", async ({ page }) => {
    await chooseFrom(page, "文件", "重命名项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("不要这个");
    await page.keyboard.press("Escape");
    await expect(statusName(page, "测试项目")).toBeVisible();
  });

  test("goes back to the start page, which lists the project", async ({ page }) => {
    await chooseFrom(page, "文件", "关闭项目");
    await expect(page.getByRole("heading", { name: "最近的项目" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^测试项目/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "最近的项目" })).toBeVisible();
  });

  test("opens again from the start page, with the layout it had", async ({ page }) => {
    await tab(page, "chat").click({ button: "middle" });
    await chooseFrom(page, "文件", "关闭项目");
    await page.getByRole("button", { name: /^测试项目/ }).click();
    await expect(tab(page, "preview")).toBeVisible();
    await expect(tab(page, "chat")).toHaveCount(0);
  });

  test("keeps projects apart", async ({ page }) => {
    await renameTo(page, "项目一");
    await chooseFrom(page, "文件", "新建项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("项目二");
    await page.keyboard.press("Enter");
    await expect(statusName(page, "项目二")).toBeVisible();
    await chooseFrom(page, "文件", "关闭项目");
    await page.getByRole("button", { name: /^项目一/ }).click();
    await expect(statusName(page, "项目一")).toBeVisible();
  });

  test("undo does not reach into another project", async ({ page }) => {
    await renameTo(page, "项目一");
    await chooseFrom(page, "文件", "新建项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("项目二");
    await page.keyboard.press("Enter");
    await expect(statusName(page, "项目二")).toBeVisible();
    await page.keyboard.press("Control+KeyZ");
    await expect(statusName(page, "项目二")).toBeVisible();
  });

  test("asks before removing a project, and can be talked out of it", async ({ page }) => {
    await chooseFrom(page, "文件", "关闭项目");
    const row = page.getByRole("listitem").filter({ hasText: "测试项目" });
    await row.hover();
    await page.getByRole("button", { name: "删除 测试项目" }).click();
    await expect(page.getByText("不能恢复")).toBeVisible();
    await expect(page.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(row).toBeVisible();

    await row.hover();
    await page.getByRole("button", { name: "删除 测试项目" }).click();
    await page.getByRole("button", { name: "删除", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.getByText("还没有项目，新建一个开始吧。")).toBeVisible();
    await page.reload();
    await expect(page.getByText("还没有项目，新建一个开始吧。")).toBeVisible();
  });

  test("does not remove a project by pressing Enter once more", async ({ page }) => {
    await chooseFrom(page, "文件", "关闭项目");
    const row = page.getByRole("listitem").filter({ hasText: "测试项目" });
    await row.hover();
    await page.getByRole("button", { name: "删除 测试项目" }).click();
    await page.keyboard.press("Enter");
    await expect(row).toBeVisible();
  });

  test("keeps its project through a reload, whatever other windows do", async ({
    page,
    context,
  }) => {
    await saved(page);
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(statusName(other, "测试项目")).toBeVisible();
    await chooseFrom(other, "文件", "关闭项目");
    await createProject(other, "新项目");
    await expect(statusName(other, "新项目")).toBeVisible();

    await page.reload();
    await expect(statusName(page, "测试项目")).toBeVisible();
    await other.reload();
    await expect(statusName(other, "新项目")).toBeVisible();
    await other.close();
  });

  test("stays on the start page through a reload, whatever other windows do", async ({
    page,
    context,
  }) => {
    await chooseFrom(page, "文件", "关闭项目");
    const other = await context.newPage();
    await other.goto("/");
    await other.getByRole("button", { name: /^测试项目/ }).click();
    await expect(statusName(other, "测试项目")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "最近的项目" })).toBeVisible();
    await other.close();
  });

  test("a new window starts on the start page, with the project in the list", async ({
    page,
    context,
  }) => {
    await saved(page);
    const other = await context.newPage();
    await other.goto("/");
    await expect(other.getByRole("button", { name: /^测试项目/ })).toBeVisible();
    await expect(tab(other, "preview")).toHaveCount(0);
    await other.close();
  });

  test("the address says which project is open", async ({ page }) => {
    const opened = page.url();
    expect(new URL(opened).searchParams.get("project")).toMatch(/^project_/);

    await chooseFrom(page, "文件", "关闭项目");
    await expect(page.getByRole("heading", { name: "最近的项目" })).toBeVisible();
    expect(new URL(page.url()).search).toBe("");

    await page.getByRole("button", { name: /^测试项目/ }).click();
    await expect(tab(page, "preview")).toBeVisible();
    expect(page.url()).toBe(opened);
  });

  test("a project removed in another window is missed on the next reload", async ({
    page,
    context,
  }) => {
    await saved(page);
    const other = await context.newPage();
    await other.goto("/");
    await other.getByRole("listitem").filter({ hasText: "测试项目" }).hover();
    await other.getByRole("button", { name: "删除 测试项目" }).click();
    await other.getByRole("button", { name: "删除", exact: true }).click();
    await expect(other.getByText("还没有项目")).toBeVisible();
    await other.close();

    await page.reload();
    await expect(page.getByText("没有找到这个项目")).toBeVisible();
    await expect(page.getByText("还没有项目")).toBeVisible();
  });

  test("shows changes from another window of the same project", async ({ page, context }) => {
    await saved(page);
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(statusName(other, "测试项目")).toBeVisible();

    await renameTo(page, "第一个窗口改的");
    await expect(statusName(other, "第一个窗口改的")).toBeVisible();
    await renameTo(other, "第二个窗口改的");
    await expect(statusName(page, "第二个窗口改的")).toBeVisible();
    await other.close();
  });

  test("merges a long log on the next visit, with nothing lost", async ({ page }) => {
    await renameTo(page, "第二个名字");
    await saved(page);
    // How many writes a burst of changes takes depends on the disk, so the log is built by hand.
    // An update that arrives twice does no harm.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open("animaquill");
          open.onsuccess = () => {
            const database = open.result;
            const transaction = database.transaction("updates", "readwrite");
            const updates = transaction.objectStore("updates");
            const read = updates.getAll();
            read.onsuccess = () => {
              const { project, update } = read.result.at(-1);
              for (let i = 0; i < 220; i++) updates.add({ project, update });
            };
            transaction.oncomplete = () => {
              database.close();
              resolve();
            };
          };
        }),
    );
    expect(await countUpdates(page)).toBeGreaterThan(200);

    await page.reload();
    await expect(statusName(page, "第二个名字")).toBeVisible();
    await expect.poll(() => countUpdates(page)).toBe(1);
    await page.reload();
    await expect(statusName(page, "第二个名字")).toBeVisible();
  });
});

test.describe("when saving fails", () => {
  async function breakStorage(page: Page) {
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.add;
      const w = window as unknown as { restoreStorage: () => void };
      w.restoreStorage = () => {
        IDBObjectStore.prototype.add = original;
      };
      IDBObjectStore.prototype.add = () => {
        throw new DOMException("no space", "QuotaExceededError");
      };
    });
  }

  async function renameWithoutSaving(page: Page) {
    await chooseFrom(page, "文件", "重命名项目");
    await page.getByRole("textbox", { name: "项目名称" }).fill("没保存上");
    await page.keyboard.press("Enter");
    await expect(page.locator("footer").getByText("没有保存")).toBeVisible();
  }

  test("says so, keeps the change, and recovers on its own", async ({ page }) => {
    await saved(page);
    await breakStorage(page);
    await renameWithoutSaving(page);
    await expect(page.getByText("改动无法保存到这个浏览器")).toBeVisible();
    await expect(statusName(page, "没保存上")).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { restoreStorage: () => void }).restoreStorage();
    });
    await expect(page.locator("footer").getByText("已保存")).toBeVisible({ timeout: 8000 });
    await expect(page.getByText("改动已经保存好了")).toBeVisible();
    await page.reload();
    await expect(statusName(page, "没保存上")).toBeVisible();
  });

  test("asks before leaving the project, and stays when told to", async ({ page }) => {
    await saved(page);
    await breakStorage(page);
    await renameWithoutSaving(page);
    await chooseFrom(page, "文件", "关闭项目");
    await expect(page.getByRole("dialog", { name: "有改动没有保存" })).toBeVisible();
    await expect(page.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(statusName(page, "没保存上")).toBeVisible();
    await expect(tab(page, "preview")).toBeVisible();

    await chooseFrom(page, "文件", "关闭项目");
    await page.getByRole("button", { name: "仍然离开" }).click();
    await expect(page.getByRole("heading", { name: "最近的项目" })).toBeVisible();
  });

  test("warns before leaving the page", async ({ page }) => {
    await saved(page);
    await breakStorage(page);
    await renameWithoutSaving(page);
    const seen = new Promise<string>((resolve) => {
      page.once("dialog", (dialog) => {
        resolve(dialog.type());
        void dialog.dismiss();
      });
    });
    await page.close({ runBeforeUnload: true });
    expect(await seen).toBe("beforeunload");
  });
});

test.describe("dialogs", () => {
  const openRename = async (page: Page) => {
    await chooseFrom(page, "文件", "重命名项目");
    await expect(page.getByRole("dialog")).toBeVisible();
  };

  test("keep shortcuts away from what is behind them", async ({ page }) => {
    await openRename(page);
    await page.keyboard.press("Alt+Digit2");
    await page.keyboard.press("Control+Shift+KeyP");
    await expect(page.getByRole("combobox", { name: "命令面板" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "剪辑" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("keep the keyboard inside", async ({ page }) => {
    await openRename(page);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const behind = await page.evaluate(
        () => document.activeElement?.closest("header, main, footer") !== null,
      );
      expect(behind).toBe(false);
    }
  });

  test("close by clicking next to them, but not by clicking inside", async ({ page }) => {
    await openRename(page);
    await page.getByRole("dialog").getByRole("heading").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.mouse.click(5, 300);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("hand the focus back", async ({ page }) => {
    await statusName(page, "测试项目").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(statusName(page, "测试项目")).toBeFocused();
  });

  test("get the focus when they come from the command palette", async ({ page }) => {
    await page.keyboard.press("Control+Shift+KeyP");
    await page.getByRole("combobox", { name: "命令面板" }).fill("重命名项目");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "项目名称" })).toBeFocused();
  });

  test("select the text, so that typing replaces it", async ({ page }) => {
    await openRename(page);
    await page.keyboard.type("打字替换");
    await expect(page.getByRole("textbox", { name: "项目名称" })).toHaveValue("打字替换");
  });
});

test.describe("when the data is out of reach", () => {
  test("does not claim there are no projects when the list cannot be read", async ({ page }) => {
    await page.addInitScript(() => {
      IDBObjectStore.prototype.getAll = () => {
        throw new DOMException("broken", "UnknownError");
      };
    });
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText("项目列表读不出来");
    await expect(page.getByText("还没有项目")).toHaveCount(0);
  });

  test("steps aside for a newer version that upgrades the data", async ({ page }) => {
    await saved(page);
    const upgraded = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const request = indexedDB.open("animaquill", 3);
          request.onsuccess = () => {
            request.result.close();
            resolve("upgraded");
          };
          request.onblocked = () => resolve("blocked");
        }),
    );
    expect(upgraded).toBe("upgraded");
    await renameTo(page, "旧页面改的");
    await expect(page.locator("footer").getByText("没有保存")).toBeVisible();
  });

  test("does not write on when another window removed the project", async ({ page, context }) => {
    await saved(page);
    const other = await context.newPage();
    await other.goto("/");
    await other.getByRole("listitem").filter({ hasText: "测试项目" }).hover();
    await other.getByRole("button", { name: "删除 测试项目" }).click();
    await other.getByRole("button", { name: "删除", exact: true }).click();
    await expect(other.getByText("还没有项目")).toBeVisible();
    await other.close();

    await renameTo(page, "项目已经没了");
    await expect(page.locator("footer").getByText("没有保存")).toBeVisible();
    expect(await countUpdates(page)).toBe(0);
  });
});

test.describe("damaged saved data", () => {
  test("still opens what it can, and says so", async ({ page }) => {
    await saved(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const open = indexedDB.open("animaquill");
          open.onsuccess = () => {
            const transaction = open.result.transaction(["updates", "projects"], "readwrite");
            const read = transaction.objectStore("projects").getAll();
            read.onsuccess = () => {
              transaction.objectStore("updates").add({
                project: read.result[0].id,
                update: new Uint8Array([255, 255, 255, 1]),
              });
            };
            transaction.oncomplete = () => resolve();
          };
        }),
    );
    await page.reload();
    await expect(statusName(page, "测试项目")).toBeVisible();
    await expect(page.getByText("部分保存记录损坏了")).toBeVisible();
  });
});

test("a crash of the whole editor leaves a way out of the project", async ({ page, problems }) => {
  // Errors in effects reach the outermost boundary, as a project that breaks the editor would.
  await page.evaluate(() => {
    Object.defineProperty(document, "title", {
      set() {
        throw new Error("Crash on request");
      },
    });
  });
  await chooseFrom(page, "文件", "重命名项目");
  await page.getByRole("textbox", { name: "项目名称" }).fill("让编辑器崩溃");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("编辑器遇到了问题");

  await page.getByRole("button", { name: "回到开始页" }).click();
  await expect(page.getByRole("heading", { name: "最近的项目" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^让编辑器崩溃/ })).toBeVisible();
  // React reports the error it caught, which is exactly what this test provokes.
  const others = problems.filter((text) => !text.includes("Crash on request"));
  problems.splice(0, problems.length, ...others);
});

test("the panels still work after a project was closed and opened", async ({ page }) => {
  await chooseFrom(page, "文件", "关闭项目");
  await page.getByRole("button", { name: /^测试项目/ }).click();
  await expect(tab(page, "preview")).toBeVisible();
  await page.keyboard.press("Alt+Digit2");
  await expect(tab(page, "keyframes")).toBeVisible();
  await page.keyboard.press("Alt+Digit1");
  await expect(content(page, "timeline")).toBeVisible();
});
