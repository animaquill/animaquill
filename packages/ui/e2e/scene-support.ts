import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createProject,
  writeProject,
  type NewProject,
  type SceneManifest,
} from "@animaquill/schema";
import type { Frame, Page } from "@playwright/test";
import { content, expect, tab, test } from "./support.ts";

/** Whether the browser of this run can capture. The one that comes with Playwright cannot yet. */
export const canCapture = Boolean(process.env["AQ_CHROME"]);

/** A clip with a scene, on the first video track. */
export interface SceneClip {
  readonly id?: string;
  readonly scene?: string;
  readonly start?: string;
  readonly duration?: string;
  readonly offset?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  /** On a track of its own, above the first one. */
  readonly above?: boolean;
}

/** Writes a project with scenes to a folder, for what the interface has no way of making yet. */
export function projectFolder(
  scenes: Readonly<Record<string, Readonly<Record<string, string>>>>,
  clips: readonly SceneClip[],
  format?: NewProject["format"],
): string {
  const manifests = Object.keys(scenes).map((id): [string, SceneManifest] => [
    id,
    { name: `场景 ${id}`, entry: "index.html", runtime: 1 },
  ]);
  const created = createProject({ name: "场景项目", ...(format && { format }) });
  const project = { ...created, scenes: new Map(manifests) };
  const files = writeProject(project);
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  const written = clips.map((clip, index) => ({
    id: clip.id ?? `clip${index}`,
    start: clip.start ?? "0",
    duration: clip.duration ?? "10",
    source: { kind: "scene", scene: clip.scene ?? Object.keys(scenes)[0] },
    ...(clip.offset && { offset: clip.offset }),
    ...(clip.properties && { properties: clip.properties }),
  }));
  const isAbove = (index: number) => clips[index]?.above === true;
  (timeline.tracks[0] as { clips: unknown[] }).clips = written.filter((_, at) => !isAbove(at));
  const upper = written.filter((_, at) => isAbove(at));
  if (upper.length > 0)
    timeline.tracks.splice(1, 0, { id: "upper", kind: "video", clips: upper } as never);
  files.set(path, JSON.stringify(timeline));
  for (const [id, sceneFiles] of Object.entries(scenes)) {
    for (const [name, text] of Object.entries(sceneFiles)) files.set(`scenes/${id}/${name}`, text);
  }
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-scene-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** Up to what the editor says about the code in a project. The page has to be on the start page. */
export async function chooseFolder(page: Page, folder: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入项目文件夹" }).click();
  await (await chooser).setFiles(folder);
}

export const openAnyway = (page: Page) =>
  page.getByRole("dialog").getByRole("button", { name: "知道了，打开项目" }).click();

/** Brings a project in the way people do. */
export async function importFolder(page: Page, folder: string): Promise<void> {
  await chooseFolder(page, folder);
  await openAnyway(page);
  await expect(tab(page, "preview")).toBeVisible();
}

/** Opens a project that has one scene from this page on the timeline, from the start of it. */
export const openScene = (page: Page, html: string, clip: SceneClip = {}) =>
  importFolder(page, projectFolder({ a: { "index.html": html } }, [clip]));

/** There is none for a moment while a project opens, or when a new one takes over. */
export const findCompositor = (page: Page): Frame | undefined =>
  page.frames().find((candidate) => candidate.url().includes("compositor.html"));

export const compositor = (page: Page): Frame => {
  const frame = findCompositor(page);
  if (!frame) throw new Error("No compositor");
  return frame;
};

/** The frames scenes run in, right now. */
export const sceneFrames = (page: Page): readonly Frame[] =>
  page.frames().filter((frame) => frame.url().includes("/scene.html"));

export type Color = readonly [red: number, green: number, blue: number, alpha: number];

/** What there is to see as long as there is no compositor. It is no color at all. */
const NO_COLOR: Color = [-999, -999, -999, -999];

/** The color of a pixel of the picture. Reading it is for tests: nothing in the product does. */
export const colorAt = async (page: Page, x: number, y: number): Promise<Color> => {
  const read = findCompositor(page)?.evaluate(
    ([left = 0, top = 0]) => {
      const canvas = document.querySelector("canvas");
      const data = canvas?.getContext("2d")?.getImageData(left, top, 1, 1).data;
      return data ? ([...data] as unknown as Color) : undefined;
    },
    [x, y],
  );
  return (await read?.catch(() => undefined)) ?? NO_COLOR;
};

/** How far a color is from another, as the largest difference of its parts. */
export const distance = (a: Color, b: readonly number[]) =>
  Math.max(...b.map((part, index) => Math.abs(part - (a[index] as number))));

export async function goTo(page: Page, time: string): Promise<void> {
  await page.getByRole("contentinfo").getByRole("button", { name: "当前时间和总时长" }).click();
  await page.getByRole("textbox", { name: "当前时间" }).fill(time);
  await page.keyboard.press("Enter");
}

/** Clicks the first clip, on the canvas, where the list of clips says it is. */
export async function clickFirstClip(page: Page): Promise<void> {
  const box = await content(page, "timeline").getByRole("option").first().boundingBox();
  if (!box) throw new Error("No clip");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

export const previewButton = (page: Page, name: string) =>
  content(page, "preview").getByRole("button", { name, exact: true });

export { content, expect, tab, test };
