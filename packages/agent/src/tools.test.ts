import { COMMANDS, ProjectStore, aiTask, orderedTracks } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { allTools, commandTools, readTools, toolName, type ToolContext } from "./tools.ts";

function setup(selection?: ToolContext["selection"]) {
  const store = ProjectStore.create(createProject({ name: "工具" }));
  let seen: number | undefined = store.revision;
  const context: ToolContext = {
    store: () => store,
    task: "t1",
    selection: selection ?? (() => undefined),
    seen: () => seen,
    saw: (revision) => (seen = revision),
  };
  const tools = new Map(allTools(context).map((tool) => [tool.name, tool]));
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(args);
  };
  return { store, context, tools, run, setSeen: (value: number | undefined) => (seen = value) };
}

describe("command tools", () => {
  it("are every command AI may give, named without dots, each with what it does", () => {
    const { context } = setup();
    const tools = commandTools(context);
    const allowed = COMMANDS.filter((command) => !command.userOnly);
    expect(tools.map((tool) => tool.name)).toEqual(allowed.map((c) => toolName(c.type)));
    expect(tools.map((tool) => tool.name)).not.toContain("project_setTags");
    // AI cannot tell where a file is, and where it goes is for people to choose.
    expect(tools.map((tool) => tool.name)).not.toContain("asset_setStorage");
    const add = tools.find(({ name }) => name === "asset_add");
    expect(add?.description).not.toMatch(/存放/);
    const parameters = JSON.stringify(add?.parameters);
    expect(parameters).toContain('"enum":["local","git"]');
    expect(parameters).not.toMatch(/"(lfs|platform|remote)"/);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.description.length).toBeGreaterThan(4);
    }
    for (const command of COMMANDS) expect(command.description.length).toBeGreaterThan(4);
  });

  it("leave out what only people may pass", () => {
    const { context } = setup();
    const byName = new Map(commandTools(context).map((tool) => [tool.name, tool]));
    const properties = (name: string) =>
      Object.keys((byName.get(name)?.parameters.properties ?? {}) as object);
    expect(properties("clip_add")).not.toContain("movedFrom");
    expect(properties("join_add")).not.toContain("copied");
    expect(properties("clip_add")).toContain("clip");
  });

  it("change the project as the task, which can be taken back as a whole", async () => {
    const { store, run } = setup();
    const answer = JSON.parse(
      await run("marker_add", { timeline: "main", marker: { time: "1.5", name: "开头" } }),
    );
    expect(answer.ok).toBe(true);
    await run("project_rename", { name: "改过了" });
    const markers = () => Object.values(store.getState().timelines.main?.markers ?? {});
    expect(markers()).toHaveLength(1);
    expect(store.history.at(-1)?.origin).toBe(aiTask("t1"));
    expect(store.canUndoOrigin(aiTask("t1"))).toBe(true);
    expect(store.undoOrigin(aiTask("t1")).ok).toBe(true);
    expect(markers()).toHaveLength(0);
    expect(store.getState().manifest.name).toBe("工具");
  });

  it("say why a command was refused", async () => {
    const { run } = setup();
    await expect(run("marker_remove", { timeline: "main", marker: "nope" })).rejects.toThrow(
      /^not-found: /,
    );
  });

  it("refuse what people changed after AI last looked", async () => {
    const { store, run, setSeen } = setup();
    setSeen(store.revision);
    store.execute({ type: "project.rename", params: { name: "用户改的" } });
    await expect(run("project_rename", { name: "AI 改的" })).rejects.toThrow(/conflict/);
    expect(store.getState().manifest.name).toBe("用户改的");
    // After reading again, it goes through.
    await run("project_overview");
    await run("project_rename", { name: "AI 改的" });
    expect(store.getState().manifest.name).toBe("AI 改的");
  });

  it("ignore parameters only people may use, also when AI writes them", async () => {
    const { store, run } = setup();
    const track = orderedTracks(store.getState().timelines.main!)[0]!.id;
    await expect(
      run("clip_add", {
        timeline: "main",
        track,
        clip: { start: "0", duration: "1", source: { kind: "color", color: "#ff0000" } },
        movedFrom: "somewhere",
      }),
    ).resolves.toContain('"ok":true');
  });
});

describe("read tools", () => {
  it("tell about the project, a timeline, the selection and a file", async () => {
    const { store, run } = setup(() => ({
      timeline: "main",
      playhead: "2",
      clips: ["c1"],
    }));
    const track = orderedTracks(store.getState().timelines.main!)[0]!.id;
    store.execute({
      type: "clip.add",
      params: {
        timeline: "main",
        track,
        clip: { id: "c1", start: "1", duration: "2", source: { kind: "color", color: "#00ff00" } },
      },
    });
    store.execute({ type: "file.write", params: { path: "code/a.js", text: "x".repeat(30) } });

    const overview = JSON.parse(await run("project_overview"));
    expect(overview.name).toBe("工具");
    expect(overview.timelines[0].id).toBe("main");
    expect(overview.files).toEqual(["code/a.js"]);

    const timeline = JSON.parse(await run("timeline_read", { from: "0", to: "5" }));
    expect(timeline.clips.map((clip: { id: string }) => clip.id)).toEqual(["c1"]);
    expect(timeline.clips[0].end).toBe("3");
    expect(JSON.parse(await run("timeline_read", { from: "4" })).clips).toEqual([]);

    const selection = JSON.parse(await run("selection_read"));
    expect(selection.playhead).toBe("2");
    expect(selection.clips[0].source.color).toBe("#00ff00");

    const file = JSON.parse(await run("file_read", { path: "code/a.js", offset: 10, length: 5 }));
    expect(file).toMatchObject({ length: 30, text: "xxxxx", more: 15 });
    await expect(run("file_read", { path: "nope.js" })).rejects.toThrow(/not-found/);
    await expect(run("timeline_read", { from: "abc" })).rejects.toThrow(/invalid-params/);
  });

  it("say when no project is open", async () => {
    const tools = readTools({
      store: () => undefined,
      task: "t",
      selection: () => undefined,
      seen: () => undefined,
      saw: () => {},
    });
    await expect(tools[0]!.run({})).rejects.toThrow(/no-project/);
  });
});
