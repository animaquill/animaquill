import { ProjectStore, aiTask } from "@animaquill/core";
import { createProject, writeProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { frameFacts, planOf } from "./look-facts.ts";
import { testHost, toolsOn } from "./test-support.ts";
import type { LookData } from "./tools/look.ts";
import type { LookAnswer, LookRequest, LookedShot, ToolHost } from "./types.ts";

/**
 * aq_render_frames with a renderer that pretends (mcp.md 8, 6.11a): the moments it asks for, the
 * boxes it draws, what the list says is on a frame, comparisons, failures and models that cannot see.
 */

/** A 1920×1080 project with a background, a title past the right edge, a logo and a picture. */
function project(): ProjectStore {
  const files = writeProject(createProject({ name: "看" }));
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { id: string; kind: string; clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "30" }));
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    {
      id: "clip_bg",
      name: "背景",
      start: "0",
      duration: "30",
      source: { kind: "color", color: "#202020" },
    },
    {
      id: "clip_photo",
      name: "照片",
      start: "20",
      duration: "10",
      source: { kind: "image", media: { asset: "pic" } },
      properties: { fit: "cover" },
    },
  ];
  timeline.tracks.push({
    id: "track_top",
    kind: "video",
    clips: [
      {
        id: "clip_title",
        name: "标题",
        start: "0",
        duration: "10",
        source: { kind: "color", color: "#ffffff" },
        // 700 to 1100 across: 140 past the right edge, which is at 960.
        properties: { "transform.width": 400, "transform.height": 200, "transform.x": 900 },
      },
      {
        id: "clip_logo",
        name: "Logo",
        start: "0",
        duration: "10",
        source: { kind: "color", color: "#3366ff" },
        // 650 to 850 across and -150 to 50 down: it overlaps the title.
        properties: {
          "transform.width": 200,
          "transform.height": 200,
          "transform.x": 750,
          "transform.y": -50,
        },
      },
    ],
  });
  files.set(path, JSON.stringify(timeline));
  const assets = JSON.parse(files.get("assets.json") ?? '{"assets":{}}') as {
    assets: Record<string, unknown>;
  };
  assets.assets.pic = {
    name: "海边",
    kind: "image",
    path: "assets/pic.png",
    storage: "git",
    hash: "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=",
    info: { width: 1000, height: 1000 },
  };
  files.set("assets.json", JSON.stringify(assets));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("the project did not open");
  return store;
}

const picture = (name: string, width = 1024, height = 576) => ({
  image: `sha256:${name.padEnd(64, "0").slice(0, 64)}`,
  type: "image/jpeg",
  width,
  height,
  bytes: 1000,
});

/** A renderer that keeps what it was asked and answers with pictures, or with what `answer` says. */
function renderer(answer?: (request: LookRequest) => LookAnswer) {
  const asked: LookRequest[] = [];
  const look = async (request: LookRequest): Promise<LookAnswer> => {
    asked.push(request);
    if (answer) return answer(request);
    const shots: LookedShot[] =
      request.kind === "sheet"
        ? [{ picture: picture("a") }]
        : request.shots.map((shot, index) => ({
            picture: picture(String(index)),
            ...(shot.marks.length > 0 && { clean: picture(`c${index}`) }),
            ...(request.before && {
              before: picture(`b${index}`),
              diff: picture(`d${index}`),
              changed: { ratio: 0.0625, box: { x: 0, y: 288, width: 512, height: 288 } },
            }),
          }));
    return { ok: true, sees: true, width: 1024, height: 576, shots };
  };
  return { asked, look };
}

function setUp(answer?: (request: LookRequest) => LookAnswer, extra: Partial<ToolHost> = {}) {
  const store = project();
  const { asked, look } = renderer(answer);
  const host = { ...testHost(store), look, ...extra };
  return { store, asked, ...toolsOn(host) };
}

const lookOf = (data: unknown) => (data as { look: LookData }).look;

