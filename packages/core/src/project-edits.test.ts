import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import type { CommandFailure } from "./failures.ts";
import { manifestProblems } from "./problems/manifest.ts";
import { timingProblems } from "./problems/timing.ts";
import { versionsAbout } from "./project-edits.ts";
import {
  aiTask,
  ProjectStore,
  type CommandCall,
  type CommandResult,
  type UndoResult,
} from "./store.ts";

/**
 * The commands of the project properties (docs/design/settings-and-properties.md of AnimaQuill
 * Cloud, 5 and S-B): each one checks before it writes, goes back with undo, and is refused while
 * the project is read-only or locked; changes reach another copy of the document.
 */

const AI = aiTask("t1");

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

function success<R extends CommandResult | UndoResult>(result: R): Extract<R, { ok: true }> {
  if (!result.ok) throw new Error(`${result.error.code}: ${JSON.stringify(result.error.params)}`);
  return result as Extract<R, { ok: true }>;
}

function twin(store: ProjectStore): ProjectStore {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(store.doc), "sync");
  return new ProjectStore(doc);
}

function sync(a: ProjectStore, b: ProjectStore): void {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), "sync");
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), "sync");
}

const manifest = (store: ProjectStore) => store.getState().manifest;
const files = (store: ProjectStore) => [...store.exportFiles().files.keys()].toSorted();

/**
 * One valid change of each new command, with what tells it happened: what undo and the other
 * window are checked by.
 */
const CHANGES: readonly {
  readonly call: CommandCall;
  readonly seen: (store: ProjectStore) => unknown;
}[] = [
  {
    call: { type: "project.setDescription", params: { description: "新的说明" } },
    seen: (store) => manifest(store).description,
  },
  {
    call: {
      type: "project.setCredits",
      params: { credits: [{ role: "导演", name: "Lin" }] },
    },
    seen: (store) => manifest(store).credits,
  },
  {
    call: {
      type: "project.setFormats",
      params: {
        formats: [{ id: "landscape", name: "横屏", width: 3840, height: 2160, fps: "30" }],
      },
    },
    seen: (store) => [manifest(store).formats, files(store)],
  },
  {
    call: {
      type: "project.setLanguages",
      params: { languages: [{ id: "zh-CN", name: "简体中文" }] },
    },
    seen: (store) => [manifest(store).languages, files(store)],
  },
  {
    call: { type: "project.setCover", params: { cover: { timeline: "main", time: "1.5" } } },
    seen: (store) => manifest(store).cover,
  },
  {
    call: { type: "timeline.setBackground", params: { timeline: "main", background: "#FF8800" } },
    seen: (store) => store.getState().timelines.main?.background,
  },
  {
    call: { type: "timeline.setDefault", params: { timeline: "highlight" } },
    seen: (store) => manifest(store).timelines,
  },
];

describe("each command of the project properties", () => {
  for (const { call, seen } of CHANGES) {
    describe(call.type, () => {
      it("changes the project, goes back with undo and comes again with redo", () => {
        const store = open();
        const before = structuredClone(seen(store));
        success(store.execute(call));
        const after = structuredClone(seen(store));
        expect(after).not.toEqual(before);
        expect(store.exportFiles().problems).toEqual([]);
        success(store.undo());
        expect(seen(store)).toEqual(before);
        success(store.redo());
        expect(seen(store)).toEqual(after);
      });

      it("reaches another window", () => {
        const store = open();
        const other = twin(store);
        success(store.execute(call));
        sync(store, other);
        expect(seen(other)).toEqual(seen(store));
      });

      it("is refused while the project is read-only, and changes nothing", () => {
        const store = open();
        const before = structuredClone(seen(store));
        store.readOnly = true;
        expect(failure(store.execute(call)).code).toBe("read-only");
        expect(seen(store)).toEqual(before);
      });

      it("is refused while the project is locked, also to AI", () => {
        const store = open();
        success(
          store.execute({
            type: "project.setTags",
            params: { tags: [{ name: "已交付", locked: true }] },
          }),
        );
        const before = structuredClone(seen(store));
        expect(failure(store.execute(call)).code).toBe("project-locked");
        expect(failure(store.execute(call, { origin: AI })).code).toBe("project-locked");
        expect(seen(store)).toEqual(before);
      });

      it("can be used by AI", () => {
        const store = open();
        success(store.execute(call, { origin: AI }));
      });
    });
  }
});

