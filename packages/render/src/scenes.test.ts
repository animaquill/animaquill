import type { RenderLayer, RenderPlan, SceneSource } from "@animaquill/core";
import type {
  SceneFailure,
  SceneHostOptions,
  SceneHostState,
  SceneProblem,
} from "@animaquill/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FromCompositor, SceneStatus, ToCompositor } from "./index.ts";
import {
  baseFor,
  frameOf,
  HeldPicture,
  MAX_SCENE_FRAME,
  PICTURE_GRACE_MS,
  SceneLayers,
  viewOf,
  type Host,
} from "./scenes.ts";
import { StillFailed, type StillFailure } from "./still.ts";

class FakeHost implements Host {
  readonly options: SceneHostOptions;
  state: SceneHostState = "opening";
  origin: string | undefined = "https://scene-0.example";
  position: number | undefined;
  stateful = false;
  opened = 0;
  closed = false;
  seeks: number[] = [];
  plays: { frame: number; at: number; rate: number }[] = [];
  pauses = 0;
  evicted: unknown[] = [];
  focusChecks = 0;
  /** What every seek answers. */
  reaching: Promise<boolean> = Promise.resolve(true);

  constructor(options: SceneHostOptions) {
    this.options = options;
  }

  open(): Promise<void> {
    this.opened += 1;
    this.state = "opening";
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.state = "closed";
  }

  /** Makes every seek throw, the way a frame that is no frame would. */
  static failSeeks = false;

  seek(frame: number): Promise<boolean> {
    if (FakeHost.failSeeks) throw new RangeError(`No frame ${frame}`);
    this.seeks.push(frame);
    return this.reaching;
  }

  play(base: { frame: number; at: number; rate: number }): void {
    this.plays.push(base);
  }

  pause(): void {
    this.pauses += 1;
  }

  evict(source: unknown): void {
    this.evicted.push(source);
  }

  focusTaken(): void {
    this.focusChecks += 1;
  }

  /** It got as far as running. */
  ready(): void {
    this.state = "ready";
    this.options.onState?.("ready");
  }

