import { madeSoundOf, type ClipState, type CommandCall } from "@animaquill/core";
import type { SceneProblem, SoundLoad, SoundOutcome } from "@animaquill/scene";
import { describe, expect, it, vi } from "vitest";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { MadeSounds, type SoundRun, type SoundRunner } from "./sounds.ts";

const CODE = "aq.sound(({ frames }) => new Float32Array(frames));";

const silence = (frames = 4): SoundOutcome => ({
  ok: true,
  channels: 1,
  frames,
  samples: new Blob([new Float32Array(frames)]),
});

interface Started {
  readonly load: SoundLoad;
  readonly onProblem: (problem: SceneProblem) => void;
  readonly finish: (outcome: SoundOutcome | undefined) => void;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
}

async function setup({ stubborn = false, clean = false } = {}) {
  const projects = new MemoryLibrary();
  const silent = () => {};
  const session = new ProjectSession(projects, memoryAddress(), {
    createFailed: silent,
    notFound: silent,
    openFailed: silent,
    tooNew: silent,
    damaged: silent,
    saveFailed: silent,
    saveRecovered: silent,
  });
  const runs: Started[] = [];
  const run: SoundRunner = (load, onProblem): SoundRun => {
    const { promise, resolve } = Promise.withResolvers<SoundOutcome | undefined>();
    // Cancelling and finishing can cross each other on the way.
    const cancel = vi.fn(() => {
      if (!stubborn) resolve(undefined);
    });
    const release = vi.fn();
    runs.push({ load, onProblem, finish: resolve, cancel, release });
    return { outcome: promise, cancel, release };
  };
  const messages = {
    problem: vi.fn<(sound: string, problem: SceneProblem) => void>(),
    failed: vi.fn<(sound: string, reason: string) => void>(),
  };
  const arrived = vi.fn<(file: string) => void>();
  await session.create("声音项目");
  const store = session.store;
  if (!store) throw new Error("No project");
  const media = projects.media(store.getState().manifest.id);
  const make = () =>
    new MadeSounds({
      session,
      projects,
      run,
      messages,
      arrived,
      followDelayMs: 0,
      // Most tests are about something else, and nothing is old then.
      cacheRules: clean ? { maxAgeMs: 0, maxBytes: 0 } : { maxAgeMs: Infinity, maxBytes: Infinity },
    });
  const execute = (type: string, params: object) => {
    const result = store.execute({ type, params } as CommandCall);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  };
  execute("track.add", { timeline: "main", id: "voice", kind: "audio" });
  const addSound = (id = "s", code = CODE) =>
    execute("sound.add", {
      id,
      sound: { name: "铃", entry: "sound.js", runtime: 1 },
      files: { "sound.js": code },
    });
  const addClip = (id = "c", sound = "s", duration = 1, start = "0") =>
    execute("clip.add", {
      timeline: "main",
      track: "voice",
      clip: {
        id,
        start,
        duration: "1",
        source: { kind: "sound", sound },
        properties: { "param.duration": duration },
      },
    });
  const clip = (id = "c") => store.getState().timelines["main"]?.clips[id] as ClipState;
  const fileOf = (id = "c") => madeSoundOf(store.getState(), clip(id))?.file as string;
  return {
    session,
    store,
    media,
    make,
    runs,
    messages,
    arrived,
    execute,
    addSound,
    addClip,
    clip,
    fileOf,
    projects,
  };
}

/** Lets what is waiting for timers and promises go on. */
const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