describe("project.setDefaultStorage", () => {
  const set = (defaultStorage: unknown) => ({
    type: "project.setDefaultStorage",
    params: { defaultStorage },
  });

  it("writes where new assets go, takes it away with null, and goes back with undo", () => {
    const store = open();
    success(store.execute(set(null)));
    expect(manifest(store).defaultStorage).toBeUndefined();
    success(store.execute(set({ kind: "local" })));
    expect(manifest(store).defaultStorage).toEqual({ kind: "local" });
    expect(store.exportFiles().problems).toEqual([]);
    expect(store.exportFiles().files.get("animaquill.json")).toContain(
      '"defaultStorage": { "kind": "local" }',
    );
    const other = twin(store);
    sync(store, other);
    expect(manifest(other).defaultStorage).toEqual({ kind: "local" });
    success(store.execute(set(null)));
    expect(manifest(store).defaultStorage).toBeUndefined();
    expect(store.exportFiles().files.get("animaquill.json")).not.toContain("defaultStorage");
    success(store.undo());
    expect(manifest(store).defaultStorage).toEqual({ kind: "local" });
    success(store.undo());
    expect(manifest(store).defaultStorage).toBeUndefined();
    success(store.undo());
    expect(manifest(store).defaultStorage).toEqual({ kind: "local" });
  });

  it("is for people only, and takes no kind it does not know", () => {
    const store = open();
    expect(failure(store.execute(set({ kind: "lfs" }), { origin: AI })).code).toBe("user-only");
    expect(failure(store.execute(set({ kind: "platform" }))).code).toBe("invalid-params");
    expect(failure(store.execute(set({ kind: "lfs", store: "a" }))).code).toBe("invalid-params");
    expect(manifest(store).defaultStorage).toEqual({ kind: "local" });
  });
});

describe("project.setDescription", () => {
  it("takes the description away when it is empty", () => {
    const store = open();
    success(store.execute({ type: "project.setDescription", params: { description: "  " } }));
    expect(manifest(store).description).toBeUndefined();
    expect(store.exportFiles().files.get("animaquill.json")).not.toContain("description");
    success(store.undo());
    expect(manifest(store).description).toBe("一条用到格式每种能力的示例项目。");
  });
});

describe("project.setCredits", () => {
  it("refuses a credit without a name", () => {
    const store = open();
    const result = store.execute({
      type: "project.setCredits",
      params: { credits: [{ role: "导演", name: " " }] },
    });
    expect(failure(result).code).toBe("invalid-params");
    expect(manifest(store).credits).toEqual([{ role: "音乐", name: "示例作者" }]);
  });

  it("takes the credits away when there are none", () => {
    const store = open();
    success(store.execute({ type: "project.setCredits", params: { credits: [] } }));
    expect(manifest(store).credits).toBeUndefined();
  });
});

