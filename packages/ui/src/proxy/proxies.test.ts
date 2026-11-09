/**
 * The proxies of a project folder, as the editor keeps them: made where a video needs one, under a
 * name of their own until they are whole, waiting while something plays, stopped when people say,
 * made again when they went away, and nothing outside their folder is ever touched.
 */
import { ProjectStore } from "@animaquill/core";
import type { LocalFolder } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { hashFile, isSameHash } from "@animaquill/media";
import { ProxyFailed, type ProxyResult } from "@animaquill/media/proxy";
import { createProject } from "@animaquill/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../workbench/emitter.ts";
import type { ProxyJob, ProxyMaker, ProxyRequest } from "./maker.ts";
import { ProxyFiles, type ProxyProject } from "./proxies.ts";
import { PROXY_FOLDER, partOf, proxyName, type ProxySpec } from "./spec.ts";

const ROOT = "文档/片子";
const BIG = "4K 视频";
const SMALL = "小视频";
/** What the fake probe finds out about a file, by what it holds. */
const FACTS: Record<string, { width: number; height: number; fps: number }> = {
  [BIG]: { width: 3840, height: 2160, fps: 60 },
  [SMALL]: { width: 1280, height: 720, fps: 30 },
  另一个4K: { width: 3840, height: 2160, fps: 60 },
};
const SPEC: ProxySpec = { width: 960, height: 540, fps: { num: 30, den: 1 } };
/** What a proxy holds here, which the fake check knows it by. */
const proxyText = ({ width, height }: ProxySpec) => `代理 ${width}x${height}`;

const opened: ProxyFiles[] = [];
afterEach(() => {
  for (const proxies of opened.splice(0)) proxies.dispose();
});

/** A maker of proxies that does what the test says, when it says. */
function fakeMaker() {
  const made: {
    request: ProxyRequest;
    paused: boolean[];
    finish: (result?: Partial<ProxyResult>) => Promise<void>;
    fail: (error: unknown) => void;
    cancelled: boolean;
  }[] = [];
  /** Whether jobs wait for the test, or go through at once. */
  let holding = false;
  const maker: ProxyMaker = {
    make(request): ProxyJob {
      let resolve: (result: ProxyResult) => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const done = new Promise<ProxyResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const record = {
        request,
        paused: [] as boolean[],
        cancelled: false,
        async finish(result: Partial<ProxyResult> = {}) {
          const text = new TextEncoder().encode(proxyText(request.spec));
          // The end first, then the start, as an MP4 does.
          await request.write(text.slice(6), 6);
          request.onProgress?.(0.5);
          await request.write(text.slice(0, 6), 0);
          resolve({ frames: 90, keys: 6, duration: 3, sourceDuration: 3, ...result });
        },
        fail: (error: unknown) => reject(error),
      };
      made.push(record);
      if (!holding) void record.finish();
      return {
        done,
        pause: () => void record.paused.push(true),
        resume: () => void record.paused.push(false),
        cancel() {
          record.cancelled = true;
          reject(new DOMException("Stopped", "AbortError"));
        },
      };
    },
  };
  return {
    maker,
    made,
    hold: (on = true) => {
      holding = on;
    },
  };
}