  say(state: SceneHostState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  fail(failure: Partial<SceneFailure>): void {
    const all = { reason: "silent", phase: "running", frame: 0, retrying: false, ...failure };
    if (!all.retrying) this.state = "stopped";
    this.options.onFailure?.(all as SceneFailure);
  }

  picture(frame = 0): FakeImage {
    const image = new FakeImage();
    this.options.onPicture?.({ frame, image: image as unknown as ImageBitmap });
    return image;
  }
}

class FakeImage {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

const source = (extra: Partial<SceneSource> = {}): SceneSource => ({
  kind: "scene",
  scene: "s",
  entry: "scenes/s/index.html",
  runtime: 1,
  revision: "r1",
  assets: [],
  seed: 1,
  ...extra,
});

const layer = (id: string, extra: Partial<RenderLayer> = {}): RenderLayer => ({
  id,
  start: 10,
  end: 20,
  offset: 0,
  source: source(),
  fit: "fixed",
  fades: { in: 0, out: 0 },
  channels: {},
  ...extra,
});

const planOf = (...layers: RenderLayer[]): RenderPlan => ({
  width: 1920,
  height: 1080,
  stage: { width: 1920, height: 1080 },
  camera: {},
  background: "#000000",
  scenes: { format: "f", language: "zh-CN", fps: { num: 30, den: 1 } },
  layers,
});

const CONTENT: Extract<ToCompositor, { type: "scene-files" }> = {
  type: "scene-files",
  scene: "s",
  revision: "r1",
  files: new Map([["scenes/s/index.html", new Blob(["a"])]]),
  assets: new Map(),
};

function setup(setupMessage: Partial<Extract<ToCompositor, { type: "setup" }>> = {}) {
  const hosts: FakeHost[] = [];
  const sent: FromCompositor[] = [];
  const redraw = vi.fn();
  const timers: (() => void)[] = [];
  const graces: { readonly run: () => void; readonly ms: number }[] = [];
  const scenes = new SceneLayers({
    mount: {} as HTMLElement,
    runtime: () => new Blob(["code"]),
    send: (message) => sent.push(message),
    redraw,
    makeHost: (options) => {
      const host = new FakeHost(options);
      hosts.push(host);
      return host;
    },
    linger: (run) => {
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
    grace: (run, ms) => {
      const grace = { run, ms };
      graces.push(grace);
      return () => graces.splice(graces.indexOf(grace), 1);
    },
  });
  scenes.handle({
    type: "setup",
    origins: ["https://scene-0.example", "https://scene-1.example"],
    compositor: "https://box.example",
    run: true,
    ...setupMessage,
  });
  const statuses = (id = "a") =>
    sent.flatMap((message) =>
      message.type === "scene-status" && message.layer === id ? [message.status] : [],
    );
  const lastStatus = (id = "a"): SceneStatus | undefined => statuses(id).at(-1);
  const asked = () => sent.filter(({ type }) => type === "needs-scene");
  return { scenes, hosts, sent, redraw, timers, graces, statuses, lastStatus, asked };
}

/** A scene that is showing at 12 seconds, with its content there. */
function showing(setupMessage = {}) {
  const context = setup(setupMessage);
  const plan = planOf(layer("a"));
  context.scenes.follow(plan, 12);
  context.scenes.handle(CONTENT);
  return { ...context, plan };
}

beforeEach(() => {
  vi.stubGlobal("window", {});
});

afterEach(() => vi.unstubAllGlobals());

describe("origins that may hold on to what hung", () => {
  const [FIRST, SECOND] = ["https://scene-0.example", "https://scene-1.example"];

  it("go on to the editor, because the next compositor has to stay away from them too", () => {
    const { hosts, sent } = showing();
    hosts[0]?.options.origins.retire(FIRST as string);
    expect(sent).toContainEqual({ type: "origin-retired", origin: FIRST });
  });

  it("stay out when the editor says that a compositor before this one saw that", () => {
    const { hosts } = showing({ retired: [FIRST] });
    const { origins } = (hosts[0] as FakeHost).options;
    expect([origins.take(), origins.take()]).toEqual([SECOND, SECOND]);
  });

  it("when none are left a scene stops, and it stays stopped without anybody trying", () => {
    const { scenes, hosts, plan, lastStatus } = showing();
    const failure = { phase: "hello", frame: 0, retrying: false } as const;
    hosts[0]?.options.onFailure?.({ ...failure, reason: "no-origin" });
    expect(lastStatus()).toMatchObject({ state: "stopped", reason: "no-origin" });
    scenes.follow(plan, 13);
    scenes.follow(plan, 14);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.opened).toBe(1);
    expect(scenes.showsPlaceholder("a")).toBe(true);
  });
});

describe("which scenes run", () => {
  it("asks for what a scene needs, once, and starts it when that came", () => {
    const { scenes, hosts, sent, asked } = setup();
    const plan = planOf(layer("a"));
    scenes.follow(plan, 12);
    scenes.follow(plan, 13);
    expect(hosts).toEqual([]);
    expect(asked()).toEqual([{ type: "needs-scene", scene: "s", revision: "r1" }]);
    expect(sent).toContainEqual({
      type: "scene-status",
      layer: "a",
      status: { state: "opening" },
    });
    scenes.handle(CONTENT);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.opened).toBe(1);
  });

  it("asks again with the next plan when nothing came, and only then", () => {
    const { scenes, hosts, asked } = setup();
    scenes.follow(planOf(layer("a")), 12);
    scenes.follow(planOf(layer("b")), 12);
    expect(asked()).toHaveLength(2);
    scenes.handle(CONTENT);
    scenes.follow(planOf(layer("a")), 12);
    expect(asked()).toHaveLength(2);
    expect(hosts.length).toBeGreaterThan(0);
  });

  it("asks again for a scene that went and came back before anybody answered", () => {
    const { scenes, asked } = setup();
    const plan = planOf(layer("a"));
    scenes.follow(plan, 12);
    scenes.follow(planOf(), 12);
    scenes.follow(plan, 12);
    expect(asked()).toHaveLength(2);
  });

  it("gets a scene ready before its clip comes up", () => {
    const { scenes, hosts } = setup();
    scenes.handle(CONTENT);
    scenes.follow(planOf(layer("a")), 9);
    expect(hosts).toHaveLength(1);
  });

  it("leaves one alone that is far away", () => {
    const { scenes, hosts, asked } = setup();
    scenes.handle(CONTENT);
    scenes.follow(planOf(layer("a")), 5);
    scenes.follow(planOf(layer("a")), 25);
    expect(hosts).toEqual([]);
    expect(asked()).toEqual([]);
  });

  it("gives every clip a scene of its own, even of one scene", () => {
    const { scenes, hosts } = setup();
    scenes.follow(planOf(layer("a"), layer("b", { start: 11, end: 15 })), 12);
    scenes.handle(CONTENT);
    expect(hosts).toHaveLength(2);
  });

  it("sends a scene to its first frame right away, and lets it keep that", () => {
    const { scenes, hosts } = setup();
    const offset = layer("a", { offset: 2 });
    scenes.follow(planOf(offset), 9);
    scenes.handle(CONTENT);
    expect(hosts[0]?.seeks).toEqual([60]);
  });

  it("closes a scene a while after its clip went, and not on the way back", () => {
    const { scenes, hosts, timers, plan, lastStatus } = showing();
    scenes.follow(plan, 25);
    expect(timers).toHaveLength(1);
    scenes.follow(plan, 12);
    expect(timers).toHaveLength(0);
    expect(hosts[0]?.closed).toBe(false);
    scenes.follow(plan, 25);
    timers[0]?.();
    expect(hosts[0]?.closed).toBe(true);
    expect(lastStatus()).toEqual({ state: "closed" });
  });

  it("does not stack up timers while the clip stays away", () => {
    const { scenes, timers, plan } = showing();
    scenes.follow(plan, 25);
    scenes.follow(plan, 26);
    scenes.follow(plan, 27);
    expect(timers).toHaveLength(1);
  });

  it("lets go of what a clip that is gone needed", () => {
    const { scenes, asked } = showing();
    scenes.follow(planOf(), 12);
    scenes.follow(planOf(layer("a")), 12);
    // It stayed running, so nothing is needed: the second clip of it would have to ask again.
    scenes.follow(planOf(layer("a"), layer("b")), 12);
    expect(asked()).toHaveLength(2);
  });

  it("runs nothing before it knows where", () => {
    const hosts: unknown[] = [];
    const scenes = new SceneLayers({
      mount: {} as HTMLElement,
      runtime: () => new Blob([]),
      send: () => {},
      redraw: () => {},
      makeHost: (options) => {
        hosts.push(options);
        return new FakeHost(options);
      },
    });
    scenes.follow(planOf(layer("a")), 12);
    scenes.handle(CONTENT);
    expect(hosts).toEqual([]);
  });
});

describe("what a scene gets", () => {
  it("is what the editor sent, and its frame rate, seed and view", () => {
    const { hosts } = showing();
    const { load } = (hosts[0] as FakeHost).options;
    expect(load).toMatchObject({
      entry: "scenes/s/index.html",
      fps: { num: 30, den: 1 },
      seed: 1,
      view: { width: 1920, height: 1080, pixelRatio: 1, format: "f", language: "zh-CN" },
    });
    expect(load.files).toBe(CONTENT.files);
  });

  it("is a plain page for development, when somebody says so", () => {
    const { hosts } = showing({ stage: "plain" });
    expect(hosts[0]?.options.stage).toBe("plain");
  });

  it("keeps every frame on the screen, without covering the pixel of another", () => {
    const { scenes, hosts } = setup();
    scenes.follow(
      planOf(...Array.from({ length: 4 }, (_, index) => layer(`c${index}`, { start: 10 }))),
      12,
    );
    scenes.handle(CONTENT);
    const placed = hosts.map(({ options }) => {
      const frame = { style: {} } as HTMLIFrameElement;
      options.place(frame);
      return frame.style;
    });
    expect(placed[0]).toMatchObject({ position: "fixed", width: "1920px", height: "1080px" });
    const places = placed.map(({ left, top }) => `${left} ${top}`);
    expect(new Set(places).size).toBe(4);
    // On a diagonal: going right goes up, so what starts further right stays clear of the rest.
    expect(placed[0]?.left).toBe("calc(100vw - 1px)");
    expect(placed[1]?.left).toBe("calc(100vw - 2px)");
    expect(placed[0]?.top).toBe("calc(100vh - 16px)");
    expect(placed[1]?.top).toBe("calc(100vh - 15px)");
  });
});

describe("following the time", () => {
  it("sends a paused scene to the frame of the playhead, once", () => {
    const { scenes, hosts, plan } = showing();
    scenes.follow(plan, 11);
    scenes.follow(plan, 11);
    expect(hosts[0]?.seeks).toEqual([60, 30]);
  });

  it("counts on the clock of the clip", () => {
    const { scenes, hosts } = setup();
    const plan = planOf(layer("a", { offset: 1 }));
    scenes.follow(plan, 11);
    scenes.handle(CONTENT);
    expect(hosts[0]?.seeks).toEqual([60]);
  });

  it("goes back like it goes forward", () => {
    const { scenes, hosts, plan } = showing();
    scenes.follow(plan, 15);
    scenes.follow(plan, 11);
    expect(hosts[0]?.seeks).toEqual([60, 150, 30]);
  });

  it("does not ask for every frame while it follows the time by itself", () => {
    const { scenes, hosts, plan } = showing();
    scenes.handle({ type: "play", seconds: 12, at: 1000, rate: 1, jump: true });
    const before = hosts[0]?.seeks.length;
    scenes.follow(plan, 12.5);
    scenes.follow(plan, 13);
    expect(hosts[0]?.seeks.length).toBe(before);
    expect(hosts[0]?.plays).toHaveLength(1);
  });

  it("a correction only corrects", () => {
    const { scenes, hosts } = showing();
    scenes.handle({ type: "play", seconds: 12, at: 1000, rate: 1, jump: true });
    const before = hosts[0]?.seeks.length;
    scenes.handle({ type: "play", seconds: 13, at: 2000, rate: 1, jump: false });
    expect(hosts[0]?.seeks.length).toBe(before);
    expect(hosts[0]?.plays).toHaveLength(2);
  });

  it("a jump back while playing goes there first: time only goes forward by itself", () => {
    const { scenes, hosts } = showing();
    scenes.handle({ type: "play", seconds: 15, at: 1000, rate: 1, jump: true });
    scenes.handle({ type: "play", seconds: 11, at: 2000, rate: 1, jump: true });
    expect(hosts[0]?.seeks.at(-1)).toBe(30);
    expect(hosts[0]?.plays.at(-1)).toMatchObject({ frame: 30, at: 2000 });
  });

  it("goes to where the playhead stopped when playing ends", () => {
    const { scenes, hosts, plan } = showing();
    scenes.handle({ type: "play", seconds: 12, at: 1000, rate: 1, jump: true });
    scenes.follow(plan, 13);
    scenes.handle({ type: "pause" });
    expect(hosts[0]?.pauses).toBe(1);
    expect(hosts[0]?.seeks.at(-1)).toBe(90);
  });

  it("goes along with playing when it was started later", () => {
    const { scenes, hosts } = setup();
    const plan = planOf(layer("a"));
    scenes.handle(CONTENT);
    scenes.follow(plan, 5);
    scenes.handle({ type: "play", seconds: 5, at: 1000, rate: 1, jump: true });
    scenes.follow(plan, 9);
    expect(hosts[0]?.seeks).toEqual([0]);
    expect(hosts[0]?.plays[0]).toMatchObject({ frame: 0, at: 6000 });
  });

  it("goes along when the clip moves while it plays: time only goes forward by itself", () => {
    const { scenes, hosts, plan } = showing();
    scenes.handle({ type: "play", seconds: 12, at: 1000, rate: 1, jump: true });
    const later = planOf({ ...(plan.layers[0] as RenderLayer), start: 11, end: 21 });
    scenes.follow(later, 12);
    expect(hosts[0]?.seeks.at(-1)).toBe(30);
    expect(hosts[0]?.plays.at(-1)).toMatchObject({ frame: 30 });
  });

  it("leaves a scene past its clip out of playing", () => {
    const { scenes, hosts, plan } = showing();
    scenes.follow(plan, 25);
    scenes.handle({ type: "play", seconds: 25, at: 1000, rate: 1, jump: true });
    expect(hosts[0]?.plays).toEqual([]);
  });

  it("picks playing up again when the clip came back", () => {
    const { scenes, hosts, plan } = showing();
    scenes.handle({ type: "play", seconds: 25, at: 1000, rate: 1, jump: true });
    scenes.follow(plan, 25);
    const before = hosts[0]?.plays.length ?? 0;
    scenes.handle({ type: "play", seconds: 12, at: 2000, rate: 1, jump: true });
    expect(hosts[0]?.plays.length).toBeGreaterThan(before);
    expect(hosts[0]?.plays.at(-1)).toMatchObject({ frame: 60, at: 2000 });
  });
});

describe("frames and time", () => {
  const fps = { num: 30, den: 1 };

  it("a moment belongs to the frame it is in", () => {
    expect(frameOf(0, fps)).toBe(0);
    expect(frameOf(0.5, fps)).toBe(15);
    expect(frameOf(0.51, fps)).toBe(15);
  });

  it("a moment that is a frame is that frame, whatever floats make of it", () => {
    for (let frame = 0; frame < 2000; frame += 1) {
      expect(frameOf(frame / 30, fps)).toBe(frame);
    }
    const ntsc = { num: 30000, den: 1001 };
    for (let frame = 0; frame < 2000; frame += 1) {
      expect(frameOf((frame * 1001) / 30000, ntsc)).toBe(frame);
    }
  });

  it("there is no frame before the first one", () => {
    expect(frameOf(-1, fps)).toBe(0);
  });

  it("a time base starts on the frame, not in between", () => {
    const base = baseFor(layer("a"), planOf(), { seconds: 12.51, at: 1000, rate: 1, jump: false });
    expect(base.frame).toBe(75);
    // 75 frames are 12.5 seconds in, so that was 10 ms before the moment it says.
    expect(base.at).toBeCloseTo(990);
  });

  it("a clip that has not started waits for its first frame", () => {
    const base = baseFor(layer("a"), planOf(), { seconds: 8, at: 1000, rate: 1, jump: false });
    expect(base).toMatchObject({ frame: 0, at: 3000 });
  });
});

describe("the view of a scene", () => {
  it("is the clip box, in the units of the world", () => {
    const channels = { "transform.width": { kind: "still", value: 640 } } as never;
    const view = viewOf(layer("a", { channels }), planOf());
    expect(view).toMatchObject({ width: 640, height: 360, pixelRatio: 1 });
  });

  it("has as many pixels as the output, whatever the resolution", () => {
    const plan = { ...planOf(), width: 3840, height: 2160 };
    expect(viewOf(layer("a"), plan)).toMatchObject({ width: 1920, height: 1080, pixelRatio: 2 });
    const small = { ...planOf(), width: 1280, height: 720 };
    expect(viewOf(layer("a"), small).pixelRatio).toBeCloseTo(2 / 3);
  });

  it("does not ask for a canvas that cannot be, whatever a clip says", () => {
    const channels = { "transform.width": { kind: "still", value: 1e7 } } as never;
    const { width, pixelRatio } = viewOf(layer("a", { channels }), planOf());
    expect(width * pixelRatio).toBeLessThanOrEqual(8192);
  });

  it("always has a size, or a scene would wait for one for ever", () => {
    const channels = {
      "transform.width": { kind: "still", value: 0 },
      "transform.height": { kind: "still", value: 0 },
    } as never;
    expect(viewOf(layer("a", { channels }), planOf())).toMatchObject({ width: 1, height: 1 });
  });
});

describe("what a scene looks like", () => {
  it("is the newest picture, and the one before it goes", () => {
    const { scenes, hosts, redraw } = showing();
    const first = hosts[0]?.picture(1);
    const second = hosts[0]?.picture(2);
    expect(first?.closed).toBe(true);
    expect(second?.closed).toBe(false);
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(scenes.pictureOf("a")?.image).toBe(second);
  });

  it("a picture being drawn stays until that is done", () => {
    const { scenes, hosts } = showing();
    const first = hosts[0]?.picture(1);
    const held = scenes.pictureOf("a");
    hosts[0]?.picture(2);
    expect(first?.closed).toBe(false);
    held?.release();
    expect(first?.closed).toBe(true);
  });

  it("the same picture can be drawn again", () => {
    const { scenes, hosts } = showing();
    const image = hosts[0]?.picture(1);
    scenes.pictureOf("a")?.release();
    scenes.pictureOf("a")?.release();
    expect(image?.closed).toBe(false);
  });

  it("goes when the clip goes", () => {
    const { scenes, hosts, timers, plan } = showing();
    const image = hosts[0]?.picture(1);
    scenes.follow(plan, 25);
    timers[0]?.();
    expect(image?.closed).toBe(true);
    expect(scenes.pictureOf("a")).toBeUndefined();
  });

  it("is nothing while a scene is on its way", () => {
    const { scenes } = showing();
    expect(scenes.pictureOf("a")).toBeUndefined();
    expect(scenes.showsPlaceholder("a")).toBe(false);
  });

  it("counts as ready with the first picture, also after a hang", () => {
    const { hosts, lastStatus } = showing();
    hosts[0]?.fail({ retrying: true, reason: "silent" });
    expect(lastStatus()).toMatchObject({ state: "retrying", reason: "silent" });
    hosts[0]?.picture(1);
    expect(lastStatus()).toEqual({ state: "ready" });
  });
});

describe("a project that changed", () => {
  const newer = () => planOf(layer("a", { source: source({ revision: "r2" }) }));
  const content = { ...CONTENT, revision: "r2" };

  /** It runs, and a new state of it came. */
  function changed() {
    const context = showing();
    context.hosts[0]?.ready();
    context.hosts[0]?.picture(1);
    context.scenes.follow(newer(), 12);
    context.scenes.handle(content);
    return context;
  }

  it("starts the new one next to the old one, somewhere else", () => {
    const { hosts } = changed();
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.closed).toBe(false);
    expect(hosts[1]?.options.avoid).toBe(hosts[0]?.origin);
    expect(hosts[1]?.seeks).toEqual([60]);
  });

  it("keeps showing the old picture until the new one has a picture", () => {
    const { scenes, hosts } = changed();
    expect(scenes.pictureOf("a")).toBeDefined();
    hosts[1]?.ready();
    expect(hosts[0]?.closed).toBe(false);
    const image = hosts[1]?.picture(60);
    expect(hosts[0]?.closed).toBe(true);
    expect(scenes.pictureOf("a")?.image).toBe(image);
  });

  it("a picture that comes late from the old one is not used", () => {
    const { scenes, hosts } = changed();
    hosts[1]?.picture(60);
    const late = hosts[0]?.picture(61);
    expect(late?.closed).toBe(true);
    expect(scenes.pictureOf("a")?.image).not.toBe(late);
  });

  it("taken back while the new one starts, the new one does not take over", () => {
    const { scenes, hosts, plan } = changed();
    scenes.follow(plan, 12);
    expect(hosts[1]?.closed).toBe(true);
    hosts[1]?.picture(60);
    expect(hosts[0]?.closed).toBe(false);
    expect(hosts).toHaveLength(2);
  });

  it("starts over what runs when more of the same scene comes, an asset that came back", () => {
    const { scenes, hosts } = showing();
    hosts[0]?.ready();
    hosts[0]?.picture(1);
    scenes.handle({ ...CONTENT, assets: new Map([["logo", new Blob(["x"])]]) });
    expect(hosts).toHaveLength(2);
    expect(hosts[1]?.options.load.assets.has("logo")).toBe(true);
    hosts[1]?.picture(60);
    expect(hosts[0]?.closed).toBe(true);
  });

  it("keeps up with changes that come one after the other", () => {
    const { scenes, hosts } = changed();
    const third = planOf(layer("a", { source: source({ revision: "r3" }) }));
    scenes.follow(third, 12);
    scenes.handle({ ...CONTENT, revision: "r3" });
    expect(hosts).toHaveLength(3);
    expect(hosts[1]?.closed).toBe(true);
    expect(hosts[0]?.closed).toBe(false);
  });

  it("does not start anything new for what scenes do not see", () => {
    const { scenes, hosts, plan } = showing();
    const moved = planOf({ ...(plan.layers[0] as RenderLayer), start: 11, end: 21 });
    scenes.follow(moved, 12);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.seeks).toEqual([60, 30]);
  });