describe("a sound nobody has heard yet", () => {
  it("gets made, and ends up in the media store under its name", async () => {
    const { make, runs, media, addSound, addClip, fileOf, arrived, clip } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    expect(sounds.stateOf(clip())).toEqual({ state: "making" });
    expect(runs).toHaveLength(1);
    runs[0]?.finish(silence());
    await vi.waitFor(() => expect(arrived).toHaveBeenCalledWith(fileOf()));
    expect(sounds.stateOf(clip())).toEqual({ state: "ready" });
    const saved = await media.get(fileOf());
    expect(saved?.type).toBe("audio/wav");
    expect(saved?.size).toBe(44 + 16);
  });

  it("lets go of where it was made only once its samples have been read", async () => {
    const { make, runs, addSound, addClip, arrived } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    expect(runs[0]?.release).not.toHaveBeenCalled();
    runs[0]?.finish(silence());
    await vi.waitFor(() => expect(arrived).toHaveBeenCalled());
    expect(runs[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("gets what it needs to run, and nothing else", async () => {
    const { make, runs, addSound, addClip, execute } = await setup();
    addSound();
    addSound("other");
    execute("file.write", { path: "code/shared.js", text: "export const a = 1;" });
    addClip("c", "s", 0.5);
    make();
    await settle();
    const load = runs[0]?.load;
    expect(load).toMatchObject({
      entry: "sounds/s/sound.js",
      duration: 0.5,
      frames: 24_000,
      sampleRate: 48_000,
      maxChannels: 2,
      limitMs: 60_000,
      params: { duration: 0.5 },
    });
    expect([...(load?.files.keys() ?? [])].toSorted()).toEqual([
      "code/shared.js",
      "sounds/s/sound.js",
    ]);
    expect(await load?.files.get("sounds/s/sound.js")?.text()).toBe(CODE);
  });

  it("is made once for two clips that sound the same", async () => {
    const { make, runs, addSound, addClip } = await setup();
    addSound();
    addClip("a");
    addClip("b", "s", 1, "5");
    make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    expect(runs).toHaveLength(1);
  });

  it("waits for its turn: only one runs at a time", async () => {
    const { make, runs, addSound, addClip, fileOf, clip } = await setup();
    addSound();
    addSound("t");
    addClip("a");
    addClip("b", "t", 1, "5");
    const sounds = make();
    await settle();
    expect(runs).toHaveLength(1);
    expect(sounds.stateOf(clip("b"))).toEqual({ state: "waiting" });
    runs[0]?.finish(silence());
    await settle();
    expect(runs).toHaveLength(2);
    expect(fileOf("a")).not.toBe(fileOf("b"));
  });
});

describe("while a sound is being made", () => {
  it("nothing else starts, whatever happens to the project", async () => {
    const { make, runs, addSound, addClip, execute } = await setup();
    addSound();
    addSound("t");
    addClip("a");
    addClip("b", "t", 1, "5");
    make();
    await settle();
    execute("clip.update", { timeline: "main", clip: "b", changes: { start: "7" } });
    await settle();
    expect(runs).toHaveLength(1);
  });
});

describe("a sound that was made before", () => {
  it("does not get made again, in a new session of the same project", async () => {
    const { make, runs, addSound, addClip, arrived, clip } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    const again = make();
    await settle();
    expect(runs).toHaveLength(1);
    expect(again.stateOf(clip())).toEqual({ state: "ready" });
    expect(arrived).toHaveBeenCalledTimes(2);
  });

  it("does not get made again for a clip that got moved, trimmed or quieter", async () => {
    const { make, runs, addSound, addClip, execute, clip } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    execute("clip.update", {
      timeline: "main",
      clip: "c",
      changes: { start: "3", duration: "0.5" },
    });
    execute("property.edit", {
      timeline: "main",
      edits: [{ owner: { clip: "c" }, path: "audio.volume", op: "set", value: -6 }],
    });
    await settle();
    expect(runs).toHaveLength(1);
    expect(sounds.stateOf(clip())).toEqual({ state: "ready" });
  });

  it("gets made again when the code changes", async () => {
    const { make, runs, addSound, addClip, execute, fileOf } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    const before = fileOf();
    execute("file.write", { path: "sounds/s/sound.js", text: `${CODE}\n// 改了` });
    await settle();
    expect(runs).toHaveLength(2);
    expect(fileOf()).not.toBe(before);
    expect(await runs[1]?.load.files.get("sounds/s/sound.js")?.text()).toContain("改了");
  });

  it("is what going back to the old code finds", async () => {
    const { make, runs, addSound, addClip, store, execute } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    execute("file.write", { path: "sounds/s/sound.js", text: "// 别的" });
    await settle();
    runs[1]?.finish(silence());
    await settle();
    store.undo();
    await settle();
    expect(runs).toHaveLength(2);
  });
});

describe("a sound nobody needs any more", () => {
  it("stops running", async () => {
    const { make, runs, addSound, addClip, execute, media, fileOf } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    const file = fileOf();
    execute("clip.remove", { timeline: "main", clips: ["c"] });
    await settle();
    expect(runs[0]?.cancel).toHaveBeenCalled();
    expect(await media.get(file)).toBeUndefined();
  });

  it("gives way to the one that took its place", async () => {
    const { make, runs, addSound, addClip, execute } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    execute("file.write", { path: "sounds/s/sound.js", text: "// 新" });
    await settle();
    expect(runs[0]?.cancel).toHaveBeenCalled();
    expect(runs).toHaveLength(2);
  });

  it("does not end up in the store when it finishes anyway", async () => {
    const { make, runs, addSound, addClip, execute, media, fileOf, arrived } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    const file = fileOf();
    execute("clip.remove", { timeline: "main", clips: ["c"] });
    await settle();
    runs[0]?.finish(silence());
    await settle();
    expect(arrived).not.toHaveBeenCalled();
    await expect(media.get(file)).resolves.toBeUndefined();
  });

  it("does not end up in the store when it finished on the way to being cancelled", async () => {
    const context = await setup({ stubborn: true });
    const { make, runs, addSound, addClip, execute, media, fileOf, arrived } = context;
    addSound();
    addClip();
    make();
    await settle();
    const file = fileOf();
    execute("clip.remove", { timeline: "main", clips: ["c"] });
    await settle();
    runs[0]?.finish(silence());
    await settle();
    expect(arrived).not.toHaveBeenCalled();
    await expect(media.get(file)).resolves.toBeUndefined();
  });

  it("is forgotten with its project", async () => {
    const { make, runs, addSound, addClip, session, arrived } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    await session.create("另一个项目");
    await settle();
    expect(runs[0]?.cancel).toHaveBeenCalled();
    expect(arrived).not.toHaveBeenCalled();
  });
});

describe("a sound that goes wrong", () => {
  it("shows that on its clip, and says why", async () => {
    const { make, runs, addSound, addClip, messages, clip } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    runs[0]?.finish({ ok: false, reason: "time" });
    await settle();
    expect(sounds.stateOf(clip())).toEqual({ state: "failed", reason: "time" });
    expect(messages.failed).toHaveBeenCalledWith("s", "time");
  });

  it("is not tried again by itself", async () => {
    const { make, runs, addSound, addClip, execute } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    runs[0]?.finish({ ok: false, reason: "time" });
    await settle();
    execute("clip.update", { timeline: "main", clip: "c", changes: { start: "2" } });
    await settle();
    expect(runs).toHaveLength(1);
  });

  it("is tried again when the code changes", async () => {
    const { make, runs, addSound, addClip, execute } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    runs[0]?.finish({ ok: false, reason: "error" });
    await settle();
    execute("file.write", { path: "sounds/s/sound.js", text: "// 修好了" });
    await settle();
    expect(runs).toHaveLength(2);
  });

  it("does not stop the next one", async () => {
    const { make, runs, addSound, addClip, clip } = await setup();
    addSound();
    addSound("t");
    addClip("a");
    addClip("b", "t", 1, "5");
    const sounds = make();
    await settle();
    runs[0]?.finish({ ok: false, reason: "bad-result" });
    await settle();
    runs[1]?.finish(silence());
    await settle();
    expect(sounds.stateOf(clip("b"))).toEqual({ state: "ready" });
  });

  it("says what the code did once, and not on top of that that it failed", async () => {
    const { make, runs, addSound, addClip, messages } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    const problem = { kind: "error", message: "boom", frame: 0 } as const;
    runs[0]?.onProblem(problem);
    runs[0]?.finish({ ok: false, reason: "error" });
    await settle();
    expect(messages.problem).toHaveBeenCalledWith("s", problem);
    expect(messages.failed).not.toHaveBeenCalled();
  });

  it("does not go on about it", async () => {
    const { make, runs, addSound, addClip, messages } = await setup();
    addSound();
    addClip();
    make();
    await settle();
    for (let index = 0; index < 20; index += 1) {
      runs[0]?.onProblem({ kind: "error", message: `boom ${index}`, frame: 0 });
    }
    expect(messages.problem).toHaveBeenCalledTimes(3);
  });

  it("is not given to code at all when it would be too long", async () => {
    const { make, runs, addSound, addClip, messages, clip } = await setup();
    addSound();
    addClip("c", "s", 301);
    const sounds = make();
    await settle();
    expect(runs).toHaveLength(0);
    expect(sounds.stateOf(clip())).toEqual({ state: "failed", reason: "over-limit" });
    expect(messages.failed).toHaveBeenCalledWith("s", "over-limit");
  });

  it("says so when there is no room for what came out", async () => {
    const { make, runs, addSound, addClip, messages, clip, projects } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    projects.failing = true;
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    runs[0]?.finish(silence());
    await settle();
    expect(sounds.stateOf(clip())).toEqual({ state: "failed", reason: "save" });
    expect(messages.failed).toHaveBeenCalledWith("s", "save");
  });
});

describe("trying again", () => {
  it("makes a sound that failed again, without anything having to change", async () => {
    const { make, runs, addSound, addClip, clip } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    runs[0]?.finish({ ok: false, reason: "silent" });
    await settle();
    sounds.retry(clip());
    await settle();
    expect(runs).toHaveLength(2);
    expect(sounds.stateOf(clip())).toEqual({ state: "making" });
    runs[1]?.finish(silence());
    await settle();
    expect(sounds.stateOf(clip())).toEqual({ state: "ready" });
  });

  it("does nothing for a sound that did not fail", async () => {
    const { make, runs, addSound, addClip, clip } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    sounds.retry(clip());
    runs[0]?.finish(silence());
    await settle();
    sounds.retry(clip());
    await settle();
    expect(runs).toHaveLength(1);
  });
});

describe("opening a project", () => {
  it("cleans up what its sounds no longer need, and only that", async () => {
    const context = await setup({ clean: true });
    const { make, runs, addSound, addClip, fileOf, projects, store, execute } = context;
    const id = store.getState().manifest.id;
    const media = projects.media(id);
    execute("asset.add", {
      id: "a",
      asset: { kind: "audio", path: "assets/a.wav", storage: "local", hash: "sha256-a" },
    });
    await media.put("sha256-a", new Blob(["用户的声音"]));
    await media.put("sound-1:stale", new Blob(["旧的"]));
    await media.put("peaks-1:sound-1:stale", new Blob(["旧的波形"]));
    addSound();
    addClip();
    const first = make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    await first.cleaned;
    const sounds = make();
    await sounds.cleaned;
    const left = [...projects.files.keys()].map((key) => key.slice(id.length + 1)).toSorted();
    expect(left).toEqual([fileOf(), "sha256-a"].toSorted());
  });

  it("cannot even be told that an asset is a sound: assets are named by their SHA-256", async () => {
    const { execute } = await setup();
    expect(() =>
      execute("asset.add", {
        id: "b",
        asset: { kind: "audio", path: "assets/b.wav", storage: "local", hash: "sound-1:written" },
      }),
    ).toThrow(/sha256/);
  });

  it("keeps what gets used fresh, so that only what nobody uses gets old", async () => {
    const { make, runs, addSound, addClip, fileOf, projects } = await setup();
    addSound();
    addClip();
    projects.now = () => 1000;
    make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    const key = [...projects.usedAt.keys()].find((name) => name.endsWith(fileOf()));
    expect(projects.usedAt.get(key ?? "")).toBe(1000);
    projects.now = () => 5000;
    make();
    await settle();
    expect(projects.usedAt.get(key ?? "")).toBe(5000);
  });
});

describe("clips", () => {
  it("that are not about a sound have nothing to say", async () => {
    const { make, execute, clip } = await setup();
    execute("asset.add", {
      id: "a",
      asset: { kind: "audio", path: "assets/a.wav", storage: "local", hash: "sha256-a" },
    });
    execute("clip.add", {
      timeline: "main",
      track: "voice",
      clip: {
        id: "c",
        start: "0",
        duration: "1",
        source: { kind: "audio", media: { asset: "a" } },
      },
    });
    expect(make().stateOf(clip())).toBeUndefined();
  });
});

describe("a sound an export waits for", () => {
  it("comes from the state the export has, even when the code changed since", async () => {
    const { make, runs, addSound, addClip, clip, store, execute, media } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    const state = store.getState();
    const made = madeSoundOf(state, clip());
    if (!made) throw new Error("No sound");
    execute("file.write", { path: "sounds/s/sound.js", text: "// 新" });
    await settle();
    expect(runs[0]?.cancel).toHaveBeenCalled();
    const waiting = sounds.whenMade(made, state);
    runs[1]?.finish(silence());
    await settle();
    expect(await runs[2]?.load.files.get("sounds/s/sound.js")?.text()).toBe(CODE);
    runs[2]?.finish(silence());
    expect(await waiting).toEqual({ state: "ready" });
    expect(await media.get(made.file)).toBeDefined();
  });

  it("that is there already is not made again", async () => {
    const { make, runs, addSound, addClip, clip, store } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    runs[0]?.finish(silence());
    await settle();
    const made = madeSoundOf(store.getState(), clip());
    if (!made) throw new Error("No sound");
    expect(await sounds.whenMade(made, store.getState())).toEqual({ state: "ready" });
    expect(runs).toHaveLength(1);
  });

  it("says why it did not come about", async () => {
    const { make, runs, addSound, addClip, clip, store } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    const made = madeSoundOf(store.getState(), clip());
    if (!made) throw new Error("No sound");
    const waiting = sounds.whenMade(made, store.getState());
    runs[0]?.finish({ ok: false, reason: "time" });
    expect(await waiting).toEqual({ state: "failed", reason: "time" });
  });

  it("stops being made when the export stops waiting and nobody else needs it", async () => {
    const { make, runs, addSound, addClip, clip, store, execute } = await setup();
    addSound();
    addClip();
    const sounds = make();
    await settle();
    const state = store.getState();
    const made = madeSoundOf(state, clip());
    if (!made) throw new Error("No sound");
    execute("clip.remove", { timeline: "main", clips: ["c"] });
    await settle();
    const stop = new AbortController();
    const waiting = sounds.whenMade(made, state, stop.signal);
    await settle();
    expect(runs).toHaveLength(2);
    const stopped = expect(waiting).rejects.toThrow("Stopped");
    stop.abort(new Error("Stopped"));
    await stopped;
    await settle();
    expect(runs[1]?.cancel).toHaveBeenCalled();
  });

  it("of another project does not get made here", async () => {
    const { make, addSound, addClip, clip, store, runs } = await setup();
    addSound();
    addClip();
    const sounds = make();
    const state = store.getState();
    const made = madeSoundOf(state, clip());
    if (!made) throw new Error("No sound");
    const other = { ...state, manifest: { ...state.manifest, id: "别的" } };
    expect(await sounds.whenMade(made, other)).toEqual({ state: "failed", reason: "error" });
    await settle();
    expect(runs).toHaveLength(1);
  });
});
