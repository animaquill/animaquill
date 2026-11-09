/**
 * The proxies of the open project where it is a folder, see the decision of 2026-11-09: a smaller
 * copy of each video that is larger than the project or has more frames, which the preview plays
 * instead while its quality is not full, so that a laptop keeps up with 4K at 60 frames. They are
 * in the project folder, see `ProxyFolder`, made one at a time away from the page while nothing
 * plays, and found again when the project opens. Only the window that writes the folder makes
 * them; the others find what it made. An export never gets one.
 */
import type { ProjectStore } from "@animaquill/core";
import type { LocalFolder, LocalGrowingFile } from "@animaquill/host";
import { FolderError } from "@animaquill/host";
import { probeMedia } from "@animaquill/media";
import { ProxyFailed, isProxy, type ProxyFailure, type ProxyTiming } from "@animaquill/media/proxy";
import { Emitter } from "../workbench/emitter.ts";
import { ProxyFolder } from "./folder.ts";
import type { ProxyJob, ProxyMaker } from "./maker.ts";
import {
  pictureOf,
  proxyEncoders,
  proxyName,
  proxySpecFor,
  type ProxySpec,
  type VideoFacts,
} from "./spec.ts";

/** How a proxy is, for people to see. */
export type ProxyState =
  /** Looking whether the folder has it. */
  | { readonly kind: "checking" }
  /** It waits for its turn, or for the window that writes the folder to make it. */
  | { readonly kind: "waiting" }
  | { readonly kind: "making"; readonly percent: number }
  | { readonly kind: "ready" }
  /** People stopped it. It is made once they ask, or when the project opens again. */
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly reason: ProxyFailure | "write" };

/** What the preview gets in place of a video. */
export interface StandIn {
  readonly file: Blob;
  /** As large as the video it stands in for, as that shows: the picture goes by that. */
  readonly width: number;
  readonly height: number;
}

/** What the preview needs of proxies. */
export interface StandIns {
  /** The proxy of a file of a video, by its hash, while there is one that can be used. */
  standInFor(hash: string): StandIn | undefined;
  /** The preview could not read the proxy it got: it is not used, and is made again. */
  failed(hash: string): void;
  subscribe(listener: () => void): () => void;
}

export interface ProxySnapshot {
  /** By the hash of the file of a video. A video that needs no proxy is not here. */
  readonly states: ReadonlyMap<string, ProxyState>;
  /** The one being made. */
  readonly making: { readonly hash: string; readonly percent: number } | undefined;
  /** How many more wait for their turn. */
  readonly waiting: number;
  /** Making waits while something plays, which needs the decoder more. */
  readonly paused: boolean;
  /** Another window writes the folder, and makes them. */
  readonly elsewhere: boolean;
}

/** No proxies, as where the project is no folder. */
export const NO_PROXIES: ProxySnapshot = {
  states: new Map(),
  making: undefined,
  waiting: 0,
  paused: false,
  elsewhere: false,
};

/** The open project as proxies need it, see `ProxyFilesOptions.project`. */
export interface ProxyProject {
  /** What this browser knows the folder by, see `FolderRecord.id`. Another one is another project. */
  readonly key: string;
  readonly store: ProjectStore;
  /** The project folder now: it can be another one once people found it somewhere else. */
  readonly folder: LocalFolder;
  /** Whether this window writes the folder now, which is the only one that makes proxies. */
  readonly writes: boolean;
  /** Whether another window of this browser writes the folder, and makes them. */
  readonly elsewhere?: boolean;
  /** The file of a video by its hash, while it is that file. */
  file(hash: string): Promise<Blob | undefined>;
}

