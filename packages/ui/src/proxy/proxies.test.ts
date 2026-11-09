/**
 * The proxies of a project folder, as the editor keeps them: made where a video needs one and
 * people asked for it, under a name of their own until they are whole, waiting while something
 * plays, stopped when people say, made again when they went away, used wherever they are there,
 * and nothing outside their folder is ever touched.
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
/** A video of the project whose file is not in the folder, as after people moved it away. */
const GONE = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
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
  compared = true,
  missing = false,
  asked = true,
  check = async (file, spec) => (await file.text()) === proxyText(spec),
}: {
  content?: string;
  disk?: MemoryDisk;
  writes?: boolean;
  maker?: ReturnType<typeof fakeMaker>;
  /** Whether the folder and the project were compared since it opened. */
  compared?: boolean;
  /** Whether the project has another video, whose file is not there. */
  missing?: boolean;
  /** Whether people ask for the proxy of the video right away, which is what gets it made. */
  asked?: boolean;
  /** Whether a file is a whole proxy, see `ProxyFilesOptions.check`. */
  check?: (file: Blob, spec: ProxySpec) => Promise<boolean>;
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
  if (missing) {
    const added = store.execute({
      type: "asset.add",
      params: {
        id: "asset_gone",
        asset: {
          kind: "video",
          storage: "local",
          path: "assets/走了.mp4",
          hash: GONE,
          name: "走了.mp4",
        },
      },
    });
    expect(added.ok).toBe(true);
  }
  const changes = new Emitter();
  const playback = new Emitter();
  let playing = false;
  let project: ProxyProject | undefined = {
    key: "本机1",
    store,
    folder,
    writes,
    elsewhere: !writes,
    compared,
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
    check,
    probe: async (file) => FACTS[await file.text()],
    lookEveryMs: 60_000,
  });
  opened.push(proxies);
  if (asked) proxies.make(hash);
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
  it("is not made until people ask, and then made", async () => {
    const { proxies, hash, maker, inFolder } = await setup({ asked: false });
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "none" });
    expect(maker.made).toEqual([]);
    expect(inFolder()).toEqual([]);
    proxies.make(hash);
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
    expect(maker.made).toHaveLength(1);
  });

  it("that is in the folder is used without asking", async () => {
    const { disk, name } = await setup({ asked: false });
    disk.write(`${ROOT}/${PROXY_FOLDER}/${name}`, proxyText(SPEC));
    const { proxies, hash, maker } = await setup({ disk, asked: false });
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
    expect(maker.made).toEqual([]);
  });

  it("is offered once while the project is open, and not when it is on its way or there", async () => {
    const { proxies, hash } = await setup({ asked: false });
    await proxies.settled();
    const shown: string[] = [];
    proxies.offer(hash, () => shown.push("first"));
    proxies.offer(hash, () => shown.push("again"));
    expect(shown).toEqual(["first"]);
    const other = await setup({ asked: false });
    await other.proxies.settled();
    other.proxies.make(other.hash);
    other.proxies.offer(other.hash, () => shown.push("on its way"));
    await other.proxies.settled();
    other.proxies.offer(other.hash, () => shown.push("there"));
    expect(shown).toEqual(["first"]);
  });

  it("is offered once the video was looked at, where that comes later", async () => {
    const { proxies, hash } = await setup({ asked: false });
    const shown: string[] = [];
    // Right after the project opened, before its videos were looked at.
    proxies.offer(hash, () => shown.push("offered"));
    expect(shown).toEqual([]);
    await proxies.settled();
    expect(shown).toEqual(["offered"]);
  });

  it("is not offered where another window makes them", async () => {
    const { proxies, hash } = await setup({ asked: false, writes: false });
    await proxies.settled();
    const shown: string[] = [];
    proxies.offer(hash, () => shown.push("offered"));
    expect(shown).toEqual([]);
  });

  it("asked for before the video was looked at gets made", async () => {
    const { proxies, hash } = await setup({ asked: false });
    proxies.make(hash);
    await proxies.settled();
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
  });

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
    // Until the new one is whole, the preview gets none, and nothing is at its name.
    expect(next.proxies.standInFor(next.hash)).toBeUndefined();
    expect(next.inFolder()).not.toContain(next.name);
    expect(next.inFolder()).toContain(partOf(next.name));
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

  it("that the preview could not read stays when it is whole, and the video plays meanwhile", async () => {
    const { proxies, hash, maker, proxyOnDisk } = await setup();
    await proxies.settled();
    proxies.failed(hash);
    expect(proxies.standInFor(hash)).toBeUndefined();
    await proxies.settled();
    await proxies.lookAgain();
    // Whole as it is: it was something else that went wrong, and it is there for the next time.
    expect(proxyOnDisk()).toBe(proxyText(SPEC));
    expect(maker.made).toHaveLength(1);
    expect(stateOf(proxies, hash)).toEqual({ kind: "failed", reason: "preview" });
    expect(proxies.standInFor(hash)).toBeUndefined();
    // People can ask for it again.
    proxies.make(hash);
    await proxies.settled();
    expect(maker.made).toHaveLength(2);
    expect(proxies.standInFor(hash)).toBeDefined();
  });

  it("that the preview could not read goes when it is not whole, and is not made again at once", async () => {
    const { proxies, hash, maker, disk, name, proxyOnDisk } = await setup();
    await proxies.settled();
    disk.write(`${ROOT}/${PROXY_FOLDER}/${name}`, "坏了");
    proxies.failed(hash);
    await proxies.settled();
    expect(proxyOnDisk()).toBeUndefined();
    expect(maker.made).toHaveLength(1);
    expect(stateOf(proxies, hash)).toEqual({ kind: "failed", reason: "preview" });
    expect(proxies.standInFor(hash)).toBeUndefined();
  });

  it("that the preview could not read does not take a new one with it, which people asked for meanwhile", async () => {
    // Looking at whether the one that could not be read is whole takes its time.
    let held: ((whole: boolean) => void) | undefined;
    let holds = false;
    const check = async (file: Blob, spec: ProxySpec) => {
      if (!holds) return (await file.text()) === proxyText(spec);
      holds = false;
      return new Promise<boolean>((resolve) => {
        held = resolve;
      });
    };
    const { proxies, hash, maker, disk, name, proxyOnDisk } = await setup({ check });
    await proxies.settled();
    disk.write(`${ROOT}/${PROXY_FOLDER}/${name}`, "坏了");
    holds = true;
    proxies.failed(hash);
    await vi.waitFor(() => expect(held).toBeDefined());
    proxies.make(hash);
    await vi.waitFor(() => expect(stateOf(proxies, hash)).toEqual({ kind: "ready" }));
    expect(maker.made).toHaveLength(2);
    held?.(false);
    await proxies.settled();
    expect(proxyOnDisk()).toBe(proxyText(SPEC));
    expect(proxies.standInFor(hash)).toBeDefined();
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
    // Another video, which gets one once people ask for it too.
    expect(stateOf(proxies, hash)).toEqual({ kind: "none" });
    proxies.make(hash);
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

describe("what is of no use in the folder of proxies", () => {
  it("does not keep the other videos from getting one where a video cannot be read", async () => {
    const { proxies, hash, maker } = await setup({ missing: true });
    await proxies.settled();
    expect(maker.made).toHaveLength(1);
    expect(stateOf(proxies, hash)).toEqual({ kind: "ready" });
  });

  it("is what writing left, another way of making, and what no video needs any more", async () => {
    const disk = new MemoryDisk({ system: "linux" });
    disk.write(`${ROOT}/assets/视频.mp4`, BIG);
    const hash = await hashFile(new Blob([disk.bytes(`${ROOT}/assets/视频.mp4`)]));
    const name = proxyName(hash, SPEC);
    // Of the video that cannot be read now: it stays, for when it is back.
    const gone = proxyName(GONE, SPEC);
    const useless = [
      partOf(name),
      `${partOf(name)}.crswap`,
      `${name}.1.crswap`,
      name.replace("-v1.mp4", "-v0.mp4"),
      proxyName(hash, { ...SPEC, width: 1280, height: 720 }),
      proxyName("sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=", SPEC),
    ];
    for (const file of useless) disk.write(`${ROOT}/${PROXY_FOLDER}/${file}`, "旧的");
    disk.write(`${ROOT}/${PROXY_FOLDER}/${gone}`, proxyText(SPEC));
    disk.write(`${ROOT}/${PROXY_FOLDER}/笔记.txt`, "笔记");
    const { proxies, inFolder } = await setup({ disk, missing: true });
    await proxies.settled();
    expect(inFolder()).toEqual([gone, name, "笔记.txt"].toSorted());
  });

  it("stays until the folder and the project were compared, and proxies get made meanwhile", async () => {
    const disk = new MemoryDisk({ system: "linux" });
    const old = "9f86d081884c7d659a2feaa0-960x540-30-v1.mp4";
    disk.write(`${ROOT}/${PROXY_FOLDER}/${old}`, "也许还有用");
    const { proxies, inFolder, name, setProject } = await setup({ disk, compared: false });
    await proxies.settled();
    // What the folder has may well be a video the project gets once it is compared with it.
    expect(inFolder()).toEqual([name, old].toSorted());
    setProject({ compared: true });
    await proxies.settled();
    expect(inFolder()).toEqual([name]);
  });
});

describe("the encoder of proxies", () => {
  it("is the processor only once the graphics card failed at one", async () => {
    const maker = fakeMaker();
    maker.hold();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { proxies, hash } = await setup({ maker });
    const accelerations = (index: number) =>
      maker.made[index]?.request.encoders.map(({ hardwareAcceleration }) => hardwareAcceleration);
    await vi.waitFor(() => expect(maker.made).toHaveLength(1));
    // On the processor, or nobody knows where: the graphics card still gets the next go.
    maker.made[0]?.fail(new ProxyFailed("encoder", { acceleration: "software" }));
    await vi.waitFor(() => expect(maker.made).toHaveLength(2));
    expect(accelerations(1)).toEqual(["prefer-hardware", "prefer-software"]);
    maker.made[1]?.fail(new ProxyFailed("encoder", { acceleration: "hardware" }));
    await proxies.settled();
    proxies.make(hash);
    await vi.waitFor(() => expect(maker.made).toHaveLength(3));
    expect(accelerations(2)).toEqual(["prefer-software"]);
  });
});