describe("project.setFormats", () => {
  const vertical = { id: "vertical", name: "竖屏", width: 1080, height: 1920, fps: "30" };
  const landscape = { id: "landscape", name: "横屏", width: 1920, height: 1080, fps: "30" };

  it("refuses no format, two with one id, and a size that is no size", () => {
    const store = open();
    const set = (formats: unknown) =>
      failure(store.execute({ type: "project.setFormats", params: { formats } }));
    expect(set([]).code).toBe("invalid-params");
    expect(set([{ ...landscape, width: 0 }]).code).toBe("invalid-params");
    const twice = set([landscape, { ...vertical, id: "landscape" }]);
    expect(twice.code).toBe("invalid-value");
    expect(twice.params).toMatchObject({ rule: "format", path: "formats.1" });
    expect(manifest(store).formats.map(({ id }) => id)).toEqual(["landscape", "vertical"]);
  });

  it("makes another one the master by putting it first", () => {
    const store = open();
    const [first, second] = manifest(store).formats;
    success(store.execute({ type: "project.setFormats", params: { formats: [second, first] } }));
    expect(manifest(store).formats.map(({ id }) => id)).toEqual(["vertical", "landscape"]);
    expect(store.exportFiles().files.has("timelines/main/overrides/format.vertical.json")).toBe(
      true,
    );
  });

  it("takes the versions of a format along, and gives them back with undo", () => {
    const store = open();
    expect(versionsAbout(store.getState(), { format: "vertical" }).map(({ file }) => file)).toEqual(
      [
        "timelines/main/overrides/format.vertical.json",
        "timelines/main/overrides/version.en.vertical.json",
      ],
    );
    const before = store.exportFiles().files;
    const result = success(
      store.execute({ type: "project.setFormats", params: { formats: [landscape] } }),
    );
    expect(result.results[0]).toEqual({
      filesRemoved: [
        "timelines/main/overrides/format.vertical.json",
        "timelines/main/overrides/version.en.vertical.json",
      ],
    });
    const after = store.exportFiles();
    expect(after.problems).toEqual([]);
    expect(after.files.has("timelines/main/overrides/format.vertical.json")).toBe(false);
    expect(after.files.has("timelines/main/overrides/language.en.json")).toBe(true);
    success(store.undo());
    expect(store.exportFiles().files).toEqual(before);
  });

  it("lists what it would take along on a dry run, and takes nothing", () => {
    const store = open();
    const result = success(
      store.execute(
        { type: "project.setFormats", params: { formats: [landscape] } },
        { dryRun: true },
      ),
    );
    expect(result.results[0]).toMatchObject({ filesRemoved: expect.any(Array) });
    expect(manifest(store).formats).toHaveLength(2);
  });
});

describe("project.setLanguages", () => {
  it("refuses no language, a tag that is none and two with one id", () => {
    const store = open();
    const set = (languages: unknown) =>
      failure(store.execute({ type: "project.setLanguages", params: { languages } }));
    expect(set([]).code).toBe("invalid-params");
    expect(set([{ id: "not a tag!", name: "x" }]).code).toBe("invalid-params");
    expect(
      set([
        { id: "en", name: "English" },
        { id: "en", name: "英语" },
      ]).code,
    ).toBe("invalid-value");
    expect(manifest(store).languages.map(({ id }) => id)).toEqual(["zh-CN", "en"]);
  });

  it("takes the strings and versions of a language along, and gives them back with undo", () => {
    const store = open();
    const before = store.exportFiles().files;
    const result = success(
      store.execute({
        type: "project.setLanguages",
        params: { languages: [{ id: "zh-CN", name: "中文", font: "思源黑体" }] },
      }),
    );
    expect(result.results[0]).toEqual({
      filesRemoved: [
        "locales/en.json",
        "timelines/main/overrides/language.en.json",
        "timelines/main/overrides/version.en.vertical.json",
      ],
    });
    expect(files(store)).not.toContain("locales/en.json");
    expect(store.exportFiles().problems).toEqual([]);
    success(store.undo());
    expect(store.exportFiles().files).toEqual(before);
  });

  it("renames one and keeps everything of it", () => {
    const store = open();
    const before = files(store);
    success(
      store.execute({
        type: "project.setLanguages",
        params: {
          languages: [
            { id: "zh-CN", name: "中文", font: "思源黑体" },
            { id: "en", name: "英语" },
          ],
        },
      }),
    );
    expect(manifest(store).languages[1]).toEqual({ id: "en", name: "英语" });
    expect(files(store)).toEqual(before);
  });
});

describe("project.setCover", () => {
  it("refuses a timeline that is not there and a moment past the end", () => {
    const store = open();
    const set = (cover: unknown) =>
      failure(store.execute({ type: "project.setCover", params: { cover } }));
    expect(set({ timeline: "nope", time: "1" })).toMatchObject({
      code: "not-found",
      params: { kind: "timeline", id: "nope" },
    });
    expect(set({ timeline: "main", time: "100000" })).toMatchObject({
      code: "invalid-value",
      params: { rule: "time-outside", path: "cover.time" },
    });
    expect(set({ timeline: "main", time: "-1" }).code).toBe("invalid-params");
    expect(manifest(store).cover).toEqual({ timeline: "main", time: "2.5" });
  });

  it("takes the cover away with null", () => {
    const store = open();
    success(store.execute({ type: "project.setCover", params: { cover: null } }));
    expect(manifest(store).cover).toBeUndefined();
    success(store.undo());
    expect(manifest(store).cover).toEqual({ timeline: "main", time: "2.5" });
  });
});