  const box = (width: number, height: number) => ({
    channels: {
      "transform.width": { kind: "still", value: width },
      "transform.height": { kind: "still", value: height },
    },
  });

  it.each([
    ["the width of its box", box(800, 1080)],
    ["the height of its box", box(1920, 800)],
    ["the file it starts with", { source: source({ entry: "scenes/s/other.html" }) }],
  ])("starts over for %s", (_, changes) => {
    const { scenes, hosts } = setup();
    scenes.handle(CONTENT);
    scenes.follow(planOf(layer("a", box(1920, 1080) as never)), 12);
    expect(hosts).toHaveLength(1);
    scenes.follow(planOf(layer("a", changes as never)), 12);
    expect(hosts).toHaveLength(2);
  });

  it("starts over for another resolution", () => {
    const { scenes, hosts, plan } = showing();
    scenes.follow({ ...plan, width: 1280, height: 720 }, 12);
    expect(hosts).toHaveLength(2);
  });

  it("an update that fails leaves the last picture, and says so", () => {
    const { scenes, hosts, lastStatus, sent } = changed();
    const before = scenes.pictureOf("a");
    before?.release();
    hosts[1]?.fail({ reason: "failed", message: "SyntaxError" });
    expect(lastStatus()).toMatchObject({
      state: "stopped",
      reason: "failed",
      message: "SyntaxError",
    });
    expect(scenes.pictureOf("a")?.image).toBe(before?.image);
    expect(hosts[0]?.closed).toBe(false);
    const count = sent.length;
    scenes.follow(newer(), 12);
    expect(hosts).toHaveLength(2);
    expect(sent.length).toBe(count);
  });

