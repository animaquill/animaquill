import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectStore, readFolder } from "@animaquill/core";
import { diskFolder } from "@animaquill/core/disk-folder";
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
import { FolderTools } from "./host.ts";
import {
  BATCH_GAP_MS,
  BatchNotes,
  CONNECTIONS_FOLDER,
  ConnectionFile,
  GONE_AFTER_MS,
  KEEP_BATCHES_MS,
  LEFT_CONNECTION_MS,
  readBatchNotes,
  tidyLeftovers,
  readConnections,
} from "./notes.ts";
import { cleanUp, sampleFolder, tempFolder } from "./test-support.ts";
import { FolderProject } from "./folder-project.ts";
import { diskWriter } from "@animaquill/core/disk-folder";

afterEach(cleanUp);

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

const read = (folder: string, path: string) => readFileSync(join(folder, path), "utf8");

/** The project in a folder as the editor would read it now. */
async function projectIn(folder: string) {
  const reading = await readFolder(await diskFolder(folder));
  return ProjectStore.create(reading.project, reading.sources);
}

/** The tools on a folder, as the server has them, without the protocol. */
const toolsOn = (root: string, notes = false) =>
  new FolderTools({ place: { kind: "folder", root }, notes });

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

  it("gives every call the error, and the same list of tools", async () => {
    const reason = "error no-project: none here";
    const tools = new FolderTools({ place: { kind: "none", reason } });
    expect(tools.tools.map(({ name }) => name)).toContain("aq_edit");
    expect(await tools.call("aq_project_status", {})).toEqual({ text: reason, isError: true });
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
    const listed = mcpToolsOf(toolsOn(tempFolder()).tools);
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
    expect(listed.length).toBe(13);
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
    const instructions = mcpInstructions("folder");
    const first = instructions.split("\n\n")[0] ?? "";
    expect(first.length).toBeLessThanOrEqual(512);
    expect(first).toMatch(/aq_project_status/);
    expect(first).toMatch(/aq_edit/);
    expect(instructions.length).toBeLessThanOrEqual(4000);
    expect(instructions).toMatch(/AnimaQuill editor/);
  });
});

describe("a project folder", () => {
  it("takes in what changed in the folder, and the next result says who changed what", async () => {
    const root = sampleFolder();
    const tools = toolsOn(root);
    const before = await tools.call("aq_timeline_read", { timeline: "main" });
    expect(before.isError).toBe(false);
    const manifest = JSON.parse(read(root, "animaquill.json")) as Record<string, unknown>;
    writeFileSync(
      join(root, "animaquill.json"),
      `${JSON.stringify({ ...manifest, name: "外面改的名字" }, null, 2)}\n`,
    );
    const status = await tools.call("aq_project_status", {});
    expect(status.text).toContain("外面改的名字");
    expect(status.text).toMatch(/^others: .*files in the project folder changed/m);
    const next = await tools.call("aq_timeline_read", { timeline: "main" });
    expect(next.text).not.toMatch(/^others:/m);
    await tools.close();
  });

  it("writes a change back, which the editor reads as it was made", async () => {
    const root = sampleFolder();
    const tools = toolsOn(root);
    await tools.call("aq_timeline_read", { timeline: "main" });
    const result = await tools.call("aq_edit", {
      operations: [
        {
          op: "clip.add",
          timeline: "main",
          track: "track_captions",
          id: "clip_mcp",
          start: "9",
          duration: "2",
          source: { kind: "caption", text: "从命令行加的" },
        },
      ],
    });
    expect(result.isError, result.text).toBe(false);
    const store = await projectIn(root);
    expect(store.getState().timelines.main?.clips.clip_mcp?.source).toMatchObject({
      kind: "caption",
      text: "从命令行加的",
    });
    store.destroy();
    await tools.close();
  });

  it("writes only what changed, and not what a file merely looks like differently", async () => {
    const root = sampleFolder();
    // Valid, and not how the editor writes it.
    const manifest = read(root, "animaquill.json").replaceAll("\n", "\r\n");
    writeFileSync(join(root, "animaquill.json"), manifest);
    const tools = toolsOn(root);
    await tools.call("aq_file_read", { path: "code/animate.js" });
    const edited = await tools.call("aq_file_edit", {
      path: "code/animate.js",
      edits: [{ old_text: "export", new_text: "// 改过\nexport" }],
    });
    expect(edited.isError, edited.text).toBe(false);
    expect(read(root, "code/animate.js")).toMatch(/^\/\/ 改过\nexport/);
    expect(read(root, "animaquill.json")).toBe(manifest);
    await tools.close();
  });

  it("does not write over a file that changed right before, and takes it in first", async () => {
    const root = sampleFolder();
    const project = await FolderProject.open(root);
    const text = read(root, "code/animate.js");
    writeFileSync(join(root, "code/animate.js"), `${text}// 外面\n`);
    const changed = project.store.execute({
      type: "file.write",
      params: { path: "code/animate.js", text: `// 里面\n${text}` },
    });
    expect(changed.ok).toBe(true);
    await project.save();
    expect(read(root, "code/animate.js")).toBe(`// 里面\n${text}// 外面\n`);
    project.destroy();
  });

  it("leaves a file that cannot come in as it is", async () => {
    const root = sampleFolder();
    const tools = toolsOn(root);
    await tools.call("aq_timeline_read", { timeline: "main" });
    writeFileSync(join(root, "timelines/main/timeline.json"), "{ 坏了");
    await tools.call("aq_edit", {
      operations: [{ op: "project.rename", name: "新名字" }],
    });
    expect(read(root, "timelines/main/timeline.json")).toBe("{ 坏了");
    expect(JSON.parse(read(root, "animaquill.json")).name).toBe("新名字");
    await tools.close();
  });
});

