import { describe, expect, it } from "vitest";
import { positionAt, positionWithin, resolveReference, virtualUrl } from "./paths.ts";

const from = "scenes/title/index.html";
const file = (path: string, fragment = "") => ({ kind: "file", path, fragment });
const external = (url: string) => ({ kind: "external", url });
const refused = (why: string) => ({ kind: "refused", why });
const inline = { kind: "inline" };

describe("resolveReference", () => {
  it.each([
    ["style.css", file("scenes/title/style.css")],
    ["./style.css", file("scenes/title/style.css")],
    ["images/logo.png", file("scenes/title/images/logo.png")],
    ["../other/a.js", file("scenes/other/a.js")],
    ["../../code/util.js", file("code/util.js")],
    ["/code/util.js", file("code/util.js")],
    ["aq:/code/util.js", file("code/util.js")],
    ["a/./b/../c.png", file("scenes/title/a/c.png")],
    ["a//b.png", file("scenes/title/a/b.png")],
    ["  logo.png\n", file("scenes/title/logo.png")],
    ["lo\tgo\n.png", file("scenes/title/logo.png")],
    ["sprite.svg#icon", file("scenes/title/sprite.svg", "#icon")],
    ["logo.png?v=2", file("scenes/title/logo.png")],
    ["logo.png?v=2#x", file("scenes/title/logo.png", "#x")],
    ["my%20logo.png", file("scenes/title/my logo.png")],
    ["原子.png", file("scenes/title/原子.png")],
    ["%E5%8E%9F%E5%AD%90.png", file("scenes/title/原子.png")],
    ["images\\logo.png", file("scenes/title/images/logo.png")],
    ["100%.png", file("scenes/title/100%.png")],
  ])("finds the file of %j", (target, expected) => {
    expect(resolveReference(target, from)).toEqual(expected);
  });

  it.each([
    [""],
    ["   "],
    ["#gradient"],
    ["data:image/png;base64,AAAA"],
    ["DATA:text/plain,x"],
    ["blob:https://scene/abc"],
    ["about:blank"],
  ])("leaves %j alone", (target) => {
    expect(resolveReference(target, from)).toEqual(inline);
  });

  it.each([
    ["https://example.com/a.png", "https://example.com/a.png"],
    ["HTTP://example.com/a.png", "HTTP://example.com/a.png"],
    ["//example.com/a.png", "//example.com/a.png"],
    ["\\\\example.com\\a.png", "\\\\example.com\\a.png"],
    ["/\\example.com/a.png", "/\\example.com/a.png"],
    ["file:///etc/hosts", "file:///etc/hosts"],
    ["javascript:alert(1)", "javascript:alert(1)"],
    ["java\tscript:alert(1)", "javascript:alert(1)"],
    ["ftp://example.com/x", "ftp://example.com/x"],
    ["C:\\windows\\system.ini", "C:\\windows\\system.ini"],
    ["aq://example.com/x", "aq://example.com/x"],
  ])("sees that %j is somewhere else", (target, url) => {
    expect(resolveReference(target, from)).toEqual(external(url));
  });

  it.each([
    ["../../../secret.txt"],
    ["../../../../../../etc/hosts"],
    ["..\\..\\..\\secret.txt"],
    ["%2e%2e/%2e%2e/%2e%2e/secret.txt"],
    ["%2E%2E/%2e./.%2E/secret.txt"],
    ["a/../../../../secret.txt"],
    ["/../secret.txt"],
    ["aq:/../secret.txt"],
    ["aq:/%2e%2e/secret.txt"],
  ])("refuses %j, which climbs out of the project", (target) => {
    expect(resolveReference(target, from)).toEqual(refused("above-root"));
  });

  it.each([
    ["..%2f..%2f..%2fsecret.txt"],
    ["..%5c..%5csecret.txt"],
    ["%2e%2e%2f%2e%2e%2fsecret.txt"],
    ["images%2flogo.png"],
    ["logo.png%00.js"],
    ["aq:code/util.js"],
  ])("refuses %j, which is not a path", (target) => {
    expect(resolveReference(target, from)).toEqual(refused("bad-path"));
  });

  it("takes an encoded percent sign for what it says, and not as another layer", () => {
    expect(resolveReference("%252e%252e/a.png", from)).toEqual(file("scenes/title/%2e%2e/a.png"));
  });

  it("stops being a path at the root, and only there", () => {
    expect(resolveReference("../../x.js", from)).toEqual(file("x.js"));
    expect(resolveReference("x.js", "index.html")).toEqual(file("x.js"));
    expect(resolveReference("../x.js", "index.html")).toEqual(refused("above-root"));
  });
});

describe("virtualUrl", () => {
  it("can go anywhere a URL can, and reads back as the same file", () => {
    for (const path of [
      "a/b.js",
      "my logo.png",
      'a"b.js',
      "</script>.js",
      "原子/a.png",
      "a#b?c.js",
    ]) {
      const url = virtualUrl(path);
      expect(url).not.toMatch(/["<>\s#?]/);
      expect(resolveReference(url, "somewhere/else.html")).toEqual(file(path));
    }
  });
});

describe("positions", () => {
  const text = "first\nsecond\n\nfourth";
  it.each([
    [0, 1, 1],
    [4, 1, 5],
    [5, 1, 6],
    [6, 2, 1],
    [8, 2, 3],
    [13, 3, 1],
    [14, 4, 1],
    [19, 4, 6],
  ])("offset %i is line %i, column %i", (offset, line, column) => {
    expect(positionAt(text, offset)).toEqual({ line, column });
  });

  it("adds up inside something that does not start at the top", () => {
    const base = { line: 10, column: 5 };
    expect(positionWithin(base, { line: 1, column: 3 })).toEqual({ line: 10, column: 7 });
    expect(positionWithin(base, { line: 2, column: 3 })).toEqual({ line: 11, column: 3 });
  });
});
