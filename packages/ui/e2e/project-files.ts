import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { expect, tab } from "./support.ts";

interface TimelineFile {
  tracks: { kind: string; clips: unknown[] }[];
  sections: { duration: string }[];
}

/** Brings in a project with clips that nothing in the editor can make, as a folder of files. */
export async function importClips(
  page: Page,
  seconds: number,
  clips: readonly unknown[],
): Promise<void> {
  const files = ProjectStore.create(createProject({ name: "写好的项目" })).exportFiles().files;
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as TimelineFile;
  const track = timeline.tracks.find(({ kind }) => kind === "video");
  const section = timeline.sections[0];
  if (!track || !section) throw new Error("no room for clips");
  section.duration = String(seconds);
  track.clips = [...clips];
  files.set(path, JSON.stringify(timeline));
  const folder = mkdtempSync(join(tmpdir(), "animaquill-project-"));
  try {
    for (const [name, text] of files) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      writeFileSync(join(folder, name), text);
    }
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "导入项目文件夹" }).click();
    await (await chooser).setFiles(folder);
    await expect(tab(page, "preview")).toBeVisible({ timeout: 120_000 });
  } finally {
    rmSync(folder, { recursive: true });
  }
}
