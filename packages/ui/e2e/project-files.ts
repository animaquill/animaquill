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

/** A quiet tone of `seconds`, as a WAV file: 8 kHz mono, enough to play. */
function toneFile(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * index) / rate)), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The asset that clips of `sound` in `importClips` can play, with `{ asset: TONE }`. */
export const TONE = "tone";

/**
 * Brings in a project with clips that nothing in the editor can make, as a folder of files: `clips`
 * on the video track and `sound` on the audio track, which have the asset `TONE` to play.
 */
export async function importClips(
  page: Page,
  seconds: number,
  clips: readonly unknown[],
  sound: readonly unknown[] = [],
): Promise<void> {
  const files: Map<string, string | Buffer> = ProjectStore.create(
    createProject({ name: "写好的项目" }),
  ).exportFiles().files;
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as TimelineFile;
  const track = timeline.tracks.find(({ kind }) => kind === "video");
  const section = timeline.sections[0];
  if (!track || !section) throw new Error("no room for clips");
  section.duration = String(seconds);
  track.clips = [...clips];
  if (sound.length > 0) {
    const audio = timeline.tracks.find(({ kind }) => kind === "audio");
    if (!audio) throw new Error("no room for sound");
    audio.clips = [...sound];
    const asset = { name: "测试音", kind: "audio", path: "assets/tone.wav", storage: "git" };
    files.set("assets.json", JSON.stringify({ assets: { [TONE]: asset } }));
    files.set("assets/tone.wav", toneFile(seconds));
  }
  files.set(path, JSON.stringify(timeline));
  const folder = mkdtempSync(join(tmpdir(), "animaquill-project-"));
  try {
    for (const [name, text] of files) {
      mkdirSync(dirname(join(folder, name)), { recursive: true });
      writeFileSync(join(folder, name), text);
    }
    const chooser = page.waitForEvent("filechooser");
    // From the file menu: the start page offers only new projects.
    await page.locator("header").getByRole("button", { name: "文件", exact: true }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: "导入项目文件夹" }).click();
    await (await chooser).setFiles(folder);
    await expect(tab(page, "preview")).toBeVisible({ timeout: 120_000 });
  } finally {
    rmSync(folder, { recursive: true });
  }
}