  describe("with code that does not parse", () => {
    const parse: SceneProblem = {
      kind: "error",
      message: "SyntaxError: Unexpected token '}'",
      file: "scenes/s/a.js",
      line: 2,
      frame: 0,
    };

    it("stays with the picture that worked, and says why", () => {
      const { scenes, hosts, lastStatus, sent } = changed();
      const before = scenes.pictureOf("a");
      before?.release();
      hosts[1]?.options.onProblem?.(parse);
      expect(hosts[1]?.closed).toBe(true);
      expect(hosts[0]?.closed).toBe(false);
      expect(scenes.pictureOf("a")?.image).toBe(before?.image);
      expect(lastStatus()).toMatchObject({ state: "stopped", message: parse.message });
      expect(sent).toContainEqual({
        type: "scene-problem",
        layer: "a",
        revision: "r2",
        problem: parse,
      });
    });

    it("does not run it again and again as time goes by", () => {
      const { scenes, hosts } = changed();
      hosts[1]?.options.onProblem?.(parse);
      scenes.follow(newer(), 13);
      expect(hosts).toHaveLength(2);
    });

    it("gives the next try a chance", () => {
      const { scenes, hosts } = changed();
      hosts[1]?.options.onProblem?.(parse);
      const fixed = planOf(layer("a", { source: source({ revision: "r3" }) }));
      scenes.follow(fixed, 12);
      scenes.handle({ ...CONTENT, revision: "r3" });
      const image = hosts[2]?.picture(60);
      expect(hosts[0]?.closed).toBe(true);
      expect(scenes.pictureOf("a")?.image).toBe(image);
    });

    it("says what is wrong now, also when something else was wrong before", () => {
      const { scenes, hosts, lastStatus } = changed();
      hosts[1]?.options.onProblem?.(parse);
      const again = planOf(layer("a", { source: source({ revision: "r3" }) }));
      scenes.follow(again, 12);
      scenes.handle({ ...CONTENT, revision: "r3" });
      hosts[2]?.options.onProblem?.({ ...parse, message: "SyntaxError: something else" });
      expect(lastStatus()).toMatchObject({ message: "SyntaxError: something else" });
    });

    it("takes over from code that ran and threw, which may be most of what people want", () => {
      const { hosts } = changed();
      hosts[1]?.options.onProblem?.({ kind: "error", message: "TypeError: x", frame: 0 });
      hosts[1]?.picture(60);
      expect(hosts[0]?.closed).toBe(true);
    });

    it("has nothing to fall back on the first time, so the scene runs as far as it can", () => {
      const { hosts, lastStatus } = showing();
      hosts[0]?.options.onProblem?.(parse);
      expect(hosts[0]?.closed).toBe(false);
      expect(lastStatus()?.state).not.toBe("stopped");
    });

    it("leaves a scene alone that already took over", () => {
      const { hosts } = changed();
      hosts[1]?.picture(60);
      hosts[1]?.options.onProblem?.(parse);
      expect(hosts[1]?.closed).toBe(false);
    });
  });

