import { wavOf } from "@animaquill/audio";
import {
  entryOf,
  madeSoundOf,
  madeSoundsOf,
  MAX_SOUND_CHANNELS,
  MAX_SOUND_SECONDS,
  soundFilesOf,
  type ClipState,
  type MadeSound,
  type ProjectState,
  type ProjectStore,
} from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import type { FromCompositor, SceneSetup, ToCompositor } from "@animaquill/render";
import {
  readSamples,
  RUNTIME_VERSION,
  SOUND_START_LIMIT_MS,
  type SceneProblem,
  type SoundFailureReason,
  type SoundLoad,
  type SoundOutcome,
} from "@animaquill/scene";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import { openHiddenCompositor, type HiddenCompositor } from "./hidden-compositor.ts";
import { cleanSoundCache, type SoundCacheRules } from "./sound-cache.ts";

/** How long code gets to make a sound. It runs next to everything else, and costs a core. */
export const SOUND_LIMIT_MS = 60_000;

/** People type, and each state of what they type would be another sound. */
const FOLLOW_DELAY_MS = 500;

/** A sound that goes wrong says what is wrong. Past this it has said it. */
const MAX_PROBLEMS_TOLD = 3;

export type SoundFailure =
  | SoundFailureReason
  /** It would be longer than a sound can be. */
  | "over-limit"
  /** It was written for a newer editor. */
  | "too-new"
  /** There is no room for it. */
  | "save";

export type SoundState =
  /** Nothing has happened yet, or it is next. */
  | { readonly state: "waiting" }
  | { readonly state: "making" }
  | { readonly state: "ready" }
  | { readonly state: "failed"; readonly reason: SoundFailure };

export interface SoundMessages {
  /** Something was wrong with what the code did. */
  problem(sound: string, problem: SceneProblem): void;
  /** It did not come about, for a reason that no problem has told. */
  failed(sound: string, reason: SoundFailure): void;
}

/** One sound on its way, which can stop being wanted. */
export interface SoundRun {
  /** Undefined when somebody cancelled it. */
  readonly outcome: Promise<SoundOutcome | undefined>;
  cancel(): void;
  /**
   * The samples have been read. Until then they may still be on their way from where they were
   * made, which therefore has to stay.
   */
  release(): void;
}

/** What makes sounds. It has to be a thing of its own to test what is around it. */
export type SoundRunner = (load: SoundLoad, onProblem: (problem: SceneProblem) => void) => SoundRun;

export interface SoundMakerOptions {
  readonly url: string;
  readonly setup: () => SceneSetup;
  readonly onRetired: (origin: string) => void;
}

/**
 * Asks a compositor of its own to run the code of a sound. Code only ever runs in a sandbox, and the
 * preview may not be open, so this one lives hidden and starts when it is first needed. Should it
 * stop answering, the next sound gets a new one.
 */
export class SoundMaker {
  readonly #options: SoundMakerOptions;
  #compositor: HiddenCompositor | undefined;
  #started: Promise<void> | undefined;
  #nextRequest = 0;

  constructor(options: SoundMakerOptions) {
    this.#options = options;
  }

  #start(): { readonly frame: HTMLIFrameElement; readonly started: Promise<void> } {
    if (!this.#compositor || !this.#started) {
      const compositor = openHiddenCompositor(this.#options.url);
      this.#compositor = compositor;
      this.#started = compositor.ready.then(() =>
        this.#post(compositor.frame, { type: "setup", ...this.#options.setup() }),
      );
    }
    return { frame: this.#compositor.frame, started: this.#started };
  }

