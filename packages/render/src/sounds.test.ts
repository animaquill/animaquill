import type { OriginPool, SoundHostOptions, SoundLoad, SoundOutcome } from "@animaquill/scene";
import { describe, expect, it, vi } from "vitest";
import type { FromCompositor } from "./index.ts";
import { SoundJobs, type Host } from "./sounds.ts";

const load: SoundLoad = {
  entry: "sounds/a/sound.js",
  files: new Map(),
  duration: 1,
  frames: 48_000,
  sampleRate: 48_000,
  maxChannels: 2,
  seed: 1,
  params: {},
  limitMs: 1000,
};

function setup() {
  const sent: FromCompositor[] = [];
  const hosts: {
    options: SoundHostOptions;
    finish: (outcome: SoundOutcome | undefined) => void;
    cancel: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }[] = [];
  const makeHost = (options: SoundHostOptions): Host => {
    const { promise, resolve } = Promise.withResolvers<SoundOutcome | undefined>();
    const cancel = vi.fn(() => resolve(undefined));
    const release = vi.fn();
    hosts.push({ options, finish: resolve, cancel, release });
    return { run: () => promise, cancel, release };
  };
  const mount = {} as HTMLElement;
  const runtime = vi.fn(() => new Blob(["code"]));
  const jobs = new SoundJobs({ mount, runtime, send: (message) => sent.push(message), makeHost });
  const setUp = (origins: readonly string[] = ["https://a.example", "https://b.example"]) =>
    jobs.handle({ type: "setup", origins, compositor: "https://c.example", run: false });
  return { jobs, sent, hosts, setUp, runtime };
}

const settled = () => new Promise((resolve) => setTimeout(resolve));

describe("making a sound", () => {
  it("passes on what came out", async () => {
    const { jobs, hosts, sent, setUp } = setup();
    setUp();
    expect(jobs.handle({ type: "sound-make", request: 1, load })).toBe(true);
    const samples = new Blob([new Float32Array(4)]);
    hosts[0]?.finish({ ok: true, channels: 1, frames: 4, samples });
    await settled();
    expect(sent).toEqual([{ type: "sound-done", request: 1, channels: 1, frames: 4, samples }]);
  });

  it("keeps what made the samples until the editor has read them", async () => {
    const { jobs, hosts, setUp } = setup();
    setUp();
    jobs.handle({ type: "sound-make", request: 1, load });
    hosts[0]?.finish({ ok: true, channels: 1, frames: 4, samples: new Blob([]) });
    await settled();
    expect(hosts[0]?.release).not.toHaveBeenCalled();
    expect(jobs.handle({ type: "sound-release", request: 1 })).toBe(true);
    expect(hosts[0]?.release).toHaveBeenCalledTimes(1);
    jobs.handle({ type: "sound-release", request: 1 });
    expect(hosts[0]?.release).toHaveBeenCalledTimes(1);
  });

  it("passes on why not", async () => {
    const { jobs, hosts, sent, setUp } = setup();
    setUp();
    jobs.handle({ type: "sound-make", request: 1, load });
    hosts[0]?.finish({ ok: false, reason: "time" });
    await settled();
    expect(sent).toEqual([{ type: "sound-failed", request: 1, reason: "time" }]);
  });

  it("passes on what the code did wrong, for the sound it belongs to", () => {
    const { jobs, hosts, sent, setUp } = setup();
    setUp();
    jobs.handle({ type: "sound-make", request: 7, load });
    const problem = { kind: "error", message: "boom", frame: 0 } as const;
    hosts[0]?.options.onProblem?.(problem);
    expect(sent).toEqual([{ type: "sound-problem", request: 7, problem }]);
  });

  it("says nothing about what somebody cancelled", async () => {
    const { jobs, hosts, sent, setUp } = setup();
    setUp();
    jobs.handle({ type: "sound-make", request: 1, load });
    expect(jobs.handle({ type: "sound-cancel", request: 1 })).toBe(true);
    await settled();
    expect(hosts[0]?.cancel).toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("cannot happen without a place to run, and says so", async () => {
    const { jobs, hosts, sent, setUp } = setup();
    setUp([]);
    jobs.handle({ type: "sound-make", request: 1, load });
    await settled();
    expect(hosts).toEqual([]);
    expect(sent).toEqual([{ type: "sound-failed", request: 1, reason: "no-origin" }]);
  });

  it("starts at the other end of the sites than scenes do", () => {
    const { jobs, hosts, setUp } = setup();
    setUp();
    jobs.handle({ type: "sound-make", request: 1, load });
    const origins = hosts[0]?.options.origins as OriginPool;
    expect(origins.take()).toBe("https://b.example");
  });

  it("leaves what is not about sounds to others, also the setup", () => {
    const { jobs } = setup();
    const setUp = { type: "setup", origins: [], compositor: "c", run: false } as const;
    expect(jobs.handle(setUp)).toBe(false);
    expect(jobs.handle({ type: "pause" })).toBe(false);
  });
});