/** A project folder with a video in it, and its proxies, as a window has them. */
async function setup({
  content = BIG,
  disk = new MemoryDisk({ system: "linux" }),
  writes = true,
  maker = fakeMaker(),
}: {
  content?: string;
  disk?: MemoryDisk;
  writes?: boolean;
  maker?: ReturnType<typeof fakeMaker>;
} = {}) {
  if (!disk.has(`${ROOT}/assets/视频.mp4`)) disk.write(`${ROOT}/assets/视频.mp4`, content);
  disk.chooseNext(ROOT);
  const folder = (await memoryFolders(disk).choose()) as LocalFolder;
  const store = ProjectStore.create(
    createProject({
      name: "片子",
      format: { id: "hd", name: "高清", width: 1920, height: 1080, fps: "30" },
    }),
  );
  const hash = await hashFile(new Blob([disk.bytes(`${ROOT}/assets/视频.mp4`)]));
  const result = store.execute({
    type: "asset.add",
    params: {
      id: "asset_video",
      asset: { kind: "video", storage: "local", path: "assets/视频.mp4", hash, name: "视频.mp4" },
    },
  });
  expect(result.ok).toBe(true);
  const changes = new Emitter();
  const playback = new Emitter();
  let playing = false;
  let project: ProxyProject | undefined = {
    key: "本机1",
    store,
    folder,
    writes,
    elsewhere: !writes,
    // The file of an asset by its hash, as the folder has it now.
    async file(wanted) {
      for (const asset of Object.values(store.getState().assets ?? {})) {
        if (asset.hash === undefined || !isSameHash(asset.hash, wanted)) continue;
        const file = await folder.file(asset.path).catch(() => undefined);
        if (file && isSameHash(await hashFile(file), wanted)) return file;
      }
      return undefined;
    },
  };
  const proxies = new ProxyFiles({
    project: () => project,
    subscribe: changes.subscribe,
    maker: maker.maker,
    playing: () => playing,
    subscribePlaying: playback.subscribe,
    check: async (file, spec) => (await file.text()) === proxyText(spec),
    probe: async (file) => FACTS[await file.text()],
    lookEveryMs: 60_000,
  });
  opened.push(proxies);
  const name = proxyName(hash, SPEC);
  return {
    disk,
    folder,
    store,
    hash,
    name,
    proxies,
    maker,
    play(on: boolean) {
      playing = on;
      playback.emit();
    },
    setProject(change: Partial<ProxyProject> | undefined) {
      project = change && project ? { ...project, ...change } : undefined;
      changes.emit();
    },
    proxyOnDisk: () =>
      disk.has(`${ROOT}/${PROXY_FOLDER}/${name}`)
        ? disk.text(`${ROOT}/${PROXY_FOLDER}/${name}`)
        : undefined,
    inFolder: () =>
      disk.has(`${ROOT}/${PROXY_FOLDER}`) ? disk.names(`${ROOT}/${PROXY_FOLDER}`).toSorted() : [],
  };
}

const stateOf = (proxies: ProxyFiles, hash: string) => proxies.getSnapshot().states.get(hash);

describe("the proxy of a video", () => {
  it("is made in the folder of proxies, under a name of its own until it is whole", async () => {
    const { proxies, maker, hash, name, disk, proxyOnDisk, inFolder } = await setup({
      maker: (() => {
        const made = fakeMaker();
        made.hold();
        return made;
      })(),
    });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    const [job] = maker.made;
    expect(job?.request.spec).toEqual(SPEC);
    expect(job?.request.encoders[0]).toMatchObject({ codec: expect.stringMatching(/^avc1\./) });
    expect(stateOf(proxies, hash)).toEqual({ kind: "making", percent: 0 });
    // On its way it is nothing anybody could take for a proxy.
    expect(inFolder()).toEqual([partOf(name), `${partOf(name)}.crswap`]);
    expect(proxies.standInFor(hash)).toBeUndefined();
    await job?.finish();
    await proxies.settled();
    expect(proxyOnDisk()).toBe(proxyText(SPEC));
    expect(inFolder()).toEqual([name]);
    expect(disk.text(`${ROOT}/.animaquill/.gitignore`)).toBe("*\n");
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
    const standIn = proxies.standInFor(hash);
    expect(standIn).toMatchObject({ width: 3840, height: 2160 });
    expect(await standIn?.file.text()).toBe(proxyText(SPEC));
  });

  it("is not made for a video that decodes as fast as the preview draws, and nothing is written", async () => {
    const { proxies, maker, hash, disk } = await setup({ content: SMALL });
    await proxies.settled();
    expect(maker.made).toEqual([]);
    expect(stateOf(proxies, hash)).toBeUndefined();
    expect(disk.has(`${ROOT}/.animaquill`)).toBe(false);
  });

  it("is found where it is, and not made again", async () => {
    const first = await setup();
    await first.proxies.settled();
    first.proxies.stop();
    const again = await setup({ disk: first.disk });
    await again.proxies.settled();
    expect(again.maker.made).toEqual([]);
    expect(stateOf(again.proxies, again.hash)).toEqual({ kind: "ready" });
  });
});