describe("aq_render_frames", () => {
  it("renders each moment on its frame, the pictures first, with what is on it", async () => {
    const { call, asked } = setUp();
    const result = await call("aq_render_frames", { times: ["2", "4.51"] });
    expect(result.isError).toBe(false);
    // 4.51 is in frame 135 at 30 frames a second, which starts at 4.5.
    expect(asked[0]?.shots.map(({ seconds }) => seconds)).toEqual([2, 4.5]);
    expect(asked[0]).toMatchObject({
      kind: "frames",
      timeline: "main",
      format: "landscape",
      texts: true,
    });
    expect(result.images?.map(({ role, note }) => [role, note])).toEqual([
      ["frame", '[image 1: timeline main "主线" in format landscape (1920×1080) at t=2, 1024×576]'],
      [
        "frame",
        '[image 2: timeline main "主线" in format landscape (1920×1080) at t=4.5, 1024×576]',
      ],
    ]);
    expect(result.text).toContain(
      "2 pictures of 1024×576 come before this text, about 1574 tokens in all",
    );
    expect(result.text).toContain("world units: the picture is x -960..960, y -540..540");
    expect(result.text).toContain("clips, back to front (3):");
    expect(result.text).toContain(
      '- clip_title "标题" color=#ffffff box 700,-100 400×200; 2.5% of the picture; opacity 1; past the edge: right 140; overlaps clip_logo "Logo"',
    );
    expect(result.text).toContain(
      '- clip_bg "背景" color=#202020 box -960,-540 1920×1080; 100% of the picture; opacity 1',
    );
    const look = lookOf(result.data);
    expect(look.kind).toBe("frames");
    expect(look.tokens).toBe(1574);
    expect(look.shots[0]?.findings).toEqual([
      { kind: "overlap", id: "clip_logo", name: "Logo", other: "clip_title", otherName: "标题" },
      { kind: "past", id: "clip_title", name: "标题", side: "right", by: 140 },
    ]);
  });

  it("says when a picture cuts its media to its box, and what the scenes say of their text", async () => {
    const store = project();
    const state = store.getState();
    const plan = planOf(state, "main", undefined);
    if (!plan) throw new Error("no plan");
    const facts = frameFacts(state, "main", plan, 21);
    expect(facts.clips.find(({ id }) => id === "clip_photo")).toMatchObject({
      cropped: true,
      outside: false,
    });
    // Text of a scene is in the CSS pixels of its page, which is its clip box: the world, here.
    const withText = frameFacts(
      state,
      "main",
      {
        ...plan,
        layers: plan.layers.map((layer) =>
          layer.id === "clip_bg"
            ? {
                ...layer,
                source: {
                  kind: "scene" as const,
                  scene: "s",
                  revision: "r",
                  entry: "index.html",
                  runtime: 1,
                  seed: 0,
                  params: {},
                } as never,
              }
            : layer,
        ),
      },
      2,
      [
        {
          layer: "clip_bg",
          texts: [{ text: "夏日限定", x: 1800, y: 500, width: 200, height: 80 }],
        },
      ],
    );
    const bg = withText.clips.find(({ id }) => id === "clip_bg");
    expect(bg?.texts).toEqual([
      { text: "夏日限定", box: { x: 840, y: -40, width: 200, height: 80 }, past: { right: 80 } },
    ]);
  });

  it("draws boxes where the list has them, red where they go past an edge, and keeps a picture without", async () => {
    const { call, asked } = setUp();
    const result = await call("aq_render_frames", {
      times: ["2"],
      annotate: ["clip_title", "clip_gone"],
    });
    expect(asked[0]?.shots[0]?.marks).toEqual([
      {
        box: { x: 700, y: -100, width: 400, height: 200 },
        label: "clip_title 标题",
        problem: true,
      },
    ]);
    expect(result.text).toContain("annotate: not on these frames: clip_gone");
    expect(result.images?.map(({ role, forPeople }) => [role, forPeople])).toEqual([
      ["frame", undefined],
      ["clean", true],
    ]);
    const all = await call("aq_render_frames", { times: ["2"], annotate: true });
    expect(all.isError).toBe(false);
    expect(asked[1]?.shots[0]?.marks.map(({ label, problem }) => [label, problem])).toEqual([
      ["clip_bg 背景", false],
      ["clip_logo Logo", false],
      ["clip_title 标题", true],
    ]);
  });

  it("gives an overview of a range in one picture, each cell a frame of its own", async () => {
    const { call, asked } = setUp();
    const result = await call("aq_render_frames", { range: { from: "0", to: "30" }, count: 6 });
    expect(asked[0]?.kind).toBe("sheet");
    expect(asked[0]?.shots.map(({ label }) => label)).toEqual(["0", "5", "10", "15", "20", "25"]);
    expect(asked[0]?.columns).toBe(3);
    expect(asked[0]?.texts).toBe(false);
    expect(result.images?.map(({ role }) => role)).toEqual(["sheet"]);
    expect(result.text).toContain(
      't=0: clip_bg "背景", clip_logo "Logo", clip_title "标题" (past right 140)',
    );
    expect(result.text).toContain('t=20: clip_bg "背景", clip_photo "照片"');
    expect(lookOf(result.data).shots).toHaveLength(6);
  });

  it("renders a region, which has to be on the picture", async () => {
    const { call, asked } = setUp();
    const off = await call("aq_render_frames", {
      times: ["2"],
      region: { x: 2000, y: 0, width: 100, height: 100 },
    });
    expect(off.text).toMatch(/^error invalid-params: region 2000,0 100×100 is not on the picture/);
    expect(asked).toHaveLength(0);
    const result = await call("aq_render_frames", {
      times: ["2"],
      region: { x: 480, y: -270, width: 480, height: 270 },
    });
    expect(asked[0]?.region).toEqual({ x: 480, y: -270, width: 480, height: 270 });
    expect(lookOf(result.data).kind).toBe("zoom");
    // Only what is in the region is listed.
    expect(result.text).toContain("clips, back to front (3):");
    expect(result.text).toContain(", only region 480,-270 480×270");
  });

  it("compares with the project as the task started: three pictures, and the share and place of the change", async () => {
    const store = project();
    const start = store.getState();
    const { asked, look } = renderer();
    const { call } = toolsOn({ ...testHost(store), look, taskStart: () => start });
    store.executeBatch(
      [{ type: "clip.move", params: { timeline: "main", clips: ["clip_logo"], by: "1" } }],
      { origin: aiTask("t1") },
    );
    const result = await call("aq_render_frames", { times: ["2"], compare: "task_start" });
    expect(result.isError).toBe(false);
    expect(asked[0]?.before).toBe(start);
    expect(result.images?.map(({ role }) => role)).toEqual(["before", "after", "diff"]);
    // The bottom left quarter of the picture.
    expect(result.text).toContain(
      "changed since task_start: 6.3% of the pixels, within box -960,0 960×540",
    );
    expect(lookOf(result.data).shots[0]?.changed).toEqual({
      ratio: 0.0625,
      box: { x: -960, y: 0, width: 960, height: 540 },
    });
    // A revision a result started with is kept too, and one that is not is said.
    const status = await call("aq_project_status");
    const revision = /^rev (\S+)/.exec(status.text)?.[1] as string;
    expect((await call("aq_render_frames", { times: ["2"], compare: revision })).isError).toBe(
      false,
    );
    expect(asked[1]?.before).toBe(store.getState());
    expect((await call("aq_render_frames", { times: ["2"], compare: "zz:1" })).text).toMatch(
      /^error not-found: revision "zz:1"/,
    );
  });

  it("without a state of the start of the task, says so", async () => {
    const { call } = setUp();
    expect((await call("aq_render_frames", { times: ["2"], compare: "task_start" })).text).toMatch(
      /^error not-available: this place keeps no state/,
    );
  });

  it("gives no picture with something missing, and says why as the user sees it", async () => {
    const { call } = setUp(() => ({
      ok: false,
      shot: 0,
      failure: { reason: "missing-file", layer: "clip_photo", file: "sha" },
    }));
    const result = await call("aq_render_frames", { times: ["21"] });
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.text).toBe(
      'error render-failed: t=21 cannot be rendered: clip clip_photo "照片" shows asset pic "海边", whose file is not on this computer. A picture with something missing would not be what the export renders, so nothing was rendered.',
    );
    expect(lookOf(result.data).failure).toMatchObject({
      reason: "missing-file",
      t: "21",
      clipName: "照片",
      assetName: "海边",
    });
  });

  it("gives a model that cannot see pictures the list only, and says so", async () => {
    const { call } = setUp((request) => ({
      ok: true,
      sees: false,
      width: 1024,
      height: 576,
      shots: request.shots.map(() => ({})),
    }));
    const result = await call("aq_render_frames", { times: ["2"] });
    expect(result.images).toBeUndefined();
    expect(result.text).toContain(
      "pictures not attached: this model cannot see pictures; this is what the frames have",
    );
    expect(result.text).toContain('clip_title "标题"');
    expect(lookOf(result.data)).toMatchObject({ sees: false, tokens: 0 });
  });

  it("checks what goes together, and says where it cannot render", async () => {
    const { tools, call } = setUp();
    const tool = tools.get("aq_render_frames");
    expect(tool?.validate({})?.text).toContain(
      "give either times (moments) or range (an overview)",
    );
    expect(tool?.validate({ times: ["1"], count: 3 })?.text).toContain(
      "count goes only with range",
    );
    expect(
      tool?.validate({ range: { from: "0", to: "5" }, region: { x: 0, y: 0, width: 1, height: 1 } })
        ?.text,
    ).toContain("an overview (range) takes neither compare nor region");
    expect(
      tool?.validate({ times: ["1", "2", "3", "4", "5"], compare: "task_start" })?.text,
    ).toContain("compare takes at most 4 times");
    expect((await call("aq_render_frames", { times: ["30"] })).text).toMatch(
      /^error out-of-range: t=30 is not before the end/,
    );
    expect((await call("aq_render_frames", { times: ["1"], version: "square" })).text).toMatch(
      /^error not-found: no picture format "square"/,
    );
    const { call: without } = toolsOn(testHost(project()));
    expect((await without("aq_render_frames", { times: ["1"] })).text).toMatch(
      /^error not-available/,
    );
  });
});
