import {
  MESSAGE_RULES,
  MessageBudget,
  TokenBucket,
  childFrameOf,
  type MessageRules,
} from "./budget.ts";
import { OriginPool } from "./origins.ts";
import { SCENE_PAGE_PATH, SCENE_SANDBOX } from "./policy.ts";
import {
  isRegistration,
  pixelSizeOf,
  readFromScene,
  readPicture,
  RUNTIME_VERSION,
  type FromScene,
  type SceneLoad,
  type ScenePicture,
  type SceneProblem,
  type TimeBase,
  type ToScene,
} from "./protocol.ts";
import {
  Strikes,
  Watchdog,
  WATCHDOG_RULES,
  type ScenePhase,
  type WatchdogRules,
} from "./watchdog.ts";

/** How often the watchdog looks. It decides by itself when to ask. */
const WATCH_EVERY_MS = 100;

/** The most problems one scene gets to report. It takes real effort to have more of those. */
const MAX_PROBLEMS = 200;

/** A scene gets over a focus now and then, by accident. Taking it again and again is no accident. */
const FOCUS_BURST = 3;
const FOCUS_PER_SECOND = 0.2;

export type SceneFailureReason =
  /** It said that it cannot run. */
  | "failed"
  /** It sent more messages than running a scene takes. */
  | "flood"
  /** It keeps taking the keyboard away from the editor. */
  | "focus"
  /** There is nowhere left to run it, see `OriginPool`. Only a new page helps. */
  | "no-origin"
  /** It sent a message that is no message of the protocol. */
  | "oversized"
  /** It went on asking for a new frame, or asked where that makes no sense. */
  | "replay"
  /** It does not answer. */
  | "silent"
  /** It answers and gets nowhere. */
  | "stuck";

/** What the compositor gets to know when a scene goes wrong, for the problems list. */
export interface SceneFailure {
  readonly reason: SceneFailureReason;
  /** What it was doing. */
  readonly phase: ScenePhase;
  /** The last frame it is known to have been on. */
  readonly frame: number;
  /** The frame it was on its way to. */
  readonly target?: number;
  /** Whether it is being started again. */
  readonly retrying: boolean;
  /** What the scene said, for `failed`. */
  readonly message?: string;
}

export type SceneHostState =
  /** Not running yet. */
  | "opening"
  /** Running, and it answers. */
  | "ready"
  /** It cannot run in this browser, which has no way of capturing it. */
  | "unsupported"
  /** It failed for good, until somebody calls `open` again. */
  | "stopped"
  | "closed";

export interface SceneHostOptions {
  /** Where frames go. */
  readonly mount: HTMLElement;
  readonly origins: OriginPool;
  /** The code of the runtime, from `virtual:animaquill-scene-runtime`. */
  readonly runtime: Blob;
  readonly load: Omit<SceneLoad, "stage">;
  /** Overrides what the browser can do. Without capture a scene is a normal page. */
  readonly stage?: SceneLoad["stage"];
  /**
   * Gives a new frame its size and place. It has to stay on the screen: a frame out of sight never
   * gets the events of animations, and each one that it waits for costs a second or two. Stay away
   * from its `visibility` and `pointer-events`, which are up to the host, also afterwards.
   */
  readonly place: (frame: HTMLIFrameElement) => void;
  readonly onState?: (state: SceneHostState) => void;
  readonly onProblem?: (problem: SceneProblem) => void;
  /** It may call `close`. */
  readonly onFailure?: (failure: SceneFailure) => void;
  /** Where a playing scene got to. */
  readonly onPosition?: (frame: number) => void;
  /** What it looks like now. Whoever gets a picture has to close it. */
  readonly onPicture?: (picture: ScenePicture) => void;
  /**
   * What its code registered, and the elements of its page with an id, as JSON. Nothing but its
   * length was checked: it is for `readRegistrationText`.
   */
  readonly onObjects?: (registration: string) => void;
  /** What it registered before is not all there is any more. */
  readonly onObjectsUnsure?: () => void;
  /** An origin not to start on: where the scene this one replaces runs, which may be stuck. */
  readonly avoid?: string;
  readonly rules?: WatchdogRules;
  readonly messageRules?: MessageRules;
}

