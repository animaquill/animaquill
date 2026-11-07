import { REGISTRATION_LIMITS, type Registration } from "@animaquill/core/registration";
import { startCapture, type Capture } from "./capture.ts";
import { MESSAGE_RULES, weightOf } from "../budget.ts";
import { loadProject, type LoadedProject } from "../loader/project.ts";
import { pathOfVirtual } from "../loader/paths.ts";
import { RUNTIME_VERSION, type FromScene, type SceneLoad, type ToScene } from "../protocol.ts";
import { AnimationClock } from "./animations.ts";
import { ClipValues, CodeObjects, SceneParams } from "./content.ts";
import { PageElements } from "./elements.ts";
import { SceneClock } from "./clock.ts";
import { installFileAccess } from "./files.ts";
import { ProblemLog } from "./problems.ts";
import { installRandom } from "./random.ts";
import {
  describeDocument,
  enterStage,
  keepDrawings,
  keepFocusAway,
  keepHistory,
  stageStyle,
  warnAboutTopLayer,
} from "./stage.ts";
import { installTime, realTime } from "./time.ts";
import { Transport } from "./transport.ts";

/** The global that the rewritten project calls. */
const GLOBAL = "__aq";

/** How long a page may take to settle before the scene goes on without it. */
const SETTLE_LIMIT_MS = 10000;
/** How long a module may wait for something when what it waits for could be time passing. */
const WAITING_FOR_TIME_MS = 100;
/**
 * How long time waits for something that should only take a moment, like reading a blob. It can also
 * be something that waits for time to pass, like a module with a timer in it, so this is the most it
 * ever costs, once, and not with every step.
 */
const WORK_LIMIT_MS = 1000;
/** How long a frame waits for what is on it to be there. */
const CONTENT_LIMIT_MS = 3000;
/** How often a long walk says how far it got. */
const PROGRESS_EVERY_MS = 250;
/** How long a walk waits for a frame of the screen, which a hidden scene does not get. */
const SCREEN_FRAME_LIMIT_MS = 1000;
const SIZE_POLL_MS = 10;

interface Boot {
  readonly code: Blob;
  readonly scene: SceneLoad;
}

const windowWithBoot = window as unknown as { aqBoot?: Boot };
const { scene } = windowWithBoot.aqBoot as Boot;
delete windowWithBoot.aqBoot;

/** The failure of the runtime itself. There is a limit to what a message can carry. */
const fail = (error: unknown) =>
  send({ type: "failed", message: String((error as Error)?.stack ?? error).slice(0, 2000) });

// The project shares this realm, so nothing here may depend on what it can replace.
const compositor = parent;
const postToCompositor = compositor.postMessage.bind(compositor);
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- the compositor's sandbox has no origin to name
const send = (message: FromScene) => postToCompositor(message, "*");
const real = realTime();
const sleep = (ms: number) => new Promise<void>((resolve) => real.setTimeout(resolve, ms));

// A message to an own port takes one turn of the event loop, unlike a timer. All promises the
// project has open run before it arrives, and that is what a turn is for.
const { port1, port2 } = new MessageChannel();
let turned = () => {};
port1.addEventListener("message", () => turned());
port1.start();
const nextTurn = () =>
  new Promise<void>((resolve) => {
    turned = resolve;
    port2.postMessage(undefined);
  });

/** Things that happen in real time and that the project is waiting for, with their limits. */
const work = new Map<Promise<unknown>, number>();
function track<T>(promise: Promise<T>): Promise<T> {
  work.set(promise, real.now() + WORK_LIMIT_MS);
  const done = () => void work.delete(promise);
  promise.then(done, done);
  return promise;
}

/** One thing may lead to the next, so this goes on until nothing follows any more. */
async function workDone(): Promise<void> {
  while (work.size > 0) {
    await sleep(1);
    const now = real.now();
    for (const [promise, limit] of work) {
      if (now < limit) continue;
      // From here on it can happen at any moment, and that is worth knowing.
      work.delete(promise);
      problems.report({ kind: "api", code: "slow-work" });
    }
  }
}

const screenFrame = () =>
  Promise.race([
    new Promise<void>((resolve) => real.requestFrame(resolve)),
    sleep(SCREEN_FRAME_LIMIT_MS),
  ]);

const random = installRandom(scene.seed);

