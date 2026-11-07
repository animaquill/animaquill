import code from "virtual:animaquill-scene-runtime";
import {
  MESSAGE_RULES,
  OriginPool,
  SceneHost,
  WATCHDOG_RULES,
  type SceneFailure,
  type SceneHostOptions,
  type SceneProblem,
} from "../../src/index.ts";
import { COMPOSITOR, SCENES } from "../hosts.ts";
import type { Call, OpenScene, Reply, SceneInfo } from "./messages.ts";

/**
 * Stands in for the compositor: it holds scenes and passes on what the test says. It takes orders
 * from its parent and nobody else, like the real one.
 */
const origins = new OriginPool(SCENES, COMPOSITOR);
const runtime = new Blob([code], { type: "text/javascript" });

/**
 * A message only gets built when `data` is read, which is what can do damage. So that is what tests
 * have to look at: `received` and `read` count what came from anywhere but the parent, and `strangers`
 * what got read of something that is not a frame of this page.
 */
const reads = { received: 0, read: 0, strangers: 0 };
const readData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")?.get;
const isFrameHere = (source: MessageEventSource | null) =>
  [...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === source);
Object.defineProperty(MessageEvent.prototype, "data", {
  get(this: MessageEvent) {
    if (this.source !== parent) {
      reads.read += 1;
      if (!isFrameHere(this.source)) reads.strangers += 1;
    }
    return readData?.call(this);
  },
});
addEventListener(
  "message",
  ({ source }) => {
    if (source !== parent) reads.received += 1;
  },
  true,
);

interface Scene {
  readonly host: SceneHost;
  readonly problems: SceneProblem[];
  readonly failures: SceneFailure[];
  readonly positions: number[];
}

const scenes = new Map<number, Scene>();
let nextScene = 1;

const blobOf = (content: string | { readonly base64: string }) =>
  typeof content === "string"
    ? new Blob([content])
    : new Blob([Uint8Array.from(atob(content.base64), (char) => char.charCodeAt(0))]);

const sceneOf = (id: number) => {
  const scene = scenes.get(id);
  if (!scene) throw new Error(`No scene ${id}`);
  return scene;
};

function open(scene: OpenScene) {
  const { files, assets, entry, stage, fps, seed, startHidden, seekAtOnce, watchdog } = scene;
  const { hello, loading, running, seekStallMs, replayBurst, replaysPerSecond } = watchdog ?? {};
  const id = nextScene;
  nextScene += 1;
  const problems: SceneProblem[] = [];
  const failures: SceneFailure[] = [];
  const positions: number[] = [];
  const options: SceneHostOptions = {
    mount: document.body,
    origins,
    runtime,
    load: {
      entry,
      files: new Map(Object.entries(files).map(([path, content]) => [path, blobOf(content)])),
      assets: new Map(Object.entries(assets ?? {}).map(([name, value]) => [name, blobOf(value)])),
      fps: { num: fps ?? 60, den: 1 },
      seed: seed ?? 1,
      view: { width: 1280, height: 720, pixelRatio: 1, format: "landscape", language: "en" },
    },
    ...(stage && { stage }),
    ...(scene.messageRules && { messageRules: { ...MESSAGE_RULES, ...scene.messageRules } }),
    place: (frame) => {
      const size = startHidden ? "width:0;height:0" : "width:1280px;height:720px";
      frame.style.cssText = `position:fixed;left:0;top:0;${size};border:0`;
      if (startHidden) {
        setTimeout(() => {
          frame.style.width = "1280px";
          frame.style.height = "720px";
        }, 1500);
      }
    },
    onProblem: (problem) => problems.push(problem),
    onFailure: (failure) => {
      failures.push(failure);
      if (scene.closeOnFailure) host.close();
    },
    onPosition: (frame) => positions.push(frame),
    rules: {
      ...WATCHDOG_RULES,
      limitMs: {
        hello: hello ?? WATCHDOG_RULES.limitMs.hello,
        loading: loading ?? WATCHDOG_RULES.limitMs.loading,
        running: running ?? WATCHDOG_RULES.limitMs.running,
      },
      seekStallMs: seekStallMs ?? WATCHDOG_RULES.seekStallMs,
      replayBurst: replayBurst ?? WATCHDOG_RULES.replayBurst,
      replaysPerSecond: replaysPerSecond ?? WATCHDOG_RULES.replaysPerSecond,
    },
  };
  const host = new SceneHost(options);
  scenes.set(id, { host, problems, failures, positions });
  const opened = host.open();
  // Again and again, so that some of it arrives while the project is loading. The host holds this
  // back until the scene is ready, so it also goes straight to the frame, to see that it holds up.
  const asking =
    seekAtOnce === undefined
      ? undefined
      : setInterval(() => {
          void host.seek(seekAtOnce);
          for (const frame of document.querySelectorAll("iframe")) {
            frame.contentWindow?.postMessage({ type: "seek", request: 0, frame: seekAtOnce }, "*");
          }
        }, 2);
  return opened.then(() => {
    clearInterval(asking);
    return id;
  });
}

