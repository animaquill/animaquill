import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  code,
  editorTab,
  files,
  LOADING,
  lines,
  openFile,
  replaceAll,
  row,
  save,
} from "./code-support.ts";
import {
  canCapture,
  chooseFolder,
  colorAt,
  content,
  distance,
  expect,
  goTo,
  importFolder,
  openAnyway,
  projectFolder,
  sceneFrames,
  tab,
  test,
} from "./scene-support.ts";

/** Monaco's list of suggestions has no roles that say what is in it. */
const suggestion = (page: Page, text: RegExp) =>
  code(page).locator(".suggest-widget .monaco-list-row").filter({ hasText: text }).first();
const problems = (page: Page) => content(page, "problems");
const status = (page: Page) => page.getByRole("contentinfo");

/** Puts the cursor at the start of the text, wherever a click would end up. */
async function goToStart(page: Page): Promise<void> {
  await lines(page).click();
  await page.keyboard.press("Control+Home");
}

const PAGE = `<!doctype html>
<html>
  <body>
    <p>你好</p>
  </body>
</html>
`;

test.describe.configure({ timeout: 90000 });

test.describe("files and code", () => {
  test.use({ withProject: false });

  const open = (page: Page, extra: Record<string, string> = {}) =>
    importFolder(page, projectFolder({ a: { "index.html": PAGE, ...extra } }, [{}]));

  test("nothing of the code editor loads before a file opens", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (request) => asked.push(request.url()));
    await open(page, { "main.js": "let a = 1;\n" });
    await tab(page, "files").click();
    await expect(row(page, "main.js")).toBeVisible();
    await page.keyboard.press("Alt+2");
    await expect(tab(page, "code")).toBeVisible();
    expect(asked.filter((url) => /monaco/i.test(url))).toEqual([]);
    await openFile(page, "main.js");
    expect(asked.filter((url) => /monaco/i.test(url)).length).toBeGreaterThan(0);
  });

  test("lists the scenes with their files, and shared code", async ({ page }) => {
    await open(page, { "main.js": "", "js/deep.js": "" });
    await tab(page, "files").click();
    await expect(row(page, "场景 a")).toBeVisible();
    await expect(row(page, "index.html")).toBeVisible();
    await expect(row(page, "deep.js")).toBeVisible();
    await expect(row(page, "共用代码")).toBeVisible();
    await row(page, "js").click();
    await expect(row(page, "deep.js")).toBeHidden();
  });

  test("makes, renames and removes files, each of them one step to undo", async ({ page }) => {
    await open(page);
    await tab(page, "files").click();
    await row(page, "index.html").click({ button: "right" });
    await page.getByRole("menuitem", { name: "新建文件" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("new.js");
    await page.keyboard.press("Enter");
    await expect(row(page, "new.js")).toBeVisible();
    await expect(editorTab(page, "new.js")).toBeVisible();
    // A new file is there to be written in.
    await expect(code(page).locator("textarea")).toBeFocused(LOADING);

    await tab(page, "files").click();
    await row(page, "new.js").click({ button: "right" });
    await page.getByRole("menuitem", { name: "改名" }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("renamed.js");
    await page.keyboard.press("Enter");
    await expect(row(page, "renamed.js")).toBeVisible();
    await expect(row(page, "new.js")).toBeHidden();
    await expect(editorTab(page, "renamed.js")).toBeVisible();

    await tab(page, "files").click();
    await row(page, "renamed.js").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
    await expect(row(page, "renamed.js")).toBeHidden();
    await expect(editorTab(page, "renamed.js")).toBeHidden();

    await row(page, "index.html").click();
    await tab(page, "timeline").click();
    await page.keyboard.press("Control+z");
    await tab(page, "files").click();
    await expect(row(page, "renamed.js")).toBeVisible();
  });

  test("works with the keyboard", async ({ page }) => {
    await open(page, { "main.js": "" });
    await tab(page, "files").click();
    await row(page, "main.js").click();
    await files(page).getByRole("tree").focus();
    await page.keyboard.press("F2");
    await page.getByRole("dialog").getByRole("textbox").fill("other.js");
    await page.keyboard.press("Enter");
    await expect(row(page, "other.js")).toBeVisible();
    await files(page).getByRole("tree").focus();
    await page.keyboard.press("Delete");
    await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
    await expect(row(page, "other.js")).toBeHidden();
  });

  test("says why a file that a scene starts with cannot go, and offers the way out", async ({
    page,
  }) => {
    await open(page, { "other.html": "<!doctype html>" });
    await tab(page, "files").click();
    await row(page, "index.html").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
    await expect(page.getByText("这是入口文件")).toBeVisible();
    await expect(row(page, "index.html")).toBeVisible();
    await row(page, "other.html").click({ button: "right" });
    await page.getByRole("menuitem", { name: "设为入口文件" }).click();
    await row(page, "index.html").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
    await expect(row(page, "index.html")).toBeHidden();
  });

  test("colors code by what it is, and completes it", async ({ page }) => {
    await open(page, { "main.js": "const a = 'b';\n", "style.css": "body { color: red; }\n" });
    await openFile(page, "main.js");
    // Words of different kinds have different colors.
    const colors = () =>
      lines(page)
        .locator(".view-line span span")
        .evaluateAll((spans) => new Set(spans.map((span) => getComputedStyle(span).color)).size);
    await expect.poll(colors, LOADING).toBeGreaterThan(2);
    await lines(page).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("document.getEl");
    await expect(suggestion(page, /getElementById/)).toBeVisible(LOADING);
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+End");
    await page.keyboard.press("Shift+Home");
    await page.keyboard.type("aq.");
    await expect(suggestion(page, /asset/)).toBeVisible(LOADING);
    await page.keyboard.press("Escape");

    await openFile(page, "style.css");
    await lines(page).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("a { backgr");
    await expect(suggestion(page, /background-color/)).toBeVisible(LOADING);
    await page.keyboard.press("Escape");

    await openFile(page, "index.html");
    await lines(page).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("<scr");
    await expect(suggestion(page, /script/)).toBeVisible();
  });

  test("speaks the language of the editor around it", async ({ page }) => {
    await open(page);
    await openFile(page, "index.html");
    await lines(page).click();
    await page.keyboard.press("Control+f");
    await expect(code(page).getByPlaceholder("查找")).toBeVisible();
  });

  test("has several tabs, which remember where people were", async ({ page }) => {
    await open(page, { "a.js": "第一个\n", "b.js": "第二个\n" });
    await openFile(page, "a.js");
    await openFile(page, "b.js");
    await expect(lines(page)).toContainText("第二个");
    await goToStart(page);
    await page.keyboard.type("x");
    await editorTab(page, "a.js").click();
    await expect(lines(page)).toContainText("第一个");
    await editorTab(page, "b.js").click();
    await expect(lines(page)).toContainText("x第二个");
  });

  test("shows what is not saved, and saves it with a command", async ({ page }) => {
    await open(page, { "a.js": "one\n" });
    await openFile(page, "a.js");
    await goToStart(page);
    await page.keyboard.type("x");
    await expect(editorTab(page, "● a.js")).toBeVisible();
    await save(page);
    await expect(editorTab(page, "a.js")).toHaveText("a.js");
    // Undoing in the project takes the change back, and the tab follows.
    await tab(page, "timeline").click();
    await page.keyboard.press("Control+z");
    await expect(lines(page)).toContainText("one");
    await expect(lines(page)).not.toContainText("xone");
    await expect(editorTab(page, "a.js")).toHaveText("a.js");
  });

  test("goes on being the editor while somebody types", async ({ page }) => {
    await open(page, { "a.js": "" });
    await openFile(page, "a.js");
    await lines(page).click();
    // Single keys are shortcuts everywhere else, and space would start playing.
    await page.keyboard.type("jkl mc ");
    await expect(lines(page)).toContainText("jkl");
    // In the editing layout the preview is behind the code, so only whether it plays counts.
    await expect(
      content(page, "preview").getByRole("button", { name: "播放", includeHidden: true }),
    ).toHaveCount(1);
    await page.keyboard.press("F1");
    await expect(page.getByPlaceholder("输入命令名称")).toBeVisible();
    await page.keyboard.press("Escape");
    await lines(page).click();
    // The keys for undoing stay with the text, and typing goes back in steps.
    for (let step = 0; step < 4; step += 1) await page.keyboard.press("Control+z");
    await expect(lines(page)).not.toContainText("jkl");
  });

  test("asks before a tab with unsaved edits closes", async ({ page }) => {
    await open(page, { "a.js": "one\n" });
    await openFile(page, "a.js");
    await goToStart(page);
    await page.keyboard.type("x");
    await code(page).getByRole("button", { name: "关闭 a.js" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(lines(page)).toContainText("xone");
    await code(page).getByRole("button", { name: "关闭 a.js" }).click();
    await dialog.getByRole("button", { name: "不保存" }).click();
    await expect(editorTab(page, "a.js")).toBeHidden();
  });

  test("asks before a project with unsaved code closes", async ({ page }) => {
    await open(page, { "a.js": "one\n" });
    await openFile(page, "a.js");
    await goToStart(page);
    await page.keyboard.type("x");
    await page.getByRole("button", { name: "文件" }).first().click();
    await page.getByRole("menuitem", { name: "关闭项目" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "全部保存" }).click();
    await expect(page.getByRole("button", { name: "新建项目" })).toBeVisible();
    await page.getByRole("button", { name: "场景项目" }).first().click();
    await expect(tab(page, "preview")).toBeVisible();
    await openFile(page, "a.js");
    await expect(lines(page)).toContainText("xone");
  });

  test("brings back what was not saved after a reload, without saving it", async ({ page }) => {
    await open(page, { "a.js": "one\n" });
    await openFile(page, "a.js");
    await goToStart(page);
    await page.keyboard.type("mine-");
    // What is typed goes on the device by itself, a moment later.
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByText("找回了 1 个没保存的文件")).toBeVisible(LOADING);
    await tab(page, "code").click();
    await expect(editorTab(page, "● a.js")).toBeVisible();
    await expect(lines(page)).toContainText("mine-one", LOADING);
    // The project itself never got it.
    await code(page).getByRole("button", { name: "关闭 a.js" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "不保存" }).click();
    await openFile(page, "a.js");
    await expect(lines(page)).not.toContainText("mine-");
    await page.reload();
    await expect(tab(page, "preview")).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByText("找回了")).toBeHidden();
  });

  test("keeps what people typed when another window changes the file", async ({
    page,
    context,
  }) => {
    await open(page, { "a.js": "one\n" });
    await openFile(page, "a.js");
    await goToStart(page);
    await page.keyboard.type("mine-");

    const other = await context.newPage();
    await other.goto(page.url());
    await openFile(other, "a.js");
    await replaceAll(other, "theirs\n");
    await save(other);
    await expect(editorTab(other, "a.js")).toHaveText("a.js");

    await expect(code(page).getByRole("alert")).toContainText("在别处改了");
    await expect(lines(page)).toContainText("mine-one");
    // Saving is a question now, and not answering it changes nothing.
    await lines(page).click();
    await save(page);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(lines(other)).toContainText("theirs");

    await code(page).getByRole("button", { name: "留下我的，继续改" }).click();
    await expect(code(page).getByRole("alert")).toBeHidden();
    await lines(page).click();
    await save(page);
    await expect(lines(other)).toContainText("mine-one");
    await expect(editorTab(other, "a.js")).toHaveText("a.js");
    await other.close();
  });

  test("follows another window when nothing is unsaved", async ({ page, context }) => {
    await open(page, { "a.js": "one\n" });
    await openFile(page, "a.js");
    const other = await context.newPage();
    await other.goto(page.url());
    await openFile(other, "a.js");
    await replaceAll(other, "theirs\n");
    await save(other);
    await expect(lines(page)).toContainText("theirs");
    await expect(code(page).getByRole("alert")).toBeHidden();
    await other.close();
  });

  test("takes the other version when people want that, one undo away", async ({
    page,
    context,
  }) => {
    await open(page, { "a.js": "one\n" });
    await openFile(page, "a.js");
    await goToStart(page);
    await page.keyboard.type("mine-");
    const other = await context.newPage();
    await other.goto(page.url());
    await openFile(other, "a.js");
    await replaceAll(other, "theirs\n");
    await save(other);
    await code(page).getByRole("button", { name: "换成别处的版本" }).click();
    await expect(lines(page)).toContainText("theirs");
    await expect(editorTab(page, "a.js")).toHaveText("a.js");
    await lines(page).click();
    await page.keyboard.press("Control+z");
    await expect(lines(page)).toContainText("mine-one");
    await other.close();
  });
});

test.describe("problems", () => {
  test.use({ withProject: false });

  test("come with the import, and stay until people clear them", async ({ page }) => {
    const folder = projectFolder({ a: { "index.html": PAGE } }, [{}]);
    mkdirSync(join(folder, "notes"));
    writeFileSync(join(folder, "notes/left.txt"), "项目用不上这个文件");
    await chooseFolder(page, folder);
    await openAnyway(page);
    await page.getByRole("dialog").getByRole("button").last().click();
    await status(page)
      .getByRole("button", { name: /^问题：/ })
      .click();
    const listed = problems(page).getByText("notes/left.txt", { exact: false });
    await expect(listed).toBeVisible();
    await problems(page).getByRole("button", { name: "清除导入时的问题" }).click();
    await expect(listed).toBeHidden();
    await expect(problems(page).getByText("没有发现问题")).toBeVisible();
  });

  test("of the editor show up while typing, and lead to the line", async ({ page }) => {
    await importFolder(
      page,
      projectFolder({ a: { "index.html": PAGE, "a.js": "let a = 1;\nlet b = ;\n" } }, [{}]),
    );
    await openFile(page, "a.js");
    await status(page)
      .getByRole("button", { name: /^问题：/ })
      .click();
    const listed = problems(page).getByRole("button", { name: /第 2 行/ });
    await expect(listed).toBeVisible(LOADING);
    await expect(
      status(page).getByRole("button", { name: "问题：1 个错误，0 个警告" }),
    ).toBeVisible();
    await expect(problems(page).getByText("scenes/a/a.js")).toBeVisible();
    await tab(page, "timeline").click();
    await tab(page, "problems").click();
    await listed.click();
    // The cursor is where the problem is, and the keyboard is in the editor.
    await expect(code(page).locator("textarea")).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.type("//");
    await expect(lines(page)).toContainText("//let b");
    await expect(listed).toBeHidden();
  });
});

const COLOR = (color: string) => `<!doctype html><style>body { background: ${color} }</style>\n`;
const isColor = async (page: Page, color: readonly number[]) =>
  distance(await colorAt(page, 960, 540), color) < 8;
const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

test.describe("saving a scene", () => {
  test.use({ withProject: false });
  test.skip(!canCapture, "needs a browser that can capture");

  const openWith = (page: Page, sceneFiles: Record<string, string>) =>
    importFolder(page, projectFolder({ a: sceneFiles }, [{ id: "c" }]));

  test("changes the picture, and leaves the playhead where it is", async ({ page }) => {
    await openWith(page, { "index.html": COLOR("#f00") });
    await expect.poll(() => isColor(page, RED)).toBe(true);
    await goTo(page, "0:05/00");
    await page.keyboard.press("Alt+2");
    await openFile(page, "index.html");
    await replaceAll(page, COLOR("#00f"));
    await expect.poll(() => isColor(page, RED)).toBe(true);
    await save(page);
    await expect.poll(() => isColor(page, BLUE)).toBe(true);
    await expect(content(page, "preview").locator("output")).toHaveText("0:05/00");
  });

  test("shows the same moment afterwards, with the old picture until then", async ({ page }) => {
    const slide = (color: string) => `<!doctype html><style>
      body { background: #000 }
      #square { position: absolute; left: 0; top: 490px; width: 100px; height: 100px;
        background: ${color}; animation: slide 10s linear both }
      @keyframes slide { to { transform: translateX(1920px) } }
    </style><div id="square"></div>`;
    await openWith(page, { "index.html": slide("#f00") });
    await goTo(page, "0:05/00");
    const at = (x: number) => colorAt(page, x, 540);
    await expect.poll(async () => distance(await at(1010), RED)).toBeLessThan(8);
    await page.keyboard.press("Alt+2");
    await openFile(page, "index.html");
    await replaceAll(page, slide("#00f"));
    await save(page);
    const seen: number[] = [];
    await expect
      .poll(async () => {
        const start = await at(50);
        if (distance(start, [0, 0, 0]) > 8) seen.push(1);
        return distance(await at(1010), BLUE);
      })
      .toBeLessThan(8);
    expect(seen).toEqual([]);
  });

  test("keeps the picture when the code does not parse, and leads to the line", async ({
    page,
    problems: logged,
  }) => {
    const good = `<!doctype html><script src="main.js"></script>`;
    const js = (color: string) =>
      `const color = "${color}";\ndocument.documentElement.style.background = color;\n`;
    await openWith(page, { "index.html": good, "main.js": js("#f00") });
    await expect.poll(() => isColor(page, RED)).toBe(true);
    await page.keyboard.press("Alt+2");
    await openFile(page, "main.js");
    await replaceAll(page, `const color = "#00f";\nconst = 1;\n`);
    await save(page);

    await expect(content(page, "preview").getByText(/SyntaxError/)).toBeVisible();
    expect(await isColor(page, RED)).toBe(true);

    await status(page)
      .getByRole("button", { name: /^问题：/ })
      .click();
    const listed = problems(page).getByRole("button", { name: /代码出错.*场景 a.*第 2 行/ });
    await expect(listed).toBeVisible();
    await listed.click();
    await expect(editorTab(page, "main.js")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await page.keyboard.type("//");
    await expect(lines(page)).toContainText("//const = 1");

    await replaceAll(page, js("#00f"));
    await save(page);
    await expect.poll(() => isColor(page, BLUE)).toBe(true);
    await expect(listed).toBeHidden();
    await expect(content(page, "preview").getByText(/SyntaxError/)).toBeHidden();
    // The error of the scene is its own, and it gets logged as such.
    logged.splice(0);
  });

  test("lists what a scene gets wrong while it runs, and only says so once", async ({
    page,
    problems: logged,
  }) => {
    const broken = `<!doctype html><script>
      setTimeout(() => missing(), 0);
      for (let i = 0; i < 5; i += 1) setTimeout(() => { throw new Error("第 " + i + " 个") }, 0);
    </script>`;
    await openWith(page, { "index.html": broken });
    await goTo(page, "0:01/00");
    await expect(status(page).getByRole("button", { name: /问题：6 个错误/ })).toBeVisible();
    await expect(page.getByText(/^“场景 a”：/)).toHaveCount(1);
    await tab(page, "problems").click();
    await expect(problems(page).getByRole("button", { name: /第 2 行/ })).toBeVisible();
    // The errors of the scene are its own, and they get logged as such.
    logged.splice(0);
  });

  test("keeps up with several saves in a row", async ({ page }) => {
    await openWith(page, { "index.html": COLOR("#f00") });
    await expect.poll(() => isColor(page, RED)).toBe(true);
    await page.keyboard.press("Alt+2");
    await openFile(page, "index.html");
    for (const color of ["#0f0", "#ff0", "#0ff", "#f0f", "#fff", "#00f"]) {
      await replaceAll(page, COLOR(color));
      await save(page);
    }
    await expect.poll(() => isColor(page, BLUE), { timeout: 10000 }).toBe(true);
    await expect.poll(() => sceneFrames(page).length).toBe(1);
  });
});
