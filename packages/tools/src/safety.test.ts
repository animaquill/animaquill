/**
 * What keeps AI from writing over what it did not see, and what tells it plainly what went wrong:
 * cases of the independent review of the tools, each as the behavior they should have.
 */
import { ProblemSet, ProjectStore, USER, aiTask, withId, type CommandCall } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { CallerState, HOLD_MS } from "./caller.ts";
import { COMMAND, openSample, testHost, toolsOn } from "./test-support.ts";

const user = (store: ProjectStore, type: string, params: unknown) => {
  const done = store.execute({ type, params } as CommandCall, { origin: USER });
  expect(done.ok, JSON.stringify(done)).toBe(true);
};
const rename = (clip: string, name: string) => ({
  operations: [{ op: "clip.update", timeline: "main", clip, changes: { name } }],
});
const nameOf = (store: ProjectStore, clip: string) =>
  store.getState().timelines.main?.clips[clip]?.name;
const revisionOf = (text: string) => /^rev (\S+)/.exec(text)?.[1] ?? "";
const setOpacity = (value: unknown) => ({
  operations: [
    {
      op: "property.edit",
      timeline: "main",
      edits: [{ owner: { clip: "clip_title" }, path: "opacity", op: "set", value }],
    },
  ],
});

/** A project whose main timeline has many clips with long names. */
function manyClips(count: number, name = "x".repeat(200)): ProjectStore {
  const project = createProject({ name: "many" });
  const main = project.timelines.get("main")?.document as Record<string, unknown>;
  const clips = Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    name,
    start: String(index),
    duration: "1",
    source: { kind: "color", color: "#000000" },
  }));
  const document = { ...main, tracks: [{ id: "v", kind: "video", clips }] } as never;
  return ProjectStore.create({
    ...project,
    timelines: new Map([["main", { document, overrides: new Map() }]]),
  });
}

describe("changes of what was not read", () => {
  it("are refused with not-read, when the caller has read nothing, as after a reload", async () => {
    const store = openSample();
    user(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "用户刚改的" },
    });
    const { call } = toolsOn(testHost(store), new CallerState());
    const result = await call("aq_edit", rename("clip_title", "AI, from before"));
    expect(result.text).toContain(
      'error not-read: you have not read clip_title "用户刚改的" (timeline main)',
    );
    expect(result.text).toContain("Nothing was written.");
    expect(nameOf(store, "clip_title")).toBe("用户刚改的");
  });

  it("are refused also with a revision given, and new objects need no reading", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call, caller } = toolsOn(host);
    // A revision from elsewhere: this caller read nothing.
    const revision = revisionOf((await toolsOn(host).call("aq_project_status")).text);
    const refused = await call("aq_edit", {
      ...rename("clip_title", "AI"),
      base_revision: revision,
    });
    expect(refused.text).toContain("error not-read");
    caller.beginAnswer();
    const added = await call("aq_edit", {
      operations: [{ op: "marker.add", timeline: "main", id: "marker_ai", time: "3" }],
    });
    expect(added.isError, added.text).toBe(false);
    expect(store.getState().timelines.main?.markers.marker_ai).toBeDefined();
  });

  it("go by what a snapshot of the caller kept, read back as after a reload", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const first = toolsOn(host);
    await first.call("aq_timeline_read");
    const snapshot: unknown = JSON.parse(JSON.stringify(first.caller));
    user(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "用户改的" },
    });
    const { call, caller } = toolsOn(host, CallerState.from(snapshot));
    const result = await call("aq_edit", rename("clip_title", "AI"));
    expect(result.text).toContain("error conflict: the user changed clip_title");
    caller.beginAnswer();
    expect((await call("aq_edit", rename("clip_logo", "AI"))).isError).toBe(false);
    // A snapshot of the project before it opened again has revisions that count no more.
    host.open(ProjectStore.fromUpdates([store.encodeState()]).store);
    const reopened = toolsOn(host, CallerState.from(snapshot));
    const stale = await reopened.call("aq_edit", rename("clip_logo", "AI again"));
    expect(stale.text).toContain("error stale-revision");
    expect(CallerState.from({ version: 0 }).seen.size).toBe(0);
  });
});

