import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import { OPERATIONS, operationOf, type Operation } from "./commands.ts";
import { brokenDocument } from "./document-check.ts";
import { FAILURE_SAMPLES, INVALID_VALUE_SAMPLES } from "./failure-samples.ts";
import {
  FAILURES,
  FAILURE_CODES,
  GENERAL_FAILURES,
  InvalidValue,
  type CommandFailure,
} from "./failures.ts";
import { documentAt, stateToProject } from "./model.ts";
import { objectKey, objectOfPath } from "./object-of-path.ts";
import { aiTask, ProjectStore, USER, type CommandResult } from "./store.ts";

/** The example project without its locked tag, so that it can be changed. */
function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

function failure(result: CommandResult): CommandFailure {
  if (result.ok) throw new Error("expected the command to fail");
  return result.error;
}

function success(result: CommandResult) {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result;
}

const AI = aiTask("t1");
const clipOn = (store: ProjectStore, id: string) => store.getState().timelines.main?.clips[id];
const COLOR = { kind: "color", color: "#ff0000" };

describe("the registry of operations", () => {
  it("has every operation once, each with what it runs on", () => {
    const names = OPERATIONS.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(46);
    for (const op of OPERATIONS as readonly Operation[]) {
      expect(op.type).toBe(op.name);
      expect(["edit", "outside", "human"]).toContain(op.level);
      expect(op.group).toMatch(/^[a-z]+$/);
      expect(op.result).toBeDefined();
      expect(op.description.length).toBeGreaterThan(4);
      for (const code of op.failures) {
        expect(FAILURE_CODES).toContain(code);
        expect(GENERAL_FAILURES as readonly string[]).not.toContain(code);
      }
      expect(operationOf(op.name)).toBe(op);
    }
  });

  it("says who can use what: people only, and the 40 that AI can", () => {
    const human = OPERATIONS.filter(({ level }) => level === "human").map(({ name }) => name);
    expect(human).toEqual(["project.setTags", "asset.setStorage"]);
    expect(OPERATIONS.filter((op) => op.ai === "yes")).toHaveLength(40);
    expect(OPERATIONS.filter((op) => op.ai !== "yes").map(({ name }) => name)).toEqual([
      "project.setTags",
      "asset.add",
      "asset.setStorage",
      "file.write",
      "clip.setProperty",
      "clip.clearProperty",
    ]);
  });

  it("keeps hidden parameters to ones that are there", () => {
    for (const op of OPERATIONS as readonly Operation[]) {
      for (const { name } of op.hiddenParams ?? []) {
        const shape = name
          .split(".")
          .reduce<unknown>(
            (schema, key) =>
              (schema as { shape?: Record<string, unknown> } | undefined)?.shape?.[key] ??
              (
                schema as { unwrap?: () => { shape?: Record<string, unknown> } } | undefined
              )?.unwrap?.()?.shape?.[key],
            op.params,
          );
        expect(shape, `${op.name} ${name}`).toBeDefined();
      }
    }
  });
});

describe("failures", () => {
  it("have parameters of the shape their code gives them", () => {
    for (const sample of [...FAILURE_SAMPLES, ...INVALID_VALUE_SAMPLES]) {
      const parsed = FAILURES[sample.code].safeParse(sample.params);
      expect(parsed.success, `${sample.code} ${JSON.stringify(sample.params)}`).toBe(true);
    }
  });

  it("have a sample of every code and every rule, for whoever tells about them", () => {
    expect(new Set(FAILURE_SAMPLES.map(({ code }) => code))).toEqual(new Set(FAILURE_CODES));
    const rules = InvalidValue.options.map((option) => option.shape.rule.value);
    expect(INVALID_VALUE_SAMPLES.map(({ params }) => params.rule)).toEqual(rules);
  });

  it("are what commands give, with the shape of their code", () => {
    const store = open();
    const results = [
      store.execute({ type: "clip.remove", params: { timeline: "main", clips: ["nope"] } }),
      store.execute({ type: "section.add", params: { timeline: "main", id: "track_video" } }),
      store.execute({
        type: "clip.move",
        params: { timeline: "main", clips: [{ clip: "clip_title" }, { clip: "clip_title" }] },
      }),
      store.execute({ type: "clip.fly", params: {} }),
    ];
    for (const result of results) {
      const { code, params } = failure(result);
      expect(FAILURES[code].safeParse(params).success, code).toBe(true);
    }
  });

  it("of parameters say every place where they do not fit", () => {
    const store = open();
    const result = store.execute({
      type: "clip.move",
      params: { timeline: 3, clips: [{ clip: "clip_title", start: 5 }], extra: true },
    });
    const { code, params } = failure(result);
    expect(code).toBe("invalid-params");
    const issues = (params.issues as { path: string; issue: string }[]).map(
      ({ path, issue }) => `${path} ${issue}`,
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        "timeline invalid_type",
        "clips.0.start invalid_type",
        " unrecognized_keys",
      ]),
    );
  });
});