export interface ProxyFilesOptions {
  /** The open project, where it is a folder, or undefined. */
  readonly project: () => ProxyProject | undefined;
  /** Called back when what `project` gives may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly maker: ProxyMaker;
  /** Whether the timeline plays, which is when nothing else should take the decoder. */
  readonly playing: () => boolean;
  readonly subscribePlaying: (listener: () => void) => () => void;
  /** For tests: whether a file is a whole proxy of this shape, see `isProxy`. */
  readonly check?: (file: Blob, spec: ProxySpec) => Promise<boolean>;
  /** For tests: what a video is like, see `probeMedia`. */
  readonly probe?: (file: Blob) => Promise<VideoFacts | undefined>;
  /** For tests: how often the folder is looked at again, see `LOOK_EVERY_MS`. */
  readonly lookEveryMs?: number;
}

/**
 * How often what the folder has is looked at again: a proxy that people took away gets made again,
 * and one that another window made gets used. It only reads a few names.
 */
export const LOOK_EVERY_MS = 5000;
/** A store that changes keeps changing for a moment, as during an import. */
const SETTLE_MS = 300;
/** A failure that may not happen again gets this many more tries by itself. */
const TRIES = 2;
/** Of how long it is, a proxy may differ from its video by this much and two of its frames. */
const LENGTH_SLACK_SECONDS = 0.1;

/** Something about a proxy, kept while the project is open. */
interface Entry {
  readonly hash: string;
  readonly spec: ProxySpec;
  readonly name: string;
  /** The video as it shows, which the proxy stands in for. */
  readonly shows: { readonly width: number; readonly height: number };
  state: ProxyState;
  /** The proxy, while it is ready. */
  file: File | undefined;
  /** A file of the proxy that the preview could not read: it does not get used again. */
  broken: { readonly size: number; readonly lastModified: number } | undefined;
  failures: number;
  /** How making it went, where this window made it. */
  made: ProxyMade | undefined;
}

/** How making a proxy went: how long the video is, and where the time went. */
export interface ProxyMade extends ProxyTiming {
  /** Seconds of the video. */
  readonly seconds: number;
}

interface Job {
  readonly entry: Entry;
  work: ProxyJob | undefined;
  /** Why it was stopped, by this side: people, another window that writes now, or nothing more. */
  stop: "stopped" | "lost" | "gone" | undefined;
}

interface Opened {
  readonly key: string;
  readonly store: ProjectStore;
  readonly place: ProxyFolder;
  folder: LocalFolder;
  writes: boolean;
  elsewhere: boolean;
  file: (hash: string) => Promise<Blob | undefined>;
  /** By the hash of the file of a video. */
  readonly entries: Map<string, Entry>;
  /** What each video is like, by hash, once found out. */
  readonly facts: Map<string, VideoFacts>;
  job: Job | undefined;
  /** Whether what crashes and older projects left in the folder of proxies is gone. */
  tidied: boolean;
  /** Videos whose proxies are not known, so that tidying would take theirs too. */
  unknown: number;
  reconciling: Promise<void> | undefined;
  again: boolean;
  /** What is on its way, for `settled`. */
  readonly busy: Set<Promise<unknown>>;
  settle: ReturnType<typeof setTimeout> | undefined;
  readonly stop: () => void;
  closed: boolean;
}

const sameStat = (a: { size: number; lastModified: number }, b: File) =>
  a.size === b.size && a.lastModified === b.lastModified;

const failureOf = (error: unknown): ProxyFailure | "write" =>
  error instanceof ProxyFailed ? error.reason : error instanceof FolderError ? "write" : "encoder";

/** Failures that the next try may not have. */
const mayPass = (reason: ProxyFailure | "write") =>
  reason !== "unsupported" && reason !== "unreadable";

export class ProxyFiles implements StandIns {
  readonly #options: ProxyFilesOptions;
  readonly #emitter = new Emitter();
  readonly #check: (file: Blob, spec: ProxySpec) => Promise<boolean>;
  readonly #probe: (file: Blob) => Promise<VideoFacts | undefined>;
  #open: Opened | undefined;
  #snapshot: ProxySnapshot = NO_PROXIES;
  #playing = false;
  /**
   * The graphics card failed at encoding a proxy: the processor does the next ones, as for an
   * export. It is slower, but it finishes.
   */
  #noHardware = false;
  readonly #stop: () => void;

