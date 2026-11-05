import { describe, expect, it } from "vitest";
import {
  Color,
  Duration,
  HttpsUrl,
  Id,
  LanguageId,
  RelativePath,
  Time,
  newId,
  sortKeys,
} from "./basics.ts";

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("ids", () => {
  it.each(["main", "clip_x7k2", "a", "scene-1", "2nd"])("accepts %s", (id) => {
    expect(accepts(Id, id)).toBe(true);
  });

  it.each([
    "",
    "..",
    ".",
    "../up",
    "a/b",
    "a\\b",
    "a.b",
    "-a",
    "_a",
    "片头",
    "a b",
    "x".repeat(65),
  ])("refuses %j, which could leave its folder or trouble some file system", (id) => {
    expect(accepts(Id, id)).toBe(false);
  });

  it("generates ids that are valid and different", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("clip")));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(accepts(Id, id)).toBe(true);
    expect([...ids][0]).toMatch(/^clip_[0-9a-z]{10}$/);
  });
});

describe("paths", () => {
  it.each(["assets/a.png", "a.mp4", "code/lib/x.js", "素材/图 1.png", "index.html"])(
    "accepts %s",
    (path) => {
      expect(accepts(RelativePath, path)).toBe(true);
    },
  );

  it.each([
    "",
    "/etc/passwd",
    "../secret",
    "a/../../b",
    "a/./b",
    "a//b",
    "a/",
    "C:/Windows",
    "c:evil",
    "a\\b",
    "..\\up",
    "..",
  ])("refuses %j, which could point outside", (path) => {
    expect(accepts(RelativePath, path)).toBe(false);
  });
});

describe("urls", () => {
  it("accepts https", () => {
    expect(accepts(HttpsUrl, "https://github.com/example/assets.git")).toBe(true);
  });

  it.each([
    "http://example.com/a.git",
    "ext::sh -c touch% /tmp/pwned",
    "file:///etc/passwd",
    "git@github.com:a/b.git",
    "ssh://git@github.com/a/b.git",
    "https://",
    "https://a b",
  ])("refuses %j", (url) => {
    expect(accepts(HttpsUrl, url)).toBe(false);
  });
});

describe("times", () => {
  it("writes every time in its canonical spelling", () => {
    expect(Time.parse("25/2")).toBe("12.5");
    expect(Duration.parse("2/6")).toBe("1/3");
  });

  it("refuses numbers, so that a file has one way to write a time", () => {
    expect(accepts(Time, 12.5)).toBe(false);
  });

  it("explains how to write it", () => {
    const result = Time.safeParse("soon");
    expect(result.error?.issues[0]?.message).toContain('"12.5"');
  });

  it("refuses negative times and empty durations", () => {
    expect(accepts(Time, "-1")).toBe(false);
    expect(accepts(Time, "0")).toBe(true);
    expect(accepts(Duration, "0")).toBe(false);
    expect(accepts(Duration, "-1")).toBe(false);
    expect(accepts(Duration, "1/30")).toBe(true);
  });
});

describe("the rest", () => {
  it("writes colors in one case", () => {
    expect(Color.parse("#AABBCC")).toBe("#aabbcc");
    expect(accepts(Color, "#abc")).toBe(false);
    expect(accepts(Color, "red")).toBe(false);
    expect(accepts(Color, "#aabbcc80")).toBe(true);
  });

  it("knows language tags", () => {
    for (const tag of ["zh-CN", "en", "pt-BR", "zh-Hant-TW"])
      expect(accepts(LanguageId, tag)).toBe(true);
    for (const tag of ["", "中文", "en_US", "../en", "e"])
      expect(accepts(LanguageId, tag)).toBe(false);
  });

  it("sorts map keys", () => {
    expect(Object.keys(sortKeys({ b: 1, a: 2, c: 3 }))).toEqual(["a", "b", "c"]);
  });
});
