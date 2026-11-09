import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { content, expect, resourcesIn, tab, test } from "./support.ts";

/**
 * The explorer: the sources of resources, where each is used, and looking after those of the
 * project, also the ones that are missing. See docs/design/resource-panels.md, section 1.
 */

test.use({ withProject: false });

/** Screenshots to look at, in the output of each test. */
const shot = (name: string) => ({ path: test.info().outputPath(name) });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(44 + samples);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate, 28);
  data.writeUInt16LE(1, 32);
  data.writeUInt16LE(8, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples, 40);
  for (let index = 0; index < samples; index += 1) data[44 + index] = index % 2 ? 188 : 68;
  return data;
}

interface TimelineFile {
  tracks: { kind: string; clips: unknown[] }[];
  sections: { duration: string }[];
}

const image = (asset: string) => ({ kind: "image", media: { asset } });

/**
 * A project with a picture used twice, once with a fade in and once with a blur, a sound, and a
 * picture whose file is not there. It comes in as a folder of files.
 */
async function open(page: Page) {
  const files = ProjectStore.create(createProject({ name: "资源项目" })).exportFiles().files;
  files.set(
    "assets.json",
    JSON.stringify({
      assets: {
        cover: { name: "封面.png", kind: "image", path: "assets/cover.png", storage: "local" },
        voice: { name: "配音.wav", kind: "audio", path: "assets/voice.wav", storage: "local" },
        gone: { name: "丢了.png", kind: "image", path: "assets/gone.png", storage: "local" },
      },
    }),
  );
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as TimelineFile;
  const video = timeline.tracks.find(({ kind }) => kind === "video");
  const audio = timeline.tracks.find(({ kind }) => kind === "audio");
  const section = timeline.sections[0];
  if (!video || !audio || !section) throw new Error("no room for clips");
  section.duration = "10";
  video.clips = [
    {
      id: "a",
      name: "开头",
      start: "0",
      duration: "3",
      source: image("cover"),
      enter: { type: "fade", duration: "0.5" },
    },
    {
      id: "b",
      name: "中间",
      start: "3",
      duration: "3",
      source: image("cover"),
      effects: [{ id: "fx", type: "blur" }],
    },
    { id: "c", name: "结尾", start: "6", duration: "3", source: image("gone") },
  ];
  audio.clips = [
    {
      id: "v",
      name: "旁白",
      start: "0",
      duration: "2",
      source: { kind: "audio", media: { asset: "voice" } },
    },
  ];
  files.set(path, JSON.stringify(timeline));
  const folder = mkdtempSync(join(tmpdir(), "animaquill-project-"));
  try {
    for (const [name, text] of files) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      writeFileSync(join(folder, name), text);
    }
    mkdirSync(join(folder, "assets"), { recursive: true });
    writeFileSync(join(folder, "assets/cover.png"), PNG);
    writeFileSync(join(folder, "assets/voice.wav"), wav(2));
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入项目文件夹" }).click();
    await (await chooser).setFiles(folder);
    // The file that is not there is said once.
    const report = page.getByRole("dialog");
    await expect(report.getByText("丢了.png")).toBeVisible({ timeout: 120_000 });
    await report.getByRole("button", { name: "关闭" }).click();
    await expect(tab(page, "preview")).toBeVisible();
  } finally {
    rmSync(folder, { recursive: true });
  }
  await tab(page, "explorer").click();
  await expect(panel(page)).toBeVisible();
}

const panel = (page: Page) => content(page, "explorer");
const node = (page: Page, name: string) => panel(page).locator(`[data-node="${name}"]`);
const items = (page: Page) => resourcesIn(page, "explorer");
const item = (page: Page, name: string) =>
  panel(page).getByRole("option", { name, exact: true }).first();
const details = (page: Page) => panel(page).getByRole("region", { name: "详情" });
const uses = (page: Page) =>
  details(page).getByRole("list", { name: "在哪里用到" }).getByRole("button");
const clips = (page: Page) => content(page, "timeline").getByRole("option");

