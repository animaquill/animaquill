import { describe, expect, it, vi } from "vitest";
import { createProject } from "./create.ts";
import { loadFixture } from "../scripts/fixture.ts";
import { jsonSchemas } from "./json-schema.ts";
import { stringifyDocument } from "./json.ts";
import { documentSchema, parseDocument, readProject, writeProject } from "./project.ts";
import { Timeline } from "./timeline.ts";
import { CURRENT_FORMAT_VERSION } from "./version.ts";

type Change = (document: any) => unknown;

const fixture = () => loadFixture("v1");

/** A copy of the fixture with one JSON file changed. */
function withChange(path: string, change: Change) {
  const files = fixture();
  const document = JSON.parse(files.get(path) ?? "null");
  change(document);
  files.set(path, JSON.stringify(document));
  return files;
}

const codes = (files: Map<string, string>) =>
  readProject(files).problems.map((problem) => problem.code);

const MAIN = "timelines/main/timeline.json";

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([k, v]) => [k, reverseKeys(v)]),
  );
}

describe("the example project", () => {
  it("is valid and has no problems", () => {
    const { project, problems } = readProject(fixture());
    expect(problems).toEqual([]);
    expect(project?.manifest.name).toBe("原子是什么");
    expect(project?.timelines.get("main")?.overrides.size).toBe(3);
  });

  it("is written back exactly as it is", () => {
    const files = fixture();
    const { project } = readProject(files);
    expect(project).toBeDefined();
    for (const [path, text] of writeProject(project as never)) {
      expect(text, path).toBe(files.get(path));
    }
  });

  it("is written the same way whatever the order of keys in the files", () => {
    const files = fixture();
    const shuffled = new Map(files);
    for (const path of files.keys()) {
      if (path.endsWith(".json")) {
        shuffled.set(path, JSON.stringify(reverseKeys(JSON.parse(files.get(path) as string))));
      }
    }
    const { project } = readProject(shuffled);
    expect(project).toBeDefined();
    for (const [path, text] of writeProject(project as never)) {
      expect(text, path).toBe(files.get(path));
    }
  });

  it("sorts clips by time, which is how a track reads", () => {
    const files = withChange(MAIN, (document) => {
      document.tracks[0].clips = document.tracks[0].clips.toReversed();
    });
    const { project } = readProject(files);
    const clips = project?.timelines.get("main")?.document?.tracks[0]?.clips;
    expect(clips?.map((clip) => clip.id)).toEqual([
      "clip_title",
      "clip_interview",
      "clip_logo",
      "clip_card",
    ]);
  });

  it("puts everything that has no order of its own into a fixed order", () => {
    const files = withChange(MAIN, (document) => {
      document.markers = document.markers.toReversed();
      document.tracks[0].transitions = document.tracks[0].transitions.toReversed();
    });
    const { project } = readProject(files);
    const original = fixture();
    expect(writeProject(project as never).get(MAIN)).toBe(original.get(MAIN));
  });

  it("orders markers by time, which is how they read", () => {
    const files = withChange(MAIN, (document) => {
      document.markers[0].time = "9";
    });
    const { project } = readProject(files);
    const markers = project?.timelines.get("main")?.document?.markers;
    expect(markers?.map((marker) => marker.id)).toEqual(["marker_turn", "marker_hook"]);
  });

  it("leaves files alone that the format does not define", () => {
    const { project } = readProject(fixture());
    const written = writeProject(project as never);
    expect(written.has("AGENTS.md")).toBe(false);
    expect(written.has("scenes/title/index.html")).toBe(false);
    expect(written.has("制作笔记/分镜.md")).toBe(false);
    expect(documentSchema("AGENTS.md")).toBeUndefined();
  });
});