describe("timeline.setBackground", () => {
  it("refuses a timeline that is not there and a colour that is none", () => {
    const store = open();
    const set = (params: unknown) =>
      failure(store.execute({ type: "timeline.setBackground", params }));
    expect(set({ timeline: "nope", background: "#000000" })).toMatchObject({
      code: "not-found",
      params: { kind: "timeline", id: "nope" },
    });
    expect(set({ timeline: "main", background: "red" }).code).toBe("invalid-params");
  });

  it("goes back to black with null", () => {
    const store = open();
    success(
      store.execute({
        type: "timeline.setBackground",
        params: { timeline: "main", background: "#112233" },
      }),
    );
    expect(store.getState().timelines.main?.background).toBe("#112233");
    success(
      store.execute({
        type: "timeline.setBackground",
        params: { timeline: "main", background: null },
      }),
    );
    expect(store.getState().timelines.main?.background).toBeUndefined();
    expect(store.exportFiles().files.get("timelines/main/timeline.json")).not.toContain(
      '"background"',
    );
  });
});

describe("timeline.setDefault", () => {
  it("refuses a timeline that is not there", () => {
    const store = open();
    const result = store.execute({ type: "timeline.setDefault", params: { timeline: "nope" } });
    expect(failure(result)).toMatchObject({ code: "not-found", params: { id: "nope" } });
    expect(manifest(store).timelines).toEqual(["main", "highlight"]);
  });

  it("changes nothing for the one that opens already", () => {
    const store = open();
    const result = success(
      store.execute({ type: "timeline.setDefault", params: { timeline: "main" } }),
    );
    expect(result.patches).toEqual([]);
  });
});

describe("times off the frames", () => {
  it("count the edges and keys of a clip, the ends of sections and markers", () => {
    const store = open();
    const problems = timingProblems(store.getState());
    expect(
      problems.map(({ subject, params }) => [subject?.kind, subject?.id, params.count]),
    ).toEqual([
      ["clip", "clip_card", 1],
      // The marker at 0.342 s, and the end of a section.
      ["timeline", "main", 2],
    ]);
    // Once the marker is on a frame, it counts no more.
    success(
      store.execute({
        type: "marker.update",
        params: { timeline: "main", marker: "marker_hook", changes: { time: "0.3" } },
      }),
    );
    expect(timingProblems(store.getState()).at(-1)?.params.count).toBe(1);
  });
});

describe("the frame rate", () => {
  it("moves no time, and what is off the frames of the new one is a problem", () => {
    const store = open();
    const clipsBefore = store.getState().timelines.main?.clips;
    // The example has a few times between the frames of 30 already.
    const at30 = timingProblems(store.getState());
    expect(at30.map(({ params }) => params.fps)).toEqual(["30", "30"]);
    success(
      store.executeBatch([
        { type: "project.setFrameRate", params: { fps: "7" } },
        {
          type: "project.setFormats",
          params: {
            formats: manifest(store).formats.map((format, index) =>
              index === 0 ? { ...format, fps: "7" } : format,
            ),
          },
        },
      ]),
    );
    expect(store.getState().timelines.main?.clips).toEqual(clipsBefore);
    const problems = timingProblems(store.getState());
    expect(problems.length).toBeGreaterThan(at30.length);
    expect(
      problems.every(({ code, params }) => code === "time-off-grid" && params.fps === "7"),
    ).toBe(true);
    // Both go back as one step.
    success(store.undo());
    expect(manifest(store).fps).toBeUndefined();
    expect(manifest(store).formats[0]?.fps).toBe("30");
    expect(timingProblems(store.getState())).toEqual(at30);
  });
});