describe("what the review found (MCP1)", () => {
  it("writes nothing more once animaquill.json went away, as before an export", async () => {
    const root = sampleFolder();
    const project = await FolderProject.open(root);
    const text = read(root, "code/animate.js");
    const changed = project.store.execute({
      type: "file.write",
      params: { path: "code/animate.js", text: `// 改过\n${text}` },
    });
    expect(changed.ok).toBe(true);
    rmSync(join(root, "animaquill.json"));
    expect(await project.save()).toEqual([]);
    expect(project.trouble).toBe("manifest-gone");
    expect(read(root, "code/animate.js")).toBe(text);
    project.destroy();
  });

  it("keeps a file that became a link, and neither writes it nor takes it away", async () => {
    const root = sampleFolder();
    const outside = tempFolder();
    writeFileSync(join(outside, "x.html"), "外面");
    const tools = toolsOn(root);
    await tools.call("aq_project_status", {});
    rmSync(join(root, "code/animate.js"));
    symlinkSync(join(outside, "x.html"), join(root, "code/animate.js"));
    await tools.call("aq_file_read", { path: "code/animate.js" });
    const edited = await tools.call("aq_file_edit", {
      path: "code/animate.js",
      edits: [{ old_text: "export", new_text: "// 改过\nexport" }],
    });
    expect(edited.text).not.toMatch(/not found|no such file/i);
    expect(read(outside, "x.html")).toBe("外面");
    expect(lstatSync(join(root, "code/animate.js")).isSymbolicLink()).toBe(true);
    await tools.close();
  });

  it("says which folder it works on", async () => {
    const root = sampleFolder();
    const tools = toolsOn(root);
    expect((await tools.call("aq_project_status", {})).text).toContain(`project folder: ${root}`);
    await tools.close();
  });

  it("takes no project from the home folder unless it is named", async () => {
    const home = sampleFolder();
    const before = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const found = await findProject(undefined, join(home, "scenes"), "");
      expect(found.kind === "none" && found.reason).toMatch(/home folder.*--project/s);
      expect(await findProject(home, tempFolder(), "")).toEqual({ kind: "folder", root: home });
    } finally {
      process.env["HOME"] = before;
    }
  });

  it("clears what a stopped server left, and only that", async () => {
    const root = tempFolder();
    const writer = await diskWriter(root);
    await writer.write(".animaquill/tmp/0123456789abcdef.part", "half");
    await writer.write(".animaquill/tmp/mine.txt", "somebody's");
    await writer.write(".animaquill/mcp/0123456789ab.json", "{}");
    const later = Date.now() + LEFT_CONNECTION_MS + 60_000;
    await tidyLeftovers(root, writer, Date.now() + 60_000);
    expect(existsSync(join(root, ".animaquill/tmp/0123456789abcdef.part"))).toBe(true);
    await tidyLeftovers(root, writer, later);
    expect(readdirSync(join(root, ".animaquill/tmp"))).toEqual(["mine.txt"]);
    expect(readdirSync(join(root, ".animaquill/mcp"))).toEqual([]);
  });

  it("tidies only notes on batches that it wrote", async () => {
    const root = tempFolder();
    const writer = await diskWriter(root);
    await writer.write(".animaquill/batches/other.json", '{"format":1,"batch":"x"}');
    await writer.write(".animaquill/batches/odd.json", '{"format":1,"batch":"odd"}');
    let now = 1_000_000;
    const notes = new BatchNotes(writer, root, "s1", () => now);
    const first = await notes.note([{ path: "a.js", hash: "1" }], undefined);
    now += KEEP_BATCHES_MS + BATCH_GAP_MS + 1;
    await notes.note([{ path: "a.js", hash: "2" }], undefined);
    const names = readdirSync(join(root, ".animaquill/batches"));
    expect(names).toContain("other.json");
    expect(names).toContain("odd.json");
    expect(names).not.toContain(`${first.batch}.json`);
  });
});