  it("an update of an update that failed gets its chance", () => {
    const { scenes, hosts } = changed();
    hosts[1]?.fail({ reason: "failed" });
    const fixed = planOf(layer("a", { source: source({ revision: "r3" }) }));
    scenes.follow(fixed, 12);
    scenes.handle({ ...CONTENT, revision: "r3" });
    expect(hosts).toHaveLength(3);
  });

  it("in a browser without pictures, the new one takes over when it runs", () => {
    const context = showing({ stage: "plain" });
    context.hosts[0]?.ready();
    context.scenes.follow(newer(), 12);
    context.scenes.handle(content);
    context.hosts[1]?.ready();
    expect(context.hosts[0]?.closed).toBe(true);
  });
});

describe("a scene that fails", () => {
  it("shows a placeholder, and says why", () => {
    const { scenes, hosts, lastStatus, redraw } = showing();
    const image = hosts[0]?.picture(1);
    hosts[0]?.fail({ reason: "flood", phase: "running", frame: 5 });
    expect(lastStatus()).toEqual({ state: "stopped", reason: "flood", phase: "running", frame: 5 });
    expect(image?.closed).toBe(true);
    expect(scenes.pictureOf("a")).toBeUndefined();
    expect(scenes.showsPlaceholder("a")).toBe(true);
    expect(redraw).toHaveBeenCalled();
  });

  it("keeps its picture while it starts again by itself", () => {
    const { scenes, hosts, lastStatus } = showing();
    hosts[0]?.picture(1);
    hosts[0]?.fail({ reason: "silent", retrying: true });
    expect(lastStatus()?.state).toBe("retrying");
    expect(scenes.pictureOf("a")).toBeDefined();
    expect(scenes.showsPlaceholder("a")).toBe(false);
  });

  it("stays away until somebody retries", () => {
    const { scenes, hosts, plan, lastStatus } = showing();
    hosts[0]?.fail({ reason: "silent" });
    scenes.follow(plan, 13);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.opened).toBe(1);
    scenes.handle({ type: "scene-retry", layer: "a" });
    expect(hosts[0]?.opened).toBe(2);
    expect(hosts[0]?.seeks.at(-1)).toBe(90);
    expect(lastStatus()?.state).toBe("opening");
  });

  it("stays away after people left it and came back", () => {
    const { scenes, hosts, plan, timers, lastStatus } = showing();
    hosts[0]?.fail({ reason: "flood" });
    scenes.follow(plan, 25);
    timers[0]?.();
    expect(lastStatus()).toEqual({ state: "closed" });
    scenes.follow(plan, 12);
    expect(hosts).toHaveLength(1);
    expect(lastStatus()).toMatchObject({ state: "stopped", reason: "flood" });
    expect(scenes.showsPlaceholder("a")).toBe(true);
    scenes.handle({ type: "scene-retry", layer: "a" });
    expect(hosts).toHaveLength(2);
  });

  it("gets a new chance when the scene changed", () => {
    const { scenes, hosts } = showing();
    hosts[0]?.fail({ reason: "failed" });
    const fixed = planOf(layer("a", { source: source({ revision: "r2" }) }));
    scenes.follow(fixed, 12);
    scenes.handle({ ...CONTENT, revision: "r2" });
    expect(hosts).toHaveLength(2);
  });

  it("a retry for what is not there does nothing", () => {
    const { scenes, hosts } = showing();
    scenes.handle({ type: "scene-retry", layer: "nope" });
    expect(hosts[0]?.opened).toBe(1);
  });

  describe("about a picture that did not get painted", () => {
    const problem: SceneProblem = { kind: "api", code: "capture-timeout", frame: 3 };
    const told = { type: "scene-problem", layer: "a", revision: "r1", problem };

    /** A page that gets frames of the screen when somebody says so. */
    function screen() {
      const waiting = new Map<number, () => void>();
      vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
        waiting.set(waiting.size + 1, run);
        return waiting.size;
      });
      vi.stubGlobal("cancelAnimationFrame", (id: number) => waiting.delete(id));
      return () => {
        for (const run of waiting.values()) run();
      };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("says so when the page is on the screen", () => {
      const nextFrame = screen();
      const { hosts, sent } = showing();
      hosts[0]?.options.onProblem?.(problem);
      nextFrame();
      expect(sent).toContainEqual(told);
    });

    it("says nothing behind another tab, where nobody can see it", () => {
      const nextFrame = screen();
      const { hosts, sent } = showing();
      hosts[0]?.options.onProblem?.(problem);
      vi.advanceTimersByTime(1000);
      nextFrame();
      expect(sent).not.toContainEqual(told);
    });
  });

  it("tells about problems, with the clip they came from", () => {
    const { hosts, sent } = showing();
    const problem: SceneProblem = { kind: "error", message: "oops", frame: 3 };
    hosts[0]?.options.onProblem?.(problem);
    expect(sent).toContainEqual({ type: "scene-problem", layer: "a", revision: "r1", problem });
  });
});