describe("a base_revision", () => {
  it("never lets through what was changed after the caller read it", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call } = toolsOn(host);
    await call("aq_object_read", { ids: ["clip_title"] });
    user(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "用户改的" },
    });
    const revision = revisionOf((await call("aq_project_status")).text);
    const result = await call("aq_edit", {
      ...rename("clip_title", "AI"),
      base_revision: revision,
    });
    expect(result.text).toContain("error conflict");
    expect(nameOf(store, "clip_title")).toBe("用户改的");
  });

  it("refuses what was changed after it, though the caller read it later", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call, caller } = toolsOn(host);
    const before = revisionOf((await call("aq_project_status")).text);
    user(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "用户改的" },
    });
    await call("aq_object_read", { ids: ["clip_title"] });
    const result = await call("aq_edit", { ...rename("clip_title", "AI"), base_revision: before });
    expect(result.text).toContain("error conflict");
    caller.beginAnswer();
    expect((await call("aq_edit", rename("clip_title", "AI"))).isError).toBe(false);
  });

  it("does not stand for reading a file before replacing it", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call } = toolsOn(host);
    user(store, "file.write", { path: "code/animate.js", text: "// 用户写的\n" });
    const revision = revisionOf((await call("aq_project_status")).text);
    const result = await call("aq_file_write", {
      path: "code/animate.js",
      text: "x\n",
      base_revision: revision,
    });
    expect(result.text).toContain("error file-not-read");
    expect(store.getState().files["code/animate.js"]).toBe("// 用户写的\n");
  });
});

describe("what a list shows", () => {
  it("is all that counts as read: clips cut for room are not", async () => {
    const store = manyClips(600);
    const { call } = toolsOn(testHost(store));
    await call("aq_object_read", { ids: ["c499"] });
    user(store, "clip.update", { timeline: "main", clip: "c499", changes: { name: "用户改的" } });
    const read = await call("aq_timeline_read", { limit: 500 });
    expect(read.text).not.toMatch(/^c499 /m);
    const result = await call("aq_edit", rename("c499", "AI"));
    expect(result.text).toContain("error conflict");
  });

  it("goes on when one item is longer than a result", async () => {
    const store = manyClips(3, "y".repeat(45_000));
    const { call, caller } = toolsOn(testHost(store));
    const first = await call("aq_timeline_read", { limit: 1 });
    expect(first.text).toMatch(/clips 1-1 of 3/);
    expect(first.text).toContain('cursor "c1" gives the next ones.');
    caller.beginAnswer();
    const next = await call("aq_timeline_read", { limit: 1, cursor: "c1" });
    expect(next.text).toMatch(/clips 2-2 of 3/);
  });
});

describe("reading an object whole and then in an overview", () => {
  it("keeps the whole read as the base of what only it shows", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call, caller } = toolsOn(host);
    await call("aq_object_read", { ids: ["clip_title"] });
    user(store, "property.edit", {
      timeline: "main",
      edits: [{ owner: { clip: "clip_title" }, path: "opacity", op: "set", value: 0.4 }],
    });
    caller.beginAnswer();
    await call("aq_timeline_read");
    caller.beginAnswer();
    const keys = {
      keys: [
        { time: "0", value: 0 },
        { time: "2", value: 1 },
      ],
    };
    const write = await call("aq_edit", setOpacity(keys));
    expect(write.text).toContain("error conflict: the user changed clip_title");
    // What the overview shows, it brought up to date.
    caller.beginAnswer();
    expect((await call("aq_edit", rename("clip_title", "AI"))).isError).toBe(false);
    await call("aq_object_read", { ids: ["clip_title"] });
    expect((await call("aq_edit", setOpacity(keys))).isError).toBe(false);
  });

  it("does not make an overview a whole read", async () => {
    const { call, caller } = toolsOn();
    await call("aq_timeline_read");
    expect(
      caller.seenOf({ kind: "clip", id: "clip_title", timeline: "main" }).full,
    ).toBeUndefined();
    await call("aq_object_read", { ids: ["clip_title"], fields: ["name"] });
    expect(
      caller.seenOf({ kind: "clip", id: "clip_title", timeline: "main" }).full,
    ).toBeUndefined();
    await call("aq_object_read", { ids: ["clip_title"] });
    expect(caller.seenOf({ kind: "clip", id: "clip_title", timeline: "main" }).full).toBeDefined();
  });
});

