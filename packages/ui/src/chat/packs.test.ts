import { describe, expect, it } from "vitest";
import { latestOf, newestTag, readmeOf } from "./github-packs.ts";
import { readmeImage, readmeLink } from "./markdown/readme-urls.ts";
import { gitHubPlace, readGitHub } from "./packs.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const TAGGED = "1111111111111111111111111111111111111111";

/**
 * GitHub as the page sees it: its API and its raw files, from a few files of a repository at each
 * commit, the tags it has, and which commits are in the history of its default branch.
 */
function gitHub(
  files: Record<string, string>,
  status = 200,
  options: {
    readonly tags?: readonly { readonly name: string; readonly sha: string }[];
    readonly at?: Readonly<Record<string, Record<string, string>>>;
    readonly history?: readonly string[];
  } = {},
) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    expect(init?.credentials).toBe("omit");
    if (status !== 200) return new Response("", { status });
    // GitHub spells the account and repository its own way, whatever the address had.
    if (url.toLowerCase() === "https://api.github.com/repos/lin/aq-packs") {
      return Response.json({ full_name: "Lin/aq-packs", default_branch: "main" });
    }
    const api = "https://api.github.com/repos/Lin/aq-packs/";
    if (url === `${api}tags?per_page=100`) {
      return Response.json(
        (options.tags ?? []).map(({ name, sha }) => ({ name, commit: { sha } })),
      );
    }
    if (url.startsWith(`${api}compare/`)) {
      const sha = url.split("...")[1] ?? "";
      return (options.history ?? [COMMIT]).includes(sha)
        ? Response.json({ status: sha === COMMIT ? "identical" : "behind" })
        : sha === OTHER
          ? Response.json({ status: "diverged" })
          : new Response("", { status: 404 });
    }
    if (url.startsWith(`${api}commits/`)) {
      return url.endsWith("/main") || url.endsWith("/v1")
        ? Response.json({ sha: COMMIT })
        : new Response("", { status: 404 });
    }
    const raw = "https://raw.githubusercontent.com/Lin/aq-packs/";
    if (!url.startsWith(raw)) return new Response("", { status: 404 });
    const [commit = "", ...path] = url.slice(raw.length).split("/");
    const tree = commit === COMMIT ? files : options.at?.[commit];
    const text = tree?.[path.join("/")];
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
        owner: "Lin",
        repo: "aq-packs",
        path: "steady",
        ref: "main",
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

  it("is the newest tag of a version where the repository has some, and that tag has to be its version", async () => {
    const at = (version: string) => ({
      "pack.json": JSON.stringify({ ...JSON.parse(MANIFEST), version, system: undefined }),
      "README.md": "# Steady",
    });
    const tags = [
      { name: "v1.2.0", sha: OTHER },
      { name: "v1.10.0", sha: TAGGED },
      { name: "v2.0.0-beta.1", sha: COMMIT },
      { name: "latest", sha: COMMIT },
    ];
    expect(newestTag(tags.map(({ name }) => name))).toBe("v1.10.0");
    const fine = gitHub({}, 200, { tags, at: { [TAGGED]: at("1.10.0") } });
    const read = await readGitHub("https://github.com/lin/aq-packs", fine.fetcher);
    expect(read).toMatchObject({
      ok: true,
      source: { commit: TAGGED, ref: "v1.10.0", tag: true, owner: "Lin" },
      readme: { text: "# Steady" },
    });
    const wrong = gitHub({}, 200, { tags, at: { [TAGGED]: at("1.9.0") } });
    expect(await readGitHub("https://github.com/lin/aq-packs", wrong.fetcher)).toEqual({
      ok: false,
      failure: "tagMismatch",
      detail: { tag: "v1.10.0", version: "1.9.0" },
    });
  });

  it("takes a commit named in the address only from the history of the default branch", async () => {
    const files = { "pack.json": MANIFEST.replace(/,"system".*\}$/, "}") };
    const root = gitHub(files);
    expect(
      await readGitHub(`https://github.com/lin/aq-packs/tree/${COMMIT}`, root.fetcher),
    ).toMatchObject({ ok: true, source: { commit: COMMIT, ref: COMMIT } });
    // Pushed to a fork: GitHub gives it under this repository's name too.
    expect(await readGitHub(`https://github.com/lin/aq-packs/tree/${OTHER}`, root.fetcher)).toEqual(
      { ok: false, failure: "notInRepository" },
    );
    expect(root.asked).toContain(
      `https://api.github.com/repos/Lin/aq-packs/compare/main...${OTHER}`,
    );
  });

  it("says when there is a newer version, by tag or by commit, and nothing of a commit people named", async () => {
    const source = {
      kind: "github" as const,
      url: "https://github.com/lin/aq-packs",
      commit: COMMIT,
    };
    expect(await latestOf(source, gitHub({}).fetcher)).toEqual({ state: "latest" });
    const tagged = gitHub({}, 200, { tags: [{ name: "v1.3.0", sha: TAGGED }] });
    expect(await latestOf(source, tagged.fetcher)).toEqual({
      state: "update",
      commit: TAGGED,
      version: "1.3.0",
    });
    expect(
      await latestOf(
        { ...source, url: `https://github.com/lin/aq-packs/tree/${COMMIT}` },
        gitHub({}).fetcher,
      ),
    ).toEqual({ state: "pinned" });
    expect(await latestOf(source, gitHub({}, 403).fetcher)).toEqual({
      state: "failed",
      failure: "rate",
    });
  });

  it("takes the default branch of a repository, and says why it could not", async () => {
    const root = gitHub({ "pack.json": MANIFEST });
    const read = await readGitHub("https://github.com/lin/aq-packs", root.fetcher);
    expect(read.ok).toBe(true);
    expect(root.asked[0]).toBe("https://api.github.com/repos/lin/aq-packs");
    expect(root.asked[1]).toBe("https://api.github.com/repos/Lin/aq-packs/tags?per_page=100");
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

describe("the README of a pack", () => {
  const place = { owner: "pipi", repo: "aq-opus", commit: COMMIT, path: "" };

  it("is cut where it is too long, at a whole character", () => {
    const long = new TextEncoder().encode(`${"字".repeat(30_000)}`);
    const readme = readmeOf(long, false);
    expect(readme.cut).toBe(true);
    expect(readme.text.endsWith("字")).toBe(true);
    expect(new TextEncoder().encode(readme.text).length).toBeLessThanOrEqual(64 * 1024);
    expect(readmeOf(new TextEncoder().encode("# Hi"), false)).toEqual({ text: "# Hi" });
  });

  it("links only to the web, mail and files of the repository at the commit installed", () => {
    expect(readmeLink("https://example.com/x", place)).toBe("https://example.com/x");
    expect(readmeLink("mailto:a@b.c", place)).toBe("mailto:a@b.c");
    for (const href of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<script>1</script>",
      "vbscript:x",
      "aq:clip/1",
      "file:///etc/passwd",
      "//evil.example/x",
      "#section",
    ]) {
      expect(readmeLink(href, place), href).toBeUndefined();
    }
    expect(readmeLink("docs/use.md", place)).toBe(
      `https://github.com/pipi/aq-opus/blob/${COMMIT}/docs/use.md`,
    );
    expect(readmeLink("/LICENSE", { ...place, path: "a/b" })).toBe(
      `https://github.com/pipi/aq-opus/blob/${COMMIT}/LICENSE`,
    );
    expect(readmeLink("../x.md", { ...place, path: "a" })).toBe(
      `https://github.com/pipi/aq-opus/blob/${COMMIT}/x.md`,
    );
    // Out of the repository: no link.
    expect(readmeLink("../../../../other/repo", place)).toBeUndefined();
    // A pack from this computer: its files are nowhere to link to.
    expect(readmeLink("docs/use.md", undefined)).toBeUndefined();
  });

  it("shows pictures of the repository from the commit installed, and waits for those from elsewhere", () => {
    expect(readmeImage("shots/a.png", place)).toEqual({
      kind: "repository",
      url: `https://raw.githubusercontent.com/pipi/aq-opus/${COMMIT}/shots/a.png`,
    });
    expect(readmeImage("https://i.imgur.com/x.png", place)).toEqual({
      kind: "elsewhere",
      url: "https://i.imgur.com/x.png",
      host: "i.imgur.com",
    });
    // Even GitHub's own raw files, of another commit or repository: from elsewhere.
    expect(
      readmeImage("https://raw.githubusercontent.com/pipi/aq-opus/main/a.png", place).kind,
    ).toBe("elsewhere");
    for (const src of [
      "data:image/svg+xml,<svg/>",
      "javascript:1",
      "//evil.example/a.png",
      "blob:x",
    ]) {
      expect(readmeImage(src, place), src).toEqual({ kind: "none" });
    }
    expect(readmeImage("../../../../x.png", place)).toEqual({ kind: "none" });
    expect(readmeImage("a.png", undefined)).toEqual({ kind: "none" });
  });
});

describe("looking for updates", () => {
  it("asks GitHub for each pack from there at most every few hours, unless asked to", async () => {
    const { ModelPacks, UPDATE_EVERY } = await import("./packs.ts");
    const saved = new Map<string, unknown>();
    const settings = {
      load: async (key: string) => saved.get(key),
      save: async (key: string, value: unknown) => {
        saved.set(key, value);
      },
      listen: () => () => {},
    };
    const memory = new Map<string, string>();
    const window = {
      read: (key: string) => memory.get(key),
      write: (key: string, value: string) => void memory.set(key, value),
    };
    const tagged = gitHub({}, 200, { tags: [{ name: "v1.3.0", sha: TAGGED }] });
    const packs = new ModelPacks(
      settings,
      { saveFailed: () => {} },
      { memory: window, fetcher: tagged.fetcher },
    );
    const manifest = JSON.stringify({
      format: 1,
      id: "lin/steady",
      name: "Steady",
      version: "1.2.0",
    });
    packs.install(new Map([["pack.json", manifest]]), {
      kind: "github",
      url: "https://github.com/lin/aq-packs",
      commit: COMMIT,
    });
    // Just installed: nothing to ask yet.
    await packs.lookForUpdates();
    expect(tagged.asked).toEqual([]);
    await packs.lookForUpdates({ force: true });
    expect(packs.updateOf("lin/steady")).toEqual({
      state: "update",
      commit: TAGGED,
      version: "1.3.0",
    });
    const asked = tagged.asked.length;
    await packs.lookForUpdates();
    expect(tagged.asked.length).toBe(asked);
    // A reload of the window: what was found holds, without asking again.
    const again = new ModelPacks(
      settings,
      { saveFailed: () => {} },
      { memory: window, fetcher: tagged.fetcher },
    );
    await again.load();
    expect(again.updateOf("lin/steady")?.version).toBe("1.3.0");
    await again.lookForUpdates();
    expect(tagged.asked.length).toBe(asked);
    expect(UPDATE_EVERY).toBe(6 * 60 * 60 * 1000);
  });
});