describe("a clock no scene gets to", () => {
  const far = (extra: Partial<RenderLayer>) => planOf(layer("a", extra));

  it("is capped, and a frame is always one that can be asked for", () => {
    const fps = { num: 30, den: 1 };
    expect(frameOf(1e20, fps)).toBe(MAX_SCENE_FRAME);
    expect(frameOf(Number.NaN, fps)).toBe(0);
    expect(Number.isSafeInteger(frameOf(1e300, { num: 1e300, den: 1 }))).toBe(true);
  });

  it("stops the clip with a reason instead of running it, by its offset", () => {
    const { scenes, hosts, lastStatus } = setup();
    scenes.follow(far({ offset: 1e20 }), 12);
    scenes.handle(CONTENT);
    expect(hosts).toEqual([]);
    expect(lastStatus()).toMatchObject({ state: "stopped", message: "frame-out-of-range" });
    expect(scenes.showsPlaceholder("a")).toBe(true);
  });

  it("or by a frame rate that no project should have", () => {
    const { scenes, hosts, lastStatus } = setup();
    const plan = {
      ...far({}),
      scenes: { format: "f", language: "zh-CN", fps: { num: 1e12, den: 1 } },
    };
    scenes.follow(plan, 12);
    scenes.handle(CONTENT);
    expect(hosts).toEqual([]);
    expect(lastStatus()).toMatchObject({ state: "stopped", message: "frame-out-of-range" });
  });

  it("closes what ran when the clip gets there", () => {
    const { scenes, hosts } = showing();
    scenes.follow(far({ offset: 1e20 }), 12);
    expect(hosts[0]?.closed).toBe(true);
  });

  it("closes a scene that could not get going, instead of leaving it behind", () => {
    const { scenes, hosts } = setup();
    scenes.follow(planOf(layer("a")), 12);
    FakeHost.failSeeks = true;
    try {
      expect(() => scenes.handle(CONTENT)).toThrow();
    } finally {
      FakeHost.failSeeks = false;
    }
    expect(hosts[0]?.closed).toBe(true);
  });
});