describe("a new project", () => {
  it("is valid and can be read back", () => {
    const project = createProject({ name: "新项目" });
    const { project: read, problems } = readProject(writeProject(project));
    expect(problems).toEqual([]);
    expect(read?.manifest.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(read?.timelines.get("main")?.document?.tracks).toHaveLength(2);
  });
});

describe("when something is wrong with a file", () => {
  it("does not open a folder that is no project", () => {
    expect(codes(new Map([["a.txt", "hello"]]))).toEqual(["not-a-project"]);
  });

  it("does not open a project without a usable manifest", () => {
    const files = fixture();
    files.set("animaquill.json", "{oops");
    const result = readProject(files);
    expect(result.project).toBeUndefined();
    expect(result.problems[0]?.code).toBe("invalid-json");
  });

  it.each(["notes.json", "assets.json", "locales/en.json", "scenes/title/scene.json"])(
    "still opens with a broken %s",
    (path) => {
      const files = fixture();
      files.set(path, "{oops");
      const { project, problems } = readProject(files);
      expect(project).toBeDefined();
      expect(problems.some((problem) => problem.file === path)).toBe(true);
    },
  );

  it("does not replace a broken file with something empty", () => {
    const files = fixture();
    files.set("notes.json", "{oops");
    const { project } = readProject(files);
    expect(writeProject(project as never).has("notes.json")).toBe(false);
  });

  it("keeps the other timelines when one is broken, and does not overwrite it", () => {
    const files = fixture();
    files.set("timelines/highlight/timeline.json", "{oops");
    const { project, problems } = readProject(files);
    expect(project?.timelines.get("main")?.document).toBeDefined();
    expect(problems.some((problem) => problem.code === "timeline-missing")).toBe(true);
    expect(writeProject(project as never).has("timelines/highlight/timeline.json")).toBe(false);
  });

  it("says where the mistake is", () => {
    const files = withChange(MAIN, (document) => {
      document.tracks[0].clips[0].start = 5;
    });
    const problem = readProject(files).problems[0];
    expect(problem?.file).toBe(MAIN);
    expect(problem?.path).toBe("tracks.0.clips.0.start");
    expect(problem?.message).toBeTruthy();
  });

  it("finds a misspelled field", () => {
    const files = withChange(MAIN, (document) => {
      document.tracks[0].clips[0].duraton = "5";
    });
    expect(codes(files)).toContain("invalid-document");
  });

  it("finds a misspelled kind of clip, but keeps a plugin kind", () => {
    const typo = withChange(MAIN, (document) => {
      document.tracks[0].clips[1].source.kind = "vedio";
    });
    expect(codes(typo)).toContain("invalid-document");
    const { project } = readProject(fixture());
    const clip = project?.timelines.get("main")?.document?.tracks[1]?.clips[0];
    expect(clip?.source).toEqual({ kind: "plugin.lottie", loops: 3, src: { asset: "logo" } });
  });

  it("opens a property whose value is a list of numbers", () => {
    const files = withChange(MAIN, (document) => {
      document.tracks[0].clips[0].properties["param.points"] = [1, 2, 3];
    });
    expect(codes(files)).not.toContain("invalid-document");
    const clip = readProject(files).project?.timelines.get("main")?.document?.tracks[0]?.clips[0];
    expect(clip?.properties?.["param.points"]).toEqual([1, 2, 3]);
  });

  it("finds a misspelled property, but allows parameters of scenes", () => {
    const typo = withChange(MAIN, (document) => {
      document.tracks[0].clips[0].properties["transfrom.x"] = 1;
    });
    expect(codes(typo)).toContain("invalid-document");
  });

  it.each([
    ["on a track", (d: any) => (d.tracks[3].properties = { "audio.volumn": -3 })],
    ["on a bus", (d: any) => (d.mix.buses[0].properties = { "audio.pann": 0 })],
    ["on a send", (d: any) => (d.tracks[3].sends[0].properties = { volume: -3 })],
  ] as [string, Change][])("finds a misspelled property %s", (_, change) => {
    expect(codes(withChange(MAIN, change))).toContain("invalid-document");
  });

  it("finds a misspelled property in an override", () => {
    const files = withChange("timelines/main/overrides/format.vertical.json", (document) => {
      document.clips.clip_title.properties["transfrom.x"] = { value: 1 };
    });
    expect(codes(files)).toContain("invalid-document");
  });

  it.each([
    ["a value out of range", "opacity", 2],
    ["a percentage as text", "transform.x", "50%"],
    ["a rotation as text", "transform.rotation", "90deg"],
    ["an unknown choice", "fit", "stretchy"],
    ["a number for a yes or no", "audio.preservePitch", 1],
    ["a negative speed", "time.speed", -1],
    ["a pan out of range", "audio.pan", 3],
    ["a negative width", "transform.width", -10],
    ["a display name in a path", "object.秤砣.x", 1],
  ])("finds %s", (_, property, value) => {
    const files = withChange(MAIN, (document) => {
      document.tracks[0].clips[1].properties[property] = value;
    });
    expect(codes(files)).toContain("invalid-document");
  });

  it("checks every key of an animated property", () => {
    const files = withChange(MAIN, (document) => {
      document.tracks[0].clips[0].properties.opacity.keys[1].value = 5;
    });
    expect(codes(files)).toContain("invalid-document");
  });

  it("checks values in an override too", () => {
    const files = withChange("timelines/main/overrides/format.vertical.json", (document) => {
      document.clips.clip_interview.properties.fit.value = "stretchy";
    });
    expect(codes(files)).toContain("invalid-document");
  });
});

describe("scene code", () => {
  it.each(["index.html", "main.js", "main.mjs", "src/index.html"])("can start from %s", (entry) => {
    const files = withChange("scenes/title/scene.json", (document) => {
      document.entry = entry;
    });
    expect(codes(files)).not.toContain("invalid-document");
  });

  it.each(["main.ts", "main.tsx", "main.jsx", "style.css", "main"])(
    "cannot start from %s, because it runs without being compiled",
    (entry) => {
      const files = withChange("sounds/impacts/sound.json", (document) => {
        document.entry = entry;
      });
      expect(codes(files)).toContain("invalid-document");
    },
  );
});

describe("frame rates", () => {
  const withFps = (fps: unknown) =>
    withChange("animaquill.json", (document) => {
      document.formats[0].fps = fps;
    });

  it("are exact and canonical", () => {
    const { project } = readProject(withFps("60000/2000"));
    expect(project?.manifest.formats[0]?.fps).toBe("30");
  });

  it.each([["0"], ["-30"], ["fast"], [30]])("refuse %j", (fps) => {
    expect(codes(withFps(fps))).toContain("invalid-document");
  });
});

describe("format versions", () => {
  it("refuses a project from a newer version rather than damaging it", () => {
    const files = withChange("animaquill.json", (document) => {
      document.formatVersion = CURRENT_FORMAT_VERSION + 1;
      document.somethingNew = true;
    });
    const result = readProject(files);
    expect(result.project).toBeUndefined();
    expect(result.problems[0]?.code).toBe("format-too-new");
  });

  it("asks for a migration of an older project", () => {
    const files = withChange("animaquill.json", (document) => {
      document.formatVersion = 0;
    });
    expect(codes(files)).toEqual(["format-needs-migration"]);
  });
});

describe("rules inside a timeline", () => {
  const invalid = (change: Change) => {
    expect(codes(withChange(MAIN, change))).toContain("invalid-document");
  };

  it("needs at least one section, whose durations define the length", () => {
    invalid((document) => {
      document.sections = [];
    });
    invalid((document) => {
      document.duration = "30";
    });
  });

  it("refuses the same id twice", () => {
    invalid((document) => {
      document.tracks[1].clips[0].id = "clip_title";
    });
    invalid((document) => {
      document.tracks[1].id = "track_video";
    });
  });

  it("keeps kinds of clips on their kind of track", () => {
    invalid((document) => {
      document.tracks[3].clips[0].source = { kind: "image", media: { asset: "logo" } };
    });
    invalid((document) => {
      document.tracks[0].clips[0].source = { kind: "audio", media: { asset: "logo" } };
    });
  });

  it("refuses keyframes out of order or at the same moment", () => {
    invalid((document) => {
      document.tracks[0].clips[0].properties.opacity.keys.reverse();
    });
    invalid((document) => {
      const keys = document.tracks[0].clips[0].properties.opacity.keys;
      keys[1].time = keys[0].time;
    });
  });

  it("refuses bezier keys without a handle and noise without a seed", () => {
    invalid((document) => {
      delete document.tracks[0].clips[0].properties.opacity.keys[0].out;
    });
    invalid((document) => {
      delete document.tracks[0].clips[0].properties["transform.x"].modifiers[0].seed;
    });
  });

  it("refuses a bezier handle that would run back in time", () => {
    invalid((document) => {
      document.tracks[0].clips[0].properties.opacity.keys[0].out = [1.5, 0];
    });
  });

  it("refuses a display name in the path of a difference", () => {
    const files = withChange("timelines/main/overrides/format.vertical.json", (document) => {
      document.clips.clip_title.properties["object.秤砣.x"] = { value: 1 };
    });
    expect(codes(files)).toContain("invalid-document");
  });

  it("refuses empty clips", () => {
    invalid((document) => {
      document.tracks[0].clips[0].duration = "0";
    });
  });

  it("refuses a transition that connects nothing", () => {
    invalid((document) => {
      delete document.tracks[0].transitions[0].from;
      delete document.tracks[0].transitions[0].to;
    });
  });
});

describe("project content is not trusted", () => {
  const dangerous: [string, Change][] = [
    ["scenes/title/scene.json", (d: any) => (d.entry = "../../secret.html")],
    ["assets.json", (d: any) => (d.assets.logo.path = "/etc/passwd")],
    ["assets.json", (d: any) => (d.assets.logo.path = "assets/../../key.pem")],
    ["assets.json", (d: any) => (d.assets["studio-loop"].url = "file:///etc/passwd")],
    ["libraries.json", (d: any) => (d.libraries[0].source = "ext::sh -c id")],
    ["animaquill.json", (d: any) => (d.timelines[0] = "../other")],
    [MAIN, (d: any) => (d.tracks[0].clips[0].source.scene = "../../outside")],
  ];

  it.each(dangerous)("refuses a dangerous value in %s", (path, change) => {
    expect(codes(withChange(path, change))).toContain("invalid-document");
  });

  it.each([
    ["timelines/../timeline.json", MAIN],
    ["scenes/../scene.json", "scenes/title/scene.json"],
    ["sounds/../sound.json", "sounds/impacts/sound.json"],
    ["locales/...json", "locales/en.json"],
    ["timelines/main/overrides/...json", "timelines/main/overrides/language.en.json"],
  ])("does not take a name from the path %s, even with valid content", (path, content) => {
    const files = fixture();
    files.set(path, files.get(content) as string);
    const { project } = readProject(files);
    const written = [...writeProject(project as never).keys()];
    expect(written.filter((name) => name.includes(".."))).toEqual([]);
  });
});

describe("problems that do not stop a project from opening", () => {
  const reported: [string, string, Change][] = [
    ["asset-missing", MAIN, (d: any) => (d.tracks[0].clips[1].source.media.asset = "gone")],
    ["scene-missing", MAIN, (d: any) => (d.tracks[0].clips[0].source.scene = "gone")],
    ["sound-missing", MAIN, (d: any) => (d.tracks[3].clips[0].source.sound = "gone")],
    ["library-missing", MAIN, (d: any) => (d.tracks[0].clips[2].source.media.library = "gone")],
    [
      "timeline-missing",
      "timelines/highlight/timeline.json",
      (d: any) => (d.tracks[0].clips[0].source.timeline = "gone"),
    ],
    ["string-missing", MAIN, (d: any) => (d.tracks[4].clips[0].source.text.string = "gone")],
    ["param-unknown", MAIN, (d: any) => (d.tracks[0].clips[0].properties["param.gone"] = 1)],
    ["bus-missing", MAIN, (d: any) => (d.tracks[3].output = "gone")],
    ["transition-clip-missing", MAIN, (d: any) => (d.tracks[0].transitions[0].from = "gone")],
    ["clip-overlap", MAIN, (d: any) => (d.tracks[0].clips[1].start = "4")],
    [
      "override-orphan",
      "timelines/main/overrides/language.en.json",
      (d: any) => (d.clips.gone = {}),
    ],
    [
      "override-orphan",
      "timelines/main/overrides/language.en.json",
      (d: any) => (d.sections.gone = d.sections.section_body),
    ],
    [
      "language-unknown",
      "timelines/main/overrides/version.en.vertical.json",
      (d: any) => (d.scope.language = "fr"),
    ],
    [
      "translation-stale",
      "locales/zh-CN.json",
      (d: any) => (d.strings["intro.title"].text = "新标题"),
    ],
    ["translation-missing", "locales/en.json", (d: any) => delete d.strings["intro.title"]],
    ["library-unlocked", "libraries.lock.json", (d: any) => delete d.libraries.lib_7f3a],
  ];

  it.each(reported)("reports %s", (code, path, change) => {
    const { project, problems } = readProject(withChange(path, change));
    expect(project).toBeDefined();
    const found = problems.filter((problem) => problem.code === code);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((problem) => problem.severity === "warning")).toBe(true);
  });

  it("reports a project file the manifest does not list", () => {
    const files = withChange("animaquill.json", (document) => {
      document.timelines = ["main"];
    });
    expect(codes(files)).toContain("timeline-unlisted");
  });

  it("lets sounds overlap on a track, because they simply mix", () => {
    const files = withChange(MAIN, (document) => {
      document.tracks[3].clips[1].start = "5.5";
    });
    expect(codes(files)).not.toContain("clip-overlap");
  });

  it("does not count drafts and hidden clips as overlapping", () => {
    const files = withChange(MAIN, (document) => {
      document.tracks[1].clips[1].start = "7";
    });
    expect(codes(files)).not.toContain("clip-overlap");
  });

  it("finds a timeline that contains itself, directly or not", () => {
    const direct = withChange("timelines/highlight/timeline.json", (document) => {
      document.tracks[0].clips[0].source.timeline = "highlight";
    });
    expect(codes(direct)).toContain("timeline-cycle");

    const indirect = withChange(MAIN, (document) => {
      document.tracks[1].clips.push({
        id: "clip_back",
        start: "20",
        duration: "1",
        source: { kind: "timeline", timeline: "highlight" },
      });
    });
    expect(codes(indirect)).toContain("timeline-cycle");
  });

  it("finds an override file whose name does not match its scope", () => {
    const files = fixture();
    const text = files.get("timelines/main/overrides/language.en.json") as string;
    files.set("timelines/main/overrides/language.fr.json", text);
    expect(codes(files)).toContain("override-misnamed");
  });

  it("does not call a translation stale when it never recorded its base", () => {
    const files = withChange("locales/en.json", (document) => {
      delete document.strings["intro.title"].base;
    });
    expect(codes(files)).not.toContain("translation-stale");
  });
});

