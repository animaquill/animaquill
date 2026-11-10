import { describe, expect, test } from "vitest";
import {
  PROJECT_FOLDERS,
  inRanks,
  isDocument,
  isProjectFile,
  isProjectFolder,
  writeRank,
} from "./project-files.ts";

/** Which files are the project's, the same for the editor and a platform that saves it to Git. */

describe("the files of a project", () => {
  test("are its documents and the code of its scenes and sounds", () => {
    for (const path of [
      "animaquill.json",
      "assets.json",
      "libraries.json",
      "libraries.lock.json",
      "notes.json",
      "timelines/main/timeline.json",
      "timelines/main/overrides/language.en.json",
      "scenes/intro/scene.json",
      "scenes/intro/index.html",
      "scenes/intro/lib/util.js",
      "sounds/beep/sound.json",
      "sounds/beep/main.js",
      "code/shared.js",
      "locales/zh-CN.json",
    ])
      expect(isProjectFile(path), path).toBe(true);
  });

  test("are not what else a folder or a repository has", () => {
    for (const path of [
      "README.md",
      "AGENTS.md",
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".animaquill/cloud.json",
      "assets/video.mp4",
      "timelines/main/notes.txt",
      "scenes/intro/.DS_Store",
      "scenes/intro/node_modules/x/index.js",
      "code/.git/config",
      "locales/zh-CN/extra.json",
    ])
      expect(isProjectFile(path), path).toBe(false);
    expect(isDocument("scenes/intro/index.html")).toBe(false);
    expect(isDocument("scenes/intro/scene.json")).toBe(true);
  });

  test("are only in the folders of the format, which a tool's folder is not one of", () => {
    expect(PROJECT_FOLDERS).toEqual(["timelines", "scenes", "sounds", "code", "locales"]);
    for (const folder of PROJECT_FOLDERS) expect(isProjectFolder(folder)).toBe(true);
    expect(isProjectFolder("scenes/intro")).toBe(true);
    expect(isProjectFolder("scenes/intro/node_modules")).toBe(false);
    expect(isProjectFolder("assets")).toBe(false);
    expect(isProjectFolder(".github")).toBe(false);
    expect(isProjectFolder("scenesx")).toBe(false);
  });

  test("are written what others refer to first, and animaquill.json last", () => {
    expect(writeRank("code/a.js")).toBe(0);
    expect(writeRank("assets.json")).toBe(0);
    expect(writeRank("scenes/a/scene.json")).toBe(1);
    expect(writeRank("timelines/main/timeline.json")).toBe(2);
    expect(writeRank("timelines/main/overrides/language.en.json")).toBe(3);
    expect(writeRank("notes.json")).toBe(3);
    expect(writeRank("animaquill.json")).toBe(4);
    const paths = ["animaquill.json", "timelines/main/timeline.json", "code/b.js", "code/a.js"];
    expect(inRanks(paths)).toEqual([
      ["code/a.js", "code/b.js"],
      ["timelines/main/timeline.json"],
      ["animaquill.json"],
    ]);
    expect(inRanks(paths, true)[0]).toEqual(["animaquill.json"]);
  });
});