describe("a scene that stops playing", () => {
  function playedAhead(stateful: boolean, ahead: number) {
    const context = showing();
    const host = context.hosts[0] as FakeHost;
    host.ready();
    context.scenes.handle({ type: "play", seconds: 12, at: 1000, rate: 1, jump: true });
    host.seeks.length = 0;
    host.stateful = stateful;
    host.position = 60 + ahead;
    context.scenes.follow(context.plan, 12);
    context.scenes.handle({ type: "pause" });
    return host;
  }

  it("stays where it got to when that is a little ahead and going back costs it everything", () => {
    expect(playedAhead(true, 3).seeks).toEqual([]);
  });

  it("goes back when that costs nothing", () => {
    expect(playedAhead(false, 3).seeks).toEqual([60]);
  });

  it("goes back when it is far off, which is no small difference any more", () => {
    expect(playedAhead(true, 600).seeks).toEqual([60]);
  });

  it("goes back after all for somebody who takes only the picture of the frame", async () => {
    const context = showing();
    const host = context.hosts[0] as FakeHost;
    host.ready();
    context.scenes.handle({ type: "play", seconds: 12, at: 1000, rate: 1, jump: true });
    host.stateful = true;
    host.position = 63;
    host.picture(63);
    context.scenes.handle({ type: "pause" });
    host.seeks.length = 0;
    const picture = context.scenes.exactPicture("a");
    await Promise.resolve();
    expect(host.seeks).toEqual([60]);
    const image = host.picture(60);
    expect((await picture).image).toBe(image);
    // Once it is there, it is there like any frame it went to.
    context.scenes.follow(context.plan, 12);
    expect(host.seeks).toEqual([60]);
  });
});

describe("what cannot run", () => {
  it("a browser that cannot capture shows placeholders, and starts no more frames", () => {
    const { scenes, hosts, plan, lastStatus, redraw } = showing();
    hosts[0]?.say("unsupported");
    expect(lastStatus()).toEqual({ state: "unsupported" });
    expect(scenes.showsPlaceholder("a")).toBe(true);
    expect(redraw).toHaveBeenCalled();
    const more = planOf(...plan.layers, layer("b"));
    scenes.follow(more, 12);
    expect(hosts).toHaveLength(1);
    expect(lastStatus("b")).toEqual({ state: "unsupported" });
    expect(scenes.showsPlaceholder("b")).toBe(true);
  });

  it("a scene for a newer editor stays out", () => {
    const { scenes, hosts, lastStatus, asked } = setup();
    scenes.follow(planOf(layer("a", { source: source({ runtime: 2 }) })), 12);
    expect(hosts).toEqual([]);
    expect(asked()).toEqual([]);
    expect(lastStatus()).toEqual({ state: "too-new" });
    expect(scenes.showsPlaceholder("a")).toBe(true);
  });

  it("a host without origins says so", () => {
    const { scenes, hosts, lastStatus } = setup({ origins: [] });
    scenes.follow(planOf(layer("a")), 12);
    expect(hosts).toEqual([]);
    expect(lastStatus()).toEqual({ state: "unsupported" });
  });

  it("nothing runs when somebody said so", () => {
    const { scenes, hosts, lastStatus } = setup({ run: false });
    scenes.follow(planOf(layer("a")), 12);
    expect(hosts).toEqual([]);
    expect(lastStatus()).toEqual({ state: "off" });
    expect(scenes.showsPlaceholder("a")).toBe(true);
  });

  it("a normal page has no picture, and shows that", () => {
    const { scenes, hosts } = showing({ stage: "plain" });
    hosts[0]?.ready();
    expect(scenes.showsPlaceholder("a")).toBe(true);
  });
});

describe("what comes from the editor", () => {
  it("asks everybody who took the keyboard", () => {
    const { scenes, hosts } = showing();
    scenes.focusTaken();
    expect(hosts[0]?.focusChecks).toBe(1);
  });

  it("gets rid of the frame that writes to the editor", () => {
    const frame = {};
    vi.stubGlobal("window", { 2: frame, length: 3 });
    const { scenes, hosts } = showing();
    scenes.handle({ type: "evict", index: 2, frames: 3 });
    expect(hosts[0]?.evicted).toEqual([frame]);
  });

  it("an index that leads nowhere does nothing", () => {
    vi.stubGlobal("window", { length: 8 });
    const { scenes, hosts } = showing();
    scenes.handle({ type: "evict", index: 7, frames: 8 });
    expect(hosts[0]?.evicted).toEqual([]);
  });

  it("does not take an innocent frame for the one the editor saw: frames came or went", () => {
    const neighbour = {};
    vi.stubGlobal("window", { 0: neighbour, length: 1 });
    const { scenes, hosts } = showing();
    scenes.handle({ type: "evict", index: 0, frames: 2 });
    expect(hosts[0]?.evicted).toEqual([]);
  });

  it("leaves everything else to the compositor", () => {
    const { scenes } = showing();
    expect(scenes.handle({ type: "seek", seconds: 1, jump: false })).toBe(false);
    expect(scenes.handle({ type: "plan", plan: planOf() })).toBe(false);
  });
});

describe("a held picture", () => {
  it("closes when it was replaced and nobody holds it", () => {
    const image = new FakeImage();
    const picture = new HeldPicture(image as unknown as ImageBitmap, 0);
    picture.hold();
    picture.hold();
    picture.replace();
    picture.release();
    expect(image.closed).toBe(false);
    picture.release();
    expect(image.closed).toBe(true);
  });
});

