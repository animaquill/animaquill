import { clipEnd, clipStart, sourceResourceOf, usesOf, type ProjectStore } from "@animaquill/core";
import {
  CloudSignedOut,
  LFS_LOOKUP_MOST,
  LfsRefused,
  type CloudLine,
  type DownloadedPiece,
  type DownloadStore,
  type LfsAccess,
  type LfsObjectState,
  type WriterClaim,
} from "@animaquill/host";
import { isSameHash } from "@animaquill/media";
import { lfsOidOf, toSeconds } from "@animaquill/schema";
import type { MissingFiles } from "../resources/missing-files.ts";
import { Emitter } from "../workbench/emitter.ts";
import { pageEnvironment, type UploadBlock, type UploadEnvironment } from "./uploads.ts";

/**
 * The files of assets of the open project that this computer does not have and that are in the
 * large file storage of its repository, downloaded through the platform (`LfsAccess.lookup` and
 * `piece`), see docs/design/asset-storage.md of AnimaQuill Cloud, 4.7. No DOM.
 *
 * - **Which:** what `MissingFiles` says can come from there ("lfs"), of the assets clips use. The
 *   others only once people ask for them (`download`, `downloadUnused`): GitHub counts what comes
 *   out of its storage against the person's traffic.
 * - **Nearest first:** by how far the clips that use each are from the playhead of the timeline
 *   shown, as it was when it last stood still for a moment. Each piece goes to whichever file is
 *   first then, so that one that comes first now goes ahead of the others at once.
 * - **A piece at a time** (`PIECE_MOST`, smaller on a slow line), each kept in this browser
 *   (`DownloadStore`) as it comes: a reload, or another window, goes on from where it got.
 * - **Checked before it goes anywhere:** once all of it is here, the file is read for its hash, and
 *   only the file of the asset's size and hash is written where it goes (`DownloadTarget`): the
 *   project folder, or this browser for a project that is only here. One that is not is downloaded
 *   again once, and then fails.
 * - **One window downloads** the files of a project (`DownloadStore.downloader`); the others show
 *   how it goes, and pass on what people do there.
 * - **What goes by itself:** no network, the platform busy, a file another computer is still
 *   uploading. What people have to do something about fails with a `DownloadProblem`.
 */

/** Files downloaded at the same time. */
export const DOWNLOADS_AT_ONCE = 2;
/** The largest piece, and the smallest one a slow line goes down to. */
export const PIECE_MOST = 16 * 1024 * 1024;
const PIECE_LEAST = 1024 * 1024;
/** A piece that took longer than this goes half as large next time, and one quicker than the other twice. */
const PIECE_SLOW_MS = 20_000;
const PIECE_QUICK_MS = 4000;
/** A piece that brought nothing for this long is given up, and goes smaller. */
const PIECE_STALL_MS = 30_000;
/** How often a file that another computer still uploads is asked about. */
const UPLOADING_EVERY_MS = 30_000;
/** How long to wait before trying again after no answer, at first and at most. */
const RETRY_FIRST_MS = 2000;
const RETRY_MOST_MS = 60_000;
/** How long the playhead stands still before the order goes by where it is. */
const SETTLE_MS = 500;
/** How often the other windows hear how it goes, at most. */
const TELL_EVERY_MS = 400;
/** Pieces of objects that no project here wants are kept this long, in case one does again. */
const KEEP_PIECES_MS = 7 * 24 * 3600_000;

/** Why a file did not come, for people to do something about. */
export type DownloadProblem =
  /** The storage does not have it. */
  | "missing"
  /** What came is not the file the asset says, or the storage has it in another size. */
  | "changed"
  /** The traffic of the account on GitHub is used up. */
  | "githubQuota"
  /** The repository of the project cannot be used now. */
  | "repository"
  | "signedOut"
  /** This browser has no room for it: `DownloadItem.need` says how much more it needs. */
  | "space"
  /** Another file is where it goes in the project folder. */
  | "occupied"
  /** The platform said no for a reason of its own. */
  | "refused";

export type DownloadPhase =
  | "queued"
  | "downloading"
  /** All of it is here, and is read for its hash. */
  | "checking"
  /** It goes where it belongs. */
  | "writing"
  /** It is here and checked, and waits for people to allow the project folder. */
  | "access"
  /** Another computer still puts it into the storage: it comes once it is there. */
  | "uploading"
  | "offline"
  | "busy"
  | "paused"
  | "failed"
  | "done"
  /** Something of the project keeps it, see `UploadBlock`. */
  | "blocked";