const frames = () => document.querySelectorAll("iframe").length;

const methods: Readonly<Record<string, (...args: never[]) => unknown>> = {
  open,
  seek: (id: number, frame: number) => sceneOf(id).host.seek(frame),
  play: (id: number, frame: number, rate = 1) =>
    sceneOf(id).host.play({ frame, rate, at: performance.timeOrigin + performance.now() }),
  pause: (id: number) => sceneOf(id).host.pause(),
  channels: (id: number, layer: string, channels: Readonly<Record<string, unknown>>) =>
    sceneOf(id).host.channels(layer, channels),
  close: (id: number) => {
    sceneOf(id).host.close();
    scenes.delete(id);
  },
  /** The editor found out which frame keeps writing to it. */
  evict: (index: number) => {
    const source = window[index] as Window | undefined;
    for (const { host } of scenes.values()) if (source) host.evict(source, "flood");
  },
  info: (id: number): SceneInfo => {
    const { host, problems, failures, positions } = sceneOf(id);
    return {
      origin: host.origin,
      state: host.state,
      capture: host.capture,
      problems,
      failures,
      positions,
      frames: frames(),
    };
  },
  /** The editor had to take the keyboard back. */
  focusTaken: () => {
    for (const { host } of scenes.values()) host.focusTaken();
  },
  /** A frame on a scene origin that nothing starts. */
  bareFrame: (origin: string) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = `${origin}/scene.html`;
    frame.style.cssText = "position:fixed;left:0;top:0;width:100px;height:100px;border:0";
    document.body.append(frame);
    return new Promise((resolve) => frame.addEventListener("load", () => resolve(true)));
  },
  frames,
  /** Which frames there are, and which one is on top. Frames of a scene let the mouse through. */
  atPoint: () => {
    const all = [...document.querySelectorAll("iframe")];
    for (const frame of all) frame.style.pointerEvents = "auto";
    const hit = document.elementFromPoint(100, 100);
    for (const frame of all) frame.style.pointerEvents = "none";
    return all.map((frame) => ({
      top: frame === hit,
      visible: frame.style.visibility !== "hidden",
      origin: new URL(frame.src).origin,
    }));
  },
  alive: () => true,
  reads: () => reads,
  /** Stands still for a while, like a page with a long task. */
  block: (ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
    return true;
  },
};

async function answer({ call, method, args }: Call): Promise<Reply> {
  try {
    const value = await (methods[method] as (...args: unknown[]) => unknown)(...args);
    return { reply: call, value };
  } catch (error) {
    return { reply: call, error: String(error) };
  }
}

addEventListener("message", (event: MessageEvent<Call>) => {
  // Reading the data is what builds a message, so that comes after knowing who wrote it.
  if (event.source !== parent) return;
  void answer(event.data).then((reply) => parent.postMessage(reply, "*"));
});

parent.postMessage({ hello: true }, "*");