describe("the picture of one frame", () => {
  /** At 12 seconds a clip that starts at 10 is two seconds in, at 30 frames a second. */
  const FRAME = 60;

  const reasonFor = (picture: Promise<HeldPicture>): Promise<StillFailure> =>
    picture.then(
      () => {
        throw new Error("There was a picture");
      },
      (error: unknown) => (error as StillFailed).failure,
    );

  const settled = async (work: Promise<unknown>) => {
    let done = false;
    const mark = () => {
      done = true;
    };
    work.then(mark, mark);
    await Promise.resolve();
    await Promise.resolve();
    return done;
  };

  it("is what the scene has, if that is the frame", async () => {
    const { scenes, hosts } = showing();
    const image = hosts[0]?.picture(FRAME);
    const picture = await scenes.exactPicture("a");
    expect(picture.frame).toBe(FRAME);
    expect(picture.image).toBe(image);
  });

  it("waits for the frame, and whatever comes before it does not count", async () => {
    const { scenes, hosts } = showing();
    hosts[0]?.picture(0);
    const picture = scenes.exactPicture("a");
    hosts[0]?.picture(FRAME - 1);
    hosts[0]?.picture(FRAME + 1);
    expect(await settled(picture)).toBe(false);
    const image = hosts[0]?.picture(FRAME);
    expect((await picture).image).toBe(image);
  });

  it("stays usable after a newer picture came, until it is let go of", async () => {
    const { scenes, hosts } = showing();
    const image = hosts[0]?.picture(FRAME);
    const picture = await scenes.exactPicture("a");
    hosts[0]?.picture(FRAME + 1);
    expect(image?.closed).toBe(false);
    picture.release();
    expect(image?.closed).toBe(true);
  });

  it("does not exist for a scene that stopped, and says why", async () => {
    const { scenes, hosts } = showing();
    const picture = reasonFor(scenes.exactPicture("a"));
    hosts[0]?.fail({ reason: "failed", message: "boom", retrying: false });
    expect(await picture).toMatchObject({
      reason: "scene",
      layer: "a",
      status: { state: "stopped", reason: "failed", message: "boom" },
    });
  });

  it("does not exist for a scene that stopped before anybody asked", async () => {
    const { scenes, hosts } = showing();
    hosts[0]?.fail({ reason: "stuck", retrying: false });
    expect(await reasonFor(scenes.exactPicture("a"))).toMatchObject({
      reason: "scene",
      status: { state: "stopped", reason: "stuck" },
    });
  });

  it("is not the picture the scene had before it stopped", async () => {
    const { scenes, hosts } = showing();
    hosts[0]?.picture(FRAME - 1);
    hosts[0]?.fail({ reason: "stuck", retrying: false });
    expect((await reasonFor(scenes.exactPicture("a"))).reason).toBe("scene");
  });

  it("goes on waiting while a scene that hung starts over", async () => {
    const { scenes, hosts } = showing();
    const picture = scenes.exactPicture("a");
    hosts[0]?.fail({ reason: "silent", retrying: true });
    expect(await settled(picture)).toBe(false);
    const image = hosts[0]?.picture(FRAME);
    expect((await picture).image).toBe(image);
  });

  it("does not exist in a browser that cannot capture", async () => {
    const { scenes, hosts } = showing();
    const picture = reasonFor(scenes.exactPicture("a"));
    hosts[0]?.say("unsupported");
    expect(await picture).toMatchObject({ reason: "scene", status: { state: "unsupported" } });
  });

  it("does not exist as a placeholder", async () => {
    const { scenes } = showing({ stage: "plain" });
    expect(await reasonFor(scenes.exactPicture("a"))).toMatchObject({
      reason: "scene",
      status: { state: "unsupported" },
    });
  });

  it("does not exist while scenes are off, or for a newer editor", async () => {
    const off = showing({ run: false });
    expect(await reasonFor(off.scenes.exactPicture("a"))).toMatchObject({
      status: { state: "off" },
    });
    const { scenes } = setup();
    scenes.follow(planOf(layer("a", { source: source({ runtime: 999 }) })), 12);
    expect(await reasonFor(scenes.exactPicture("a"))).toMatchObject({
      status: { state: "too-new" },
    });
  });

  it("does not exist for a clip that is not there", async () => {
    const { scenes } = showing();
    expect(await reasonFor(scenes.exactPicture("b"))).toEqual({
      reason: "scene",
      layer: "b",
      status: { state: "closed" },
    });
  });

  it("ends with the clip going away", async () => {
    const { scenes, timers } = showing();
    const picture = reasonFor(scenes.exactPicture("a"));
    scenes.follow(planOf(), 12);
    timers[0]?.();
    expect(await picture).toMatchObject({ reason: "scene", status: { state: "closed" } });
  });

  describe("when the scene says it got there", () => {
    it("gives the picture a moment, and then gives up, with both frames", async () => {
      const { scenes, hosts, graces } = showing();
      hosts[0]?.picture(FRAME - 1);
      const picture = reasonFor(scenes.exactPicture("a"));
      await vi.waitFor(() => expect(graces).toHaveLength(1));
      expect(graces[0]?.ms).toBe(PICTURE_GRACE_MS);
      graces[0]?.run();
      expect(await picture).toEqual({
        reason: "scene-frame",
        layer: "a",
        wanted: FRAME,
        got: FRAME - 1,
      });
    });

    it("gives up the same way without any picture at all", async () => {
      const { scenes, graces } = showing();
      const picture = reasonFor(scenes.exactPicture("a"));
      await vi.waitFor(() => expect(graces).toHaveLength(1));
      graces[0]?.run();
      expect(await picture).toEqual({ reason: "scene-frame", layer: "a", wanted: FRAME });
    });

    it("takes the picture when that comes in time", async () => {
      const { scenes, hosts, graces } = showing();
      const picture = scenes.exactPicture("a");
      await vi.waitFor(() => expect(graces).toHaveLength(1));
      const image = hosts[0]?.picture(FRAME);
      expect((await picture).image).toBe(image);
      expect(graces).toHaveLength(0);
    });
  });

  it("has all the time it takes on the way to the frame", async () => {
    const { scenes, hosts, graces } = setup();
    const plan = planOf(layer("a"));
    scenes.follow(plan, 12);
    const reaching = Promise.withResolvers<boolean>();
    scenes.handle(CONTENT);
    // The seek that started it went out with the fake host, so it takes another one.
    const host = hosts[0] as FakeHost;
    host.reaching = reaching.promise;
    scenes.follow(plan, 13);
    const picture = scenes.exactPicture("a");
    await Promise.resolve();
    await Promise.resolve();
    expect(graces).toHaveLength(0);
    reaching.resolve(true);
    await vi.waitFor(() => expect(graces).toHaveLength(1));
    const image = host.picture(90);
    expect((await picture).image).toBe(image);
  });
});
