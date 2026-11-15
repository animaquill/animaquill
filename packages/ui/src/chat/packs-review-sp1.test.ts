/**
 * Cases of the review of S-P1 (2026-11-15): names, README links and pictures, what of a pack from
 * GitHub shows before it passed the checks, kept records, and a repository given to another account.
 */
import { checkPack, nameIssues } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import { latestOf, readmeOf } from "./github-packs.ts";
import { readmeImage, readmeLink } from "./markdown/readme-urls.ts";
import { originOf } from "./packText.ts";
import { readGitHub, readSource } from "./packs.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NEW = "1111111111111111111111111111111111111111";
const place = { owner: "pipi", repo: "aq", commit: COMMIT, path: "sub/dir" };

describe("S-P1 review: names", () => {
  const bad: [string, string][] = [
    ["fullwidth paren", "Opus（内置）"],
    ["ornate paren", "Opus ﴾内置﴿"],
    ["math bracket", "Opus ⟮x⟯"],
    ["space inside word", "内 置"],
    ["traditional", "內置"],
    ["lookalike builtin", "bu1lt-1n"],
    ["fullwidth builtin", "ＢＵＩＬＴＩＮ"],
    ["official cyrillic", "оfficial"],
    ["auto", "自 动"],
    ["colon armenian+auto", "自动։x"],
    ["31 combining", "a" + "́".repeat(60)],
    ["too long", "x".repeat(41)],
    ["double space", "a  b"],
    ["nbsp", "a b"],
    ["ideographic space", "a　b"],
    ["leading", " a"],
    ["slash-only quote", "Claude 5 [内置]"],
    ["angle", "Claude <b>"],
  ];
  for (const [what, name] of bad) {
    it(`[挡住] ${what}`, () => {
      expect(nameIssues(name).length).toBeGreaterThan(0);
    });
  }
  const good = ["Opus 稳重版", "DeepSeek steady", "通用写法 v2", "שלום עולם", "稳重版-pipi"];
  for (const name of good) {
    it(`[放行] ${name}`, () => expect(nameIssues(name)).toEqual([]));
  }
});

describe("S-P1 review: README links and pictures", () => {
  const links = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
    "file:///etc/passwd",
    "blob:https://x/y",
    "//evil.example/x",
    "\\\\evil.example/x",
    "/\\evil.example/x",
    "../../../other/repo/blob/main/x.md",
    "%2e%2e/%2e%2e/%2e%2e/%2e%2e/x",
    "..%2f..%2f..%2f..%2fx",
    "..\\..\\..\\..\\x",
    "/../../x",
  ];
  for (const href of links) {
    it(`[挡住] link ${JSON.stringify(href)}`, () => {
      const to = readmeLink(href, place);
      if (to !== undefined) {
        // Allowed only when it stays on github.com under this commit, or is a plain https address
        // the author wrote in full (which the title shows).
        expect(
          to.startsWith(`https://github.com/pipi/aq/blob/${COMMIT}/`) || to.startsWith("https://"),
        ).toBe(true);
        expect(new URL(to).hostname).not.toBe("evil.example");
      }
    });
  }
  const pictures = [
    "../../../other/repo/main/x.png",
    "/../../x.png",
    "%2e%2e/%2e%2e/%2e%2e/%2e%2e/x.png",
    "\\\\evil.example/x.png",
    "/\\evil.example/x.png",
    "java\tscript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "blob:https://x/y",
    "//evil.example/x.png",
    "ftp://evil.example/x.png",
  ];
  for (const src of pictures) {
    it(`[挡住] picture ${JSON.stringify(src)}`, () => {
      const image = readmeImage(src, place);
      expect(image.kind === "elsewhere" ? false : image.kind === "repository").toBe(
        image.kind === "repository",
      );
      if (image.kind === "repository") {
        expect(image.url.startsWith(`https://raw.githubusercontent.com/pipi/aq/${COMMIT}/`)).toBe(
          true,
        );
      }
      expect(image.kind).not.toBe("elsewhere");
    });
  }
  it("[挡住] a picture at another host never counts as the repository", () => {
    expect(readmeImage("https://raw.githubusercontent.com/evil/x/main/p.png", place).kind).toBe(
      "elsewhere",
    );
    expect(readmeImage("https://github.com/pipi/aq/raw/main/p.png", place).kind).toBe("elsewhere");
  });
});