describe("a batch", () => {
  it("says which of its operations failed, and changes nothing at all", () => {
    const store = open();
    const before = store.getState();
    const history = store.history.length;
    const revision = store.revision;
    const result = store.executeBatch(
      [
        { type: "project.rename", params: { name: "改了" } },
        { type: "marker.add", params: { timeline: "main", time: "1" } },
        { type: "clip.remove", params: { timeline: "main", clips: ["nope"] } },
        { type: "project.rename", params: { name: "又改了" } },
      ],
      { origin: AI },
    );
    expect(failure(result)).toMatchObject({ code: "not-found", index: 2 });
    expect(store.getState()).toBe(before);
    expect(store.history).toHaveLength(history);
    expect(store.revision).toBe(revision);
    expect(store.canUndoOrigin(AI)).toBe(false);
  });

  it("counts from 0, also for parameters that do not fit and commands there are not", () => {
    const store = open();
    const rename = { type: "project.rename", params: { name: "x" } };
    expect(failure(store.executeBatch([{ type: "clip.fly" }]))).toMatchObject({ index: 0 });
    expect(
      failure(store.executeBatch([rename, { type: "project.rename", params: { name: 1 } }])),
    ).toMatchObject({ code: "invalid-params", index: 1 });
  });

  it("gives back the project it leaves, also when it only checks", () => {
    const store = open();
    const rename = { type: "project.rename", params: { name: "看看" } };
    const tried = success(store.executeBatch([rename], { dryRun: true }));
    expect(tried.state.manifest.name).toBe("看看");
    expect(store.getState().manifest.name).not.toBe("看看");
    const done = success(store.executeBatch([rename]));
    expect(done.state).toBe(store.getState());
  });
});

describe("ids of sections, tracks and clips", () => {
  /** One id for all three, as the format says: each command checks all of them. */
  it.each([
    ["section.add", { timeline: "main", id: "track_video", duration: "1" }, "section", "track"],
    ["track.add", { timeline: "main", id: "clip_title", kind: "video" }, "track", "clip"],
    [
      "clip.add",
      { timeline: "main", track: "track_video", id: "section_intro", start: "500", duration: "1" },
      "clip",
      "section",
    ],
    [
      "clip.split",
      { timeline: "main", clip: "clip_title", at: "1", piece: "track_music" },
      "clip",
      "track",
    ],
  ])("%s does not take one that another kind has", (type, params, kind, by) => {
    const store = open();
    const before = store.getState();
    const call = { type, params: { ...params, ...(type === "clip.add" && { source: COLOR }) } };
    const result = store.execute(call, { origin: AI });
    expect(failure(result)).toMatchObject({ code: "id-taken", params: { kind, by } });
    expect(store.getState()).toBe(before);
    expect(store.exportFiles().problems).toEqual([]);
  });

  it("are still free to take where nothing has them", () => {
    const store = open();
    success(
      store.executeBatch([
        { type: "track.add", params: { timeline: "main", id: "intro", kind: "video" } },
        { type: "section.add", params: { timeline: "main", id: "outro", duration: "1" } },
      ]),
    );
    // The same id on another timeline is another one.
    success(
      store.execute({
        type: "track.add",
        params: { timeline: "highlight", id: "intro", kind: "video" },
      }),
    );
  });

  it("of markers are their own, and one cannot take the place of another", () => {
    const store = open();
    success(
      store.execute({ type: "marker.add", params: { timeline: "main", id: "m", time: "1" } }),
    );
    const again = store.execute({
      type: "marker.add",
      params: { timeline: "main", id: "m", time: "2", name: "别的" },
    });
    expect(failure(again)).toMatchObject({ code: "id-taken", params: { kind: "marker" } });
    expect(store.getState().timelines.main?.markers.m?.time).toBe("1");
  });
});