describe("checking a single file", () => {
  it("accepts a good file and gives the canonical value", () => {
    const parsed = parseDocument(MAIN, fixture().get(MAIN) as string, Timeline);
    expect(parsed.problems).toEqual([]);
    expect(parsed.value?.name).toBe("主线");
  });

  it("knows the schema of each kind of file", () => {
    expect(documentSchema("animaquill.json")).toBeDefined();
    expect(documentSchema("timelines/a/timeline.json")).toBe(Timeline);
    expect(documentSchema("timelines/a/overrides/language.en.json")).toBeDefined();
    expect(documentSchema("scenes/a/scene.json")).toBeDefined();
    expect(documentSchema("sounds/a/sound.json")).toBeDefined();
    expect(documentSchema("locales/en.json")).toBeDefined();
    expect(documentSchema("scenes/a/index.html")).toBeUndefined();
    expect(documentSchema("timelines/a/b/timeline.json")).toBeUndefined();
  });
});

describe("the published JSON Schema", () => {
  it("exists for every document and refuses unknown fields", () => {
    const schemas = jsonSchemas() as Record<string, { additionalProperties?: boolean }>;
    expect(Object.keys(schemas)).toHaveLength(10);
    expect(schemas["timeline"]?.additionalProperties).toBe(false);
    expect(schemas["project"]?.additionalProperties).toBe(false);
  });

  it("matches the files in the repository", async () => {
    const { readFileSync } = await import("node:fs");
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      const url = new URL(`../json-schema/${name}.schema.json`, import.meta.url);
      expect(readFileSync(url, "utf8"), `run pnpm export-schema: ${name}`).toBe(
        stringifyDocument(schema),
      );
    }
  });
});

describe("generated ids", () => {
  it("do not repeat within a new project", () => {
    const spy = vi.fn();
    spy(createProject({ name: "a" }).manifest.id);
    spy(createProject({ name: "b" }).manifest.id);
    expect(spy.mock.calls[0]).not.toEqual(spy.mock.calls[1]);
  });
});