export interface DownloadItem {
  readonly asset: string;
  readonly name: string;
  readonly size: number;
  readonly hash: string;
  readonly phase: DownloadPhase;
  /** Bytes that are here. */
  readonly received: number;
  /** Bytes a second, while it comes. */
  readonly speed?: number;
  readonly problem?: DownloadProblem;
  /** For "space": bytes this browser needs more. */
  readonly need?: number;
  /** For "queued": how many go before it. */
  readonly ahead?: number;
  /** For "uploading": how far the other computer got. */
  readonly uploading?: { readonly received: number; readonly size: number };
  readonly doneAt?: number;
}

export interface DownloadsSnapshot {
  /** The open project, as this browser keeps it. */
  readonly key: string | undefined;
  /** Of the open project, nearest first, and then what came today. */
  readonly items: readonly DownloadItem[];
  /** Which window downloads them: this one, another one, or none yet. */
  readonly sender: "here" | "elsewhere" | "none";
  readonly blocked: UploadBlock | undefined;
  readonly paused: boolean;
  /** Files that can be downloaded and are not, as no clip uses them. */
  readonly unused: { readonly count: number; readonly bytes: number };
}

/** The open project, as the downloads need it. */
export interface DownloadProject {
  readonly key: string;
  readonly store: ProjectStore;
  /** Its id on the platform, where it is connected. */
  readonly project?: string;
  /** What keeps its files from coming now. */
  readonly blocked?: UploadBlock;
}

/** What writing a file where it goes came to. */
export type WriteResult = "written" | "access" | "occupied";

/** Where the files of the open project go: its folder, or this browser. */
export interface DownloadTarget {
  /** Whether what comes goes into this browser, which needs room for it twice for a while. */
  readonly inBrowser: boolean;
  write(
    asset: { readonly id: string; readonly path: string; readonly hash: string },
    file: Blob,
  ): Promise<WriteResult>;
}

/** Where the playhead is, as the order of the downloads goes by it. */
export interface Playhead {
  readonly timeline: string;
  readonly seconds: number;
  readonly playing: boolean;
}

export interface AssetDownloadsOptions {
  /** Where this browser keeps the pieces; without it, nothing is downloaded. */
  readonly store: DownloadStore | undefined;
  readonly lfs: () => LfsAccess | undefined;
  readonly project: () => DownloadProject | undefined;
  /** What the open project does not have here, see `MissingFileWatch`. */
  readonly missing: () => MissingFiles;
  readonly subscribeMissing: (listener: () => void) => () => void;
  readonly target: () => DownloadTarget | undefined;
  /** The hash of a file, as the format writes it. */
  readonly hash: (file: Blob, signal: AbortSignal) => Promise<string>;
  readonly playhead?: () => Playhead | undefined;
  readonly subscribePlayhead?: (listener: () => void) => () => void;
  /** How much room this browser has, and uses, in bytes; undefined where it does not say. */
  readonly estimate?: () => Promise<{ readonly quota: number; readonly usage: number } | undefined>;
  readonly environment?: UploadEnvironment;
}

/** A file that is to come, as the project says it. */
interface Wanted {
  readonly asset: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly hash: string;
  readonly oid: string;
  readonly used: boolean;
}

/** How a file that is to come goes here, which is not kept. */
interface Going {
  phase: DownloadPhase;
  received: number;
  speed?: number;
  problem?: DownloadProblem;
  need?: number;
  uploading?: { readonly received: number; readonly size: number };
  /** Not before then, in ms of the environment. */
  retryAt: number;
  /** How long the next wait is, after no answer. */
  backoff: number;
  /** Files that came and were not the file. */
  mismatches: number;
  /** All of it is here and was found to be the file: it only has to go where it belongs. */
  checked?: boolean;
  /** For the hash it is about: another hash of the asset is another file. */
  readonly hash: string;
}

/** What one window tells the others. */
type LineMessage =
  | { readonly t: "live"; readonly key: string; readonly items: readonly DownloadItem[] }
  | {
      readonly t: "do";
      readonly key: string;
      readonly what: "retry" | "unused" | "one";
      readonly asset?: string;
    };

const isLineMessage = (message: unknown): message is LineMessage => {
  const { t, key } = (message ?? {}) as { t?: unknown; key?: unknown };
  return (t === "live" || t === "do") && typeof key === "string";
};

/** Stopped on purpose. */
class Stopped extends Error {
  override readonly name = "Stopped";
}

const isNamed = (error: unknown, name: string) =>
  typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;

/**
 * The file of an object out of the pieces that are kept of it, from its start: what they have
 * together without a gap, whichever overlap, as a slower line can leave pieces of other sizes.
 */
export function assembled(
  pieces: readonly DownloadedPiece[],
  size: number,
): { readonly file: Blob; readonly bytes: number } {
  const parts: Blob[] = [];
  let at = 0;
  for (;;) {
    let best: DownloadedPiece | undefined;
    for (const piece of pieces)
      if (piece.start <= at && piece.start + piece.bytes.size > at)
        if (!best || piece.start + piece.bytes.size > best.start + best.bytes.size) best = piece;
    if (!best || at >= size) break;
    const end = Math.min(best.start + best.bytes.size, size);
    parts.push(best.bytes.slice(at - best.start, end - best.start));
    at = end;
  }
  return { file: new Blob(parts), bytes: at };
}