const clock: SceneClock = new SceneClock(scene.fps, {
  turn: async () => {
    await nextTurn();
    if (work.size > 0) await workDone();
  },
  settle: () => animations.sync(),
  due: () => animations.due(),
  announce: async () => {
    let ran = animations.announce();
    // The browser only delivers these on a frame of the screen, and an animation that was just
    // paused needs one frame to settle first.
    if (animations.eventsWatched && animations.crossedEventPoint()) {
      await screenFrame();
      await screenFrame();
      ran = true;
    }
    if (ran) await nextTurn();
    return ran;
  },
  failed: (error) => {
    // As if it had been thrown from a task of its own: the project's `onerror` runs, and so does ours.
    reportError(error);
  },
});

const animations = new AnimationClock(() => clock.now);

/** Time stands still until the project is there. The compositor asks again when it hears `ready`. */
let ready = false;

/** Something the project threw while it loaded, which may have kept it from registering the rest. */
let loadFailed = false;

const problems = new ProblemLog(
  (problem) => {
    if (!ready && (problem.kind === "error" || problem.kind === "rejection")) loadFailed = true;
    send({ type: "problem", problem });
  },
  () => clock.frameNow,
);

/** A mistake in how the project uses `aq`, with the line it came from. */
const misused = (code: string, target?: string) =>
  problems.report({
    kind: "api",
    code,
    ...(target !== undefined && { target }),
    ...problems.caller(),
  });

/** Where the scene is in time, in seconds, which is what code reads values at. */
const seconds = () => clock.now / 1000;

const values = new ClipValues(scene.values);
const objects = new CodeObjects(values, seconds, () => registrationChanged());
const params = new SceneParams(scene.params, values, seconds, misused);
const elements = new PageElements(
  values,
  (code, target) => problems.report({ kind: "api", code, ...(target !== undefined && { target }) }),
  REGISTRATION_LIMITS.elements,
);

/** A registration goes again after a change, and not more often than this. */
const REGISTRATION_EVERY_MS = 250;
/** What the compositor takes in one message, less what the message itself weighs. */
const REGISTRATION_BYTES = MESSAGE_RULES.maxRegistrationBytes - 1024;
let registrationWaiting = false;
let registrationSent = Number.NEGATIVE_INFINITY;

/**
 * Says what code registered and which elements there are. The compositor would take a scene away
 * that sends more than a message can hold, so what does not fit stays out, and people hear why.
 */
function sendRegistration(): void {
  registrationWaiting = false;
  registrationSent = real.now();
  const all = objects.descriptors();
  const registration = (count: number): Registration => ({
    objects: all.slice(0, count),
    elements: elements.found,
    complete: !loadFailed,
  });
  let fits = all.length;
  if (weightOf(registration(fits), REGISTRATION_BYTES) > REGISTRATION_BYTES) {
    let low = 0;
    while (low < fits) {
      const middle = (low + fits + 1) >> 1;
      if (weightOf(registration(middle), REGISTRATION_BYTES) > REGISTRATION_BYTES)
        fits = middle - 1;
      else low = middle;
    }
    problems.report({ kind: "api", code: "object-too-many", target: "bytes" });
  }
  send({ type: "objects", registration: registration(fits) });
}

/** Before the scene is ready all of it goes at once, after that a change goes after a moment. */
function registrationChanged(): void {
  if (!ready || registrationWaiting) return;
  registrationWaiting = true;
  const wait = Math.max(REGISTRATION_EVERY_MS - (real.now() - registrationSent), 0);
  real.setTimeout(sendRegistration, wait);
}

const frameCallbacks = new Set<(seconds: number) => void>();

/** These run again for the same frame, in any order, so they get the same numbers each time. */
function runFrameCallbacks(): void {
  for (const callback of frameCallbacks) {
    random.forFrame(clock.frame, () => {
      try {
        callback(clock.now / 1000);
      } catch (error) {
        reportError(error);
      }
    });
  }
}

/** Images that got their chance to be decoded. One that does not make it should not cost that twice. */
const decoded = new WeakSet<HTMLImageElement>();

/** Either way, this is as far as it is going to get. */
const imageLoaded = (image: HTMLImageElement) =>
  image.complete
    ? Promise.resolve()
    : new Promise<void>((done) => {
        image.addEventListener("load", () => done(), { once: true });
        image.addEventListener("error", () => done(), { once: true });
      });