  #post(frame: HTMLIFrameElement, message: ToCompositor): void {
    // The sandbox has no origin of its own to name.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
    frame.contentWindow?.postMessage(message, "*");
  }

  #stop(frame: HTMLIFrameElement): void {
    frame.remove();
    if (this.#compositor?.frame !== frame) return;
    this.#compositor = undefined;
    this.#started = undefined;
  }

  run: SoundRunner = (load, onProblem) => {
    const { frame, started } = this.#start();
    this.#nextRequest += 1;
    const request = this.#nextRequest;
    const { promise: outcome, resolve } = Promise.withResolvers<SoundOutcome | undefined>();
    const finish = (result: SoundOutcome | undefined) => {
      clearTimeout(timer);
      removeEventListener("message", onMessage);
      resolve(result);
    };
    // It says so itself long before this, as long as it does anything at all.
    const timer = setTimeout(
      () => {
        this.#stop(frame);
        finish({ ok: false, reason: "silent" });
      },
      load.limitMs + SOUND_START_LIMIT_MS * 3,
    );
    /** Anything can write to this page, and reading `data` is what builds a message. */
    const onMessage = (event: MessageEvent<FromCompositor>) => {
      if (event.source !== frame.contentWindow) return;
      const { data } = event;
      if (data.type === "origin-retired") this.#options.onRetired(data.origin);
      else if (data.type === "sound-problem" && data.request === request) onProblem(data.problem);
      else if (data.type === "sound-failed" && data.request === request) {
        finish({ ok: false, reason: data.reason });
      } else if (data.type === "sound-done" && data.request === request) {
        // The compositor only passes this on. Being sure of what comes in is up to this side.
        const samples = readSamples({ ...data, type: "samples" }, load);
        finish(samples ? { ok: true, ...samples } : { ok: false, reason: "bad-result" });
      }
    };
    addEventListener("message", onMessage);
    void started.then(() => this.#post(frame, { type: "sound-make", request, load }));
    return {
      outcome,
      cancel: () => {
        this.#post(frame, { type: "sound-cancel", request });
        finish(undefined);
      },
      release: () => this.#post(frame, { type: "sound-release", request }),
    };
  };
}

/** The sound being looked for or made. */
interface Busy {
  readonly file: string;
  /** Somebody waits for it, whatever project is open. */
  readonly hold?: Hold;
  cancel: () => void;
}

/** A sound to look for or make, and what for. */
interface Job {
  readonly made: MadeSound;
  /** What it is made from. */
  readonly state: ProjectState;
  /** The open project wants it. */
  readonly store?: ProjectStore;
  /** Somebody waits for it. */
  readonly hold?: Hold;
}

/** How a sound that somebody waits for came out. */
export type SoundOutcomeState = Extract<SoundState, { state: "ready" | "failed" }>;

/**
 * A sound somebody waits for, which stays wanted until it is there or failed, whatever happens to
 * the project and whichever project is open meanwhile: it has what it is made from, and the media
 * store it goes into is that of its own project.
 */
interface Hold {
  readonly key: string;
  readonly made: MadeSound;
  /** What it is made from, which need not be what the project is now. */
  readonly state: ProjectState;
  readonly waiters: Set<(outcome: SoundOutcomeState) => void>;
}

/** The same name can be a sound of two projects, each in a media store of its own. */
const holdKey = (project: string, file: string) => `${project}\n${file}`;

export interface MadeSoundsOptions {
  readonly session: ProjectSession;
  readonly projects: ProjectLibrary;
  readonly run: SoundRunner;
  readonly messages: SoundMessages;
  /** It is in the media store now. */
  readonly arrived: (file: string) => void;
  readonly limitMs?: number;
  /** For tests: how long to wait for people to stop typing. */
  readonly followDelayMs?: number;
  readonly cacheRules?: SoundCacheRules;
  readonly now?: () => number;
}

/**
 * The sounds of the open project that code has to make. Each one has a name that comes from all that
 * decides how it sounds, so a file by that name in the media store is that sound, and only something
 * that changes it means making it again. That goes on here, one at a time, whatever panels are open.
 * Nothing waits for it: until it is there the clips show that and time goes on without them.
 */
export class MadeSounds {
  readonly #options: MadeSoundsOptions;
  readonly #emitter = new Emitter();
  /** By file, as far as anybody needs them. */
  readonly #states = new Map<string, SoundState>();
  #wanted: ReadonlyMap<string, MadeSound> = new Map();
  /** By `holdKey`, in the order they came. */
  readonly #holds = new Map<string, Hold>();
  #store: ProjectStore | undefined;
  #stopStore = () => {};
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy: Busy | undefined;
  #version = 0;