/**
 * How far from the playhead the clips that use an asset are, for the order: 0 for one under it,
 * seconds to the nearest one on the timeline shown, after that those that only other timelines use
 * (by their order), and last those no clip uses.
 */
export function distancesOf(
  store: ProjectStore,
  assets: readonly string[],
  playhead: Playhead | undefined,
): Map<string, number> {
  const state = store.getState();
  const wanted = new Set(assets);
  const distance = new Map<string, number>();
  const timelines = Object.keys(state.timelines);
  const OTHER = 1e9;
  timelines.forEach((id, index) => {
    const timeline = state.timelines[id];
    if (!timeline) return;
    const shown = id === playhead?.timeline;
    for (const clip of Object.values(timeline.clips)) {
      const used = sourceResourceOf(clip.source);
      if (used?.kind !== "asset" || !wanted.has(used.id)) continue;
      let far: number;
      if (shown && playhead) {
        const start = toSeconds(clipStart(clip));
        const end = toSeconds(clipEnd(clip));
        far =
          playhead.seconds < start
            ? start - playhead.seconds
            : playhead.seconds > end
              ? playhead.seconds - end
              : 0;
      } else far = OTHER + index;
      distance.set(used.id, Math.min(distance.get(used.id) ?? Infinity, far));
    }
  });
  for (const asset of assets)
    if (!distance.has(asset))
      distance.set(
        asset,
        usesOf(state, { kind: "asset", id: asset }).length > 0 ? OTHER * 2 : OTHER * 3,
      );
  return distance;
}