test("lists the sources, and what each of them has", async ({ page }) => {
  await open(page);
  await expect(panel(page).getByRole("treeitem")).toHaveText([
    "内置",
    "转场",
    "效果",
    "本项目",
    "素材",
    "场景",
    "声音",
    "转场",
    "效果",
    "缺失的资源（1）",
    "关联的素材库",
  ]);
  await node(page, "project").click();
  await expect(items(page)).toHaveCount(3);
  await expect(panel(page).getByRole("group", { name: "图片" }).getByRole("option")).toHaveCount(2);
  await item(page, "封面.png").click();
  await expect(details(page).getByRole("heading", { name: "封面.png" })).toBeVisible();
  await expect(details(page)).toContainText("项目文件夹里的 assets/cover.png");
  await panel(page).screenshot(shot("explorer-project.png"));

  // What comes with the editor can be looked at, and copied once projects can have their own.
  await node(page, "built-in").click();
  await expect(item(page, "淡入")).toBeVisible();
  await expect(item(page, "模糊")).toBeVisible();
  await node(page, "built-in.effects").click();
  await expect(item(page, "淡入")).toHaveCount(0);
  await item(page, "模糊").click();
  await expect(details(page).getByRole("button", { name: /复制到本项目/ })).toBeDisabled();
  await expect(details(page)).toContainText("编辑器自带");
  await panel(page).screenshot(shot("explorer-built-in.png"));

  await node(page, "project.transitions").click();
  await expect(panel(page).getByText("项目里还不能放自己的转场")).toBeVisible();
  await node(page, "libraries").click();
  await expect(panel(page).getByText("阶段 8")).toBeVisible();
  // The keyboard goes through the tree.
  await node(page, "libraries").press("ArrowUp");
  await expect(node(page, "missing")).toHaveAttribute("aria-selected", "true");
});