describe("S-P1 review: what is shown from GitHub before the pack passes the checks", () => {
  const manifest = (version: string) =>
    JSON.stringify({ format: 1, id: "lin/x", name: "X", version });
  const gitHub = (versionOnBranch: string) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/lin/aq")
        return Response.json({ full_name: "lin/aq", default_branch: "main" });
      if (url.includes("/tags")) return Response.json([]);
      if (url.includes("/commits/")) return Response.json({ sha: NEW });
      if (url.endsWith("/pack.json")) return new Response(manifest(versionOnBranch));
      return new Response("", { status: 404 });
    }) as typeof fetch;
  const source = {
    kind: "github" as const,
    url: "https://github.com/lin/aq",
    commit: COMMIT,
    owner: "lin",
    repo: "aq",
  };
  it("[挡住] the version of an update found is plain (letters, digits, dots)", async () => {
    for (const version of ["1.2.0‮(内置)", "v1 (内置) ", "​​1.0"]) {
      const found = await latestOf(source, gitHub(version));
      expect(found.state).toBe("update");
      if (found.state === "update") expect(found.version ?? "").toMatch(/^[0-9A-Za-z.+-]*$/);
    }
  });
  it("[挡住] the version in a tag mismatch is cut", async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/lin/aq")
        return Response.json({ full_name: "lin/aq", default_branch: "main" });
      if (url.includes("/tags")) return Response.json([{ name: "v1.0.0", commit: { sha: NEW } }]);
      if (url.endsWith("/pack.json")) return new Response(manifest("x".repeat(30_000)));
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const read = await readGitHub("https://github.com/lin/aq", fetcher);
    expect(read.ok).toBe(false);
    if (!read.ok) expect((read.detail?.version ?? "").length).toBeLessThanOrEqual(40);
  });
});

describe("S-P1 review: kept records", () => {
  it('[挡住] a settings record that says discover is not read before "发现" has packs (S-P2)', () => {
    const source = readSource({ kind: "discover", entry: "<b>x</b>", repo: "y", commit: COMMIT });
    expect(source).toBeUndefined();
    expect(originOf({ builtin: false }, source).kind).toBe("gone");
  });
  it("[挡住] a github record cannot name an owner that is not an account", () => {
    const source = readSource({
      kind: "github",
      url: "https://github.com/lin/aq",
      commit: COMMIT,
      owner: "内置",
    });
    expect(originOf({ builtin: false }, source)).toMatchObject({ kind: "github", owner: "lin" });
    const other = readSource({
      kind: "github",
      url: "https://evil.example/内置/x",
      commit: COMMIT,
      owner: "内置",
    });
    expect(originOf({ builtin: false }, other)).toMatchObject({ kind: "github", owner: undefined });
  });
  it("[挡住] a github record's commit is a full commit", () => {
    const source = readSource({
      kind: "github",
      url: "https://github.com/lin/aq",
      commit: "main/../../x",
    });
    expect(source).toBeUndefined();
  });
  it("README of 64 KB+ is cut", () => {
    const read = readmeOf(new TextEncoder().encode("a".repeat(70_000)), true);
    expect(read?.text.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("S-P1 review: hidden characters in names still stop an install", () => {
  for (const name of ["a\u200bb", "abc\u202e", "abc\u2067", "a\u2066b"]) {
    it(`[挡住] ${JSON.stringify(name)}`, () => {
      const { pack, problems } = checkPack(
        new Map([["pack.json", JSON.stringify({ format: 1, id: "x/y", name, version: "1.0.0" })]]),
        { mode: "install" },
      );
      expect(pack).toBeUndefined();
      expect(problems.some(({ code }) => code === "characters")).toBe(true);
    });
  }
});

describe("S-P1 review: an update from a repository that moved to another account", () => {
  it("[挡住] the update dialog warns when GitHub now says another owner", async () => {
    const { originDiffers } = await import("./packText.ts");
    const pack = { id: "lin/x", name: "X", version: "1.0.0", author: { name: "Lin" } } as never;
    const old = {
      kind: "github" as const,
      url: "https://github.com/pipi/aq",
      commit: COMMIT,
      owner: "pipi",
      repo: "aq",
    };
    const moved = { ...old, commit: NEW, owner: "evil", repo: "aq" };
    expect(originDiffers(pack, pack, moved, old)).toBe(true);
    const { ownerMoved } = await import("./packText.ts");
    expect(ownerMoved(moved, old)).toEqual({ before: "pipi/aq", after: "evil/aq" });
    // GitHub's spelling of the same account: the same.
    expect(originDiffers(pack, pack, { ...old, commit: NEW, owner: "PiPi" }, old)).toBe(false);
  });
});

describe("S-P1 review: the newest tag of a repository with many", () => {
  it("[挡住] tags are read page by page, so the newest is found past the first hundred", async () => {
    const names = Array.from({ length: 250 }, (_, index) => `v1.0.${index}`);
    const asked: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url === "https://api.github.com/repos/lin/aq")
        return Response.json({ full_name: "lin/aq", default_branch: "main" });
      if (url.includes("/tags")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        return Response.json(
          names
            .slice((page - 1) * 100, page * 100)
            .map((name) => ({ name, commit: { sha: name === "v1.0.249" ? NEW : COMMIT } })),
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const found = await latestOf(
      { kind: "github", url: "https://github.com/lin/aq", commit: COMMIT },
      fetcher,
    );
    expect(found).toEqual({ state: "update", commit: NEW, version: "1.0.249" });
    expect(asked.filter((url) => url.includes("/tags"))).toHaveLength(3);
  });
});
