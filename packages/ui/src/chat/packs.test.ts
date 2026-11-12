import { describe, expect, it } from "vitest";
import { gitHubPlace, readGitHub } from "./packs.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** GitHub as the page sees it: its API and its raw files, from a few files of a repository. */
function gitHub(files: Record<string, string>, status = 200) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    expect(init?.credentials).toBe("omit");
    if (status !== 200) return new Response("", { status });
    if (url === "https://api.github.com/repos/lin/aq-packs") {
      return Response.json({ default_branch: "main" });
    }
    if (url.startsWith("https://api.github.com/repos/lin/aq-packs/commits/")) {
      return url.endsWith("/main") || url.endsWith("/v1")
        ? Response.json({ sha: COMMIT })
        : new Response("", { status: 404 });
    }
    const prefix = `https://raw.githubusercontent.com/lin/aq-packs/${COMMIT}/`;
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : undefined;
    const text = path === undefined ? undefined : files[path];
    return text === undefined ? new Response("", { status: 404 }) : new Response(text);
  }) as typeof fetch;
  return { fetcher, asked };
}

const MANIFEST = JSON.stringify({
  format: 1,
  id: "lin/steady",
  name: "Steady",
  version: "1.0.0",
  system: { work: { file: "work.md" }, extra: { file: "../../secret.md" } },
});

describe("a pack on GitHub", () => {
  it("is found from the addresses people paste", () => {
    expect(gitHubPlace("https://github.com/lin/aq-packs/tree/main/deepseek-steady")).toEqual({
      owner: "lin",
      repo: "aq-packs",
      ref: "main",
      path: "deepseek-steady",
    });
    expect(gitHubPlace("https://github.com/lin/aq-packs")).toEqual({
      owner: "lin",
      repo: "aq-packs",
      ref: undefined,
      path: "",
    });
    expect(gitHubPlace("https://github.com/lin/aq-packs/blob/v1/a/b/pack.json")).toMatchObject({
      ref: "v1",
      path: "a/b",
    });
    for (const wrong of [
      "http://github.com/lin/aq-packs",
      "https://gitlab.com/lin/aq-packs",
      "https://github.com/lin",
      "https://github.com/lin/aq-packs/blob/main/README.md",
      "https://github.com/lin/aq-packs/tree/main/a%2Fb",
      "not an address",
    ]) {
      expect(gitHubPlace(wrong), wrong).toBeUndefined();
    }
  });

  it("comes from one commit, with only the files of the pack it names", async () => {
    const { fetcher, asked } = gitHub({
      "steady/pack.json": MANIFEST,
      "steady/work.md": "How to work\nSmall batches.",
    });
    const read = await readGitHub("https://github.com/lin/aq-packs/tree/main/steady", fetcher);
    expect(read).toMatchObject({
      ok: true,
      source: {
        kind: "github",
        url: "https://github.com/lin/aq-packs/tree/main/steady",
        commit: COMMIT,
      },
    });
    if (!read.ok) return;
    expect([...read.files.keys()]).toEqual(["pack.json", "work.md"]);
    // Nothing outside the folder is asked for: the check says that path is wrong.
    expect(asked.some((url) => url.includes("secret"))).toBe(false);
    expect(
      asked.every((url) => url.startsWith("https://api.github.com/") || url.includes(COMMIT)),
    ).toBe(true);
  });

  it("takes the default branch of a repository, and says why it could not", async () => {
    const root = gitHub({ "pack.json": MANIFEST });
    const read = await readGitHub("https://github.com/lin/aq-packs", root.fetcher);
    expect(read.ok).toBe(true);
    expect(root.asked[0]).toBe("https://api.github.com/repos/lin/aq-packs");
    expect(await readGitHub("https://github.com/lin/aq-packs/tree/nope/x", root.fetcher)).toEqual({
      ok: false,
      failure: "notFound",
    });
    expect(await readGitHub("https://github.com/lin/aq-packs", gitHub({}, 403).fetcher)).toEqual({
      ok: false,
      failure: "rate",
    });
    expect(await readGitHub("ftp://x", root.fetcher)).toEqual({ ok: false, failure: "address" });
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await readGitHub("https://github.com/lin/aq-packs", down)).toEqual({
      ok: false,
      failure: "network",
    });
  });
});

describe("the details of a pack", () => {
  it("say where it is from, what it changes by group, and what of it goes unused", async () => {
    const { builtinPacks, TOOLSET_VERSION } = await import("@animaquill/tools");
    const { ModelPacks, detailsOf } = await import("./packs.ts");
    const saved = new Map<string, unknown>();
    const settings = {
      load: async (key: string) => saved.get(key),
      save: async (key: string, value: unknown) => {
        saved.set(key, value);
      },
      listen: () => () => {},
    };
    const packs = new ModelPacks(settings, { saveFailed: () => {} });
    const manifest = JSON.stringify({
      format: 1,
      id: "lin/steady",
      name: "Steady",
      version: "1.0.0",
      models: ["deepseek-*"],
      call: { reasoning: "low" },
      system: { extra: "Keep batches small." },
      tools: { aq_search: { description: { append: "Search first." } } },
      params: { start: "Start in seconds." },
    });
    packs.install(new Map([["pack.json", manifest]]), { kind: "file", name: "pack.json" });
    const installed = packs.installedOf("lin/steady");
    if (!installed) throw new Error("not installed");
    const details = detailsOf(installed);
    expect(details).toMatchObject({
      id: "lin/steady",
      source: { kind: "file", name: "pack.json" },
      toolset: TOOLSET_VERSION,
      call: [{ field: "reasoning", after: "low", costly: false }],
      problems: [],
      dropped: [],
    });
    expect(
      details.words.map(({ group, changes }) => [group, changes.map(({ key }) => key)]),
    ).toEqual([
      ["system", ["system.extra"]],
      ["tools", ["tools.aq_search.description"]],
      ["params", ["params.start"]],
    ]);
    const claude = builtinPacks().find(({ id }) => id === "animaquill/claude-5");
    if (!claude) throw new Error("no Claude 5");
    expect(detailsOf(claude)).toMatchObject({ source: "builtin", words: [] });
    expect(detailsOf(claude)).not.toHaveProperty("toolset");
  });
});