/**
 * New images and fonts have to be there, or the frame would be missing them.
 *
 * `decode` takes the compositor of the browser, and while the frame is hidden that may not answer
 * however long it waits, also for an image that loaded long ago, and the frame cannot tell that it
 * is hidden. So that only happens on the way to a frame, when it shows.
 */
async function contentReady(showing: boolean): Promise<void> {
  // The browser only looks for the fonts of text that it laid out.
  document.documentElement.getBoundingClientRect();
  const images = [...document.images];
  // A lazy image waits to come near the screen, and in a scene that may never happen.
  for (const image of images) if (image.loading === "lazy") image.loading = "eager";
  const undecoded = showing ? images.filter((image) => !decoded.has(image)) : [];
  for (const image of undecoded) decoded.add(image);
  const settled = Promise.allSettled([
    document.fonts.ready,
    ...images.map(imageLoaded),
    ...undecoded.map((image) => image.decode()),
  ]);
  const inTime = await Promise.race([
    settled.then(() => true),
    sleep(CONTENT_LIMIT_MS).then(() => false),
  ]);
  if (!inTime) problems.report({ kind: "api", code: "content-timeout" });
}

const fps = scene.fps.num / scene.fps.den;

let lastProgress = 0;

const transport = new Transport(clock, {
  arrived: async () => {
    runFrameCallbacks();
    // What the clip says about elements comes last, so that it wins over code.
    try {
      elements.apply(seconds());
    } catch (error) {
      reportError(error);
    }
    animations.sync();
    await contentReady(true);
    await capture?.take(clock.frame);
  },
  seeked: (request, frame, stateful) => send({ type: "seeked", request, frame, stateful }),
  needsReplay: (request, frame) => send({ type: "needs-replay", request, frame }),
  position: (frame) => send({ type: "position", frame }),
  walked: (frame) => {
    const now = real.now();
    if (now - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = now;
    send({ type: "progress", frame });
  },
  wall: () => real.origin + real.now(),
  onScreenFrame: (run) => real.requestFrame(run),
  broke: (error) => fail(error),
  fps,
});

function onMessage(event: MessageEvent<ToScene>): void {
  // A scene can reach its neighbours, and they can reach it. Only the compositor gets to say.
  if (event.source !== compositor) return;
  event.stopImmediatePropagation();
  const { data } = event;
  switch (data.type) {
    case "seek":
      if (ready) transport.seek(data.request, data.frame);
      break;
    case "play":
      if (ready) transport.play(data.base);
      break;
    case "pause":
      transport.pause();
      break;
    case "channels": {
      const changed = values.change(data.channels);
      if (changed.length === 0) break;
      params.changed(changed);
      // Nothing else would show it while the scene stands still.
      if (ready) transport.refresh();
      break;
    }
    case "ping":
      send({ type: "pong", nonce: data.nonce });
      break;
    default:
  }
}

/** `document.open` removes every listener of the window, so this runs on both sides of it. */
function listen(): void {
  addEventListener("message", onMessage);
  addEventListener("error", problems.onError, true);
  // Order counts: nothing of the project may see a message of the compositor.
  addEventListener("unhandledrejection", problems.onRejection);
  addEventListener("securitypolicyviolation", problems.onBlocked);
}

const makeUrl = (content: Blob | string, type: string) =>
  URL.createObjectURL(
    content instanceof Blob ? content.slice(0, content.size, type) : new Blob([content], { type }),
  );

/** The project's own global. Code in a scene talks to the editor through this and nothing else. */
function installApi(project: LoadedProject): void {
  const assets = new Map<string, string>();
  const asset = (id: string) => {
    const known = assets.get(id);
    if (known !== undefined) return known;
    const file = scene.assets.get(id);
    if (!file) {
      problems.report({ kind: "api", code: "missing-asset", target: String(id) });
      return "data:,";
    }
    const url = URL.createObjectURL(file);
    assets.set(id, url);
    return url;
  };
  const frame = (callback: (seconds: number) => void) => {
    frameCallbacks.add(callback);
    return () => void frameCallbacks.delete(callback);
  };
  const { width, height, pixelRatio, format, language } = scene.view;
  Object.defineProperty(globalThis, "aq", {
    value: Object.freeze({
      runtime: RUNTIME_VERSION,
      view: Object.freeze({ width, height, pixelRatio, format, language }),
      asset,
      frame,
      object: (id: unknown, options: unknown) => objects.register(id, options, misused),
      param: (id: unknown, at?: unknown) => params.read(id, at),
    }),
    enumerable: true,
    // Scripts may declare a variable of that name, which cannot be done to what is fixed.
    configurable: true,
  });
  Object.defineProperty(globalThis, GLOBAL, {
    value: {
      spec: (specifier: string, from: string) =>
        project.specifier(String(specifier), pathOfVirtual(from)),
      load: track,
      head: () => {
        describeDocument(scene.view);
        document.currentScript?.remove();
      },
      body: () => {
        useStage();
        document.currentScript?.remove();
      },
    },
  });
}

let staged = false;
let capture: Capture | undefined;

function useStage(): void {
  if (staged) return;
  staged = true;
  if (scene.stage !== "canvas") return;
  capture = startCapture(enterStage(scene.view), {
    send: (picture) => postToCompositor({ type: "frame", ...picture }, "*", [picture.image]),
    report: (code) => problems.report({ kind: "api", code }),
    sleep,
    onScreenFrame: (run) => real.requestFrame(run),
  });
}

const importModule = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;

/** What is in the document ran, or it is waiting for time to pass, which only happens later. */
async function documentSettled(repair: () => ReadonlySet<string>): Promise<void> {
  if (document.readyState !== "complete") {
    await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
  }
  // A page that ends in the middle of a tag can swallow what was meant to open the stage.
  useStage();
  const putRight = repair();
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]');
  const modules = Promise.allSettled([...scripts].map(({ src }) => importModule(src)));
  const done = modules.then(() => true);
  const inTime = await Promise.race([done, sleep(WAITING_FOR_TIME_MS).then(() => false)]);
  // A module with `await` in it can wait for anything, and time only passes after this.
  if (!inTime && !clock.waiting) await Promise.race([done, sleep(SETTLE_LIMIT_MS)]);
  await workDone();
  await contentReady(false);
  // SMIL only starts after the load event.
  await sleep(0);
  problems.release(putRight);
}