test("says where something is used, and goes there", async ({ page }) => {
  await open(page);
  await node(page, "project.media").click();
  await item(page, "封面.png").click();
  await expect(uses(page)).toHaveText(["开头，0:00", "中间，0:03"]);
  await uses(page).nth(1).click();
  await expect(content(page, "timeline")).toBeVisible();
  await expect(clips(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(clips(page).first()).toHaveAttribute("aria-selected", "false");

  // Transitions and effects say which clip has them.
  await tab(page, "explorer").click();
  await node(page, "built-in.effects").click();
  await item(page, "模糊").click();
  await expect(uses(page)).toHaveText(["中间 的效果，0:03"]);
  await node(page, "built-in.transitions").click();
  await item(page, "淡入").click();
  await expect(uses(page)).toHaveText(["开头 的入转场，0:00"]);
  await details(page).screenshot(shot("explorer-uses.png"));
  await item(page, "淡出").click();
  await expect(details(page).getByText("还没有用到")).toBeVisible();

  await node(page, "project.media").click();
  await item(page, "配音.wav").click();
  await uses(page).first().click();
  await expect(clips(page).last()).toHaveAttribute("aria-selected", "true");
});

test("renames and tags what the assets tab then finds", async ({ page }) => {
  await open(page);
  await node(page, "project.media").click();
  await item(page, "封面.png").click();
  await details(page).getByRole("button", { name: "改名…" }).click();
  await page.getByRole("textbox", { name: "给“封面.png”改名" }).fill("片头封面");
  await page.keyboard.press("Enter");
  await expect(details(page).getByRole("heading", { name: "片头封面" })).toBeVisible();

  await details(page).getByRole("button", { name: "标签…" }).click();
  await page.getByRole("textbox", { name: "“片头封面”的标签" }).fill("片头、竖屏可用");
  await page.keyboard.press("Enter");
  await expect(details(page).getByRole("list", { name: "标签" }).getByRole("listitem")).toHaveText([
    "片头",
    "竖屏可用",
  ]);

  await tab(page, "assets").click();
  const assets = content(page, "assets");
  await assets.getByRole("searchbox", { name: "搜索素材" }).fill("竖屏");
  await expect(resourcesIn(page, "assets")).toHaveText(["片头封面"]);
  await assets.getByRole("searchbox", { name: "搜索素材" }).fill("");
  await assets.getByRole("radio", { name: "按标签" }).click();
  await expect(assets.getByRole("group", { name: "片头" }).getByRole("option")).toHaveCount(1);

  // No tags at all is an answer too.
  await tab(page, "explorer").click();
  await details(page).getByRole("button", { name: "标签…" }).click();
  await page.getByRole("textbox", { name: "“片头封面”的标签" }).fill("");
  await page.getByRole("dialog").getByRole("button", { name: "保存" }).click();
  await expect(details(page).getByText("没有标签")).toBeVisible();
});

test("takes away something in use only after saying where, and with its clips", async ({
  page,
}) => {
  await open(page);
  await node(page, "project.media").click();
  await item(page, "配音.wav").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("还有 1 处在用它，删除会把这些片段一起删掉");
  await expect(dialog.getByRole("listitem")).toHaveText(["旁白，0:00"]);
  await dialog.screenshot(shot("explorer-remove.png"));
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(item(page, "配音.wav")).toBeVisible();

  await item(page, "配音.wav").click({ button: "right" });
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(item(page, "配音.wav")).toHaveCount(0);
  await tab(page, "timeline").click();
  await expect(clips(page)).toHaveCount(3);
  await page.keyboard.press("Control+z");
  await expect(clips(page)).toHaveCount(4);
  await tab(page, "explorer").click();
  await expect(item(page, "配音.wav")).toBeVisible();
});

test("lists what is missing, and puts it right", async ({ page }) => {
  await open(page);
  await node(page, "missing").click();
  await expect(items(page)).toHaveCount(1);
  await expect(item(page, "丢了.png")).toContainText("文件找不到");
  await item(page, "丢了.png").click();
  await expect(details(page).getByRole("note")).toContainText("文件找不到：assets/gone.png");
  await expect(uses(page)).toHaveText(["结尾，0:06"]);
  await panel(page).screenshot(shot("explorer-missing.png"));

  // Another resource takes its place on the clips, as one step.
  await details(page).getByRole("button", { name: "换成别的资源…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "换成" })).toHaveValue("cover");
  await dialog.getByRole("button", { name: "换", exact: true }).click();
  await expect(uses(page)).toHaveCount(0);
  await node(page, "project.media").click();
  await item(page, "封面.png").click();
  await expect(uses(page)).toHaveCount(3);
  await page.keyboard.press("Control+z");
  await expect(uses(page)).toHaveCount(2);

  // Found again, it is not missing any more.
  await node(page, "missing").click();
  await item(page, "丢了.png").click();
  const chooser = page.waitForEvent("filechooser");
  await details(page).getByRole("button", { name: "重新找到文件…" }).click();
  await (await chooser).setFiles({ name: "丢了.png", mimeType: "image/png", buffer: PNG });
  await expect(panel(page).getByText("没有缺失的资源。").first()).toBeVisible();
  await expect(node(page, "missing")).toHaveText("缺失的资源");
  await node(page, "project.media").click();
  await expect(item(page, "丢了.png").locator("img")).toBeVisible();
});

test("is where the other tabs of resources show something", async ({ page }) => {
  await open(page);
  await tab(page, "transitions").click();
  await content(page, "transitions")
    .getByRole("option", { name: "淡入", exact: true })
    .first()
    .click({
      button: "right",
    });
  await page.getByRole("menuitem", { name: "在资源管理器里显示" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(node(page, "built-in.transitions")).toHaveAttribute("aria-selected", "true");
  await expect(details(page).getByRole("heading", { name: "淡入" })).toBeVisible();
  await expect(item(page, "淡入")).toBeFocused();

  await tab(page, "effects").click();
  await content(page, "effects").getByRole("option", { name: "模糊", exact: true }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "在资源管理器里显示" }).click();
  await expect(node(page, "built-in.effects")).toHaveAttribute("aria-selected", "true");
  await expect(details(page).getByRole("heading", { name: "模糊" })).toBeVisible();

  await tab(page, "assets").click();
  await resourcesIn(page, "assets").filter({ hasText: "配音.wav" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "在资源管理器里显示" }).click();
  await expect(node(page, "project.media")).toHaveAttribute("aria-selected", "true");
  await expect(details(page).getByRole("heading", { name: "配音.wav" })).toBeVisible();
});