  constructor(options: ProxyFilesOptions) {
    this.#options = options;
    this.#check = options.check ?? ((file, { width, height }) => isProxy(file, { width, height }));
    this.#probe =
      options.probe ??
      (async (file) => {
        const facts = await probeMedia(file);
        return facts?.kind === "video" && facts.width && facts.height
          ? { width: facts.width, height: facts.height, fps: facts.fps }
          : undefined;
      });
    this.#playing = options.playing();
    const stops = [
      options.subscribe(() => this.#follow()),
      options.subscribePlaying(() => this.#followPlaying()),
    ];
    this.#stop = () => {
      for (const stop of stops) stop();
    };
    this.#follow();
  }

  /** Stops what is on its way and follows nothing any more, for a page that goes. */
  dispose(): void {
    this.#stop();
    if (this.#open) this.#close(this.#open);
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ProxySnapshot => this.#snapshot;

  /** How the proxy of an asset is, or undefined where it needs none. */
  stateOf(asset: string): ProxyState | undefined {
    const hash = this.#open?.store.getState().assets?.[asset]?.hash;
    return hash === undefined ? undefined : this.#snapshot.states.get(hash);
  }

  /** How making the proxy of an asset went, where this window made it since the project opened. */
  madeOf(asset: string): ProxyMade | undefined {
    const hash = this.#open?.store.getState().assets?.[asset]?.hash;
    return hash === undefined ? undefined : this.#open?.entries.get(hash)?.made;
  }

  standInFor(hash: string): StandIn | undefined {
    const entry = this.#open?.entries.get(hash);
    if (entry?.state.kind !== "ready" || !entry.file) return undefined;
    return { file: entry.file, ...entry.shows };
  }

  failed(hash: string): void {
    const open = this.#open;
    const entry = open?.entries.get(hash);
    if (!open || entry?.state.kind !== "ready" || !entry.file) return;
    const { size, lastModified } = entry.file;
    entry.broken = { size, lastModified };
    entry.file = undefined;
    entry.state = { kind: "waiting" };
    this.#changed();
    if (open.writes) {
      this.#track(
        open,
        open.place
          .remove(entry.name)
          .catch(() => {})
          .then(() => this.#pump(open)),
      );
    }
  }

  /** Stops making the proxy of this file, or all of them, until people ask again. */
  stop(hash?: string): void {
    const open = this.#open;
    if (!open) return;
    for (const entry of open.entries.values()) {
      if (hash !== undefined && entry.hash !== hash) continue;
      const { kind } = entry.state;
      if (open.job?.entry === entry) {
        open.job.stop = "stopped";
        open.job.work?.cancel();
      } else if (kind === "waiting" || kind === "failed" || kind === "checking") {
        entry.state = { kind: "stopped" };
      }
    }
    this.#changed();
  }

  /** Makes the proxy of this file after all, after it was stopped or failed. */
  make(hash: string): void {
    const open = this.#open;
    const entry = open?.entries.get(hash);
    if (!open || !entry) return;
    if (entry.state.kind !== "stopped" && entry.state.kind !== "failed") return;
    entry.failures = 0;
    entry.state = { kind: "waiting" };
    this.#changed();
    this.#pump(open);
  }

  /** Looks at the folder again right away, as when the window comes to the front. */
  async lookAgain(): Promise<void> {
    const open = this.#open;
    if (open) await this.#look(open);
  }

  /** Resolves once what was asked for so far is done, for tests. */
  async settled(): Promise<void> {
    for (;;) {
      const open = this.#open;
      if (!open) return;
      if (open.settle !== undefined) {
        clearTimeout(open.settle);
        open.settle = undefined;
        this.#track(open, this.#reconcile(open));
      }
      if (open.busy.size === 0) return;
      await Promise.allSettled(open.busy);
    }
  }

  /** Something that goes on by itself, which `settled` waits for. */
  #track(open: Opened, work: Promise<unknown>): void {
    open.busy.add(work);
    void work
      .catch(() => {})
      .finally(() => {
        open.busy.delete(work);
      });
  }

  #follow(): void {
    const project = this.#options.project();
    const open = this.#open;
    if (!project) {
      if (open) this.#close(open);
      return;
    }
    if (!open || open.key !== project.key || open.store !== project.store) {
      if (open) this.#close(open);
      this.#start(project);
      return;
    }
    open.file = (hash) => project.file(hash);
    if (open.elsewhere !== (project.elsewhere === true)) {
      open.elsewhere = project.elsewhere === true;
      this.#changed();
    }
    if (open.folder !== project.folder) {
      open.folder = project.folder;
      this.#track(open, this.#look(open));
    }
    if (open.writes !== project.writes) {
      open.writes = project.writes;
      if (!project.writes && open.job) {
        open.job.stop = "lost";
        open.job.work?.cancel();
      }
      this.#changed();
      if (project.writes) this.#track(open, this.#begin(open));
    }
  }

  #start(project: ProxyProject): void {
    const stops: (() => void)[] = [];
    const open: Opened = {
      key: project.key,
      store: project.store,
      place: new ProxyFolder(() => open.folder),
      folder: project.folder,
      writes: project.writes,
      elsewhere: project.elsewhere === true,
      file: (hash) => project.file(hash),
      entries: new Map(),
      facts: new Map(),
      job: undefined,
      tidied: false,
      unknown: 0,
      reconciling: undefined,
      again: false,
      busy: new Set(),
      settle: undefined,
      stop: () => {
        for (const stop of stops) stop();
      },
      closed: false,
    };
    this.#open = open;
    // Only what decides which videos get one, and what each is like.
    let { assets, manifest } = project.store.getState();
    stops.push(
      project.store.subscribe(() => {
        const now = project.store.getState();
        if (now.assets === assets && now.manifest === manifest) return;
        ({ assets, manifest } = now);
        clearTimeout(open.settle);
        open.settle = setTimeout(() => {
          open.settle = undefined;
          this.#track(open, this.#reconcile(open));
        }, SETTLE_MS);
      }),
    );
    const timer = setInterval(
      () => this.#track(open, this.#look(open)),
      this.#options.lookEveryMs ?? LOOK_EVERY_MS,
    );
    stops.push(() => clearInterval(timer));
    this.#changed();
    this.#track(open, this.#begin(open));
  }

