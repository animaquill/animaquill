import { describe, expect, it } from "vitest";
import { isRefusedByChrome } from "./chrome-names.ts";
import {
  FALLBACK_NAME,
  MAX_NAME_LENGTH,
  MAX_PATH_LENGTH,
  fileNameFor,
  isSafeName,
  isSafePath,
  newNameFor,
  sameNameKey,
} from "./paths.ts";

describe("names the editor may make", () => {
  it.each([
    ["红色.webm", true],
    ["scene.json", true],
    [".gitignore", true],
    ["第1~3集", false],
    ["a~b.txt", false],
    ["conin$", false],
    ["com¹", false],
    ["COM².txt", false],
    ["aux.js", false],
    ["a\uD83Db", false],
    ["x".repeat(MAX_NAME_LENGTH), true],
    ["x".repeat(MAX_NAME_LENGTH + 1), false],
  ])("%j: %s", (name, safe) => {
    expect(isSafeName(name)).toBe(safe);
  });

  it("keeps paths short, and inside of the project", () => {
    expect(isSafePath("assets/红色.webm")).toBe(true);
    expect(isSafePath(`${"a".repeat(60)}/${"b".repeat(59)}`)).toBe(true);
    expect(isSafePath(`${"a".repeat(60)}/${"b".repeat(60)}`)).toBe(false);
    expect(isSafePath(`assets/${"x".repeat(MAX_NAME_LENGTH + 1)}`)).toBe(false);
    expect(isSafePath("../outside.txt")).toBe(false);
    expect(isSafePath("scenes/con/index.html")).toBe(false);
  });
});

describe("a name for a new file", () => {
  it("stays what people called it", () => {
    expect(newNameFor("红色.webm", [])).toBe("红色.webm");
  });

  it("gets a number when it is taken, also in another case or form", () => {
    expect(newNameFor("红色.webm", ["红色.webm"])).toBe("红色 (2).webm");
    expect(newNameFor("Red.webm", ["red.WEBM", "red (2).webm"])).toBe("Red (3).webm");
    expect(newNameFor("é.png", ["é.png"])).toBe("é (2).png");
  });

  it("takes out what the browser refuses", () => {
    expect(newNameFor("a:b?.mp4", [])).toBe("a_b_.mp4");
    expect(newNameFor("第1~3集.mp4", [])).toBe("第1-3集.mp4");
    expect(newNameFor("con.wav", [])).toBe("_con.wav");
    expect(newNameFor("  .mp4", [])).toBe(`${FALLBACK_NAME}.mp4`);
    expect(newNameFor("快捷.lnk", [])).toBe("快捷_lnk");
    expect(newNameFor(".mp4", [])).toBe(`${FALLBACK_NAME}.mp4`);
  });

  it("keeps the extension, and cuts what is before it", () => {
    const name = newNameFor(`${"长".repeat(100)}.mp4`, []);
    expect(name).toBe(`${"长".repeat(MAX_NAME_LENGTH - 4)}.mp4`);
    const numbered = newNameFor(`${"长".repeat(100)}.mp4`, [name]);
    expect(numbered).toBe(`${"长".repeat(MAX_NAME_LENGTH - 8)} (2).mp4`);
  });

  it("keeps the whole path within its length", () => {
    const folder = `assets/${"深".repeat(80)}`;
    const name = newNameFor(`${"长".repeat(100)}.mp4`, [], folder);
    expect(`${folder}/${name}`.length).toBeLessThanOrEqual(MAX_PATH_LENGTH);
    expect(name.endsWith(".mp4")).toBe(true);
  });

  it("works whatever people called the file", () => {
    const pool = [
      ...'~. 　​‍﻿:*?|<>"/\\\n\t',
      ..."😀字aA0_-",
      "\uD83D",
      "﷐",
      "con",
      "aux",
      ".url",
      ".mp4",
      "clock$",
      "conin$",
    ];
    for (let round = 0; round < 1000; round++) {
      let wanted = "";
      for (let index = 0; index < 1 + Math.random() * 20; index++) {
        wanted += pool[Math.floor(Math.random() * pool.length)];
      }
      const taken = [newNameFor(wanted, [])];
      const name = newNameFor(wanted, taken, "assets");
      expect(isSafeName(name), JSON.stringify(wanted)).toBe(true);
      expect(isRefusedByChrome(name), JSON.stringify(wanted)).toBe(false);
      expect(sameNameKey(name)).not.toBe(sameNameKey(taken[0] as string));
    }
  });
});

describe("a file name for anything", () => {
  it("keeps what opens it", () => {
    expect(fileNameFor("我的/项目-第3帧.png")).toBe("我的_项目-第3帧.png");
  });

  it("is no short name of Windows", () => {
    expect(fileNameFor("a~b.txt")).toBe("a-b.txt");
    expect(fileNameFor("ab.t~x")).toBe("ab.t-x");
  });
});