describe("reading a file", () => {
  it("says which lines it gave and where to go on, when they do not all fit", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const text = Array.from(
      { length: 2000 },
      (_, i) => `const value_${i} = "${"a".repeat(30)}";`,
    ).join("\n");
    user(store, "file.write", { path: "code/long.js", text });
    const { call } = toolsOn(host);
    const read = await call("aq_file_read", { path: "code/long.js" });
    const shown = read.text.split("\n").filter((line) => /^\s+\d+→/.test(line)).length;
    expect(shown).toBeLessThan(2000);
    expect(read.text.split("\n")[1]).toBe(`file code/long.js lines 1-${shown} of 2000`);
    expect(read.text).toContain(`offset ${shown + 1}`);
    const write = await call("aq_file_write", { path: "code/long.js", text: "x\n" });
    expect(write.text).toContain(`you have read lines 1-${shown} of code/long.js (2000 lines)`);
    expect(write.text).toContain(`the first line not read is ${shown + 1}`);
  });

  it("needs every line read to replace the file, and a cut line is not read", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    user(store, "file.write", {
      path: "code/part.js",
      text: Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`).join("\n"),
    });
    user(store, "file.write", { path: "code/min.js", text: `const a = "${"z".repeat(5000)}";\n` });
    const { call, caller } = toolsOn(host);
    await call("aq_file_read", { path: "code/part.js", limit: 10 });
    const partly = await call("aq_file_write", { path: "code/part.js", text: "const v0 = 0;\n" });
    expect(partly.text).toContain("you have read lines 1-10 of code/part.js (300 lines)");
    caller.beginAnswer();
    await call("aq_file_read", { path: "code/part.js", offset: 11 });
    expect(
      (await call("aq_file_write", { path: "code/part.js", text: "const v0 = 0;\n" })).isError,
    ).toBe(false);
    caller.beginAnswer();
    const cut = await call("aq_file_read", { path: "code/min.js" });
    expect(cut.text).toContain("line 1 is 5013 characters long; it is cut after 2000");
    expect((await call("aq_file_write", { path: "code/min.js", text: "x\n" })).text).toContain(
      "error file-not-read",
    );
  });

  it("with Windows line endings takes text as it shows, and keeps the endings", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    user(store, "file.write", {
      path: "code/win.js",
      text: "export const a = 1;\r\nexport const b = 2;\r\n",
    });
    const { call } = toolsOn(host);
    const read = await call("aq_file_read", { path: "code/win.js" });
    expect(read.text).toContain("(Windows line endings)");
    expect(read.text).not.toContain("\r");
    const result = await call("aq_file_edit", {
      path: "code/win.js",
      edits: [
        {
          old_text: "export const a = 1;\nexport const b = 2;",
          new_text: "export const a = 3;\nexport const b = 4;",
        },
      ],
    });
    expect(result.isError, result.text).toBe(false);
    expect(store.getState().files["code/win.js"]).toBe(
      "export const a = 3;\r\nexport const b = 4;\r\n",
    );
  });
});

describe("a request_id", () => {
  it("of a dry run does not answer the real write", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call, caller } = toolsOn(host);
    await call("aq_timeline_read");
    const ops = {
      operations: [{ op: "marker.add", timeline: "main", time: "7", name: "Once" }],
      request_id: "add-marker",
    };
    await call("aq_edit", { ...ops, dry_run: true });
    caller.beginAnswer();
    const real = await call("aq_edit", ops);
    expect(real.text).toContain("done: 1 operation as one step");
    expect(
      Object.values(store.getState().timelines.main?.markers ?? {}).some((m) => m.name === "Once"),
    ).toBe(true);
  });
});

describe("parameters that are wrong", () => {
  it("get no did-you-mean for short names, nor a list with parameters AI does not see", async () => {
    const { call } = toolsOn();
    const result = await call("aq_edit", {
      operations: [
        {
          op: "clip.add",
          timeline: "main",
          track: "track_overlay",
          start: "0",
          duration: "1",
          source: { kind: "color", color: "#ff0000" },
          x: 1,
        },
      ],
    });
    expect(result.text).toContain('unknown parameter "x"');
    expect(result.text).not.toContain("did you mean");
    expect(result.text).not.toContain("movedFrom");
  });

  it("are told at the place in a union where they are wrong", async () => {
    const { call, caller } = toolsOn();
    const numberTime = await call(
      "aq_edit",
      setOpacity({
        keys: [
          { time: 0, value: 0 },
          { time: "1", value: 1 },
        ],
      }),
    );
    expect(numberTime.text).toContain(
      'edits[0].value.keys[0].time: expected a time: seconds as a string, such as "12.5", got the number 0',
    );
    caller.beginAnswer();
    const wrongOp = await call("aq_edit", {
      operations: [
        {
          op: "property.edit",
          timeline: "main",
          edits: [
            {
              owner: { clip: "clip_title" },
              path: "transform.x",
              op: "addKey",
              time: "1",
              value: 3,
            },
          ],
        },
      ],
    });
    expect(wrongOp.text).toContain('edits[0].op: expected one of "write", "setKey"');
    expect(wrongOp.text).toContain('got the string "addKey"');
    caller.beginAnswer();
    const missing = await call("aq_edit", {
      operations: [
        { op: "clip.add", timeline: "main", track: "track_overlay", start: "0", duration: "1" },
      ],
    });
    expect(missing.text).toContain('source: missing; such as {"kind":"color","color":"#3366ff"}');
    expect(missing.text).not.toContain("does not fit any");
  });

  it("of the tools that read are errors, not exceptions", async () => {
    const { call } = toolsOn();
    for (const from of ["abc", "-1", "1e3", "1/0"]) {
      const result = await call("aq_timeline_read", { from });
      expect(result.text, from).toContain("error invalid-params");
    }
  });

  it("as a JSON string for operations get told so", async () => {
    const { call } = toolsOn();
    const result = await call("aq_edit", { operations: "[]" });
    expect(result.text).toContain("pass operations as a JSON array, not a string");
    expect(result.text).toContain("nothing was written");
  });
});

describe("names that are not there", () => {
  it("of fields are said to be not set", async () => {
    const { call } = toolsOn();
    const result = await call("aq_object_read", {
      ids: ["clip_title"],
      fields: ["properties.transform.y", "start"],
    });
    expect(result.text).toContain("not set: properties.transform.y");
  });

  it("of transitions and effects come with the built-in ones", async () => {
    const { call, caller } = toolsOn();
    const effect = await call("aq_edit", {
      operations: [{ op: "effect.add", timeline: "main", clip: "clip_title", type: "glow" }],
    });
    expect(effect.text).toContain(
      "There is no effect glow. Built-in effects: brightness, contrast",
    );
    caller.beginAnswer();
    const transition = await call("aq_edit", {
      operations: [
        {
          op: "clip.setTransition",
          timeline: "main",
          clip: "clip_logo",
          enter: { type: "crossfade", duration: "1" },
        },
      ],
    });
    expect(transition.text).toMatch(
      /There is no transition crossfade\. Built-in transitions: .*fade/,
    );
  });

  it("of clips come with similar ones, before nothing was written", async () => {
    const { call } = toolsOn();
    const result = await call("aq_edit", rename("clip_titel", "x"));
    const lines = result.text.split("\n");
    expect(lines[1]).toMatch(/^similar: clip_title/);
    expect(lines.at(-1)).toBe("nothing was written");
  });
});

describe("each message as a task of its own", () => {
  it("counts the caller's earlier changes as its own", async () => {
    let task = "t1";
    const host = { ...testHost(), origin: () => aiTask(task) };
    const store = host.store() as ProjectStore;
    const { call, caller } = toolsOn(host);
    await call("aq_object_read", { ids: ["clip_title"] });
    user(store, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "用户改的" },
    });
    const hide = (hidden: boolean) => ({
      operations: [
        { op: "clip.update", timeline: "main", clip: "clip_title", changes: { hidden } },
      ],
    });
    expect((await call("aq_edit", hide(true))).isError).toBe(false);
    task = "t2";
    caller.beginAnswer();
    const second = await call("aq_edit", hide(false));
    expect(second.isError, second.text).toBe(false);
    expect(second.text).not.toContain("another AI task");
    const conflict = await call("aq_edit", rename("clip_title", "AI"));
    expect(conflict.text).toContain(
      'error conflict: the user changed clip_title "用户改的" (name)',
    );
    expect(conflict.text).not.toContain("hidden");
  });

  it("says the user undid what the caller did", async () => {
    let task = "t1";
    const host = { ...testHost(), origin: () => aiTask(task) };
    const store = host.store() as ProjectStore;
    const { call, caller } = toolsOn(host);
    await call("aq_timeline_read");
    await call("aq_edit", rename("clip_logo", "AI 改的"));
    expect(store.undoOrigin(aiTask("t1")).ok).toBe(true);
    task = "t2";
    caller.beginAnswer();
    const next = await call("aq_project_status");
    expect(next.text).toContain(
      "others: since your last call the user undid your earlier changes of clip_logo (name)",
    );
    const again = await call("aq_edit", rename("clip_logo", "AI again"));
    expect(again.text).toContain(
      "error conflict: the user undid your earlier changes of clip_logo",
    );
  });
});

describe("what others did", () => {
  it("in another window is told as such, in the line about others and in conflicts", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call } = toolsOn(host);
    await call("aq_timeline_read");
    const remote = ProjectStore.fromUpdates([store.encodeState()]).store as ProjectStore;
    user(remote, "clip.update", {
      timeline: "main",
      clip: "clip_title",
      changes: { name: "另一个窗口" },
    });
    store.applyUpdates([remote.encodeState()]);
    const result = await call("aq_edit", rename("clip_title", "AI"));
    expect(result.text).toContain(
      'error conflict: another window changed clip_title "另一个窗口" (name)',
    );
    expect(nameOf(store, "clip_title")).toBe("另一个窗口");
  });

  it("says an object was removed", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const { call } = toolsOn(host);
    await call("aq_timeline_read");
    user(store, "clip.remove", { timeline: "main", clips: ["clip_idea"] });
    const result = await call("aq_edit", rename("clip_idea", "AI"));
    expect(result.text).toContain("the user changed clip_idea (removed)");
  });
});

describe("the syntax check", () => {
  it("takes a .js file as an old script when it is no module", async () => {
    const { call } = toolsOn();
    const result = await call("aq_file_write", {
      path: "code/legacy.js",
      text: "var yield = 1; with (Math) { var r = PI; }\n",
    });
    expect(result.text).toContain("syntax: ok");
  });

  it("does not take data-type for type, and checks JSON", async () => {
    const { call } = toolsOn();
    const page = await call("aq_file_write", {
      path: "scenes/title/x.html",
      text: '<script data-type="x">let a = ;</script>\n',
    });
    expect(page.text).toMatch(/syntax: error/);
    const json = await call("aq_file_write", { path: "code/data.json", text: "{ bad" });
    expect(json.text).toMatch(/syntax: error/);
  });
});

describe("small things of the texts", () => {
  it("say a new file added lines and removed none, of 1 line", async () => {
    const { call } = toolsOn();
    const result = await call("aq_file_write", { path: "code/one.js", text: "export {};" });
    expect(result.text).toContain("wrote code/one.js (new, 1 line)");
    expect(result.text).not.toContain("-1");
  });

  it("send the manifest of a scene to scene.update", async () => {
    const { call } = toolsOn();
    const result = await call("aq_file_write", { path: "scenes/title/scene.json", text: "{}" });
    expect(result.text).toContain("which scene.update in aq_edit changes");
  });

  it("name the guide sections in English too", async () => {
    const { call } = toolsOn();
    const result = await call("aq_guide", { query: "keyframe" });
    expect(result.text).toContain("format/时间轴");
    const topics = await call("aq_guide", {});
    expect(topics.text).toContain("search them with Chinese words too");
  });
});

/** A runtime error of the title scene, as the editor reports it once the scene ran. */
const threw = withId({
  source: "runtime",
  severity: "error",
  code: "scene-error",
  params: {},
  subject: { kind: "scene", id: "title" },
  file: "scenes/title/index.html",
  line: 4,
  detail: "TypeError: x is undefined",
});

/** A host that ran the scenes it is told, at the code they have then. */
function runningHost() {
  const host = testHost();
  const store = host.store() as ProjectStore;
  const problems = new ProblemSet({ reports: ["runtime"] });
  const ran = new Map<string, string>();
  const codeOf = (id: string) =>
    JSON.stringify(
      Object.entries(store.getState().files).filter(([path]) => path.startsWith(`scenes/${id}/`)),
    );
  const run = (id: string) => ran.set(id, codeOf(id));
  return {
    host: {
      ...host,
      problems: () => (problems.update(store.getState()), problems),
      ranNow: ({ id }: { readonly id: string }) => ran.get(id) === codeOf(id),
    },
    store,
    problems,
    run,
  };
}

describe("checking code that changed", () => {
  it("tells changed code that has not run since, and what threw before the change", async () => {
    const { host, problems, run } = runningHost();
    run("title");
    problems.report("runtime", "scenes", [threw]);
    const { call, caller } = toolsOn(host);
    await call("aq_file_read", { path: "scenes/title/index.html" });
    const edit = await call("aq_file_edit", {
      path: "scenes/title/index.html",
      edits: [{ old_text: '<h1 id="title"></h1>', new_text: '<h1 id="title">Hi</h1>' }],
    });
    expect(edit.text).toContain(
      "once the editor has run it: a scene runs while one of its clips is in the preview",
    );
    caller.beginAnswer();
    const before = await call("aq_check_run");
    expect(before.text).toContain(
      "not run since changed: scenes/title/index.html (scene title runs while one of its clips is in the preview)",
    );
    expect(before.text).toMatch(
      /E scene-error .*: the code threw an error \(from the code before its last change\) \| said:/,
    );
    // Once the editor ran the new code, the error is of it, and nothing waits to run.
    run("title");
    caller.beginAnswer();
    const after = await call("aq_check_run");
    expect(after.text).not.toContain("not run since changed");
    expect(after.text).not.toContain("from the code before");
  });

  it("says so of code that never ran, and of a scene with no clips", async () => {
    const { host } = runningHost();
    const { call, caller } = toolsOn(host);
    await call("aq_file_read", { path: "scenes/title/index.html" });
    await call("aq_file_edit", {
      path: "scenes/title/index.html",
      edits: [{ old_text: "<body>", new_text: "<body><script>aq.nope()</script>" }],
    });
    await call("aq_edit", {
      operations: [
        {
          op: "scene.add",
          id: "unused",
          manifest: { name: "Unused", entry: "index.html", runtime: 1 },
          files: { "index.html": "<p>x</p>" },
        },
      ],
    });
    caller.beginAnswer();
    const check = await call("aq_check_run");
    expect(check.text).toContain(
      "not run since changed: scenes/title/index.html (scene title runs",
    );
    expect(check.text).toContain(
      "not run since changed: scenes/unused/index.html (scene unused has no clips, so it does not run)",
    );
  });

  it("says nothing of it where no code runs, as on a command line", async () => {
    const { call } = toolsOn();
    await call("aq_file_read", { path: "scenes/title/index.html" });
    await call("aq_file_edit", {
      path: "scenes/title/index.html",
      edits: [{ old_text: "<body>", new_text: "<body><p>x</p>" }],
    });
    const check = await call("aq_check_run");
    expect(check.text).not.toContain("not run since changed");
  });

  it("keeps what the conversation changed with the caller, over a reload", async () => {
    const { call, caller } = toolsOn();
    await call("aq_file_write", { path: "code/new.js", text: "export {};\n" });
    expect([...CallerState.from(JSON.parse(JSON.stringify(caller))).changedCode]).toEqual([
      "code/new.js",
    ]);
  });
});

describe("a reopened project", () => {
  it("says that what is read again after it can be changed", async () => {
    const host = testHost();
    const store = host.store() as ProjectStore;
    const first = toolsOn(host);
    await first.call("aq_timeline_read");
    const snapshot: unknown = JSON.parse(JSON.stringify(first.caller));
    host.open(ProjectStore.fromUpdates([store.encodeState()]).store);
    const { call } = toolsOn(host, CallerState.from(snapshot));
    const result = await call("aq_edit", rename("clip_logo", "x"));
    expect(result.text).toContain("objects read again after the reopen can be changed");
  });
});

describe("an answer the host says nothing of", () => {
  it("lets go of a failed change once the host says another answer began", async () => {
    let answer = "a1";
    const host = { ...testHost(), answer: () => answer };
    const { call } = toolsOn(host);
    await call("aq_timeline_read");
    await call("aq_edit", { operations: [{ op: "marker.add", timeline: "main", tme: "1" }] });
    const same = await call("aq_edit", {
      operations: [{ op: "marker.add", timeline: "main", time: "1" }],
    });
    expect(same.text).toMatch(/^error not-run/);
    answer = "a2";
    const next = await call("aq_edit", {
      operations: [{ op: "marker.add", timeline: "main", time: "1" }],
    });
    expect(next.isError, next.text).toBe(false);
  });

  it("lets go of it after a while where the host says nothing at all", async () => {
    let now = 1_000;
    const caller = new CallerState(() => now);
    const { call } = toolsOn(testHost(), caller);
    await call("aq_timeline_read");
    await call("aq_edit", { operations: [{ op: "marker.add", timeline: "main", tme: "1" }] });
    const same = await call("aq_edit", {
      operations: [{ op: "marker.add", timeline: "main", time: "1" }],
    });
    expect(same.text).toMatch(/^error not-run/);
    now += HOLD_MS + 1;
    const later = await call("aq_edit", {
      operations: [{ op: "marker.add", timeline: "main", time: "1" }],
    });
    expect(later.isError, later.text).toBe(false);
  });
});

describe("what is kept of a caller", () => {
  it("stays small for a large timeline read over several reloads", async () => {
    const store = manyClips(2000, "c");
    const host = testHost(store);
    let caller = new CallerState();
    for (let round = 0; round < 3; round += 1) {
      const { call } = toolsOn(host, caller);
      for (let page = 0, cursor: string | undefined; page < 5; page += 1) {
        const read = await call("aq_timeline_read", { limit: 500, ...(cursor && { cursor }) });
        cursor = /cursor "(c\d+)"/.exec(read.text)?.[1];
        if (!cursor) break;
      }
      caller = CallerState.from(JSON.parse(JSON.stringify(caller)));
      host.open(ProjectStore.fromUpdates([store.encodeState()]).store);
    }
    expect(JSON.stringify(caller).length).toBeLessThan(200_000);
  });
});

describe("errors that say what does not fit", () => {
  it("say it, without telling AI what to send", async () => {
    const { call, caller } = toolsOn();
    await call("aq_timeline_read");
    const many = Array.from({ length: 101 }, (_, index) => ({
      op: "marker.add",
      timeline: "main",
      time: String(index),
    }));
    const tooMany = await call("aq_edit", { operations: many });
    expect(tooMany.text).toContain("so these take several batches");
    caller.beginAnswer();
    const onTop = await call("aq_edit", {
      operations: [
        {
          op: "clip.move",
          timeline: "main",
          clips: [
            { clip: "clip_lottie", start: "0" },
            { clip: "clip_idea", start: "0" },
          ],
        },
      ],
    });
    expect(onTop.text).toContain("moved clips cannot overlap each other");
    for (const text of [tooMany.text, onTop.text]) expect(text).not.toMatch(COMMAND);
  });
});