  #close(open: Opened): void {
    open.closed = true;
    open.stop();
    clearTimeout(open.settle);
    if (open.job) {
      open.job.stop = "gone";
      open.job.work?.cancel();
    }
    if (this.#open === open) this.#open = undefined;
    this.#changed();
  }

  /** Once the project is open, and once this window writes the folder. */
  async #begin(open: Opened): Promise<void> {
    await this.#reconcile(open);
    if (open.closed || !open.writes) return;
    // Before anything gets made: what crashes left would be taken for it.
    if (!open.tidied && open.unknown === 0) {
      open.tidied = true;
      const keep = new Set([...open.entries.values()].map(({ name }) => name));
      await open.place.tidy(keep);
    }
    this.#pump(open);
  }

  /** One at a time, and once more when asked for meanwhile. */
  #reconcile(open: Opened): Promise<void> {
    if (open.reconciling) {
      open.again = true;
      return open.reconciling;
    }
    const run = async () => {
      do {
        open.again = false;
        await this.#reconcileOnce(open);
      } while (open.again && !open.closed);
    };
    open.reconciling = run()
      .catch((error: unknown) => console.warn("The proxies could not be looked at", error))
      .finally(() => {
        open.reconciling = undefined;
      });
    return open.reconciling;
  }

  /** Which videos need a proxy now, and what each is like: the project and its files decide. */
  async #reconcileOnce(open: Opened): Promise<void> {
    const state = open.store.getState();
    const picture = pictureOf(state);
    const hashes = new Set<string>();
    for (const asset of Object.values(state.assets ?? {})) {
      if (asset.kind === "video" && asset.hash !== undefined && asset.storage !== "remote") {
        hashes.add(asset.hash);
      }
    }
    for (const entry of open.entries.values()) {
      if (!hashes.has(entry.hash)) this.#drop(open, entry);
    }
    let unknown = 0;
    for (const hash of hashes) {
      const facts = await this.#factsOf(open, hash);
      if (open.closed) return;
      if (!facts) unknown += 1;
      const spec = facts && picture && proxySpecFor(facts, picture);
      const name = spec && proxyName(hash, spec);
      const known = open.entries.get(hash);
      if (known && known.name === name) continue;
      if (known) this.#drop(open, known);
      if (!facts || !spec || !name) continue;
      const entry: Entry = {
        hash,
        spec,
        name,
        shows: { width: facts.width, height: facts.height },
        state: { kind: "checking" },
        file: undefined,
        broken: undefined,
        failures: 0,
        made: undefined,
      };
      open.entries.set(hash, entry);
      this.#changed();
      await this.#find(open, entry);
      this.#pump(open);
    }
    open.unknown = unknown;
  }

  /** What a video is like, found out once from its file. Undefined while there is no file. */
  async #factsOf(open: Opened, hash: string): Promise<VideoFacts | undefined> {
    const known = open.facts.get(hash);
    if (known) return known;
    try {
      const file = await open.file(hash);
      const facts = file && (await this.#probe(file));
      if (facts) open.facts.set(hash, facts);
      return facts;
    } catch {
      return undefined;
    }
  }

  /** Stops what is going on with a proxy that is not wanted any more, and forgets it. */
  #drop(open: Opened, entry: Entry): void {
    if (open.job?.entry === entry) {
      open.job.stop = "gone";
      open.job.work?.cancel();
    }
    open.entries.delete(entry.hash);
    this.#changed();
  }

  /** Whether the folder has the proxy, whole. One that is not right goes, where this window writes. */
  async #find(open: Opened, entry: Entry): Promise<void> {
    let found: File | undefined;
    try {
      found = await open.place.find(entry.name);
    } catch {
      // The folder cannot be looked at now: it gets looked at again.
      if (entry.state.kind === "checking") entry.state = { kind: "waiting" };
      this.#changed();
      return;
    }
    if (open.closed || open.entries.get(entry.hash) !== entry) return;
    const isBroken = found && entry.broken && sameStat(entry.broken, found);
    if (found && !isBroken && (await this.#check(found, entry.spec).catch(() => false))) {
      if (open.entries.get(entry.hash) !== entry || open.job?.entry === entry) return;
      entry.file = found;
      entry.state = { kind: "ready" };
      this.#changed();
      return;
    }
    // No proxy, or one that is not right. Only the window that writes takes anything away.
    if (found && open.writes) await open.place.remove(entry.name).catch(() => {});
    if (entry.state.kind === "checking" || entry.state.kind === "ready") {
      entry.file = undefined;
      entry.state = { kind: "waiting" };
    }
    this.#changed();
  }

  /** What the folder has now: what went away gets made again, what another window made is used. */
  async #look(open: Opened): Promise<void> {
    for (const entry of open.entries.values()) {
      if (open.closed || open.job?.entry === entry) continue;
      const { kind } = entry.state;
      if (kind === "ready" && entry.file) {
        const now = await open.place.find(entry.name).catch(() => entry.file);
        if (now && sameStat(now, entry.file)) continue;
        entry.file = undefined;
        entry.state = { kind: "checking" };
        this.#changed();
        await this.#find(open, entry);
      } else if (kind === "waiting" && !open.writes) {
        await this.#find(open, entry);
      }
    }
    this.#pump(open);
  }

  /** Starts the next proxy, where this window writes, nothing else is on its way, and nothing plays. */
  #pump(open: Opened): void {
    if (open.closed || !open.writes || !open.tidied || open.job || this.#playing) return;
    const next = [...open.entries.values()].find(({ state }) => state.kind === "waiting");
    if (next) this.#track(open, this.#make(open, next));
  }

  async #make(open: Opened, entry: Entry): Promise<void> {
    const job: Job = { entry, work: undefined, stop: undefined };
    open.job = job;
    entry.state = { kind: "making", percent: 0 };
    this.#changed();
    let growing: LocalGrowingFile | undefined;
    let whole = false;
    try {
      const source = await open.file(entry.hash);
      // Nothing to make it of: the file of the video is not there, or not that file any more.
      if (!source) throw new ProxyFailed("read");
      if (job.stop) throw new DOMException("Stopped", "AbortError");
      growing = await open.place.start(entry.name);
      if (job.stop) throw new DOMException("Stopped", "AbortError");
      const into = growing;
      const work = this.#options.maker.make({
        file: source,
        spec: entry.spec,
        encoders: proxyEncoders(entry.spec).filter(
          ({ hardwareAcceleration }) =>
            !this.#noHardware || hardwareAcceleration !== "prefer-hardware",
        ),
        write: (data, position) => into.write(data, position),
        onProgress: (share) => {
          const percent = Math.min(99, Math.floor(share * 100));
          if (entry.state.kind !== "making" || entry.state.percent === percent) return;
          entry.state = { kind: "making", percent };
          this.#changed();
        },
      });
      job.work = work;
      if (this.#playing) work.pause();
      const result = await work.done;
      const written = await growing.finish();
      whole = true;
      const isWhole =
        Math.abs(result.duration - result.sourceDuration) <=
          LENGTH_SLACK_SECONDS + (2 * entry.spec.fps.den) / entry.spec.fps.num &&
        (await this.#check(written, entry.spec));
      if (!isWhole) throw new ProxyFailed("encoder");
      if (job.stop) throw new DOMException("Stopped", "AbortError");
      const file = await open.place.commit(entry.name);
      entry.file = file;
      entry.broken = undefined;
      entry.failures = 0;
      entry.made = result.timing && { seconds: result.sourceDuration, ...result.timing };
      entry.state = { kind: "ready" };
    } catch (error) {
      if (!whole) await growing?.abandon().catch(() => {});
      else await open.place.discard(entry.name).catch(() => {});
      const reason = failureOf(error);
      if (job.stop === "stopped") entry.state = { kind: "stopped" };
      else if (job.stop) entry.state = { kind: "waiting" };
      else {
        console.warn("A proxy could not be made", error);
        if (reason === "encoder") this.#noHardware = true;
        entry.failures += 1;
        entry.state =
          mayPass(reason) && entry.failures < TRIES
            ? { kind: "waiting" }
            : { kind: "failed", reason };
      }
    } finally {
      if (open.job === job) open.job = undefined;
      this.#changed();
      this.#pump(open);
    }
  }

  #followPlaying(): void {
    const playing = this.#options.playing();
    if (playing === this.#playing) return;
    this.#playing = playing;
    const work = this.#open?.job?.work;
    if (playing) work?.pause();
    else work?.resume();
    this.#changed();
    const open = this.#open;
    if (open && !playing) this.#pump(open);
  }

  #changed(): void {
    const open = this.#open;
    const entries = open ? [...open.entries.values()] : [];
    const job = open?.job;
    const states = new Map(entries.map((entry) => [entry.hash, entry.state]));
    const making =
      job && job.entry.state.kind === "making"
        ? { hash: job.entry.hash, percent: job.entry.state.percent }
        : undefined;
    const before = this.#snapshot;
    const snapshot: ProxySnapshot = {
      states,
      making,
      waiting: entries.filter(({ state }) => state.kind === "waiting").length,
      paused: making !== undefined && this.#playing,
      elsewhere: open?.elsewhere === true,
    };
    const isSame =
      before.making?.hash === snapshot.making?.hash &&
      before.making?.percent === snapshot.making?.percent &&
      before.waiting === snapshot.waiting &&
      before.paused === snapshot.paused &&
      before.elsewhere === snapshot.elsewhere &&
      before.states.size === states.size &&
      [...states].every(([hash, state]) => before.states.get(hash) === state);
    if (isSame) return;
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }
}