describe("notes of the local MCP", () => {
  it("make one batch of writes of a connection that follow within ten minutes", async () => {
    const root = tempFolder();
    const writer = await diskWriter(root);
    let now = 1_000_000;
    const notes = new BatchNotes(writer, root, "s1", () => now);
    const client = { name: "claude-code", version: "2.1.0" };
    const first = await notes.note([{ path: "a.js", hash: "1" }], client);
    now += BATCH_GAP_MS;
    const second = await notes.note([{ path: "b.js", hash: "2" }], client);
    expect(second.batch).toBe(first.batch);
    expect(second.files).toEqual({ "a.js": "1", "b.js": "2" });
    now += BATCH_GAP_MS + 1;
    const third = await notes.note([{ path: "a.js", hash: undefined }], client);
    expect(third.batch).not.toBe(first.batch);
    expect(third.files).toEqual({ "a.js": null });
    // Another connection is another batch.
    const other = await new BatchNotes(writer, root, "s2", () => now).note(
      [{ path: "a.js", hash: "3" }],
      client,
    );
    expect(other.batch).not.toBe(third.batch);
    const kept = await readBatchNotes(root);
    expect(kept.map(({ session, client: who }) => [session, who?.name]).toSorted()).toEqual([
      ["s1", "claude-code"],
      ["s1", "claude-code"],
      ["s2", "claude-code"],
    ]);
    expect(read(root, ".animaquill/.gitignore")).toBe("*\n");
  });

  it("are written as an AI tool changes the project, with its name", async () => {
    const root = sampleFolder();
    const tools = toolsOn(root, true);
    tools.named({ name: "codex", version: "1.0" });
    await tools.call("aq_file_read", { path: "code/animate.js" });
    await tools.call("aq_file_edit", {
      path: "code/animate.js",
      edits: [{ old_text: "export", new_text: "// 改过\nexport" }],
    });
    const [note] = await readBatchNotes(root);
    expect(note?.client).toEqual({ name: "codex", version: "1.0" });
    expect(Object.keys(note?.files ?? {})).toEqual(["code/animate.js"]);
    const connections = await readConnections(root);
    expect(connections.map(({ session, client }) => [session, client?.name])).toEqual([
      [tools.session, "codex"],
    ]);
    await tools.close();
    expect(await readConnections(root)).toEqual([]);
    expect(readdirSync(join(root, CONNECTIONS_FOLDER))).toEqual([]);
  });

  it("say a connection is on while it says so, and gone after two minutes", async () => {
    const root = tempFolder();
    let now = 5_000_000;
    const file = new ConnectionFile(await diskWriter(root), "s1", () => now);
    await file.start();
    expect((await readConnections(root, now)).length).toBe(1);
    expect((await readConnections(root, now + GONE_AFTER_MS + 1)).length).toBe(0);
    now += 60_000;
    await file.named({ name: "claude-code" });
    expect(
      (await readConnections(root, now + GONE_AFTER_MS)).map(({ aliveAt }) => aliveAt),
    ).toEqual([now]);
    await file.close();
    expect(existsSync(join(root, file.path))).toBe(false);
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

  it("keeps AI to the project folder", async () => {
    const root = sampleFolder();
    const tools = toolsOn(root);
    const result = await tools.call("aq_file_write", { path: "../outside.js", text: "x" });
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, "..", "outside.js"))).toBe(false);
    await tools.close();
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
async function connect(cwd: string, args: readonly string[] = [], legacy = false) {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { versionNegotiation: { mode: legacy ? "legacy" : { pin: "2026-07-28" } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", ...args],
    cwd,
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

const textOf = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0]?.text ?? "") as string;

describe("animaquill mcp", { timeout: 60_000 }, () => {
  it("serves the tools to a client of 2026 and of 2025, on the project it starts in", async () => {
    const root = sampleFolder();
    for (const legacy of [false, true]) {
      const client = await connect(join(root, "scenes"), [], legacy);
      expect(client.getNegotiatedProtocolVersion()).toBe(legacy ? "2025-11-25" : "2026-07-28");
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(
        mcpToolsOf(toolsOn(root).tools).map(({ name }) => name),
      );
      expect(client.getInstructions()).toBe(mcpInstructions("folder"));
      const status = await client.callTool({ name: "aq_project_status", arguments: {} });
      expect(textOf(status)).toContain("原子是什么");
      await client.close();
    }
  });

  it("does the tasks of the design: read, add a clip with keys, change code, fix a problem", async () => {
    const root = sampleFolder();
    const client = await connect(tempFolder(), ["--project", root]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, textOf(result)).toBeFalsy();
      return textOf(result);
    };
    expect(await call("aq_timeline_read", { timeline: "main" })).toMatch(/clip_/);
    await call("aq_edit", {
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
        {
          op: "property.edit",
          timeline: "main",
          edits: [
            {
              owner: { clip: "clip_headline" },
              path: "transform.scale",
              op: "set",
              value: {
                keys: [
                  { time: "0", value: 0.8 },
                  { time: "1", value: 1 },
                ],
              },
            },
          ],
        },
      ],
    });
    await call("aq_file_read", { path: "scenes/title/index.html" });
    await call("aq_file_edit", {
      path: "scenes/title/index.html",
      edits: [{ old_text: '<h1 id="title"></h1>', new_text: '<h1 id="title" class="big"></h1>' }],
    });
    // A problem made outside: the AI finds it, and fixes it.
    const timeline = JSON.parse(read(root, "timelines/main/timeline.json"));
    timeline.tracks[0].clips.push({
      id: "clip_ghost",
      start: "40",
      duration: "1",
      source: { kind: "scene", scene: "ghost" },
    });
    writeFileSync(join(root, "timelines/main/timeline.json"), JSON.stringify(timeline));
    const problems = await call("aq_check_run", {});
    expect(problems).toMatch(/scene-missing clip_ghost/);
    // Changed by somebody else: it is read before it is changed, as with the editor.
    expect(await call("aq_timeline_read", { timeline: "main" })).toMatch(/clip_ghost/);
    await call("aq_edit", {
      operations: [{ op: "clip.remove", timeline: "main", clips: ["clip_ghost"] }],
    });
    expect(await call("aq_check_run", {})).not.toMatch(/clip_ghost/);
    await client.close();

    const store = await projectIn(root);
    const state = store.getState();
    const clip = state.timelines.main?.clips.clip_headline;
    expect(clip?.source).toMatchObject({ kind: "scene", scene: "title" });
    expect(JSON.stringify(clip?.properties)).toMatch(/"keys"/);
    expect(state.files["scenes/title/index.html"]).toContain('class="big"');
    expect(state.timelines.main?.clips.clip_ghost).toBeUndefined();
    store.destroy();
    const [note] = await readBatchNotes(root);
    expect(note?.client?.name).toBe("test-client");
    expect(Object.keys(note?.files ?? {})).toEqual(
      expect.arrayContaining(["timelines/main/timeline.json", "scenes/title/index.html"]),
    );
  });

  it("says where it looked when it finds no project", async () => {
    const client = await connect(tempFolder());
    const result = await client.callTool({ name: "aq_project_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no-project.*--project/s);
    await client.close();
  });
});

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
    const tools = toolsOn(tempFolder()).tools;
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