/** One running document. A scene that has to start over gets a new one of these. */
interface Frame {
  readonly element: HTMLIFrameElement;
  readonly origin: string;
  readonly dog: Watchdog;
  readonly budget: MessageBudget;
  readonly focus: TokenBucket;
  readonly pictures: TokenBucket;
  /** The picture of a frame that has not taken over yet. */
  held: ScenePicture | undefined;
  ready: boolean;
  /** Where it last said it was. */
  position: number;
  /** What it was asked and has not answered, by request. */
  readonly asked: Map<number, number>;
  /** It started out at the beginning, so there was nothing for this one to go back through. */
  firstRequest: number | undefined;
  /** The browser got a page into it, which a process that hung would not. */
  loaded: boolean;
}

interface PendingSeek {
  readonly request: number;
  readonly done: (reached: boolean) => void;
}

/** A number that only something that read the message can know. */
function randomNonce(): number {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  return (high >>> 11) * 2 ** 32 + low;
}

/**
 * A scene as seen from the compositor. It hides that a scene can get replaced: going back through
 * code that ran needs a new document, and so does getting over a hang. The old frame stays until the
 * new one has got to where it has to be, so that the picture never goes away in between.
 *
 * Everything that comes out of a frame was made by code from the project, so nothing it says gets
 * taken at its word: a request has to be one that went out, and silence only ends with an answer
 * that a running scene can give.
 */
export class SceneHost {
  readonly #options: SceneHostOptions;
  readonly #rules: WatchdogRules;
  #strikes: Strikes;
  /** At most two: the one in use, and the one that takes over from it. */
  #current: Frame | undefined;
  #next: Frame | undefined;
  #state: SceneHostState = "opening";
  #capture: boolean | undefined;
  #stateful = false;
  #request = 0;
  /** Where the scene should be, which a new frame has to catch up with. */
  #wanted: number | undefined;
  #base: TimeBase | undefined;
  readonly #channels = new Map<string, Readonly<Record<string, unknown>>>();
  readonly #pending: PendingSeek[] = [];
  readonly #problems = new Set<string>();
  #replays: TokenBucket;
  /** A frame that wants to be replaced, while too many were replaced just now. */
  #replayWaiting: Frame | undefined;
  #opened: PromiseWithResolvers<void> | undefined;
  #watching: ReturnType<typeof setInterval> | undefined;

  constructor(options: SceneHostOptions) {
    this.#options = options;
    this.#rules = options.rules ?? WATCHDOG_RULES;
    this.#strikes = new Strikes(this.#rules.strikes, this.#rules.forgiveAfterMs);
    this.#replays = this.#replayBucket();
  }

