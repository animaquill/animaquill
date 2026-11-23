import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diskWriter } from "@animaquill/core/disk-folder";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  CallerState,
  createToolset,
  mcpInstructions,
  mcpToolsOf,
  type ToolHost,
} from "@animaquill/tools";
import { afterEach, describe, expect, it } from "vitest";
import { check, describe as describeProject, guide } from "./commands.ts";
import { findProject } from "./find.ts";
import { listedTools } from "./server.ts";
import { findTarget } from "./target.ts";
import { FakePage, cleanUp, sampleFolder, storeOf, tempFolder } from "./test-support.ts";

afterEach(cleanUp);

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

const read = (folder: string, path: string) => readFileSync(join(folder, path), "utf8");

describe("finding the project", () => {
  it("is the folder the server starts in, or the nearest one above with animaquill.json", async () => {
    const root = sampleFolder();
    expect(await findProject(undefined, root, "")).toEqual({ kind: "folder", root });
    const inside = join(root, "scenes", "title");
    expect(await findProject(undefined, inside, "")).toEqual({ kind: "folder", root });
  });

  it("is the folder that --project names, or the folder of the animaquill.json it names", async () => {
    const root = sampleFolder();
    const elsewhere = tempFolder();
    expect(await findProject(root, elsewhere)).toEqual({ kind: "folder", root });
    expect(await findProject(join(root, "animaquill.json"), elsewhere)).toEqual({
      kind: "folder",
      root,
    });
  });

  it("is found from the folder the AI tool works in, where the server starts elsewhere", async () => {
    const root = sampleFolder();
    const inside = join(root, "scenes");
    expect(await findProject(undefined, tempFolder(), inside)).toEqual({ kind: "folder", root });
  });

  it("says what to do where there is none", async () => {
    const empty = tempFolder();
    const none = await findProject(undefined, empty, "");
    expect(none.kind).toBe("none");
    expect(none.kind === "none" && none.reason).toMatch(/^error no-project: .*--project/s);
    const given = await findProject(empty, tempFolder());
    expect(given.kind === "none" && given.reason).toMatch(/has no animaquill\.json/);
  });

  it("is a folder of a project, an address of an online one, or else the project in front", async () => {
    const root = sampleFolder();
    const found = await findTarget(undefined, "s1", root, "");
    expect(found.kind === "target" && found.target).toMatchObject({ kind: "folder", root });
    if (found.kind === "target" && found.target.kind === "folder") {
      const probe = JSON.parse(read(root, found.target.probe.path));
      expect(probe.nonce).toBe(found.target.probe.nonce);
      await found.cleanup();
      expect(existsSync(join(root, found.target.probe.path))).toBe(false);
    }
    expect(await findTarget("https://editor.test/p/abc%20d", "s1")).toMatchObject({
      target: { kind: "link", origin: "https://editor.test", project: "abc d" },
    });
    expect((await findTarget("https://editor.test/start", "s1")).kind).toBe("none");
    expect(await findTarget(undefined, "s1", tempFolder(), "")).toMatchObject({
      target: { kind: "front" },
    });
  });

  it("writes no probe through a link", async () => {
    const root = sampleFolder();
    const outside = tempFolder();
    symlinkSync(outside, join(root, ".animaquill"));
    const found = await findTarget(undefined, "s1", root, "");
    expect(found.kind).toBe("none");
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("the tools through MCP", () => {
  const browserTools = () => {
    const host: ToolHost = {
      store: () => undefined,
      origin: () => "ai:t",
      problems: () => {
        throw new Error("not asked");
      },
    };
    return createToolset(host, new CallerState());
  };

  it("are the tools of the browser, in the same order and to the byte", () => {
    const listed = mcpToolsOf(listedTools());
    const browser = browserTools();
    expect(listed.map(({ _meta, ...tool }) => tool)).toEqual(
      browser.map(({ name, title, description, inputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        annotations,
      })),
    );
    expect(listed.length).toBe(14);
  });

  it("load aq_project_status at once, and mark what changes the project as not destructive", async () => {
    const listed = mcpToolsOf(browserTools());
    expect(listed.filter(({ _meta }) => _meta).map(({ name }) => name)).toEqual([
      "aq_project_status",
    ]);
    const writes = listed.filter(({ annotations }) => !annotations.readOnlyHint);
    expect(writes.map(({ name }) => name)).toEqual(["aq_edit", "aq_file_edit", "aq_file_write"]);
    for (const { annotations } of writes) {
      expect(annotations).toMatchObject({ destructiveHint: false, idempotentHint: false });
    }
    for (const { annotations } of listed) expect(annotations.openWorldHint).toBe(false);
    await expect(JSON.stringify(listed, null, 2)).toMatchFileSnapshot(
      "__snapshots__/mcp-tools.json",
    );
  });

  it("come with instructions whose first paragraph says it all, in 512 characters", () => {
    const instructions = mcpInstructions("editor");
    const first = instructions.split("\n\n")[0] ?? "";
    expect(first.length).toBeLessThanOrEqual(512);
    expect(first).toMatch(/aq_project_status/);
    expect(first).toMatch(/aq_edit/);
    expect(instructions.length).toBeLessThanOrEqual(4000);
    expect(instructions).toMatch(/AnimaQuill editor/);
  });
});

describe("writing a folder", () => {
  it("never leaves it, nor follows a link", async () => {
    const root = tempFolder();
    const outside = tempFolder();
    const writer = await diskWriter(root);
    for (const path of ["../x.js", "/tmp/x.js", "a/../../x.js", "C:/x.js", "a\\..\\x.js", "a:b"]) {
      await expect(writer.write(path, "x"), path).rejects.toThrow(/no path inside/);
    }
    mkdirSync(join(root, "code"));
    symlinkSync(outside, join(root, "code", "linked"));
    await expect(writer.write("code/linked/x.js", "x")).rejects.toThrow(/no folder/);
    symlinkSync(join(outside, "target.js"), join(root, "code", "file.js"));
    await expect(writer.write("code/file.js", "x")).rejects.toThrow(/a link/);
    await expect(writer.remove("code/file.js")).rejects.toThrow(/a link/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("the command line", () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      output: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    };
  };

  it("checks a project: 0 without errors, 1 with them, 2 without a project", async () => {
    const root = sampleFolder();
    const fine = capture();
    expect(await check({ kind: "folder", root }, true, fine.output)).toBe(0);
    expect(JSON.parse(fine.out.join("\n"))).toMatchObject({ errors: 0 });
    writeFileSync(join(root, "timelines/highlight/timeline.json"), "{ 坏了");
    const broken = capture();
    expect(await check({ kind: "folder", root }, false, broken.output)).toBe(1);
    expect(broken.out.join("\n")).toMatch(/timelines\/highlight\/timeline\.json/);
    const none = capture();
    expect(
      await check({ kind: "none", reason: "error no-project: none" }, false, none.output),
    ).toBe(2);
  });

  it("describes a project, and reads the manual without one", async () => {
    const root = sampleFolder();
    const said = capture();
    expect(await describeProject({ kind: "folder", root }, said.output)).toBe(0);
    expect(said.out.join("\n")).toContain("原子是什么");
    const manual = capture();
    expect(await guide("ops/clip.move", undefined, manual.output)).toBe(0);
    expect(manual.out.join("\n")).toMatch(/^# clip\.move/m);
  });
});

/** The server as AI tools start it: `animaquill mcp` in a process of its own, on stdio. */
async function connect(
  cwd: string,
  env: Record<string, string>,
  args: readonly string[] = [],
  legacy = false,
  name = "test-client",
) {
  const client = new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", ...args],
    cwd,
    // Nothing opens in a browser here.
    env: {
      ...(process.env as Record<string, string>),
      ANIMAQUILL_TEST: "1",
      ANIMAQUILL_OPEN: "true",
      ...env,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

const textOf = (result: unknown) =>
  ((result as { content: { text: string }[] }).content.at(-1)?.text ?? "") as string;

/** A range of ports of its own for each test, which nothing else here uses. */
let nextPorts = 47_600 + (process.pid % 40) * 10;
const portsOfTest = () => {
  nextPorts += 10;
  return { first: nextPorts, count: 3 };
};

const ORIGIN = "https://editor.test";

describe("animaquill mcp", { timeout: 60_000 }, () => {
  it("serves the tools of the browser to clients of 2026 and of 2025, and says there is no editor", async () => {
    const root = sampleFolder();
    const ports = portsOfTest();
    const env = {
      ANIMAQUILL_HOME: tempFolder(),
      ANIMAQUILL_RELAY_PORTS: `${ports.first}:${ports.count}`,
    };
    for (const legacy of [false, true]) {
      const client = await connect(join(root, "scenes"), env, [], legacy);
      expect(client.getNegotiatedProtocolVersion()).toBe(legacy ? "2025-11-25" : "2026-07-28");
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(
        mcpToolsOf(listedTools()).map(({ name }) => name),
      );
      expect(client.getInstructions()).toBe(mcpInstructions("editor"));
      const status = await client.callTool({ name: "aq_project_status", arguments: {} });
      expect(status.isError).toBe(true);
      expect(textOf(status)).toMatch(/^error editor-not-open: .*the folder /s);
      await client.close();
    }
  });

  it("runs the calls of two AI tools in the page that has the project, through one relay", async () => {
    const root = sampleFolder();
    const ports = portsOfTest();
    const home = tempFolder();
    const env = { ANIMAQUILL_HOME: home, ANIMAQUILL_RELAY_PORTS: `${ports.first}:${ports.count}` };
    // One is told on its command line, and every one by what `allow-origin` keeps.
    writeFileSync(join(home, "mcp.json"), JSON.stringify({ allowOrigins: [ORIGIN] }));
    const first = await connect(root, env, ["--allow-origin", ORIGIN], false, "claude-code");
    const second = await connect(tempFolder(), env, ["--project", root], false, "codex");
    // The first one listens; the page finds it there.
    await first.listTools();
    const store = await storeOf(root);
    const manifest = store.getState().manifest;
    const page = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store,
      folder: root,
      project: { mode: "offline", key: "folder-1", id: manifest.id, name: manifest.name },
    });
    await waitFor(() =>
      page.connect().then(
        () => true,
        () => false,
      ),
    );
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, textOf(result)).toBeFalsy();
      return textOf(result);
    };
    // The page says what it has open a moment after it connects, later on a busy computer.
    await waitFor(async () => {
      const result = await first.callTool({ name: "aq_project_status", arguments: {} });
      return !textOf(result).startsWith("error editor-not-open") || false;
    }, 30_000);
    const status = await call(first, "aq_project_status", {});
    expect(status).toMatch(new RegExp(`^project: "${manifest.name}" \\(offline, the folder `));
    expect(await call(second, "aq_timeline_read", { timeline: "main" })).toMatch(/clip_/);
    await call(second, "aq_edit", {
      operations: [
        {
          op: "clip.add",
          timeline: "main",
          track: "track_video",
          id: "clip_headline",
          start: "31",
          duration: "4",
          source: { kind: "scene", scene: "title" },
        },
      ],
    });
    // In the page, as that session.
    const clip = store.getState().timelines.main?.clips.clip_headline;
    expect(clip?.source).toMatchObject({ kind: "scene", scene: "title" });
    // The AI tool has its own plan mode: a plan goes in its reply, and nothing here holds changes.
    expect(
      await call(first, "aq_propose", { kind: "plan", title: "片头", steps: [{ text: "淡入" }] }),
    ).toMatch(/no plan card/);
    // The relay goes: the other one takes over, and the page connects to it.
    await first.close();
    page.close();
    // On whichever port of the range it got, as pages look on each.
    const again = await waitFor(async () => {
      for (let port = ports.first; port < ports.first + ports.count; port += 1) {
        const next = new FakePage({
          port,
          origin: ORIGIN,
          store,
          folder: root,
          project: { mode: "offline", key: "folder-1", id: manifest.id, name: manifest.name },
        });
        const connected = await next.connect().then(
          () => true,
          () => false,
        );
        if (connected) return next;
      }
      return false;
    });
    expect(await call(second, "aq_timeline_read", { timeline: "main" })).toMatch(/clip_headline/);
    await second.close();
    again.close();
    store.destroy();
    // What told the page which folder it is goes with the sessions.
    expect(existsSync(join(root, ".animaquill/mcp"))).toBe(true);
    expect(readdirSync(join(root, ".animaquill/mcp"))).toEqual([]);
  });

  it("finds no project in a copy of the folder, which has the same id", async () => {
    const root = sampleFolder();
    const copy = sampleFolder();
    const ports = portsOfTest();
    const env = {
      ANIMAQUILL_HOME: tempFolder(),
      ANIMAQUILL_RELAY_PORTS: `${ports.first}:${ports.count}`,
    };
    const client = await connect(copy, env, ["--allow-origin", ORIGIN]);
    await client.listTools();
    const store = await storeOf(root);
    const manifest = store.getState().manifest;
    const page = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store,
      folder: root,
      project: { mode: "offline", key: "folder-1", id: manifest.id, name: manifest.name },
    });
    await waitFor(() =>
      page.connect().then(
        () => true,
        () => false,
      ),
    );
    // The page of the other folder shows that AI tools wait for this one; nothing runs there.
    const result = await client.callTool({ name: "aq_project_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^error editor-opening: .*wait for the project/);
    await client.close();
    page.close();
    store.destroy();
  });

  it("keeps out pages of other origins", async () => {
    const root = sampleFolder();
    const ports = portsOfTest();
    const env = {
      ANIMAQUILL_HOME: tempFolder(),
      ANIMAQUILL_RELAY_PORTS: `${ports.first}:${ports.count}`,
    };
    const client = await connect(root, env, ["--allow-origin", ORIGIN]);
    await client.listTools();
    const store = await storeOf(root);
    const page = new FakePage({
      port: ports.first,
      origin: "https://elsewhere.test",
      store,
      project: { mode: "online", key: "p", id: "x", name: "x" },
    });
    await waitFor(() =>
      page.connect().then(
        () => "in",
        (error: Error) => (/403|Unexpected server response/.test(error.message) ? "out" : false),
      ),
    ).then((how) => expect(how).toBe("out"));
    await client.close();
    store.destroy();
  });

  it("says what to do where --project names no project", async () => {
    const env = { ANIMAQUILL_HOME: tempFolder(), ANIMAQUILL_RELAY_PORTS: "47590:2" };
    const client = await connect(tempFolder(), env, ["--project", tempFolder()]);
    const result = await client.callTool({ name: "aq_project_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no-project.*--project/s);
    await client.close();
  });
});

/** Waits for something to be true, or gives what it was. */
async function waitFor<T>(attempt: () => Promise<T | false>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const got = await attempt();
    if (got !== false) return got;
    if (Date.now() > until) throw new Error("waited in vain");
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe("the skill", () => {
  const SKILL = fileURLToPath(new URL("../../../../skills/animaquill/", import.meta.url));
  const pages = () => [
    "SKILL.md",
    ...readdirSync(join(SKILL, "references")).map((name) => `references/${name}`),
  ];

  it("has what Agent Skills ask for: a name of its folder and a description", () => {
    const text = read(SKILL, "SKILL.md");
    const head = /^---\nname: (.+)\ndescription: (.+)\n/.exec(text);
    expect(head?.[1]).toBe("animaquill");
    expect((head?.[2] ?? "").length).toBeLessThanOrEqual(1024);
    for (const [, link] of text.matchAll(/\]\((references\/[^)]+)\)/g)) {
      expect(existsSync(join(SKILL, link as string)), link).toBe(true);
    }
  });

  it("gives batches that aq_edit takes, and names only tools there are", () => {
    const tools = listedTools();
    const edit = tools.find(({ name }) => name === "aq_edit");
    const names = new Set(tools.map(({ name }) => name));
    let batches = 0;
    for (const page of pages()) {
      const text = read(SKILL, page);
      for (const [name] of text.matchAll(/\baq_[a-z_]+/g))
        expect(names, `${page}: ${name}`).toContain(name);
      for (const [, block] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        const operations = JSON.parse(block as string);
        expect(edit?.validate({ operations }), `${page}: ${block}`).toBeUndefined();
        batches += 1;
      }
    }
    expect(batches).toBeGreaterThanOrEqual(2);
    // The check is no formality.
    expect(edit?.validate({ operations: [{ op: "clip.add", timeline: "main" }] })).toBeDefined();
  });
});

describe("the marketplace of Claude Code plugins", () => {
  // The format, as https://code.claude.com/docs/en/plugins/marketplace-reference and
  // https://code.claude.com/docs/en/plugins/manifest-reference have it (read 2026-11-15).
  const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
  const marketplace = JSON.parse(read(ROOT, ".claude-plugin/marketplace.json")) as {
    name: string;
    owner: { name: string };
    plugins: {
      name: string;
      source: string;
      skills: string[];
      mcpServers: Record<string, { command: string; args: string[] }>;
    }[];
  };
  const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  it("has a name, an owner and one plugin, as names of plugin ids can be", () => {
    expect(marketplace.name).toMatch(ID);
    expect(marketplace.name).not.toMatch(/\.\./);
    expect(marketplace.owner.name.length).toBeGreaterThan(0);
    expect(marketplace.plugins.map(({ name }) => name)).toEqual(["animaquill"]);
    for (const { name } of marketplace.plugins) {
      expect(name).toMatch(ID);
      expect(name).not.toMatch(/^(claude|anthropic)/i);
    }
  });

  it("is the plugin itself, at the root of the repository, with the skill and the server", () => {
    const [plugin] = marketplace.plugins;
    expect(plugin?.source).toBe("./");
    // Without a plugin.json of its own, the entry is the manifest, servers included.
    expect(existsSync(join(ROOT, ".claude-plugin/plugin.json"))).toBe(false);
    for (const path of plugin?.skills ?? []) {
      expect(path.startsWith("./") && !path.includes("..")).toBe(true);
      expect(existsSync(join(ROOT, path, "SKILL.md")), path).toBe(true);
    }
    expect(plugin?.mcpServers).toEqual({
      animaquill: { command: "npx", args: ["-y", "animaquill@latest", "mcp"] },
    });
  });

  it("is what the README says to install", () => {
    const readme = read(ROOT, "packages/local/README.md");
    expect(readme).toContain("claude plugin marketplace add animaquill/animaquill");
    const [plugin] = marketplace.plugins;
    expect(readme).toContain(`claude plugin install ${plugin?.name}@${marketplace.name}`);
    const { command, args } = plugin?.mcpServers.animaquill ?? { command: "", args: [] };
    expect(readme).toContain(
      `claude mcp add --scope user animaquill -- ${command} ${args.join(" ")}`,
    );
    expect(readme).toContain(`codex mcp add animaquill -- ${command} ${args.join(" ")}`);
  });
});

describe("the types of the scene runtime", () => {
  const OSS = fileURLToPath(new URL("../../../../", import.meta.url));
  /** The names of `aq` that a table of the scene runtime lists, from the line of each. */
  const namesIn = (table: string) =>
    [...table.matchAll(/^\| `aq\.([a-z]+)/gm)].map(([, name]) => name as string);
  const runtime = read(OSS, "docs/scene-runtime.md");
  const [scenes = "", sounds = ""] = runtime.split(/^## 声音$/m);

  it("go along with the npm package, and declare what the runtime says aq has", () => {
    const manifest = JSON.parse(read(OSS, "packages/local/package.json")) as { files: string[] };
    expect(manifest.files).toContain("types");
    const scene = read(OSS, "packages/local/types/scene.d.ts");
    const sound = read(OSS, "packages/local/types/sound.d.ts");
    const declared = (types: string) =>
      new Set([...types.matchAll(/^\s+(?:readonly )?([a-z]+)[(:]/gm)].map(([, name]) => name));
    expect(namesIn(scenes).length).toBeGreaterThanOrEqual(6);
    for (const name of namesIn(scenes)) expect(declared(scene), name).toContain(name);
    expect(namesIn(sounds)).toEqual(["runtime", "sound"]);
    for (const name of namesIn(sounds)) expect(declared(sound), name).toContain(name);
  });
});