async function waitForSize(): Promise<void> {
  // A frame in another process learns its size some time after it started, and `100vh` would be 0.
  while (innerWidth === 0) await sleep(SIZE_POLL_MS);
}

async function main(): Promise<void> {
  listen();
  installTime(clock);
  keepHistory();
  keepDrawings();
  keepFocusAway(() => problems.report({ kind: "api", code: "focus" }));
  warnAboutTopLayer((api) => problems.report({ kind: "api", code: "top-layer", target: api }));

  const project = await loadProject({
    entry: scene.entry,
    files: scene.files,
    makeUrl,
    head: `<style>${stageStyle(scene.view, scene.stage)}</style><script>${GLOBAL}.head()</script>`,
    body: `<script>${GLOBAL}.body()</script>`,
    global: GLOBAL,
    report: ({ code, file, line, column, target }) =>
      problems.report({
        kind: "loader",
        code,
        file,
        ...(line !== undefined && { line }),
        ...(column !== undefined && { column }),
        ...(target !== undefined && { target }),
      }),
  });
  if (project.html === "") {
    send({ type: "failed", message: "missing-entry" });
    return;
  }
  problems.sources = project.sources;
  installApi(project);
  const repair = installFileAccess({
    project,
    entry: scene.entry,
    files: scene.files,
    seed: scene.seed,
    global: GLOBAL,
    report: ({ code, file, target }) =>
      problems.report({ kind: "loader", code, file, ...(target !== undefined && { target }) }),
    workerFailed: problems.onError,
    workerStarted: () => problems.report({ kind: "api", code: "worker-timing" }),
    workletStarted: () => problems.report({ kind: "api", code: "worklet" }),
    track,
  });

  await waitForSize();

  document.open();
  listen();
  document.write(project.html);
  document.close();

  await documentSettled(repair);
  animations.start();
  animations.sync();
  ready = true;
  params.loaded();
  elements.scan(registrationChanged);
  sendRegistration();
  send({ type: "ready", width: innerWidth, height: innerHeight });
}

// Nothing can be drawn when this fails, so the compositor needs to hear it in so many words.
main().catch((error: unknown) => {
  fail(error);
});