  #replayBucket(): TokenBucket {
    const { replayBurst, replaysPerSecond } = this.#rules;
    return new TokenBucket(replayBurst, replaysPerSecond, performance.now());
  }

  get state(): SceneHostState {
    return this.#state;
  }

  /** Whether the browser can capture a scene, once a page has said so. */
  get capture(): boolean | undefined {
    return this.#capture;
  }

  /** The origin of the frame in use. */
  get origin(): string | undefined {
    return this.#current?.origin;
  }

  /** The last frame the frame in use is known to have been on. */
  get position(): number | undefined {
    return this.#current?.position;
  }

  /** Whether going back takes it a new frame, as far as it said when it last got somewhere. */
  get stateful(): boolean {
    return this.#stateful;
  }

  /** Starts the scene. Finishes when it is ready or cannot be. */
  open(): Promise<void> {
    this.#end();
    this.#strikes = new Strikes(this.#rules.strikes, this.#rules.forgiveAfterMs);
    this.#replays = this.#replayBucket();
    this.#problems.clear();
    this.#opened = Promise.withResolvers<void>();
    addEventListener("message", this.#onMessage);
    this.#watching = setInterval(this.#watch, WATCH_EVERY_MS);
    this.#setState("opening");
    this.#current = this.#start();
    if (!this.#current) this.#giveUp();
    return this.#opened.promise;
  }

  close(): void {
    this.#end();
    this.#setState("closed");
  }

  /** Whatever is going on, it is over. */
  #end(): void {
    removeEventListener("message", this.#onMessage);
    clearInterval(this.#watching);
    this.#remove(this.#current);
    this.#remove(this.#next);
    this.#current = undefined;
    this.#next = undefined;
    this.#replayWaiting = undefined;
    this.#finishSeeks(this.#request, false);
    this.#opened?.resolve();
  }

  /** Goes to a frame and stays there. Gives whether it got there. */
  seek(frame: number): Promise<boolean> {
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError(`No frame ${frame}`);
    if (!this.#current) return Promise.resolve(false);
    this.#base = undefined;
    this.#wanted = frame;
    this.#replayWaiting = undefined;
    this.#request += 1;
    const request = this.#request;
    const reached = new Promise<boolean>((done) => this.#pending.push({ request, done }));
    this.#sendSeek();
    return reached;
  }

  /** Follows the time from now on. Send it again to correct the time. */
  play(base: TimeBase): void {
    this.#base = base;
    this.#wanted = base.frame;
    this.#send(this.#next ?? this.#current, { type: "play", base });
  }

  pause(): void {
    this.#base = undefined;
    this.#send(this.#next ?? this.#current, { type: "pause" });
  }

  /**
   * What changed of what the clip holds for the scene, see `ToScene`. It survives the scene being
   * replaced: a new frame starts with all of it.
   */
  channels(layer: string, channels: Readonly<Record<string, unknown>>): void {
    const merged: Record<string, unknown> = { ...this.#channels.get(layer) };
    for (const [path, value] of Object.entries(channels)) {
      if (value === null) delete merged[path];
      else merged[path] = value;
    }
    this.#channels.set(layer, merged);
    this.#send(this.#current, { type: "channels", layer, channels });
    this.#send(this.#next, { type: "channels", layer, channels });
  }

  /** All that the clips hold for the scene, for a frame that starts. */
  #values(): Readonly<Record<string, unknown>> {
    const values: Record<string, unknown> = {};
    for (const channels of this.#channels.values()) Object.assign(values, channels);
    return values;
  }

  /**
   * The editor lost the keyboard to something in this page. Only this page can tell which frame that
   * was, and only until the editor has taken it back, so the editor has to ask first. Nothing can
   * keep a frame from taking the focus, and taking it back does not keep up with a frame that goes
   * on doing it, so what is left is taking the frame away.
   */
  focusTaken(): void {
    const frame = this.#frameOf(
      (document.activeElement as HTMLIFrameElement | null)?.contentWindow,
    );
    if (!frame) return;
    frame.element.blur();
    if (!frame.focus.take(1, performance.now())) this.#fail(frame, "focus");
  }

  /** Whether a window is a frame of this scene, or a page inside one. */
  owns(source: MessageEventSource | null): boolean {
    return this.#senderOf(source) !== undefined;
  }

  /** Somebody else found out that this scene has to go: a scene can write to any page. */
  evict(source: MessageEventSource | null, reason: "flood"): void {
    const frame = this.#senderOf(source);
    if (frame) this.#fail(frame, reason);
  }

  #setState(state: SceneHostState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#options.onState?.(state);
  }

  #send(frame: Frame | undefined, message: ToScene, transfer: Transferable[] = []): void {
    // A sandboxed page has no origin to name.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
    frame?.element.contentWindow?.postMessage(message, "*", transfer);
  }

  /** A new frame, somewhere else than the one in use. Nothing when there is no origin left. */
  #start(): Frame | undefined {
    const { mount, origins, place, avoid, messageRules = MESSAGE_RULES } = this.#options;
    const origin = origins.take(this.#current?.origin ?? avoid);
    if (origin === undefined) return undefined;
    const element = document.createElement("iframe");
    element.setAttribute("sandbox", SCENE_SANDBOX);
    element.src = `${origin}${SCENE_PAGE_PATH}`;
    place(element);
    // Nobody has any business in there. Code can still take the focus, see `focusTaken`.
    element.tabIndex = -1;
    element.style.pointerEvents = "none";
    // Only a frame of the screen delivers the events of animations, and code that listens may not
    // have run yet. So there are none of those until the project is there.
    element.style.visibility = "hidden";
    // One that takes over stays behind the old one until it has got there.
    if (this.#current) this.#current.element.before(element);
    else mount.append(element);
    const now = performance.now();
    const frame: Frame = {
      element,
      origin,
      dog: new Watchdog(now, this.#rules),
      budget: new MessageBudget(now, messageRules),
      focus: new TokenBucket(FOCUS_BURST, FOCUS_PER_SECOND, now),
      pictures: new TokenBucket(messageRules.burstPictures, messageRules.picturesPerSecond, now),
      held: undefined,
      ready: false,
      position: 0,
      asked: new Map(),
      firstRequest: undefined,
      loaded: false,
    };
    // Also an error page loads: that is the network, or a site that is not there right now.
    element.addEventListener("load", () => (frame.loaded = true), { once: true });
    return frame;
  }

  #remove(frame: Frame | undefined): void {
    if (!frame) return;
    // Nobody may have noticed yet, but a frame going away does not end what it left behind.
    if (frame.dog.isQuiet) this.#options.origins.retire(frame.origin);
    frame.element.remove();
    frame.held?.image.close();
    frame.held = undefined;
    this.#options.origins.give(frame.origin);
  }

  #frameOf(window: unknown): Frame | undefined {
    return [this.#current, this.#next].find((frame) => frame?.element.contentWindow === window);
  }

  /**
   * Which frame answers for a window. A page in a scene can write as well as the scene can, from as
   * deep down as it likes, and it all counts for the frame of the scene that it is in.
   */
  #senderOf(source: MessageEventSource | null): Frame | undefined {
    return this.#frameOf(childFrameOf(window, source as Window | null));
  }

  /**
   * Nothing here may touch `event.data` before the budget has had its say. A message only gets built
   * when somebody reads that, and for a big one that is what does the damage.
   */
  #onMessage = (event: MessageEvent): void => {
    const frame = this.#senderOf(event.source);
    if (!frame) return;
    const now = performance.now();
    const admitted = frame.budget.admit(now);
    if (admitted !== "ok") {
      this.#fail(frame, admitted);
      return;
    }
    // A scene can write to this page from a frame of its own, which counts, and means nothing.
    if (event.source !== frame.element.contentWindow) return;
    const data: unknown = event.data;
    const picture = readPicture(data);
    if (picture === "malformed") {
      this.#fail(frame, "oversized");
      return;
    }
    if (picture) {
      this.#picture(frame, picture, now);
      return;
    }
    const weighed = frame.budget.weigh(data, now, isRegistration(data));
    if (weighed !== "ok") {
      this.#fail(frame, weighed);
      return;
    }
    const message = readFromScene(data);
    if (message) this.#handle(frame, message);
  };

  #handle(frame: Frame, message: FromScene): void {
    switch (message.type) {
      case "hello":
        this.#hello(frame, message.capture);
        break;
      case "ready":
        this.#ready(frame);
        break;
      case "failed":
        this.#fail(frame, "failed", message.message);
        break;
      case "seeked":
        this.#seeked(frame, message.request, message.frame);
        if (frame === this.#current) this.#stateful = message.stateful;
        break;
      case "needs-replay":
        this.#replay(frame, message.request, message.frame);
        break;
      case "position":
        this.#position(frame, message.frame);
        break;
      case "progress":
        frame.dog.progressed(message.frame);
        break;
      case "problem":
        this.#problem(message.problem);
        break;
      case "objects":
        // A frame on its way to take over runs the same code, and what it found counts as much.
        this.#options.onObjects?.(message.registration);
        break;
      case "objects-unsure":
        this.#options.onObjectsUnsure?.();
        break;
      case "pong":
        frame.dog.answered(message.nonce);
        break;
      default:
    }
  }

  /**
   * A picture only costs what it costs where it was made, and it reaches this page without a copy,
   * so there is no weighing it. What can go wrong is how many there are and how large they are: this
   * page draws them. Anything not used here has to be closed, or it stays around until it gets
   * collected, however large it is.
   */
  #picture(frame: Frame, picture: ScenePicture, now: number): void {
    const { image } = picture;
    if (!frame.pictures.take(1, now)) {
      image.close();
      this.#fail(frame, "flood");
      return;
    }
    const { width, height } = pixelSizeOf(this.#options.load.view);
    if (image.width !== width || image.height !== height) {
      image.close();
      this.#fail(frame, "oversized");
      return;
    }
    if (frame === this.#next) {
      frame.held?.image.close();
      frame.held = picture;
    } else this.#show(picture);
  }

  #show(picture: ScenePicture): void {
    if (this.#options.onPicture) this.#options.onPicture(picture);
    else picture.image.close();
  }

  /** A frame takes over from the one before it, and what it looks like comes along. */
  #takeOver(frame: Frame): void {
    this.#current = frame;
    const { held } = frame;
    frame.held = undefined;
    if (held) this.#show(held);
  }

  #hello(frame: Frame, capture: boolean): void {
    if (frame.dog.phase !== "hello") return;
    this.#capture = capture;
    const stage = this.#options.stage ?? (capture ? "canvas" : undefined);
    if (!stage) {
      this.#end();
      this.#setState("unsupported");
      return;
    }
    frame.dog.enter("loading");
    this.#send(frame, {
      type: "boot",
      runtime: RUNTIME_VERSION,
      code: this.#options.runtime,
      scene: { ...this.#options.load, stage, values: this.#values() },
    });
  }

  #ready(frame: Frame): void {
    if (frame.dog.phase !== "loading") return;
    frame.ready = true;
    frame.element.style.visibility = "";
    frame.dog.enter("running");
    for (const [layer, channels] of this.#channels) {
      this.#send(frame, { type: "channels", layer, channels });
    }
    if (frame === this.#current) {
      this.#setState("ready");
      this.#opened?.resolve();
    }
    // Whether it is new or took over from one that hung, it has to get to where the old one was.
    this.#sendSeek();
    if (this.#base) this.#send(frame, { type: "play", base: this.#base });
  }

  /** A frame that is still starting catches up when it is ready. */
  #sendSeek(): void {
    const target = this.#next ?? this.#current;
    const frame = this.#wanted;
    if (frame === undefined || !target?.ready) return;
    const request = this.#request;
    target.asked.set(request, frame);
    target.firstRequest ??= request;
    target.dog.seeking(frame);
    this.#send(target, { type: "seek", request, frame });
  }

  #seeked(frame: Frame, request: number, position: number): void {
    if (frame.asked.get(request) !== position) return;
    for (const key of frame.asked.keys()) if (key <= request) frame.asked.delete(key);
    frame.position = position;
    if (frame.asked.size === 0) frame.dog.settled();
    const latest = request === this.#request;
    if (latest) this.#strikes.worked(performance.now());
    if (frame === this.#next) {
      // It only counts once it has got to the latest frame. Until then the old one stays.
      if (!latest) return;
      this.#remove(this.#current);
      this.#next = undefined;
      this.#takeOver(frame);
    }
    this.#finishSeeks(request, true);
  }

  /** The old frame stays on screen until the new one has got there. */
  #replay(frame: Frame, request: number, target: number): void {
    // Going forward again in the meantime needs no new frame.
    if (frame.asked.get(request) !== target || request !== this.#request) return;
    frame.asked.clear();
    frame.dog.settled();
    if (request === frame.firstRequest) {
      this.#fail(frame, "replay");
      return;
    }
    this.#replayWaiting = frame;
    this.#startReplay();
  }

  #startReplay(): void {
    const frame = this.#replayWaiting;
    if (!frame || !this.#replays.take(1, performance.now())) return;
    this.#replayWaiting = undefined;
    if (frame === this.#next) {
      this.#remove(frame);
      this.#next = undefined;
    }
    this.#next ??= this.#start();
    if (!this.#next) this.#giveUp();
  }

  #position(frame: Frame, position: number): void {
    if (frame !== this.#current || !this.#base) return;
    frame.position = position;
    this.#wanted = position;
    this.#options.onPosition?.(position);
  }

  /** The runtime only says things once, but what comes through here is not up to the runtime. */
  #problem(problem: SceneProblem): void {
    const { kind, code, message, file, line, column, target } = problem;
    const key = JSON.stringify([kind, code, message, file, line, column, target]);
    if (this.#problems.has(key) || this.#problems.size > MAX_PROBLEMS) return;
    this.#problems.add(key);
    if (this.#problems.size > MAX_PROBLEMS) {
      this.#options.onProblem?.({ kind: "api", code: "too-many-problems", frame: problem.frame });
    } else {
      this.#options.onProblem?.(problem);
    }
  }

  #finishSeeks(upTo: number, reached: boolean): void {
    while (this.#pending[0] && this.#pending[0].request <= upTo) {
      this.#pending.shift()?.done(reached);
    }
  }

  /**
   * Takes a frame away. Only a scene that stopped working gets another chance: what cannot have
   * happened by accident is not going to get better. Whoever hears about this may close the scene,
   * so that comes last, and what is left to do after it only happens when nobody did.
   */
  #fail(frame: Frame, reason: SceneFailureReason, message?: string): void {
    // Whatever this is, it can come from a loop that never ends, and that stays when the frame goes.
    // Only a scene that says it cannot run has shown that it can still say something, and a page
    // that loaded without saying hello did not get as far as running anything.
    const ranNothing = reason === "silent" && frame.dog.phase === "hello" && frame.loaded;
    if (reason !== "failed" && !ranNothing) this.#options.origins.retire(frame.origin);
    const canRetry = reason === "silent" || reason === "stuck";
    const retrying = canRetry && this.#strikes.hung(performance.now());
    const { target } = frame.dog;
    const failure: SceneFailure = {
      reason,
      phase: frame.dog.phase,
      frame: frame.position,
      ...(target !== undefined && { target }),
      retrying,
      ...(message !== undefined && { message }),
    };
    if (!retrying) {
      this.#end();
      this.#setState("stopped");
      this.#options.onFailure?.(failure);
      return;
    }
    // A scene next to a hung one on the same origin would never start, so the old one goes first.
    this.#remove(frame);
    const wasNext = frame === this.#next;
    const heir = this.#next;
    this.#next = undefined;
    if (!wasNext) {
      this.#current = undefined;
      if (heir) this.#takeOver(heir);
    }
    this.#options.onFailure?.(failure);
    if (this.#state === "closed") return;
    if (wasNext) this.#next = this.#start();
    else this.#current ??= this.#start();
    if (!this.#current || (wasNext && !this.#next)) this.#giveUp();
  }

  /** There is nowhere to start a frame, and asking again would not change that. */
  #giveUp(): void {
    const frame = this.#wanted ?? 0;
    this.#end();
    this.#setState("stopped");
    this.#options.onFailure?.({ reason: "no-origin", phase: "hello", frame, retrying: false });
  }

  #watch = (): void => {
    const now = performance.now();
    const visible = document.visibilityState === "visible";
    for (const frame of [this.#current, this.#next]) {
      // What happened to one frame just now can have taken the other along.
      if (!frame || (frame !== this.#current && frame !== this.#next)) continue;
      const verdict = frame.dog.check(now, visible);
      if (verdict === "ping") {
        const nonce = randomNonce();
        frame.dog.pinged(nonce);
        this.#send(frame, { type: "ping", nonce });
      } else if (verdict === "silent" || verdict === "stuck") {
        this.#fail(frame, verdict);
      }
    }
    this.#startReplay();
  };
}