describe("what the commands of the project properties write at most", () => {
  const landscape = { id: "landscape", name: "横屏", width: 1920, height: 1080, fps: "30" };
  const refused = (call: CommandCall) => {
    const store = open();
    const result = store.execute(call);
    expect(failure(result).code, call.type).toBe("invalid-params");
  };

  it("refuses sizes, counts and lengths no canvas, list or card takes", () => {
    refused({ type: "project.setFormats", params: { formats: [{ ...landscape, width: 1e9 }] } });
    refused({ type: "project.setFormats", params: { formats: [{ ...landscape, fps: "1001" }] } });
    refused({
      type: "project.setFormats",
      params: { formats: [{ ...landscape, name: "名".repeat(101) }] },
    });
    refused({
      type: "project.setFormats",
      params: {
        formats: Array.from({ length: 17 }, (_, index) => ({ ...landscape, id: `f${index}` })),
      },
    });
    refused({ type: "project.setFrameRate", params: { fps: "5000" } });
    refused({ type: "project.setDescription", params: { description: "长".repeat(5001) } });
    refused({
      type: "project.setCredits",
      params: { credits: Array.from({ length: 101 }, () => ({ role: "", name: "人" })) },
    });
    refused({
      type: "project.setLanguages",
      params: {
        languages: Array.from({ length: 65 }, (_, index) => ({
          id: `x${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`,
          name: "语",
        })),
      },
    });
  });

  it("refuses a safe area whose sides cover all of the picture", () => {
    refused({
      type: "project.setFormats",
      params: {
        formats: [{ ...landscape, safeArea: { top: 0.5, right: 0, bottom: 0.5, left: 0 } }],
      },
    });
    refused({
      type: "project.setFormats",
      params: {
        formats: [{ ...landscape, safeArea: { top: 0, right: 0.6, bottom: 0, left: 0.4 } }],
      },
    });
    const store = open();
    success(
      store.execute({
        type: "project.setFormats",
        params: {
          formats: [{ ...landscape, safeArea: { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 } }],
        },
      }),
    );
  });

  it("takes as much as the limits", () => {
    const store = open();
    success(
      store.executeBatch([
        {
          type: "project.setFormats",
          params: { formats: [{ ...landscape, width: 16384, fps: "1000" }] },
        },
        { type: "project.setDescription", params: { description: "长".repeat(5000) } },
        {
          type: "project.setCredits",
          params: { credits: Array.from({ length: 100 }, () => ({ role: "角", name: "名" })) },
        },
      ]),
    );
    expect(manifestProblems(store.getState())).toEqual([]);
  });
});

describe("what animaquill.json and the files say apart", () => {
  const codes = (store: ProjectStore) =>
    manifestProblems(store.getState()).map(({ code, params, file }) => [code, params, file]);

  it("is nothing in the example project", () => {
    expect(codes(open())).toEqual([]);
  });

  it("finds versions and strings of what the manifest has no more, and languages without strings", () => {
    const store = open();
    const state = store.getState();
    // As two windows at once can leave it: the manifest has a language whose strings went, and
    // lost a format whose versions are still there.
    const apart = {
      ...state,
      manifest: {
        ...state.manifest,
        formats: state.manifest.formats.slice(0, 1),
        languages: [...state.manifest.languages, { id: "fr", name: "Français" }],
      },
      locales: { ...state.locales, de: {} },
    };
    expect(manifestProblems(apart).map(({ code, params, file }) => [code, params, file])).toEqual([
      [
        "version-unlisted",
        { version: "format.vertical", missing: "format:vertical" },
        "timelines/main/overrides/format.vertical.json",
      ],
      [
        "version-unlisted",
        { version: "version.en.vertical", missing: "format:vertical" },
        "timelines/main/overrides/version.en.vertical.json",
      ],
      ["strings-unlisted", { language: "de" }, "locales/de.json"],
      ["language-without-strings", { language: "fr" }, "animaquill.json"],
    ]);
  });

  it("says where a hand-written manifest has more than the commands write, and opens it", () => {
    const written = loadFixture("v1");
    const wide = JSON.parse(written.get("animaquill.json") as string);
    delete wide.tags;
    wide.formats = Array.from({ length: 20 }, (_, index) => ({
      id: `f${index}`,
      name: `画幅 ${index}`,
      width: 20000,
      height: 1080,
      fps: "30",
    }));
    written.set("animaquill.json", JSON.stringify(wide));
    for (const name of written.keys()) if (name.includes("vertical")) written.delete(name);
    const { store } = ProjectStore.open(written);
    expect(store).toBeDefined();
    expect(
      manifestProblems(store!.getState())
        .filter(({ code }) => code === "manifest-over-limit")
        .map(({ params }) => params),
    ).toEqual([
      { field: "formats", value: 20, limit: 16 },
      { field: "side", value: 20000, limit: 16384 },
    ]);
  });
});
