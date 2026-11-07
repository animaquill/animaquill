import { describe, expect, it } from "vitest";
import { cleanMessage, cleanName, cleanStack, namesIn } from "./privacy.ts";

const SITE = "https://editor.example";
const SANDBOX = "https://sandbox.example";

describe("messages", () => {
  it("keeps what the browser says about the code", () => {
    for (const message of [
      "Cannot read properties of undefined",
      "e.at is not a function",
      "Maximum call stack size exceeded",
      "Cannot convert a BigInt value to a number",
      "Failed to execute postMessage on Window",
      "n is not defined",
      "Assignment to constant variable.",
    ]) {
      expect(cleanMessage(message)).toBe(message);
    }
  });

  it("loses words that are not about code, which can be values people typed without quotes", () => {
    expect(cleanMessage("Cannot use 'in' operator to search for 'kind' in Q3 revenue up 40%")).toBe(
      "Cannot use <…> operator to search for <…> in …%",
    );
    expect(cleanMessage("Cannot convert Secret to a BigInt")).toBe("Cannot convert … to a BigInt");
    expect(cleanMessage("Not a time: meet Acme at noon")).toBe("Not a time: … at …");
    expect(cleanMessage("Invalid array length 123456")).toBe("Invalid array length …");
  });

  it("loses names it knows, whatever their case and also without their extension", () => {
    const secrets = new Set(["my_scene", "intro_v2.html", "intro_v2", "fooBar", "ab"]);
    expect(cleanMessage("MY_SCENE is not defined", secrets)).toBe("<name> is not defined");
    expect(cleanMessage("intro_v2 is not a function", secrets)).toBe("<name> is not a function");
    expect(cleanMessage("FooBar.x is not a function", secrets)).toBe("<name>.x is not a function");
    expect(cleanMessage("x_ is not defined", new Set(["x_"]))).toBe("<name> is not defined");
    // A short name that is no word of code goes like any other word.
    expect(cleanMessage("ab is not defined", secrets)).toBe("… is not defined");
    // Names inside other names stay, or code would lose its letters.
    expect(cleanMessage("t.fooBarBaz is not defined", secrets)).toBe("t.fooBarBaz is not defined");
  });

  it("loses whatever is quoted, which is where names and values end up", () => {
    expect(cleanMessage(`Cannot read properties of undefined (reading 'budget')`)).toBe(
      "Cannot read properties of undefined (reading <…>)",
    );
    expect(cleanMessage(`Unexpected token 'x', "x = secret()" is not valid JSON`)).toBe(
      "Unexpected token <…>, <…> is not valid JSON",
    );
    expect(cleanMessage("No such file: “方案 B”")).toBe("No such file: <…>");
  });

  it("loses paths, files and addresses", () => {
    const message = cleanMessage(
      "Failed to load scenes/launch/intro.html from blob:https://x/1 or C:\\Users\\li\\plan.webm or teaser.mp4 at https://example.com/a?b",
    );
    expect(message).not.toMatch(/scenes|intro|launch|Users|plan|teaser|example/);
    expect(message).toBe("Failed to load <path> from <url> or <path> or <file> at <url>");
  });

  it("loses text in other languages, where the names of a Chinese project are", () => {
    expect(cleanMessage("没有这个命令：秘密发布会")).toBe("…");
    expect(cleanMessage("Clip 片头动画 is locked")).toBe("… is locked");
  });

  it("is short, and takes anything", () => {
    expect(cleanMessage("x.y ".repeat(1000))).toHaveLength(200);
    expect(cleanMessage(42)).toBe("…");
    expect(cleanMessage(undefined)).toBe("undefined");
  });

  it("costs little with many names, most of which could not be left anyway", () => {
    const secrets = new Set(
      Array.from({ length: 20_000 }, (_, index) => `素材 ${index} Clip number ${index}`),
    );
    const started = performance.now();
    for (let index = 0; index < 100; index++)
      cleanMessage(`e.at is not a function ${index}`, secrets);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("names of errors", () => {
  it("keeps kinds and nothing else", () => {
    expect(cleanName("TypeError")).toBe("TypeError");
    expect(cleanName("QuotaExceededError")).toBe("QuotaExceededError");
    expect(cleanName("Error in 我的项目")).toBe("Error");
    expect(cleanName(undefined)).toBe("Error");
  });
});

describe("stacks", () => {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'secret')",
    `    at Ab.render (${SITE}/assets/index-1a2b3c4d.js:1:2345)`,
    `    at async ${SITE}/assets/index-1a2b3c4d.js:1:999`,
    "    at eval (eval at run (blob:https://scene-1.example/123:1:5), <anonymous>:3:9)",
    "    at mySecretScene (https://scene-1.example/scene.html:7:2)",
    `    at new Compositor (${SANDBOX}/assets/compositor-9z8y7x6w.js:1:42)`,
    `    at ${SITE}/%E6%88%91.js:1:1`,
  ].join("\n");

  it("keeps the places in the code of the editor, and only counts the others", () => {
    expect(cleanStack(stack, [SITE, SANDBOX])).toEqual({
      frames: [
        { fn: "Ab.render", file: "/assets/index-1a2b3c4d.js", line: 1, column: 2345 },
        { file: "/assets/index-1a2b3c4d.js", line: 1, column: 999 },
        { fn: "Compositor", file: "/assets/compositor-9z8y7x6w.js", line: 1, column: 42 },
      ],
      dropped: 3,
    });
  });

  it("never keeps the message the stack starts with", () => {
    expect(JSON.stringify(cleanStack(stack, [SITE, SANDBOX]))).not.toMatch(/secret|Secret/);
  });

  it("reads Firefox and Safari too", () => {
    expect(
      cleanStack(`render@${SITE}/assets/index-1a2b3c4d.js:1:20\n@${SITE}/x.js:2:3`, [SITE]),
    ).toEqual({
      frames: [
        { fn: "render", file: "/assets/index-1a2b3c4d.js", line: 1, column: 20 },
        { file: "/x.js", line: 2, column: 3 },
      ],
      dropped: 0,
    });
  });

  it("has nothing for what has no stack", () => {
    expect(cleanStack(undefined, [SITE])).toEqual({ frames: [], dropped: 0 });
  });
});

describe("names in a project", () => {
  it("finds what people named, with the parts of paths", () => {
    const names = namesIn({
      manifest: { name: "秘密发布会", fps: "30" },
      files: { "scenes/launch/intro.html": "<p>secret</p>" },
      scenes: { teaser: { name: "TeaserCut", entry: "scenes/launch/intro.html" } },
      assets: { a1: { name: "plan.webm", kind: "video" } },
    });
    for (const name of [
      "秘密发布会",
      "scenes/launch/intro.html",
      "launch",
      "intro",
      "intro.html",
      "teaser",
      "TeaserCut",
      "plan.webm",
      "plan",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("<p>secret</p>");
    expect(names).not.toContain("video");
  });
});
