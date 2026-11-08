import { describe, expect, it } from "vitest";
import { chromeRefuses, isRefusedByChrome, mightBeShortName } from "./chrome-names.ts";

describe("names that Chrome refuses", () => {
  it.each([
    // Measured on Chrome 157 on Linux and Edge 158 on Windows, 2026-11-08.
    ["我的项目", undefined],
    ["第二集~", "everywhere"],
    ["~草稿", "everywhere"],
    ["你好~~", "everywhere"],
    ["一家人👨‍👩‍👧", "everywhere"],
    ["项目　", "everywhere"],
    ["　项目", "everywhere"],
    ["项目 ", "everywhere"],
    ["复制的​标题", "everywhere"],
    ["标题﻿", "everywhere"],
    ["clock$", "everywhere"],
    ["clock$.txt", "everywhere"],
    ["CON", "everywhere"],
    ["aux.js", "everywhere"],
    ["com1", "everywhere"],
    ["lpt9.txt", "everywhere"],
    ["desktop.ini", "everywhere"],
    ["Thumbs.db", "everywhere"],
    ["site.url", "everywhere"],
    ["link.lnk", "everywhere"],
    ["x.scf", "everywhere"],
    ["name.local", undefined],
    ["x.{abc}", "everywhere"],
    ["A~", "everywhere"],
    ["name.", "everywhere"],
    ["a.b", undefined],
    // What the first version of these rules missed.
    ["conin$", "everywhere"],
    ["conout$", "everywhere"],
    ["CONOUT$", "everywhere"],
    ["第1~3集", "windows"],
    ["a~b.txt", "windows"],
    // The report has this one refused as well, which the source does not: ".json" is too long.
    ["草稿~2.json", undefined],
    ["草稿~2.txt", "windows"],
    ["第1~3集正片完整版", undefined],
    ["a~b.json5", undefined],
  ] as const)("%j: %s", (name, where) => {
    expect(chromeRefuses(name)).toBe(where);
    expect(isRefusedByChrome(name)).toBe(where !== undefined);
  });

  it.each([
    ["", "nothing"],
    [".", "only a dot"],
    ["..", "two dots"],
    ["..x", "a second dot at the start"],
    ["a/b", "a slash"],
    ["a\\b", "a backslash"],
    ["a:b", "a colon"],
    ['a"b', "a quote"],
    ["a*b", "a star"],
    ["a?b", "a question mark"],
    ["a|b", "a bar"],
    ["a<b", "an angle bracket"],
    ["a\u0007b", "a control character"],
    ["a﷐b", "a noncharacter"],
    ["a\u{1FFFE}b", "a noncharacter of another plane"],
    ["a\tb", "a tab"],
  ])("refuses %j, with %s", (name) => {
    expect(chromeRefuses(name)).toBe("everywhere");
  });

  it.each([
    ".gitignore",
    ".animaquill",
    "a~b",
    ".a~b",
    "README.md",
    "scene.json",
    "a.tar.gz",
    "x.lnk.gz",
    "x.{a}.gz",
    "a.{b.c}",
    "conin$.txt",
    "desktop.ini.bak",
    "com10",
    "console",
    "com¹",
    "a b",
  ])("lets %j be, at least outside of Windows", (name) => {
    expect(chromeRefuses(name)).not.toBe("everywhere");
  });

  it("sees devices the way Windows does, whatever comes after the first dot", () => {
    for (const name of ["con.txt", "nul.tar.gz", "AUX.", "prn .", "com3.json", "LPT1.a.b"]) {
      expect(chromeRefuses(name), name).toBe("everywhere");
    }
  });

  it("takes special names as a whole only", () => {
    expect(chromeRefuses("desktop.ini . ")).toBe("everywhere");
    expect(chromeRefuses("conin$.txt")).toBeUndefined();
    expect(chromeRefuses("thumbs.db.txt")).toBeUndefined();
  });

  it("takes the extension that Chromium takes", () => {
    // ".tar.gz" is one extension to Chromium, so ".lnk.gz" is no ".lnk".
    expect(chromeRefuses("x.lnk.gz")).toBeUndefined();
    expect(chromeRefuses("x.gz.lnk")).toBe("everywhere");
    expect(chromeRefuses("x.longer.url")).toBe("everywhere");
    // A second extension that is too long is no part of it.
    expect(chromeRefuses("x.{abcd}.gz")).toBeUndefined();
    expect(chromeRefuses("x.user.js")).toBeUndefined();
    expect(chromeRefuses(".url")).toBe("everywhere");
  });
});

describe("short names of Windows", () => {
  it.each([
    ["第1~3集", true],
    ["a~b", true],
    ["abcdef~1", true],
    ["abcdefg~1", false],
    ["a~b.txt", true],
    ["abcdefg~.txt", true],
    ["abcdefgh~.txt", false],
    ["abcd~efg.txt", true],
    ["a~b.json", false],
    ["a~b.c.d", false],
    ["~.a", true],
    [".a~b", false],
    ["a b~c", false],
    ["a+b~c", false],
    ["a[b]~c", false],
    ["no tilde", false],
    ["abcdefgh.txt", false],
  ])("%j: %s", (name, expected) => {
    expect(mightBeShortName(name)).toBe(expected);
  });

  it("counts like Windows does, in UTF-16 code units", () => {
    expect(mightBeShortName("😀😀😀~1")).toBe(true);
    expect(mightBeShortName("😀😀😀😀~1")).toBe(false);
  });

  it("is what Chrome refuses on Windows after a dot at the start", () => {
    expect(chromeRefuses(".a~b")).toBe("windows");
  });
});