describe("making proxies", () => {
  it("touches nothing outside the folder of proxies, and there only what the editor made", async () => {
    const disk = new MemoryDisk({ system: "linux" });
    const theirs: Record<string, string> = {
      ".animaquill/.gitignore": "我自己的规则\n",
      ".animaquill/recovered/2026/notes.json": "找回的",
      ".animaquill/proxies/笔记.txt": "放在这里的笔记",
      ".animaquill/proxies/a.mp4": "别人的视频",
      "notes.txt": "笔记",
      "README.md": "说明",
    };
    for (const [path, text] of Object.entries(theirs)) disk.write(`${ROOT}/${path}`, text);
    // What the editor left: a proxy of another size of the project, and a crash on the way.
    const old = "9f86d081884c7d659a2feaa0-1280x720-30-v1.mp4";
    for (const leftover of [old, `${old}.part`, `${old}.part.crswap`]) {
      disk.write(`${ROOT}/${PROXY_FOLDER}/${leftover}`, "旧的");
    }
    const { proxies, name, inFolder } = await setup({ disk });
    await proxies.settled();
    for (const [path, text] of Object.entries(theirs))
      expect(disk.text(`${ROOT}/${path}`)).toBe(text);
    expect(disk.text(`${ROOT}/assets/视频.mp4`)).toBe(BIG);
    expect(inFolder()).toEqual(["a.mp4", name, "笔记.txt"].toSorted());
  });

  it("waits while the timeline plays, and starts nothing new meanwhile", async () => {
    const maker = fakeMaker();
    maker.hold();
    const { proxies, play, hash } = await setup({ maker });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    play(true);
    expect(maker.made[0]?.paused).toEqual([true]);
    expect(proxies.getSnapshot()).toMatchObject({ paused: true, making: { hash } });
    play(false);
    expect(maker.made[0]?.paused).toEqual([true, false]);
    expect(proxies.getSnapshot().paused).toBe(false);
    // One that starts while something plays starts out waiting.
    proxies.stop();
    await proxies.settled();
    play(true);
    proxies.make(hash);
    await proxies.settled();
    expect(maker.made).toHaveLength(1);
    play(false);
    await vi.waitFor(() => expect(maker.made).toHaveLength(2));
  });

  it("stops when people say so, leaves nothing, and goes on when they ask", async () => {
    const maker = fakeMaker();
    maker.hold();
    const { proxies, hash, inFolder, proxyOnDisk } = await setup({ maker });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    proxies.stop();
    await proxies.settled();
    expect(maker.made[0]?.cancelled).toBe(true);
    expect(stateOf(proxies, hash)).toEqual({ kind: "stopped" });
    expect(inFolder()).toEqual([]);
    expect(proxies.standInFor(hash)).toBeUndefined();
    maker.hold(false);
    proxies.make(hash);
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
    expect(proxyOnDisk()).toBe(proxyText(SPEC));
  });

  it("leaves nothing a crash could have the next page take for a proxy", async () => {
    const maker = fakeMaker();
    maker.hold();
    const first = await setup({ maker });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    // Half of it is written when the browser goes away.
    await maker.made[0]?.request.write(new TextEncoder().encode("代理"), 0);
    first.disk.crash();
    expect(first.inFolder()).toEqual([partOf(first.name), `${partOf(first.name)}.crswap`]);
    // And somebody put something that is no proxy at its name.
    first.disk.write(`${ROOT}/${PROXY_FOLDER}/${first.name}`, "代理 96");
    const later = fakeMaker();
    later.hold();
    const next = await setup({ disk: first.disk, maker: later });
    await vi.waitFor(() => expect(later.made).toHaveLength(1));
    // Until the new one is whole, the preview gets none, and what was left is gone.
    expect(next.proxies.standInFor(next.hash)).toBeUndefined();
    expect(next.inFolder()).toEqual([partOf(next.name), `${partOf(next.name)}.crswap`]);
    await later.made[0]?.finish();
    await next.proxies.settled();
    expect(next.proxyOnDisk()).toBe(proxyText(SPEC));
    expect(next.inFolder()).toEqual([next.name]);
  });

  it("are made again when people take their folder away, and .animaquill with it", async () => {
    const { proxies, disk, hash, maker, proxyOnDisk } = await setup();
    await proxies.settled();
    const before = proxies.standInFor(hash)?.file;
    disk.remove(`${ROOT}/.animaquill`);
    await proxies.lookAgain();
    await proxies.settled();
    expect(maker.made).toHaveLength(2);
    expect(proxyOnDisk()).toBe(proxyText(SPEC));
    expect(disk.text(`${ROOT}/.animaquill/.gitignore`)).toBe("*\n");
    expect(proxies.standInFor(hash)?.file).not.toBe(before);
  });

  it("are made again when the preview could not read one", async () => {
    const { proxies, hash, maker } = await setup();
    await proxies.settled();
    proxies.failed(hash);
    expect(proxies.standInFor(hash)).toBeUndefined();
    await vi.waitFor(() => expect(maker.made).toHaveLength(2));
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
  });

  it("are only made by the window that writes the folder, and found by the others", async () => {
    const disk = new MemoryDisk({ system: "linux" });
    const reader = await setup({ disk, writes: false });
    await reader.proxies.settled();
    expect(reader.maker.made).toEqual([]);
    expect(stateOf(reader.proxies, reader.hash)).toEqual({ kind: "waiting" });
    expect(reader.proxies.getSnapshot().elsewhere).toBe(true);
    const writer = await setup({ disk });
    await writer.proxies.settled();
    await reader.proxies.lookAgain();
    expect(stateOf(reader.proxies, reader.hash)).toEqual({ kind: "ready" });
  });

  it("stop where this window does not write the folder any more", async () => {
    const maker = fakeMaker();
    maker.hold();
    const { proxies, setProject, hash, inFolder } = await setup({ maker });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    setProject({ writes: false });
    await proxies.settled();
    expect(maker.made[0]?.cancelled).toBe(true);
    expect(stateOf(proxies, hash)).toEqual({ kind: "waiting" });
    expect(inFolder()).toEqual([]);
    maker.hold(false);
    setProject({ writes: true });
    await vi.waitFor(() => expect(stateOf(proxies, hash)).toEqual({ kind: "ready" }));
  });

  it("follow the file of a video, and what they were made of goes the next time the project opens", async () => {
    const { proxies, store, disk, name, inFolder } = await setup();
    await proxies.settled();
    disk.write(`${ROOT}/assets/视频.mp4`, "另一个4K");
    const hash = await hashFile(new Blob(["另一个4K"]));
    const result = store.execute({
      type: "asset.update",
      params: { asset: "asset_video", changes: { hash } },
    });
    expect(result.ok).toBe(true);
    await proxies.settled();
    const fresh = proxyName(hash, SPEC);
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
    expect(inFolder()).toEqual([fresh, name].toSorted());
    proxies.stop();
    const next = await setup({ disk });
    await next.proxies.settled();
    expect(next.inFolder()).toEqual([fresh]);
  });

  it("fail for good where the browser cannot encode them, and try once more otherwise", async () => {
    const maker = fakeMaker();
    maker.hold();
    const { proxies, hash, inFolder } = await setup({ maker });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(maker.made[0]?.request.encoders[0]?.hardwareAcceleration).toBe("prefer-hardware");
    maker.made[0]?.fail(new ProxyFailed("encoder"));
    await vi.waitFor(() => expect(maker.made).toHaveLength(2));
    // The graphics card failed at it: the processor has the next go, as for an export.
    expect(
      maker.made[1]?.request.encoders.map(({ hardwareAcceleration }) => hardwareAcceleration),
    ).toEqual(["prefer-software"]);
    maker.made[1]?.fail(new ProxyFailed("encoder"));
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "failed", reason: "encoder" });
    expect(inFolder()).toEqual([]);
    proxies.make(hash);
    await vi.waitFor(() => expect(maker.made).toHaveLength(3));
    maker.made[2]?.fail(new ProxyFailed("unsupported"));
    await proxies.settled();
    expect(maker.made).toHaveLength(3);
    expect(stateOf(proxies, hash)).toEqual({ kind: "failed", reason: "unsupported" });
  });

  it("are not taken when they are not as long as the video", async () => {
    const maker = fakeMaker();
    maker.hold();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { proxies, hash, inFolder } = await setup({ maker });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    await maker.made[0]?.finish({ duration: 1.5 });
    await vi.waitFor(() => expect(maker.made).toHaveLength(2));
    await maker.made[1]?.finish({ duration: 1.5 });
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "failed", reason: "encoder" });
    expect(inFolder()).toEqual([]);
  });

  it("are let go of when the project closes", async () => {
    const maker = fakeMaker();
    maker.hold();
    const { proxies, setProject, inFolder } = await setup({ maker });
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    setProject(undefined);
    expect(maker.made[0]?.cancelled).toBe(true);
    expect(proxies.getSnapshot().states.size).toBe(0);
    await vi.waitFor(() => expect(inFolder()).toEqual([]));
  });
});