  constructor(options: MadeSoundsOptions) {
    this.#options = options;
    options.session.subscribe(() => this.#followSession());
    this.#followSession();
  }

  subscribe = this.#emitter.subscribe;
  /** Changes when any sound does. */
  getVersion = (): number => this.#version;

  /** Makes a sound that failed again, without anything having to change. */
  retry(clip: ClipState): void {
    const made = this.#store && madeSoundOf(this.#store.getState(), clip);
    if (!made || this.#states.get(made.file)?.state !== "failed") return;
    this.#states.delete(made.file);
    this.#version += 1;
    this.#emitter.emit();
    this.#next();
  }

  /** Resolves once what was there to clean when the project opened is gone. For tests. */
  cleaned: Promise<unknown> = Promise.resolve();

  /** What is going on with the sound of a clip, for clips that have one. */
  stateOf(clip: ClipState): SoundState | undefined {
    const made = this.#store && madeSoundOf(this.#store.getState(), clip);
    return made && (this.#states.get(made.file) ?? { state: "waiting" });
  }

  /**
   * Resolves once a sound is in the media store of the project of `state`, or is not going to be.
   * It gets made from `state`, like an export needs it, and stays wanted until then, even when the
   * project changes or another one opens meanwhile. A sound of the open project that failed before
   * is failed: making it again is up to people, see `retry`. When the signal says stop, it rejects,
   * and the sound goes on only if something else needs it.
   */
  whenMade(made: MadeSound, state: ProjectState, signal?: AbortSignal): Promise<SoundOutcomeState> {
    const project = state.manifest.id;
    const known = this.#isOpen(project) ? this.#states.get(made.file) : undefined;
    if (known?.state === "ready" || known?.state === "failed") return Promise.resolve(known);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const { promise, resolve, reject } = Promise.withResolvers<SoundOutcomeState>();
    const key = holdKey(project, made.file);
    let hold = this.#holds.get(key);
    if (!hold) {
      hold = { key, made, state, waiters: new Set() };
      this.#holds.set(key, hold);
    }
    const held = hold;
    held.waiters.add(resolve);
    signal?.addEventListener("abort", () => {
      reject(signal.reason);
      held.waiters.delete(resolve);
      if (held.waiters.size > 0 || this.#holds.get(key) !== held) return;
      this.#holds.delete(key);
      if (this.#busy?.hold === held) this.#busy.cancel();
    });
    this.#next();
    return promise;
  }

  #isOpen(project: string): boolean {
    return this.#store?.getState().manifest.id === project;
  }

  #set(file: string, state: SoundState): void {
    this.#states.set(file, state);
    this.#version += 1;
    this.#emitter.emit();
  }

  /** The same name in the same project is the same sound, whoever it was made for. */
  #endHoldOf({ made, state }: Job, outcome: SoundOutcomeState): void {
    const key = holdKey(state.manifest.id, made.file);
    const hold = this.#holds.get(key);
    if (!hold) return;
    this.#holds.delete(key);
    for (const waiter of hold.waiters) waiter(outcome);
  }

  #followSession(): void {
    const { store } = this.#options.session;
    if (store === this.#store) return;
    this.#stopStore();
    // What somebody waits for goes on: it does not depend on which project is open.
    if (!this.#busy?.hold) {
      this.#busy?.cancel();
      this.#busy = undefined;
    }
    this.#states.clear();
    this.#wanted = new Map();
    this.#store = store;
    this.#stopStore = store?.subscribe(this.#later) ?? (() => {});
    this.#follow();
    if (store) this.cleaned = this.#clean(store);
  }

  /** Once when a project opens: everything else that happens to the code makes new sounds. */
  async #clean(store: ProjectStore): Promise<void> {
    const state = store.getState();
    const needed = new Set<string>();
    for (const timeline of Object.keys(state.timelines)) {
      for (const { file } of madeSoundsOf(state, timeline)) needed.add(file);
    }
    for (const asset of Object.values(state.assets ?? {})) {
      if (asset.hash !== undefined) needed.add(asset.hash);
    }
    // An export may still need a sound of an older state of this project.
    for (const { made, state: held } of this.#holds.values()) {
      if (held.manifest.id === state.manifest.id) needed.add(made.file);
    }
    const media = this.#options.projects.media(state.manifest.id);
    const now = this.#options.now?.() ?? Date.now();
    try {
      await cleanSoundCache(media, (name) => needed.has(name), now, this.#options.cacheRules);
    } catch (error) {
      // What could not be cleaned now gets its chance next time.
      console.warn("Sounds that nobody needs could not be cleaned up", error);
    }
  }

  #later = (): void => {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(this.#follow, this.#options.followDelayMs ?? FOLLOW_DELAY_MS);
  };

  #follow = (): void => {
    const state = this.#store?.getState();
    if (!state) return;
    const wanted = new Map<string, MadeSound>();
    for (const timeline of Object.keys(state.timelines)) {
      for (const made of madeSoundsOf(state, timeline)) wanted.set(made.file, made);
    }
    this.#wanted = wanted;
    for (const file of this.#states.keys()) if (!wanted.has(file)) this.#states.delete(file);
    if (this.#busy && !this.#busy.hold && !wanted.has(this.#busy.file)) this.#busy.cancel();
    this.#version += 1;
    this.#emitter.emit();
    this.#next();
  };

  #next(): void {
    if (this.#busy) return;
    // Somebody waits for a held one, which is therefore first.
    const [hold] = this.#holds.values();
    if (hold) {
      this.#start({ made: hold.made, state: hold.state, hold });
      return;
    }
    const store = this.#store;
    const made = [...this.#wanted.values()].find(({ file }) => !this.#states.has(file));
    if (!made || !store) return;
    this.#states.set(made.file, { state: "waiting" });
    this.#start({ made, state: store.getState(), store });
  }

  #start(job: Job): void {
    const busy: Busy = {
      file: job.made.file,
      ...(job.hold && { hold: job.hold }),
      cancel: () => {},
    };
    this.#busy = busy;
    void this.#get(job, busy)
      .catch((error: unknown) => {
        console.warn("A sound could not be made", error);
        if (this.#isWanted(job)) this.#fail(job, "error");
      })
      .finally(() => {
        if (this.#busy !== busy) return;
        this.#busy = undefined;
        this.#next();
      });
  }

  /** Whether what it is made for still needs it. */
  #isWanted({ made, store, hold }: Job): boolean {
    if (hold) return this.#holds.get(hold.key) === hold;
    return this.#store === store && this.#wanted.has(made.file);
  }

  /** It is there, for the open project as far as it is a sound of it, and for who waits. */
  #done(job: Job): void {
    const { made, state } = job;
    this.#endHoldOf(job, { state: "ready" });
    if (!this.#isOpen(state.manifest.id) || !this.#wanted.has(made.file)) return;
    this.#set(made.file, { state: "ready" });
    this.#options.arrived(made.file);
  }

  /** `told` is for what people heard about from the code already. */
  #fail(job: Job, reason: SoundFailure, told = false): void {
    const { made, state } = job;
    this.#endHoldOf(job, { state: "failed", reason });
    // What goes wrong with a project that is not open is for whoever waits for it to say.
    if (!this.#isOpen(state.manifest.id)) return;
    if (this.#wanted.has(made.file)) this.#set(made.file, { state: "failed", reason });
    if (!told) this.#options.messages.failed(made.sound, reason);
  }

  async #get(job: Job, busy: Busy): Promise<void> {
    const { made, state } = job;
    const { file } = made;
    const media = this.#options.projects.media(state.manifest.id);
    const stillWanted = () => this.#isWanted(job);
    const open = () => this.#isOpen(state.manifest.id);
    // A store that cannot be read is a store that does not have it.
    const saved = await media.get(file).catch(() => undefined);
    if (!stillWanted()) return;
    if (saved) {
      // What gets used stays, however old it is.
      void media.touchMade(file).catch(() => {});
      this.#done(job);
      return;
    }
    if (made.runtime > RUNTIME_VERSION) {
      this.#fail(job, "too-new");
      return;
    }
    if (made.duration > MAX_SOUND_SECONDS) {
      this.#fail(job, "over-limit");
      return;
    }
    if (open() && this.#wanted.has(file)) this.#set(file, { state: "making" });
    let told = 0;
    const run = this.#options.run(this.#loadOf(state, made), (problem) => {
      told += 1;
      if (told <= MAX_PROBLEMS_TOLD && open()) this.#options.messages.problem(made.sound, problem);
    });
    busy.cancel = run.cancel;
    const outcome = await run.outcome;
    if (!outcome || !stillWanted()) return;
    if (!outcome.ok) {
      this.#fail(job, outcome.reason, outcome.reason === "error" && told > 0);
      return;
    }
    let wav: Blob;
    try {
      wav = await wavOf(outcome.samples, outcome.channels, outcome.frames, made.sampleRate);
    } finally {
      run.release();
    }
    try {
      await media.put(file, wav);
    } catch (error) {
      console.warn("A sound could not be saved", error);
      this.#fail(job, "save");
      return;
    }
    if (!stillWanted()) return;
    this.#done(job);
  }

  #loadOf(state: ProjectState, made: MadeSound): SoundLoad {
    const paths = soundFilesOf(state, made.sound);
    const { entry, duration, sampleRate, seed, params, output } = made;
    return {
      entry,
      files: new Map(paths.map((path) => [path, new Blob([entryOf(state.files, path) ?? ""])])),
      duration,
      frames: Math.max(Math.round(duration * sampleRate), 1),
      sampleRate,
      maxChannels: MAX_SOUND_CHANNELS,
      seed,
      params,
      ...(output !== undefined && { output }),
      limitMs: this.#options.limitMs ?? SOUND_LIMIT_MS,
    };
  }
}