describe("the check of documents before a batch is written", () => {
  /**
   * A command that misses a rule of the format, as `section.add` once did with ids of other kinds:
   * what it would write is caught before anything is.
   */
  it("refuses what would make a valid document invalid, and writes nothing", () => {
    const store = open();
    const op = operationOf("section.add") as Operation;
    const spy = vi.spyOn(op, "run").mockImplementation((draft) => {
      draft.set(["timelines", "main", "sections", "track_video"], {
        id: "track_video",
        duration: "1",
        order: 9,
      });
      return { id: "track_video" };
    });
    try {
      const before = store.getState();
      const result = store.execute(
        { type: "section.add", params: { timeline: "main", duration: "1" } },
        { origin: AI },
      );
      expect(failure(result)).toMatchObject({
        code: "would-break-document",
        params: { file: "timelines/main/timeline.json" },
      });
      expect(store.getState()).toBe(before);
      expect(store.exportFiles().problems).toEqual([]);
      // Also only to check.
      const tried = store.execute(
        { type: "section.add", params: { timeline: "main", duration: "1" } },
        { dryRun: true },
      );
      expect(failure(tried).code).toBe("would-break-document");
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves documents that were not valid before to whoever fixes them", () => {
    const store = open();
    // An older page, or a file, put a track with the id of a section there.
    const tracks = (store.doc.getMap("project").get("timelines") as Y.Map<Y.Map<unknown>>)
      .get("main")
      ?.get("tracks") as Y.Map<unknown>;
    const old = new Y.Doc();
    Y.applyUpdate(old, store.encodeState());
    const oldTracks = (old.getMap("project").get("timelines") as Y.Map<Y.Map<unknown>>)
      .get("main")
      ?.get("tracks") as Y.Map<unknown>;
    old.transact(() => {
      const track = new Y.Map<unknown>();
      track.set("id", "section_intro");
      track.set("kind", "video");
      track.set("order", 20);
      oldTracks.set("section_intro", track);
    });
    store.applyUpdates([Y.encodeStateAsUpdate(old, Y.encodeStateVector(store.doc))]);
    expect(tracks.has("section_intro")).toBe(true);
    expect(store.exportFiles().problems.map(({ file }) => file)).toEqual([
      "timelines/main/timeline.json",
    ]);
    // People and AI still work on it, and can fix it.
    const rename = { timeline: "main", clip: "clip_title", changes: { name: "还能改" } };
    success(store.execute({ type: "clip.update", params: rename }, { origin: AI }));
    success(
      store.execute({ type: "track.remove", params: { timeline: "main", track: "section_intro" } }),
    );
    expect(store.exportFiles().problems).toEqual([]);
  });

  /**
   * Only what changed of a timeline is read, see `mayBreak`: what did not change can still be what a
   * changed clip runs into, where a clip that did not change is not what its key says, or is on a
   * track that is gone, which the export makes up.
   */
  it.each([
    ["a clip whose id is not its key", { id: "taken" }, "taken"],
    ["a caption on a track that is gone", { track: "gone" }, "recovered-caption"],
  ])("finds what a new clip runs into with %s", (_, odd, id) => {
    const before = open().getState();
    const main = before.timelines.main;
    const title = main?.clips.clip_title;
    const line = main?.clips.clip_line;
    if (!main || !title || !line) throw new Error("no clip");
    // No caption track: a caption on a track that is gone goes on one that the export makes up.
    const { track_captions: _captions, ...noCaptions } = main.tracks;
    const tracks = "id" in odd ? main.tracks : noCaptions;
    const oddOne = "id" in odd ? { ...title, ...odd } : { ...line, ...odd };
    const key = "id" in odd ? "clip_title" : "clip_line";
    const withOdd = { ...main, tracks, clips: { ...main.clips, [key]: oddOne } };
    const was = { ...before, timelines: { ...before.timelines, main: withOdd } };
    expect(stateToProject(was).problems).toEqual([]);
    const added = { ...title, id, start: "300" };
    const clips = { ...withOdd.clips, [id]: added };
    const now = { ...was, timelines: { ...was.timelines, main: { ...withOdd, clips } } };
    const patches = [
      { op: "set" as const, path: ["timelines", "main", "clips", id], value: added },
    ];
    expect(brokenDocument(was, now, patches)).toMatchObject({
      code: "would-break-document",
      params: { file: "timelines/main/timeline.json" },
    });
  });

  /** What a command that misses a rule writes of a clip, where only clips change. */
  it.each([
    ["a clip that is not one", "clip_title", { duration: "-1" }],
    ["a clip with the id of a section", "section_intro", {}],
    ["a picture on a track for captions", "clip_title", { track: "track_captions" }],
  ])("refuses %s, reading only what changed", (_, key, changes) => {
    const store = open();
    const title = clipOn(store, "clip_title");
    const op = operationOf("project.rename") as Operation;
    const spy = vi.spyOn(op, "run").mockImplementation((draft) => {
      const clip = { ...title, ...changes, id: key, start: key === "clip_title" ? "0" : "300" };
      draft.set(["timelines", "main", "clips", key], clip);
    });
    try {
      const result = store.execute({ type: "project.rename", params: { name: "x" } });
      expect(failure(result)).toMatchObject({ code: "would-break-document" });
    } finally {
      spy.mockRestore();
    }
  });

  it("reads only the documents that a change touches", () => {
    const before = open().getState();
    const timelines = { ...before.timelines, main: { ...before.timelines.main, name: "" } };
    const broken = { ...before, timelines } as typeof before;
    expect(
      brokenDocument(before, broken, [{ op: "set", path: ["manifest", "name"], value: "x" }]),
    ).toBe(undefined);
    expect(
      brokenDocument(before, broken, [
        { op: "set", path: ["timelines", "main", "name"], value: "" },
      ]),
    ).toMatchObject({
      code: "would-break-document",
      params: { file: "timelines/main/timeline.json" },
    });
  });
});

describe("hidden parameters", () => {
  it("that only people may use are refused from anyone else", () => {
    const store = open();
    const params = { asset: "interview", changes: { path: "assets/other.mp4" } };
    const refused = store.execute({ type: "asset.update", params }, { origin: AI });
    expect(failure(refused)).toMatchObject({
      code: "user-only",
      params: { command: "asset.update", param: "changes.path" },
    });
    success(store.execute({ type: "asset.update", params }, { origin: USER }));
    const named = { asset: "interview", changes: { name: "采访" } };
    success(store.execute({ type: "asset.update", params: named }, { origin: AI }));
  });

  it("that another operation is for still work, for people", () => {
    const store = open();
    const params = { timeline: "main", clip: "clip_title", changes: { duration: "1" } };
    success(store.execute({ type: "clip.update", params }));
    expect(clipOn(store, "clip_title")?.duration).toBe("1");
  });
});

describe("revisions", () => {
  it("are of their epoch, which a store that opens anew does not share", () => {
    const store = open();
    const other = open();
    expect(store.revisionId).toMatch(/^[a-z0-9]{4}:\d+$/);
    expect(store.revisionId).not.toBe(other.revisionId);
    const rename = { type: "project.rename", params: { name: "x" } };
    expect(failure(store.execute(rename, { baseRevision: other.revisionId }))).toMatchObject({
      code: "stale-revision",
      params: { given: other.revisionId, current: store.revisionId },
    });
    success(store.execute(rename, { baseRevision: store.revisionId }));
  });

  it("of a count this store has not come to are none of it", () => {
    const store = open();
    const ahead = `${store.revisionId.split(":")[0]}:${store.revision + 5}`;
    const rename = { type: "project.rename", params: { name: "x" } };
    expect(failure(store.execute(rename, { baseRevision: ahead })).code).toBe("stale-revision");
    expect(failure(store.execute(rename, { baseRevision: "nonsense" })).code).toBe(
      "stale-revision",
    );
    expect(store.revisionOf(store.revisionId)).toBe(store.revision);
  });

  /**
   * What AI saw of each object, as whoever calls for it keeps track. The user changes clip A after
   * AI read it; AI then changes clip B, which nobody changed, and only after that A, as it knew it.
   * With one revision for everything, the change of B would bring it past the user's change of A.
   */
  it("can be one for each object, so that a change elsewhere does not hide the user's", () => {
    const store = open();
    const seen = new Map<string, number>();
    const look = (...ids: string[]) => {
      for (const id of ids) seen.set(id, store.revision);
    };
    const baseRevision = (path: readonly string[]) => seen.get(objectOfPath(path).id);
    const rename = (clip: string, name: string) => ({
      type: "clip.update",
      params: { timeline: "main", clip, changes: { name } },
    });
    look("clip_title", "clip_logo");
    success(store.execute(rename("clip_title", "用户改的")));
    success(store.execute(rename("clip_logo", "AI 改的"), { origin: AI, baseRevision }));
    look("clip_logo");
    const late = store.execute(rename("clip_title", "AI 按旧的改"), { origin: AI, baseRevision });
    expect(failure(late)).toMatchObject({
      code: "conflict",
      conflicts: [["timelines", "main", "clips", "clip_title", "name"]],
    });
    expect(clipOn(store, "clip_title")?.name).toBe("用户改的");
    // Once it looked again, it can.
    look("clip_title");
    success(store.execute(rename("clip_title", "AI 改的"), { origin: AI, baseRevision }));
  });

  it("can leave a path out, which then is not checked", () => {
    const store = open();
    const params = { timeline: "main", clip: "clip_title", changes: { name: "用户改的" } };
    const at = store.revision;
    success(store.execute({ type: "clip.update", params }));
    const again = { ...params, changes: { name: "AI" } };
    expect(
      failure(
        store.execute({ type: "clip.update", params: again }, { origin: AI, baseRevision: at }),
      ).code,
    ).toBe("conflict");
    success(
      store.execute(
        { type: "clip.update", params: again },
        { origin: AI, baseRevision: () => undefined },
      ),
    );
  });
});

describe("objects of paths", () => {
  it.each([
    [["timelines", "main", "clips", "c1", "properties", "opacity"], "clip", "c1", "main"],
    [["timelines", "main", "clips", "c1", "effects", "fx", "order"], "clip", "c1", "main"],
    [
      ["timelines", "main", "overrides", "language.en", "clips", "c1", "source"],
      "clip",
      "c1",
      "main",
    ],
    [["timelines", "main", "overrides", "language.en", "scope"], "timeline", "main", undefined],
    [["timelines", "main", "tracks", "t1", "name"], "track", "t1", "main"],
    [["timelines", "main", "sections", "s1"], "section", "s1", "main"],
    [["timelines", "main", "joins", "j1", "transition"], "join", "j1", "main"],
    [["timelines", "main", "markers", "m1", "time"], "marker", "m1", "main"],
    [["timelines", "main", "name"], "timeline", "main", undefined],
    [["timelines", "main", "clips"], "timeline", "main", undefined],
    [["assets", "a1"], "asset", "a1", undefined],
    [["places", "a1"], "asset", "a1", undefined],
    [["scenes", "title", "params"], "scene", "title", undefined],
    [["sounds", "bell"], "sound", "bell", undefined],
    [["files", "scenes/title/index.html"], "file", "scenes/title/index.html", undefined],
    [["manifest", "name"], "project", "project", undefined],
    [["notes", "n1"], "project", "project", undefined],
  ])("%j is a %s", (path, kind, id, timeline) => {
    expect(objectOfPath(path)).toEqual({ kind, id, ...(timeline && { timeline }) });
  });

  it("have one key for one object", () => {
    const of = (path: string[]) => objectKey(objectOfPath(path));
    expect(of(["timelines", "main", "clips", "c1", "name"])).toBe(
      of(["timelines", "main", "clips", "c1", "start"]),
    );
    expect(of(["timelines", "main", "clips", "c1"])).not.toBe(
      of(["timelines", "highlight", "clips", "c1"]),
    );
  });
});

describe("documents of the state", () => {
  /** The check before a change and the export have to agree on what is valid, see `documentAt`. */
  it.each([
    ["as it is", () => {}],
    [
      "a track with the id of a section",
      (main: Record<string, any>) => {
        main.tracks.section_intro = { id: "section_intro", kind: "video", order: 9 };
      },
    ],
    [
      "a clip with the id of a track",
      (main: Record<string, any>) => {
        main.clips.track_music = { ...main.clips.clip_title, id: "track_music" };
      },
    ],
    [
      "a clip that is not one",
      (main: Record<string, any>) => {
        main.clips.clip_title = { ...main.clips.clip_title, duration: "-1" };
      },
    ],
    [
      "a picture on a track for sound",
      (main: Record<string, any>) => {
        main.clips.clip_title = { ...main.clips.clip_title, track: "track_voice" };
      },
    ],
    [
      "no name",
      (main: Record<string, any>) => {
        main.name = "";
      },
    ],
  ])("are valid or not as the export says, with %s", (_, change) => {
    const state = open().getState();
    const main = structuredClone(state.timelines.main) as Record<string, any>;
    change(main);
    const changed = {
      ...state,
      timelines: { ...state.timelines, main },
    } as unknown as typeof state;
    const file = "timelines/main/timeline.json";
    const exported = stateToProject(changed).problems.some((problem) => problem.file === file);
    const document = documentAt(["timelines", "main", "clips"]);
    expect(document?.file).toBe(file);
    expect(document?.issue(changed) !== undefined).toBe(exported);
  });
});

describe("what stays as it was", () => {
  it("refuses a batch whose second command takes the id the first gave a track", () => {
    const store = open();
    const before = store.getState();
    const shared = { timeline: "main", id: "shared" };
    const result = store.executeBatch(
      [
        { type: "track.add", params: { ...shared, kind: "video" } },
        {
          type: "clip.add",
          params: { ...shared, track: "shared", start: "0", duration: "1", source: COLOR },
        },
      ],
      { origin: AI },
    );
    expect(failure(result)).toMatchObject({ code: "id-taken", index: 1 });
    expect(store.getState()).toBe(before);
  });

  it("refuses the old name of the new part of a cut, rather than leaving it out", () => {
    const store = open();
    const params = { timeline: "main", clip: "clip_title", at: "1", id: "x" };
    expect(failure(store.execute({ type: "clip.split", params })).code).toBe("invalid-params");
  });

  it("takes a revision as a number as before", () => {
    const store = open();
    const seen = store.revision;
    const rename = (name: string) => ({
      type: "clip.update",
      params: { timeline: "main", clip: "clip_title", changes: { name } },
    });
    success(store.execute(rename("用户改的")));
    const ai = (baseRevision: number) =>
      store.execute(rename("AI 改的"), { origin: AI, baseRevision });
    expect(failure(ai(seen)).code).toBe("conflict");
    expect(failure(ai(store.revision + 1)).code).toBe("stale-revision");
    success(ai(store.revision));
  });

  it("leaves no step to undo for a batch it refuses, and undoes the one before", () => {
    const store = open();
    const name = store.getState().manifest.name;
    success(store.execute({ type: "project.rename", params: { name: "一" } }));
    const op = operationOf("section.add") as Operation;
    const spy = vi.spyOn(op, "run").mockImplementation((draft) => {
      const section = { id: "track_video", duration: "1", order: 9 };
      draft.set(["timelines", "main", "sections", "track_video"], section);
      return { id: "track_video" };
    });
    try {
      const params = { timeline: "main", duration: "1" };
      const refused = store.execute({ type: "section.add", params });
      expect(failure(refused).code).toBe("would-break-document");
    } finally {
      spy.mockRestore();
    }
    expect(store.undo().ok).toBe(true);
    expect(store.getState().manifest.name).toBe(name);
  });

  it("has a revision of one store be none of a copy of it", () => {
    const store = open();
    const copy = ProjectStore.fromUpdates([store.encodeState()]).store as ProjectStore;
    expect(copy.revisionOf(store.revisionId)).toBe(undefined);
    expect(store.revisionOf(store.revisionId)).toBe(store.revision);
    expect(copy.revisionOf(0)).toBe(0);
  });
});