export class AssetDownloads {
  readonly #options: AssetDownloadsOptions;
  readonly #env: UploadEnvironment;
  readonly #emitter = new Emitter();
  #snapshot: DownloadsSnapshot = {
    key: undefined,
    items: [],
    sender: "none",
    blocked: undefined,
    paused: false,
    unused: { count: 0, bytes: 0 },
  };
  #key: string | undefined;
  #claim: WriterClaim | undefined;
  #waiting = false;
  #paused = false;
  #follow: AbortController | undefined;
  #line: CloudLine | undefined;
  readonly #stops: (() => void)[] = [];
  /** What is to come, by asset, and what could come but nobody asked for. */
  #wanted = new Map<string, Wanted>();
  #unused: Wanted[] = [];
  /** Assets people asked for that no clip uses. */
  readonly #asked = new Set<string>();
  readonly #going = new Map<string, Going>();
  /** What the platform said of each, by asset, until it is asked again. */
  readonly #looked = new Map<string, { readonly state: LfsObjectState; readonly at: number }>();
  #looking: Promise<void> | undefined;
  /** Files being worked on now, with what stops them. */
  readonly #active = new Map<string, AbortController>();
  /** What came while the project is open, for the panel. */
  readonly #done = new Map<string, DownloadItem>();
  /** How another window said its files go. */
  #heard: readonly DownloadItem[] = [];
  #piece = PIECE_MOST;
  #settled: Playhead | undefined;
  /** What is to come in its order, until that changes, see `#ordered`. */
  #order: Wanted[] | undefined;
  #settleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Stops waiting for the next file that waits for its time. */
  #wakeStop: AbortController | undefined;
  #told = 0;
  #tellLater: ReturnType<typeof setTimeout> | undefined;
  #tidied = false;

  constructor(options: AssetDownloadsOptions) {
    this.#options = options;
    this.#env = options.environment ?? pageEnvironment();
    this.#settled = options.playhead?.();
    this.#stops.push(this.#env.onWake(() => this.#nudge()));
    this.#stops.push(options.subscribeMissing(() => this.#rethink()));
    if (options.subscribePlayhead)
      this.#stops.push(options.subscribePlayhead(() => this.#playheadMoved()));
    const store = options.store;
    if (store)
      this.#stops.push(
        store.listen((key) => {
          if (key === this.#key) void this.#readPaused();
        }),
      );
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): DownloadsSnapshot => this.#snapshot;

  /** Whether downloads can be kept at all in this browser, with a platform that gives them. */
  get available(): boolean {
    const lfs = this.#options.lfs();
    return (
      this.#options.store !== undefined && lfs?.piece !== undefined && lfs.lookup !== undefined
    );
  }

  dispose(): void {
    void this.close();
    for (const stop of this.#stops.splice(0)) stop();
    clearTimeout(this.#settleTimer);
  }

  /** Follows the open project, as it changed, see `AssetUploads.follow`. */
  follow(): void {
    const project = this.#options.project();
    const key = project?.key;
    if (key !== this.#key) {
      void this.#stop();
      this.#key = key;
      if (key === undefined || !this.#options.store) return this.#publish();
      const follow = new AbortController();
      this.#follow = follow;
      const line = this.#options.store.line(key);
      this.#line = line;
      const stopListening = line?.listen((message) => this.#hear(message));
      follow.signal.addEventListener(
        "abort",
        () => {
          stopListening?.();
          line?.close();
        },
        { once: true },
      );
      this.#rethink();
      void this.#readPaused().then(() => this.#takeTurn(key, follow.signal));
      return;
    }
    this.#rethink();
  }

  /** Stops, as the project closes: what came so far is kept, and goes on next time. */
  async close(): Promise<void> {
    const stopped = this.#stop();
    this.#key = undefined;
    this.#publish();
    await stopped;
  }

  #stop(): Promise<void> {
    this.#follow?.abort(new Stopped());
    this.#follow = undefined;
    for (const stop of this.#active.values()) stop.abort(new Stopped());
    this.#active.clear();
    const claim = this.#claim;
    this.#claim = undefined;
    this.#waiting = false;
    this.#line = undefined;
    this.#wanted = new Map();
    this.#unused = [];
    this.#order = undefined;
    this.#asked.clear();
    this.#going.clear();
    this.#looked.clear();
    this.#done.clear();
    this.#heard = [];
    this.#paused = false;
    clearTimeout(this.#tellLater);
    this.#tellLater = undefined;
    this.#wakeStop?.abort(new Stopped());
    claim?.release();
    return Promise.resolve();
  }

  async #takeTurn(key: string, signal: AbortSignal): Promise<void> {
    const store = this.#options.store;
    if (!store) return;
    let claim: WriterClaim;
    try {
      claim = await store.downloader(key).claim({
        signal,
        onWaiting: () => {
          if (signal.aborted) return;
          this.#waiting = true;
          this.#publish();
        },
      });
    } catch {
      return;
    }
    if (signal.aborted || this.#key !== key) {
      claim.release();
      return;
    }
    this.#claim = claim;
    this.#waiting = false;
    this.#heard = [];
    void claim.lost.then(() => {
      if (this.#claim !== claim) return;
      this.#claim = undefined;
      for (const stop of this.#active.values()) stop.abort(new Stopped());
      this.#publish();
      if (this.#key === key && !signal.aborted) void this.#takeTurn(key, signal);
    });
    if (!this.#tidied) {
      this.#tidied = true;
      void this.#tidy();
    }
    this.#publish();
    this.#pump();
  }

  /** Pieces of objects nobody here wants any more, and that nothing touched for a week, go. */
  async #tidy(): Promise<void> {
    const store = this.#options.store;
    if (!store) return;
    try {
      const wanted = new Set([...this.#wanted.values(), ...this.#unused].map(({ oid }) => oid));
      const now = Date.now();
      for (const { oid, at } of await store.objects())
        if (!wanted.has(oid) && now - at > KEEP_PIECES_MS) await store.dropPieces(oid);
    } catch (error) {
      console.warn("What was downloaded before could not be looked through", error);
    }
  }

  async #readPaused(): Promise<void> {
    const store = this.#options.store;
    const key = this.#key;
    if (!store || key === undefined) return;
    const paused = await store.paused(key).catch(() => false);
    if (this.#key !== key) return;
    this.#paused = paused;
    if (paused) for (const stop of this.#active.values()) stop.abort(new Stopped());
    this.#publish();
    this.#pump();
  }

  #hear(message: unknown): void {
    if (!isLineMessage(message) || message.key !== this.#key) return;
    if (message.t === "live") {
      if (this.#claim) return;
      this.#heard = message.items;
      this.#publish();
      return;
    }
    if (!this.#claim) return;
    if (message.what === "retry") this.retry(message.asset);
    else if (message.what === "unused") this.downloadUnused();
    else if (message.asset !== undefined) this.download(message.asset);
  }

  #ask(what: "retry" | "unused" | "one", asset?: string): void {
    const key = this.#key;
    if (key === undefined) return;
    this.#line?.post({ t: "do", key, what, ...(asset !== undefined && { asset }) });
  }

  // What people do.

  /** Pauses or goes on, for the project, in every window. */
  async setPaused(paused: boolean): Promise<void> {
    const store = this.#options.store;
    const key = this.#key;
    if (!store || key === undefined) return;
    this.#paused = paused;
    this.#publish();
    await store.setPaused(key, paused);
  }

  /** Tries again what failed, or one file of it. */
  retry(asset?: string): void {
    if (!this.#claim) return this.#ask("retry", asset);
    for (const [id, going] of this.#going) {
      if (asset !== undefined && id !== asset) continue;
      if (going.phase !== "failed" && going.phase !== "access" && going.phase !== "uploading")
        continue;
      going.phase = "queued";
      going.retryAt = 0;
      going.backoff = RETRY_FIRST_MS;
      if (going.problem !== "changed") going.mismatches = 0;
      delete going.problem;
      delete going.need;
      this.#looked.delete(id);
    }
    this.#publish();
    this.#pump();
  }

  /** Tries again what waits for this: people did what it needed, such as allowing the folder. */
  retryAll(problems: readonly (DownloadProblem | "access")[]): void {
    const wanted = new Set<string>(problems);
    for (const [id, going] of this.#going)
      if (wanted.has(going.phase === "access" ? "access" : (going.problem ?? ""))) this.retry(id);
  }

  /** Downloads a file no clip uses, as people asked for it. */
  download(asset: string): void {
    if (!this.#claim) return this.#ask("one", asset);
    this.#asked.add(asset);
    this.#rethink();
  }

  /** Downloads all the files no clip uses. */
  downloadUnused(): void {
    if (!this.#claim) return this.#ask("unused");
    for (const { asset } of this.#unused) this.#asked.add(asset);
    this.#rethink();
  }

  // What is to come.

  /** Looks again at what the project lacks, and goes by it. */
  #rethink(): void {
    const project = this.#options.project();
    if (!project || project.key !== this.#key) return this.#publish();
    const state = project.store.getState();
    const wanted = new Map<string, Wanted>();
    const unused: Wanted[] = [];
    // A project of this computer alone, or a platform that gives no files: nothing comes.
    const none =
      !this.available || project.blocked === "notCloud" || project.blocked === "unsupported";
    for (const [id, file] of none ? [] : this.#options.missing()) {
      if (file.elsewhere !== "lfs") continue;
      const asset = state.assets?.[id];
      if (asset?.hash === undefined || asset.size === undefined) continue;
      const oid = lfsOidOf(asset.hash);
      if (oid === undefined) continue;
      const used = usesOf(state, { kind: "asset", id }).length > 0;
      const each: Wanted = {
        asset: id,
        name: asset.name ?? asset.path.split("/").at(-1) ?? asset.path,
        path: asset.path,
        size: asset.size,
        hash: asset.hash,
        oid,
        used,
      };
      if (used || this.#asked.has(id)) wanted.set(id, each);
      else unused.push(each);
    }
    // What is not to come any more stops: it is here, or it is another file now.
    for (const [id, stop] of this.#active) {
      const now = wanted.get(id);
      const going = this.#going.get(id);
      if (!now || (going && !isSameHash(going.hash, now.hash))) stop.abort(new Stopped());
    }
    for (const [id, going] of this.#going) {
      const now = wanted.get(id);
      if (!now || !isSameHash(going.hash, now.hash)) {
        this.#going.delete(id);
        this.#looked.delete(id);
      }
    }
    for (const each of wanted.values())
      if (!this.#going.has(each.asset))
        this.#going.set(each.asset, {
          phase: "queued",
          received: 0,
          retryAt: 0,
          backoff: RETRY_FIRST_MS,
          mismatches: 0,
          hash: each.hash,
        });
    this.#wanted = wanted;
    this.#unused = unused;
    this.#order = undefined;
    this.#publish();
    this.#pump();
  }

  #playheadMoved(): void {
    const now = this.#options.playhead?.();
    if (!now || now.playing) return;
    clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      const still = this.#options.playhead?.();
      if (!still || still.playing) return;
      const before = this.#settled;
      this.#settled = still;
      if (before?.timeline !== still.timeline || before.seconds !== still.seconds) {
        this.#order = undefined;
        this.#publish();
      }
    }, SETTLE_MS);
  }

  /**
   * What is to come, first what comes first: worked out again once what is to come, or where the
   * playhead stood still, changed, and not for every piece that comes.
   */
  #ordered(): Wanted[] {
    if (this.#order) return this.#order;
    const project = this.#options.project();
    const all = [...this.#wanted.values()];
    if (!project) return all;
    const distance = distancesOf(
      project.store,
      all.map(({ asset }) => asset),
      this.#settled ?? this.#options.playhead?.(),
    );
    this.#order = all.toSorted(
      (a, b) =>
        (distance.get(a.asset) ?? 0) - (distance.get(b.asset) ?? 0) ||
        a.size - b.size ||
        (a.asset < b.asset ? -1 : 1),
    );
    return this.#order;
  }

  // Getting them.

  /** Starts on what comes next, as many at once as go, where this window downloads. */
  #pump(): void {
    const project = this.#options.project();
    const lfs = this.#options.lfs();
    if (!this.#claim || !project || project.key !== this.#key || !lfs?.piece || !lfs.lookup) return;
    if (this.#paused || project.blocked !== undefined || project.project === undefined) return;
    const now = this.#env.now();
    let soonest = Infinity;
    for (const wanted of this.#ordered()) {
      if (this.#active.size >= DOWNLOADS_AT_ONCE) break;
      if (this.#active.has(wanted.asset)) continue;
      const going = this.#going.get(wanted.asset);
      if (
        !going ||
        !["queued", "offline", "busy", "uploading", "downloading"].includes(going.phase)
      )
        continue;
      if (going.retryAt > now) {
        soonest = Math.min(soonest, going.retryAt);
        continue;
      }
      const stop = new AbortController();
      this.#active.set(wanted.asset, stop);
      void this.#step(wanted, going, project.project, lfs, stop.signal)
        .catch((error: unknown) => {
          if (error instanceof Stopped || stop.signal.aborted) {
            // Stopped halfway: from where it got, next time.
            if (going.phase === "downloading" || going.phase === "checking") going.phase = "queued";
            return;
          }
          console.warn("A file could not be downloaded", error);
          this.#fail(going, "refused");
        })
        .finally(() => {
          if (this.#active.get(wanted.asset) === stop) this.#active.delete(wanted.asset);
          this.#publish();
          this.#pump();
        });
    }
    this.#wakeStop?.abort(new Stopped());
    this.#wakeStop = undefined;
    if (soonest < Infinity) {
      const wake = new AbortController();
      this.#wakeStop = wake;
      this.#env.sleep(Math.max(0, soonest - now) + 5, wake.signal).then(
        () => {
          if (this.#wakeStop === wake) this.#wakeStop = undefined;
          this.#pump();
        },
        () => {},
      );
    }
  }

  /** Whatever waits for the network tries now. */
  #nudge(): void {
    for (const going of this.#going.values())
      if (going.phase === "offline" || going.phase === "busy") going.retryAt = 0;
    this.#pump();
  }

  #fail(going: Going, problem: DownloadProblem, need?: number): void {
    going.phase = "failed";
    going.problem = problem;
    delete going.speed;
    if (need !== undefined) going.need = need;
  }

  /** Waits a while before the next try, longer each time there is no answer. */
  #later(going: Going, phase: "offline" | "busy", ms?: number): void {
    going.phase = phase;
    delete going.speed;
    going.retryAt = this.#env.now() + (ms ?? going.backoff);
    if (ms === undefined) going.backoff = Math.min(going.backoff * 2, RETRY_MOST_MS);
  }

  /** What a refusal of the platform comes to for a file. */
  #refused(going: Going, error: unknown): void {
    if (error instanceof CloudSignedOut) return this.#fail(going, "signedOut");
    if (!(error instanceof LfsRefused)) throw error;
    switch (error.code) {
      case "busy":
        return this.#later(going, "busy", (error.retryAfter ?? 5) * 1000);
      case "unavailable":
      case "slow":
        return this.#later(going, "offline");
      case "missing":
        return this.#fail(going, "missing");
      case "changed":
        return this.#fail(going, "changed");
      case "githubQuota":
        return this.#fail(going, "githubQuota");
      case "gone":
      case "notLinked":
      case "notFound":
        return this.#fail(going, "repository");
      default:
        return this.#fail(going, "refused");
    }
  }

  /** Asks the platform about what is to come and was not asked about yet, 100 at a time. */
  async #lookUp(project: string, lfs: LfsAccess, signal: AbortSignal): Promise<void> {
    if (this.#looking) return this.#looking;
    const now = this.#env.now();
    const due = [...this.#wanted.values()].filter(({ asset }) => {
      const looked = this.#looked.get(asset);
      if (!looked) return true;
      return looked.state.state === "uploading" && now - looked.at >= UPLOADING_EVERY_MS;
    });
    const asking = (async () => {
      for (let at = 0; at < due.length; at += LFS_LOOKUP_MOST) {
        const batch = due.slice(at, at + LFS_LOOKUP_MOST);
        const states = await (lfs.lookup as NonNullable<LfsAccess["lookup"]>)(
          project,
          batch.map(({ oid, size }) => ({ oid, size })),
          { signal },
        );
        batch.forEach(({ asset }, index) => {
          const state = states[index];
          if (state) this.#looked.set(asset, { state, at: this.#env.now() });
        });
      }
    })();
    this.#looking = asking;
    try {
      await asking;
    } finally {
      this.#looking = undefined;
    }
  }

  /** One step of a file: what the platform says of it, a piece of it, or once all of it is here, the rest. */
  async #step(
    wanted: Wanted,
    going: Going,
    project: string,
    lfs: LfsAccess,
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.#options.store as DownloadStore;
    try {
      const looked = this.#looked.get(wanted.asset);
      if (
        !looked ||
        (looked.state.state === "uploading" && this.#env.now() - looked.at >= UPLOADING_EVERY_MS)
      )
        await this.#lookUp(project, lfs, signal);
    } catch (error) {
      if (signal.aborted) throw new Stopped();
      return this.#refused(going, error);
    }
    const state = this.#looked.get(wanted.asset)?.state;
    if (!state || state.state === "unavailable") return this.#later(going, "offline");
    if (state.state === "missing") return this.#fail(going, "missing");
    if (state.state === "changed") return this.#fail(going, "changed");
    if (state.state === "uploading") {
      going.phase = "uploading";
      going.uploading = { received: state.received, size: state.size };
      going.retryAt = this.#env.now() + UPLOADING_EVERY_MS;
      return;
    }
    delete going.uploading;
    const pieces = await store.pieces(wanted.oid);
    const { bytes } = assembled(pieces, wanted.size);
    going.received = bytes;
    if (bytes >= wanted.size) return this.#finish(wanted, going, pieces, signal);
    if (going.phase !== "downloading") {
      // Room for what is still to come, before any of it does.
      const target = this.#options.target();
      const room = await this.#options.estimate?.().catch(() => undefined);
      const need = (wanted.size - bytes) * (target?.inBrowser ? 2 : 1);
      if (room && room.quota - room.usage < need)
        return this.#fail(going, "space", need - (room.quota - room.usage));
    }
    going.phase = "downloading";
    delete going.problem;
    this.#publish();
    const end = Math.min(bytes + this.#piece, wanted.size) - 1;
    const began = this.#env.now();
    const stalled = new AbortController();
    let stallTimer = setTimeout(() => stalled.abort(), PIECE_STALL_MS);
    let piece: DownloadedPiece;
    try {
      piece = await (lfs.piece as NonNullable<LfsAccess["piece"]>)(
        project,
        { oid: wanted.oid, size: wanted.size },
        bytes,
        end,
        {
          signal: AbortSignal.any([signal, stalled.signal]),
          onBytes: (got) => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => stalled.abort(), PIECE_STALL_MS);
            const took = Math.max(1, this.#env.now() - began);
            going.received = bytes + got;
            going.speed = Math.round((got / took) * 1000);
            this.#publish();
          },
        },
      );
    } catch (error) {
      if (signal.aborted) throw new Stopped();
      if (stalled.signal.aborted || this.#env.now() - began > PIECE_SLOW_MS)
        this.#piece = Math.max(PIECE_LEAST, Math.floor(this.#piece / 2));
      if (stalled.signal.aborted) return this.#later(going, "offline", 0);
      return this.#refused(going, error);
    } finally {
      clearTimeout(stallTimer);
    }
    const took = this.#env.now() - began;
    if (took > PIECE_SLOW_MS) this.#piece = Math.max(PIECE_LEAST, Math.floor(this.#piece / 2));
    else if (took < PIECE_QUICK_MS && piece.bytes.size >= this.#piece)
      this.#piece = Math.min(PIECE_MOST, this.#piece * 2);
    if (piece.bytes.size > 0) {
      try {
        await store.putPiece(wanted.oid, piece.start, piece.bytes);
      } catch (error) {
        if (isNamed(error, "QuotaExceededError"))
          return this.#fail(going, "space", piece.bytes.size);
        throw error;
      }
    }
    going.received = bytes + piece.bytes.size;
    going.backoff = RETRY_FIRST_MS;
  }

  /** All of it is here: checked, and put where it goes. */
  async #finish(
    wanted: Wanted,
    going: Going,
    pieces: readonly DownloadedPiece[],
    signal: AbortSignal,
  ): Promise<void> {
    const store = this.#options.store as DownloadStore;
    const target = this.#options.target();
    if (!target) return this.#later(going, "offline");
    going.phase = "checking";
    delete going.speed;
    this.#publish();
    const { file } = assembled(pieces, wanted.size);
    const hash = going.checked ? wanted.hash : await this.#options.hash(file, signal);
    if (signal.aborted) throw new Stopped();
    if (file.size !== wanted.size || !isSameHash(hash, wanted.hash)) {
      going.checked = false;
      // Not the file: what came goes, and it comes once more before it fails.
      await store.dropPieces(wanted.oid);
      going.received = 0;
      going.mismatches += 1;
      if (going.mismatches >= 2) return this.#fail(going, "changed");
      going.phase = "queued";
      return;
    }
    going.checked = true;
    going.phase = "writing";
    this.#publish();
    const written = await target.write(
      { id: wanted.asset, path: wanted.path, hash: wanted.hash },
      file,
    );
    if (written === "access") {
      going.phase = "access";
      return;
    }
    if (written === "occupied") return this.#fail(going, "occupied");
    await store.dropPieces(wanted.oid).catch(() => {});
    going.phase = "done";
    this.#done.set(wanted.asset, {
      asset: wanted.asset,
      name: wanted.name,
      size: wanted.size,
      hash: wanted.hash,
      phase: "done",
      received: wanted.size,
      doneAt: Date.now(),
    });
  }

  // What people see.

  #publish(): void {
    const blocked = this.#key === undefined ? undefined : this.#options.project()?.blocked;
    let items: DownloadItem[];
    if (!this.#claim && this.#heard.length > 0) items = [...this.#heard];
    else {
      items = [];
      let ahead = 0;
      for (const wanted of this.#ordered()) {
        const going = this.#going.get(wanted.asset);
        if (!going || going.phase === "done") continue;
        const phase: DownloadPhase =
          going.phase === "failed" || going.phase === "access"
            ? going.phase
            : this.#paused
              ? "paused"
              : blocked !== undefined
                ? "blocked"
                : going.phase;
        items.push({
          asset: wanted.asset,
          name: wanted.name,
          size: wanted.size,
          hash: wanted.hash,
          phase,
          received: going.received,
          ...(going.speed !== undefined && phase === "downloading" && { speed: going.speed }),
          ...(going.problem !== undefined && phase === "failed" && { problem: going.problem }),
          ...(going.need !== undefined && phase === "failed" && { need: going.need }),
          ...(phase === "queued" && { ahead }),
          ...(going.uploading && phase === "uploading" && { uploading: going.uploading }),
        });
        if (phase === "queued") ahead += 1;
      }
      for (const done of this.#done.values())
        if (!items.some(({ asset }) => asset === done.asset)) items.push(done);
    }
    this.#snapshot = {
      key: this.#key,
      items,
      sender: this.#claim ? "here" : this.#waiting ? "elsewhere" : "none",
      blocked,
      paused: this.#paused,
      unused: {
        count: this.#unused.length,
        bytes: this.#unused.reduce((all, { size }) => all + size, 0),
      },
    };
    this.#emitter.emit();
    this.#tell();
  }

  #tell(now = false): void {
    const key = this.#key;
    if (!this.#claim || key === undefined || !this.#line) return;
    const wait = this.#told + TELL_EVERY_MS - this.#env.now();
    if (wait > 0 && !now) {
      this.#tellLater ??= setTimeout(
        () => {
          this.#tellLater = undefined;
          this.#tell(true);
        },
        Math.min(wait, TELL_EVERY_MS),
      );
      return;
    }
    this.#told = this.#env.now();
    this.#line.post({ t: "live", key, items: this.#snapshot.items } satisfies LineMessage);
  }
}

/** What the files that are to come add up to, for the status bar and the panel. */
export function downloadTotals(snapshot: DownloadsSnapshot): {
  readonly count: number;
  readonly bytes: number;
  readonly received: number;
  readonly percent: number;
  readonly speed: number;
  readonly failed: number;
  /** Failed for something people have to do, or waiting for them to allow the folder. */
  readonly needsPeople: boolean;
} {
  const going = snapshot.items.filter(({ phase }) => phase !== "done");
  const bytes = going.reduce((all, { size }) => all + size, 0);
  const received = going.reduce((all, { received: got, size }) => all + Math.min(got, size), 0);
  const failed = going.filter(({ phase }) => phase === "failed").length;
  return {
    count: going.length,
    bytes,
    received,
    percent: bytes > 0 ? Math.floor((received / bytes) * 100) : 100,
    speed: going.reduce((all, { speed }) => all + (speed ?? 0), 0),
    failed,
    needsPeople: going.some(({ phase }) => phase === "failed" || phase === "access"),
  };
}

/**
 * All of the file of an object at once, out of the large file storage of a project's repository,
 * for what cannot wait for the queue, as a copy of the project into a folder that does not stay
 * with the platform (docs/design/start-and-cloud.md of AnimaQuill Cloud, 4.3): from what this
 * browser kept of it, piece by piece, each kept as it comes. Resolves to the file once it is all
 * here and is the file of this hash, which stays kept until `store.dropPieces`; to undefined where
 * it cannot come, or is not that file.
 */
export async function downloadWhole(
  lfs: LfsAccess,
  store: DownloadStore,
  project: string,
  file: { readonly hash: string; readonly size: number },
  hash: (file: Blob, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<Blob | undefined> {
  const oid = lfsOidOf(file.hash);
  if (oid === undefined || !lfs.piece) return undefined;
  for (let tries = 0; tries < 5;) {
    signal.throwIfAborted();
    const { file: whole, bytes } = assembled(await store.pieces(oid), file.size);
    if (bytes >= file.size) {
      if (isSameHash(await hash(whole, signal), file.hash)) return whole;
      await store.dropPieces(oid);
      return undefined;
    }
    try {
      const piece = await lfs.piece(
        project,
        { oid, size: file.size },
        bytes,
        Math.min(bytes + PIECE_MOST, file.size) - 1,
        { signal },
      );
      if (piece.bytes.size === 0) tries += 1;
      else await store.putPiece(oid, piece.start, piece.bytes);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof LfsRefused && (error.code === "unavailable" || error.code === "busy")) {
        tries += 1;
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}
