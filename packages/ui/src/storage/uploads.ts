import { STORAGE, placedAsset, type Here, type ProjectStore } from "@animaquill/core";
import {
  CloudSignedOut,
  LfsRefused,
  type CloudLine,
  type LfsAccess,
  type LfsUpload,
  type UploadRecord,
  type UploadStore,
  type WriterClaim,
} from "@animaquill/host";
import { isSameHash } from "@animaquill/media";
import { lfsOidOf } from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The files of assets on their way into the large file storage of the repository of the open
 * project (docs/design/asset-storage.md of AnimaQuill Cloud, 4.1 to 4.3), through the platform
 * (`LfsAccess`). No DOM.
 *
 * - **Only once it is there.** What an asset says of where its file is (`asset.setStorage`, from
 *   `STORAGE`) changes only once the platform says the storage has the file ("done", or "present"),
 *   for the content the asset has then: never before, and never for another file of it.
 * - **What is asked for is kept** in this browser (`UploadStore`), with how far it got: closing the
 *   project stops it, opening it again goes on, in any window. Paused, it stays paused.
 * - **One window sends** the files of a project (`UploadStore.uploader`); the others show how it goes
 *   (`CloudLine`) and change what is kept, which the one that sends follows.
 * - **The file is checked** before it is sent: its size and hash as the asset says (`UploadFiles`),
 *   and the platform reads it through for its hash itself; one that changed meanwhile fails as
 *   "changed", as does one the storage has in another size.
 * - **Pieces** go one after the other, three files at a time (the platform takes three pieces of a
 *   person at a time), each piece as large as goes through in about `PIECE_TARGET_MS`: halved after
 *   "slow", after a piece that got no answer for `PIECE_GIVE_UP_MS`, and after one that failed late.
 * - **What goes by itself:** no network, the platform busy or away, an upload that expired. What
 *   people have to do something about fails with an `UploadProblem`, and waits for them.
 */

/** The largest file the large file storage of GitHub takes, as far as is known (4.4). */
export const LFS_FILE_MOST = 2 * 1024 ** 3;
/** Files sent at the same time. */
export const FILES_AT_ONCE = 3;
/** How long a piece should take. */
const PIECE_TARGET_MS = 7000;
/** A piece that got no answer for this long is given up and sent smaller: the platform waits a minute. */
const PIECE_GIVE_UP_MS = 55_000;
/** A piece that failed after this long is sent smaller next time. */
const PIECE_LATE_MS = 20_000;
/** The first piece of a window, before anything is known of the line. */
const FIRST_PIECE = 1024 * 1024;
/** Pieces are multiples of this, which the platform's smallest piece is too. */
const PIECE_STEP = 64 * 1024;
/** How often the platform is asked about a file that is all there, at first and at most. */
const POLL_FIRST_MS = 1500;
const POLL_MOST_MS = 10_000;
/** How long to wait before trying again after no answer, at first and at most. */
const RETRY_FIRST_MS = 2000;
const RETRY_MOST_MS = 60_000;
/** How often the other windows hear how it goes, at most. */
const TELL_EVERY_MS = 400;

/** Why a file did not get there, for people to do something about. */
export type UploadProblem =
  /** The large file storage of the account has no room left. */
  | "githubQuota"
  /** The person never said they know what putting files there means, which the platform asks. */
  | "notAcknowledged"
  /** Larger than the storage takes. */
  | "tooLarge"
  /** The file is not the one the asset says any more, as it changed while it was sent. */
  | "changed"
  /** The folder of the project may not be read now: people have to allow it again. */
  | "access"
  /** The file is not on this computer. */
  | "missing"
  /** Nobody is signed in. */
  | "signedOut"
  /** The storage, or the platform, said no for a reason of its own. */
  | "refused";

/**
 * What keeps the files of the open project from going anywhere now, which nobody fails for: it is
 * not connected to the platform ("notCloud"), connecting it is not finished ("notMade"), it has no
 * repository ("noRepository"), or its repository cannot be used now ("repository"); nobody is
 * signed in ("signedOut"); or the platform takes no files ("unsupported").
 */
export type UploadBlock =
  "notCloud" | "notMade" | "noRepository" | "repository" | "signedOut" | "unsupported";

/** How a file on its way goes, as people see it. */
export type UploadPhase =
  /** Waiting for its turn. */
  | "queued"
  /** Its file is looked at, before it is sent. */
  | "reading"
  | "sending"
  /** All of it is there, and the platform reads it through for its hash. */
  | "checking"
  /** The platform puts it into the storage. */
  | "pushing"
  | "done"
  | "paused"
  | "failed"
  /** No answer: it goes on once there is one. */
  | "offline"
  /** The platform has no room for it now: it goes on in a moment. */
  | "busy"
  /** Something of the project keeps it, see `UploadBlock`. */
  | "blocked";

export interface UploadItem {
  readonly asset: string;
  readonly name: string;
  readonly size: number;
  readonly hash: string;
  readonly phase: UploadPhase;
  /** Bytes the platform has. */
  readonly received: number;
  /** Bytes a second, while it is sent. */
  readonly speed?: number;
  /** For "busy": the person has as many files on their way as the platform takes. */
  readonly full?: boolean;
  readonly problem?: UploadProblem;
  /** For "queued": how many go before it. */
  readonly ahead?: number;
  /** Another file of an asset whose file was there before. */
  readonly replaced?: boolean;
  readonly at: number;
  readonly doneAt?: number;
}

export interface UploadsSnapshot {
  /** The open project, as this browser keeps it. */
  readonly key: string | undefined;
  /** Of the open project, in the order they were asked for. */
  readonly items: readonly UploadItem[];
  /** Which window sends them: this one, another one, or none yet. */
  readonly sender: "here" | "elsewhere" | "none";
  readonly blocked: UploadBlock | undefined;
}

/** The open project, as the queue needs it, see `AssetUploads`. */
export interface UploadProject {
  readonly key: string;
  readonly store: ProjectStore;
  /** Its id on the platform, where it is connected. */
  readonly project?: string;
  /** What keeps its files from going anywhere now. */
  readonly blocked?: UploadBlock;
}

/** What the file of an asset is on this computer, see `UploadFiles`. */
export type FileFound =
  | { readonly kind: "there"; readonly file: Blob }
  | { readonly kind: "missing" | "changed" | "access" }
  /** It cannot be read now, as while another program holds on to it: it is looked at again. */
  | { readonly kind: "unknown" };

/** Where the files of the open project are read from. */
export interface UploadFiles {
  /**
   * The file of an asset, as long as it is the one of this hash and size: "changed" where it is
   * another one now. `again`: the file changed or could not be read since it was given out, as
   * after a NotReadableError.
   */
  read(
    asset: string,
    file: { readonly hash: string; readonly size: number },
    again?: boolean,
  ): Promise<FileFound>;
}

/** The time, waiting, and the network, as the page has them: in tests, as a test says. */
export interface UploadEnvironment {
  readonly now: () => number;
  /** Waits, or rejects with the reason of the signal once it aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Calls back once the network may be back, as when the page comes to the front: try now. */
  readonly onWake: (listener: () => void) => () => void;
}

export const pageEnvironment = (): UploadEnvironment => ({
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  onWake(listener) {
    if (typeof window === "undefined") return () => {};
    const onVisible = () => {
      if (document.visibilityState === "visible") listener();
    };
    window.addEventListener("online", listener);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", listener);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },
});

export interface AssetUploadsOptions {
  /** Where this browser keeps them; without it, nothing is sent. */
  readonly store: UploadStore | undefined;
  /** The platform's side, where there is one. */
  readonly lfs: () => LfsAccess | undefined;
  /** The open project, as it is now: undefined for none. */
  readonly project: () => UploadProject | undefined;
  readonly files: () => UploadFiles | undefined;
  /** Where the open project is, as far as places go, see `Here`: undefined for anywhere. */
  readonly here?: () => Here | undefined;
  readonly environment?: UploadEnvironment;
  /** All of what was asked for of a project got there: how many. */
  readonly onAllDone?: (count: number) => void;
  /** A file failed for something people have to do. */
  readonly onFailed?: (item: UploadItem) => void;
}

/** What one window tells the others of how the files it sends go. */
interface LiveMessage {
  readonly t: "live";
  readonly key: string;
  readonly live: readonly (readonly [string, Live])[];
}

/** How a file that is being sent goes, which is not kept. */
interface Live {
  readonly phase: Extract<
    UploadPhase,
    "reading" | "sending" | "checking" | "pushing" | "offline" | "busy"
  >;
  readonly received: number;
  readonly speed?: number;
  readonly full?: boolean;
}

const isLiveMessage = (message: unknown): message is LiveMessage =>
  typeof message === "object" &&
  message !== null &&
  (message as { t?: unknown }).t === "live" &&
  typeof (message as { key?: unknown }).key === "string" &&
  Array.isArray((message as { live?: unknown }).live);

/** Stopped on purpose: what is being sent stops, and nothing is written of it. */
class Stopped extends Error {
  override readonly name = "Stopped";
}

/** A file failed for something people have to do. */
class Failed extends Error {
  override readonly name = "Failed";
  readonly problem: UploadProblem;
  constructor(problem: UploadProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** A failed file again, from the start of what the platform holds of it: it is asked anew. */
const anew = ({
  problem: _problem,
  upload: _upload,
  received: _received,
  ...kept
}: UploadRecord): UploadRecord | undefined =>
  kept.state === "failed" ? { ...kept, state: "waiting" } : undefined;

/** What a failure the platform said comes to. */
const problemOf = (error: string | undefined): UploadProblem | "again" | "repository" => {
  switch (error) {
    case "changed":
    case "githubQuota":
    case "tooLarge":
      return error;
    case "gone":
      return "repository";
    // What the platform had of it went, or it was over: from the start.
    case "lost":
    case undefined:
      return "again";
    default:
      return "refused";
  }
};

const isNamed = (error: unknown, name: string) =>
  typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;

/** The hash of a file as Git LFS names it; undefined for one that is none. */
const oidOf = (hash: string) => lfsOidOf(hash);

/** A file being sent here, and what stops it. */
interface Running {
  readonly hash: string;
  readonly stop: AbortController;
  readonly done: Promise<void>;
}

export class AssetUploads {
  readonly #options: AssetUploadsOptions;
  readonly #env: UploadEnvironment;
  readonly #emitter = new Emitter();
  #snapshot: UploadsSnapshot = { key: undefined, items: [], sender: "none", blocked: undefined };
  /** The project this follows, as it was when it began to. */
  #key: string | undefined;
  #records: readonly UploadRecord[] = [];
  /** How the files this window sends go. */
  readonly #live = new Map<string, Live>();
  /** How the files another window sends go, as it said last. */
  #heard = new Map<string, Live>();
  readonly #running = new Map<string, Running>();
  #claim: WriterClaim | undefined;
  /** Another window has the turn, and this one waits for it. */
  #waiting = false;
  /** The platform is being told what people gave up. */
  #telling = false;
  /** Stops waiting for the turn, and everything that goes on for the project. */
  #follow: AbortController | undefined;
  #line: CloudLine | undefined;
  readonly #stops: (() => void)[] = [];
  /** How large a piece goes through in about `PIECE_TARGET_MS`, as the last ones went. */
  #piece = FIRST_PIECE;
  /** Wakes up whatever waits for the network, or for the next turn. */
  #wake: AbortController = new AbortController();
  #told = 0;
  #tellLater: ReturnType<typeof setTimeout> | undefined;
  /** How many of the project got there since nothing was left: for "all of them are there". */
  #doneInRound = 0;

  constructor(options: AssetUploadsOptions) {
    this.#options = options;
    this.#env = options.environment ?? pageEnvironment();
    this.#stops.push(this.#env.onWake(() => this.#nudge()));
    const store = options.store;
    if (store)
      this.#stops.push(
        store.listen((key) => {
          if (key === this.#key) void this.#reload();
          if (this.#unfinishedRead) void this.#readUnfinished();
        }),
      );
  }

  readonly #unfinishedEmitter = new Emitter();
  #unfinished: ReadonlyMap<string, number> = new Map();
  #unfinishedRead = false;

  /**
   * How many files of each project of this browser are not there yet, by its key in this browser
   * and by its id on the platform, for the start page: read once something wants it, and again
   * as they change, in any window.
   */
  subscribeUnfinished = (listener: () => void): (() => void) => {
    if (!this.#unfinishedRead) {
      this.#unfinishedRead = true;
      void this.#readUnfinished();
    }
    return this.#unfinishedEmitter.subscribe(listener);
  };
  getUnfinished = (): ReadonlyMap<string, number> => this.#unfinished;

  async #readUnfinished(): Promise<void> {
    const store = this.#options.store;
    if (!store) return;
    try {
      const records = await store.list();
      const counts = unfinishedByProject(records);
      for (const record of records)
        if (record.state !== "done" && record.state !== "cancelling")
          counts.set(record.project, (counts.get(record.project) ?? 0) + 1);
      this.#unfinished = counts;
      this.#unfinishedEmitter.emit();
    } catch (error) {
      console.warn("The uploads of this browser could not be read", error);
    }
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): UploadsSnapshot => this.#snapshot;

  /** Whether uploads can be kept at all in this browser, with a platform that takes them. */
  get available(): boolean {
    return this.#options.store !== undefined && this.#options.lfs() !== undefined;
  }

  /** Lets go of everything, as the page goes. */
  dispose(): void {
    void this.close();
    for (const stop of this.#stops.splice(0)) stop();
  }

  /**
   * Follows the open project, as it changed: begins to send its files where this window may, or
   * hears how another window sends them. Nothing changes where it is the same project.
   */
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
      const stopListening = line?.listen((message) => {
        if (!isLiveMessage(message) || message.key !== this.#key || this.#claim) return;
        this.#heard = new Map(message.live);
        this.#publish();
      });
      follow.signal.addEventListener(
        "abort",
        () => {
          stopListening?.();
          line?.close?.();
        },
        { once: true },
      );
      const store = project?.store;
      if (store) {
        let looking = false;
        const stopWatching = store.subscribe(() => {
          if (looking) return;
          looking = true;
          queueMicrotask(() => {
            looking = false;
            if (!follow.signal.aborted) this.#lookForReplaced();
          });
        });
        follow.signal.addEventListener("abort", stopWatching, { once: true });
      }
      void this.#reload().then(() => this.#takeTurn(key, follow.signal));
      return;
    }
    // The same project: what keeps it may have changed.
    this.#publish();
    this.#nudge();
  }

  /**
   * Stops sending, as the project closes: what is on its way stays as it is, and goes on once the
   * project is open again. Resolves once nothing goes on any more.
   */
  async close(): Promise<void> {
    const stopped = this.#stop();
    this.#key = undefined;
    this.#publish();
    await stopped;
  }

  /**
   * Stops what goes on for the project this follows, and forgets it: the turn goes to another
   * window once what was being sent stopped.
   */
  #stop(): Promise<void> {
    this.#follow?.abort(new Stopped());
    this.#follow = undefined;
    const running = [...this.#running.values()];
    this.#running.clear();
    for (const each of running) each.stop.abort(new Stopped());
    const claim = this.#claim;
    this.#claim = undefined;
    this.#waiting = false;
    this.#line = undefined;
    this.#live.clear();
    this.#heard = new Map();
    this.#records = [];
    clearTimeout(this.#tellLater);
    this.#tellLater = undefined;
    this.#doneInRound = 0;
    return Promise.all(running.map(({ done }) => done.catch(() => {}))).then(() =>
      claim?.release(),
    );
  }

  /** Waits for this window's turn to send the files of the project, and sends them then. */
  async #takeTurn(key: string, signal: AbortSignal): Promise<void> {
    const store = this.#options.store;
    if (!store) return;
    let claim: WriterClaim;
    try {
      claim = await store.uploader(key).claim({
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
    this.#heard = new Map();
    void claim.lost.then(() => {
      if (this.#claim !== claim) return;
      // Another window took over: it goes on from what is kept.
      this.#claim = undefined;
      for (const each of this.#running.values()) each.stop.abort(new Stopped());
      this.#publish();
      if (this.#key === key && !signal.aborted) void this.#takeTurn(key, signal);
    });
    await this.#reload();
    this.#lookForReplaced();
    this.#pump();
  }

  /** Reads what is kept of the open project again, and goes by it. */
  async #reload(): Promise<void> {
    const key = this.#key;
    const store = this.#options.store;
    if (key === undefined || !store) return;
    let records: readonly UploadRecord[];
    try {
      records = await store.list(key);
    } catch (error) {
      console.warn("The uploads of the project could not be read", error);
      return;
    }
    if (this.#key !== key) return;
    this.#records = records.toSorted((a, b) => a.at - b.at || (a.asset < b.asset ? -1 : 1));
    // What people paused, cancelled or changed elsewhere stops here.
    for (const [asset, running] of this.#running) {
      const record = this.#records.find((each) => each.asset === asset);
      if (!record || record.state !== "waiting" || record.hash !== running.hash)
        running.stop.abort(new Stopped());
    }
    this.#publish();
    this.#pump();
  }

  /**
   * Another file of an asset whose file was in the storage goes where that one went, by itself
   * (4.6): as people chose another file for it, or the file changed and they took it as it is. Only
   * the window that sends looks, so that it is asked for once.
   */
  #lookForReplaced(): void {
    const project = this.#options.project();
    if (!this.#claim || !project || project.key !== this.#key || project.project === undefined)
      return;
    const state = project.store.getState();
    const wanted: string[] = [];
    for (const [id, place] of Object.entries(state.places ?? {})) {
      if (place?.storage !== "lfs") continue;
      const asset = state.assets?.[id];
      if (asset?.hash === undefined || isSameHash(place.hash, asset.hash)) continue;
      const kept = this.#records.find((record) => record.asset === id);
      if (kept && isSameHash(kept.hash, asset.hash)) continue;
      wanted.push(id);
    }
    if (wanted.length > 0) void this.add(wanted, { replaced: true });
    // An asset that went away: its file goes nowhere any more.
    const gone = this.#records.filter(
      ({ asset, state: kept }) =>
        kept !== "done" && kept !== "cancelling" && !state.assets?.[asset],
    );
    if (gone.length > 0) void this.#giveUp(gone.map(({ asset }) => asset));
  }

  /** Starts what waits, as many as go at once, where this window sends. */
  #pump(): void {
    const project = this.#options.project();
    const lfs = this.#options.lfs();
    if (!this.#claim || !project || project.key !== this.#key || !lfs) return;
    if (project.blocked !== undefined || project.project === undefined) return;
    const cancelling = this.#records.filter(({ state }) => state === "cancelling");
    if (cancelling.length > 0 && !this.#telling) {
      this.#telling = true;
      void this.#tellCancelled(cancelling).finally(() => {
        this.#telling = false;
      });
    }
    for (const record of this.#records) {
      if (this.#running.size >= FILES_AT_ONCE) break;
      if (record.state !== "waiting" || this.#running.has(record.asset)) continue;
      const stop = new AbortController();
      const follow = this.#follow?.signal;
      if (follow) follow.addEventListener("abort", () => stop.abort(follow.reason), { once: true });
      const running: { hash: string; stop: AbortController; done: Promise<void> } = {
        hash: record.hash,
        stop,
        done: Promise.resolve(),
      };
      this.#running.set(record.asset, running);
      running.done = this.#send(record, project, lfs, stop.signal)
        .catch((error: unknown) => {
          if (error instanceof Stopped || stop.signal.aborted) return;
          console.warn("A file could not be sent", error);
        })
        .finally(() => {
          if (this.#running.get(record.asset) === running) this.#running.delete(record.asset);
          this.#live.delete(record.asset);
          this.#publish();
          this.#pump();
        });
    }
  }

  /** Whatever waits for the network or the next try tries now. */
  #nudge(): void {
    const wake = this.#wake;
    this.#wake = new AbortController();
    wake.abort(new Stopped());
    this.#pump();
  }

  /** Waits a while, or until something says to try now; rejects once the file stops. */
  async #rest(ms: number, signal: AbortSignal): Promise<void> {
    const wake = this.#wake.signal;
    try {
      await this.#env.sleep(ms, AbortSignal.any([signal, wake]));
    } catch (error) {
      if (signal.aborted) throw new Stopped();
      if (!wake.aborted) throw error;
    }
  }

  #setLive(asset: string, live: Live | undefined): void {
    if (live) this.#live.set(asset, live);
    else this.#live.delete(asset);
    this.#publish();
  }

  /** Keeps a change of the record of a file, as long as it is still the one being sent. */
  async #keep(
    record: UploadRecord,
    change: (kept: UploadRecord) => UploadRecord | null,
  ): Promise<UploadRecord | undefined> {
    const store = this.#options.store;
    if (!store) return undefined;
    const [after] = await store.update(record.key, [record.asset], (kept) =>
      kept && kept.hash === record.hash && kept.state === "waiting" ? change(kept) : undefined,
    );
    return after;
  }

  /** Sends one file, from where it got, until the storage has it or it fails. */
  async #send(
    record: UploadRecord,
    project: UploadProject,
    lfs: LfsAccess,
    signal: AbortSignal,
  ): Promise<void> {
    const oid = oidOf(record.hash);
    try {
      if (oid === undefined) throw new Failed("refused");
      if (record.size > LFS_FILE_MOST) throw new Failed("tooLarge");
      this.#setLive(record.asset, { phase: "reading", received: record.received ?? 0 });
      let file = await this.#file(record, false, signal);
      let restarts = 0;
      for (let retry = RETRY_FIRST_MS; ;) {
        if (signal.aborted) throw new Stopped();
        try {
          let upload = await this.#current(record, lfs, project.project as string, oid, signal);
          for (;;) {
            if (signal.aborted) throw new Stopped();
            if (upload.state === "present" || upload.state === "done") {
              if (await this.#arrived(record, upload, project)) return;
              // The project cannot take it now, as while it is read-only: later.
              this.#setLive(record.asset, { phase: "pushing", received: record.size });
              await this.#rest(RETRY_MOST_MS, signal);
              continue;
            }
            if (upload.state === "failed" || upload.state === "expired") {
              const problem = upload.state === "expired" ? "again" : problemOf(upload.error);
              if (problem === "repository") {
                // The project's repository: said for the project, and it waits.
                this.#setLive(record.asset, { phase: "offline", received: 0 });
                await this.#rest(RETRY_MOST_MS, signal);
              } else if (problem !== "again") throw new Failed(problem);
              // Over: from the start, as a new one, a few times in a row at most.
              else if ((restarts += 1) > 3) throw new Failed("refused");
              await this.#keep(record, ({ upload: _upload, received: _received, ...rest }) => rest);
              upload = await lfs.begin(project.project as string, { oid, size: record.size });
              continue;
            }
            if (upload.state === "receiving" && upload.received < upload.size) {
              const sent = await this.#pieces(record, lfs, upload, file, signal);
              if (sent.kind === "file") {
                file = sent.file;
                continue;
              }
              upload = sent.upload;
              continue;
            }
            // All of it there: the platform checks it, and puts it into the storage.
            upload = await this.#settled(record, lfs, upload, signal);
          }
        } catch (error) {
          if (error instanceof Stopped || error instanceof Failed || signal.aborted) throw error;
          if (error instanceof CloudSignedOut) throw new Failed("signedOut");
          if (!(error instanceof LfsRefused)) throw error;
          switch (error.code) {
            case "tooLarge":
            case "githubQuota":
            case "notAcknowledged":
              throw new Failed(error.code);
            case "notLinked":
            case "gone":
              // The project's repository: what keeps it is said for the project, and it waits.
              this.#setLive(record.asset, { phase: "offline", received: record.received ?? 0 });
              await this.#rest(RETRY_MOST_MS, signal);
              continue;
            case "busy":
              this.#setLive(record.asset, {
                phase: "busy",
                received: record.received ?? 0,
                ...(error.detail === "person" && { full: true }),
              });
              await this.#rest((error.retryAfter ?? 10) * 1000, signal);
              continue;
            case "notFound":
              // The upload is not there any more: `#current` begins it again.
              await this.#rest(retry, signal);
              retry = Math.min(retry * 2, RETRY_MOST_MS);
              continue;
            case "unavailable":
            case "slow":
            case "offset":
              this.#setLive(record.asset, { phase: "offline", received: record.received ?? 0 });
              await this.#rest(retry, signal);
              retry = Math.min(retry * 2, RETRY_MOST_MS);
              continue;
            default:
              throw new Failed("refused");
          }
        }
      }
    } catch (error) {
      if (error instanceof Failed) {
        const failed = await this.#keep(record, (kept) => ({
          ...kept,
          state: "failed",
          problem: error.problem,
        }));
        const item = failed && this.#itemOf(failed, 0);
        if (item) this.#options.onFailed?.(item);
        return;
      }
      throw error;
    }
  }

  /** The file of an asset, as long as it is the one that is to be sent. */
  async #file(record: UploadRecord, again: boolean, signal: AbortSignal): Promise<Blob> {
    for (let retry = RETRY_FIRST_MS; ; retry = Math.min(retry * 2, RETRY_MOST_MS)) {
      const files = this.#options.files();
      const found = files
        ? await files.read(record.asset, { hash: record.hash, size: record.size }, again)
        : ({ kind: "unknown" } as const);
      if (signal.aborted) throw new Stopped();
      if (found.kind === "there") return found.file;
      if (found.kind !== "unknown") throw new Failed(found.kind);
      await this.#rest(retry, signal);
    }
  }

  /** The upload this file is on, as the platform has it: the one that is kept, or a new one. */
  async #current(
    record: UploadRecord,
    lfs: LfsAccess,
    project: string,
    oid: string,
    signal: AbortSignal,
  ): Promise<LfsUpload> {
    const kept = this.#records.find((each) => each.asset === record.asset)?.upload ?? record.upload;
    if (kept !== undefined) {
      try {
        const upload = await lfs.state(kept);
        // One that is over, as one that failed before people tried again, is begun anew.
        const over = upload.state === "failed" || upload.state === "expired";
        if (!over && upload.oid === oid && upload.size === record.size) return upload;
      } catch (error) {
        if (!(error instanceof LfsRefused) || error.code !== "notFound") throw error;
      }
    }
    if (signal.aborted) throw new Stopped();
    const upload = await lfs.begin(project, { oid, size: record.size });
    if (upload.id !== undefined)
      await this.#keep(record, (each) => ({
        ...each,
        upload: upload.id as string,
        received: upload.received,
      }));
    return upload;
  }

  /**
   * Sends the pieces of a file from where the upload got, to its end or until something else is
   * to be done: resolves to the upload then, or to the file again where it has to be read again.
   */
  async #pieces(
    record: UploadRecord,
    lfs: LfsAccess,
    begun: LfsUpload,
    file: Blob,
    signal: AbortSignal,
  ): Promise<{ kind: "upload"; upload: LfsUpload } | { kind: "file"; file: Blob }> {
    const id = begun.id as string;
    const most = Math.max(begun.chunk, 1);
    const least = Math.min(Math.max(begun.minChunk, 1), most);
    const fit = (bytes: number) =>
      Math.min(
        most,
        Math.max(
          least,
          bytes >= PIECE_STEP ? Math.floor(bytes / PIECE_STEP) * PIECE_STEP : Math.floor(bytes),
        ),
      );
    let upload = begun;
    let retry = RETRY_FIRST_MS;
    while (upload.state === "receiving" && upload.received < upload.size) {
      if (signal.aborted) throw new Stopped();
      const offset = upload.received;
      const length = Math.min(fit(this.#piece), upload.size - offset);
      let bytes: ArrayBuffer;
      try {
        bytes = await file.slice(offset, offset + length).arrayBuffer();
      } catch (error) {
        // The file changed, or went, since it was given out: as it is now.
        if (isNamed(error, "NotReadableError") || isNamed(error, "NotFoundError"))
          return { kind: "file", file: await this.#file(record, true, signal) };
        throw error;
      }
      if (bytes.byteLength !== length)
        return { kind: "file", file: await this.#file(record, true, signal) };
      const started = this.#env.now();
      const giveUp = new AbortController();
      const timer = setTimeout(() => giveUp.abort(new Stopped()), PIECE_GIVE_UP_MS);
      try {
        upload = await lfs.send(id, offset, new Blob([bytes]), {
          signal: AbortSignal.any([signal, giveUp.signal]),
        });
        const took = Math.max(this.#env.now() - started, 1);
        const speed = (length * 1000) / took;
        // Toward a piece of `PIECE_TARGET_MS`, at most twice as large as the last one.
        this.#piece = fit(Math.min(speed * (PIECE_TARGET_MS / 1000), length * 2));
        retry = RETRY_FIRST_MS;
        this.#setLive(record.asset, { phase: "sending", received: upload.received, speed });
        await this.#keep(record, (kept) => ({ ...kept, upload: id, received: upload.received }));
      } catch (error) {
        if (signal.aborted) throw new Stopped();
        const took = this.#env.now() - started;
        if (giveUp.signal.aborted || (error instanceof LfsRefused && error.code === "slow")) {
          this.#piece = fit(length / 2);
          continue;
        }
        if (!(error instanceof LfsRefused)) throw error;
        if (error.code === "offset") {
          upload =
            error.received === undefined
              ? await lfs.state(id)
              : { ...upload, received: error.received };
          continue;
        }
        if (error.code === "busy") {
          this.#setLive(record.asset, { phase: "busy", received: offset });
          await this.#rest((error.retryAfter ?? 2) * 1000, signal);
          continue;
        }
        if (error.code !== "unavailable") throw error;
        // No answer: smaller where it failed late, and from where the platform got.
        if (took > PIECE_LATE_MS) this.#piece = fit(length / 2);
        this.#setLive(record.asset, { phase: "offline", received: offset });
        await this.#rest(retry, signal);
        retry = Math.min(retry * 2, RETRY_MOST_MS);
        upload = await lfs.state(id);
      } finally {
        clearTimeout(timer);
      }
    }
    return { kind: "upload", upload };
  }

  /** Asks the platform about a file that is all there, until it is something else. */
  async #settled(
    record: UploadRecord,
    lfs: LfsAccess,
    upload: LfsUpload,
    signal: AbortSignal,
  ): Promise<LfsUpload> {
    let wait = POLL_FIRST_MS;
    let now = upload;
    for (;;) {
      const checking = now.state === "receiving";
      this.#setLive(record.asset, { phase: checking ? "checking" : "pushing", received: now.size });
      if (now.state !== "receiving" && now.state !== "received" && now.state !== "pushing")
        return now;
      await this.#rest(wait, signal);
      wait = Math.min(wait * 1.5, POLL_MOST_MS);
      now = await lfs.state(now.id as string);
    }
  }

  /**
   * The storage has the file: the asset says so, for the content it has, where the project is open
   * and can be changed. Otherwise the record stays as it is, and the next time the project is open
   * the platform says so again at once.
   */
  async #arrived(
    record: UploadRecord,
    upload: LfsUpload,
    project: UploadProject,
  ): Promise<boolean> {
    const open = this.#options.project();
    const store = open?.key === record.key ? open.store : undefined;
    if (!store || store !== project.store) throw new Stopped();
    if (store.readOnly) return false;
    const asset = store.getState().assets?.[record.asset];
    // Another file of the asset now, or none: this one is there all the same, and nothing is said.
    if (asset?.hash !== undefined && isSameHash(asset.hash, record.hash)) {
      const result = store.execute(
        {
          type: "asset.setStorage",
          params: { asset: record.asset, storage: "lfs", hash: asset.hash, repo: upload.repo },
        },
        { origin: STORAGE },
      );
      if (!result.ok) {
        console.warn("Where the file of an asset is could not be written", result.error);
        throw new Failed("refused");
      }
    }
    await this.#keep(record, ({ problem: _problem, ...kept }) => ({
      ...kept,
      state: "done",
      received: record.size,
      doneAt: this.#env.now(),
    }));
    this.#doneInRound += 1;
    // As it is kept now, which another file may have changed a moment ago.
    await this.#reload();
    const left = this.#records.filter(
      (each) => each.state === "waiting" || each.state === "paused",
    ).length;
    if (left === 0 && this.#doneInRound > 0) {
      const count = this.#doneInRound;
      this.#doneInRound = 0;
      this.#options.onAllDone?.(count);
    }
    return true;
  }

  // What people ask for. Each changes what is kept, which the window that sends follows.

  /**
   * Asks for the files of these assets to go into the storage, as they are now. Resolves to how
   * many were asked for: not those whose file is on its way or there already, nor those without a
   * file that can be sent (no hash or size, or too large).
   */
  async add(assets: readonly string[], { replaced = false } = {}): Promise<number> {
    const project = this.#options.project();
    const store = this.#options.store;
    if (!project || !store || project.project === undefined) return 0;
    const state = project.store.getState();
    const at = this.#env.now();
    const fresh = new Map<string, UploadRecord>();
    for (const asset of new Set(assets)) {
      const found = state.assets?.[asset];
      if (found?.hash === undefined || found.size === undefined || found.size > LFS_FILE_MOST)
        continue;
      // There already, for this very content, where it counts: in the repository of the project.
      if (this.#isThere(asset)) continue;
      fresh.set(asset, {
        key: project.key,
        asset,
        target: "lfs",
        hash: found.hash,
        size: found.size,
        name: found.name ?? found.path,
        project: project.project,
        state: "waiting",
        at,
        ...(replaced && { replaced: true as const }),
      });
    }
    let added = 0;
    await store.update(project.key, [...fresh.keys()], (kept, asset) => {
      const next = fresh.get(asset) as UploadRecord;
      // On its way: a paused one goes on. There: not where it counts now (see above), as after
      // another repository was chosen, so it goes again; the platform says at once if it has it.
      if (
        kept &&
        kept.hash === next.hash &&
        (kept.state === "waiting" || kept.state === "paused")
      ) {
        if (kept.state !== "paused") return undefined;
        added += 1;
        return { ...kept, state: "waiting" };
      }
      added += 1;
      return next;
    });
    this.#nudge();
    return added;
  }

  /**
   * Whether the file an asset has now is in the storage of this project's repository, as people
   * see it (`placedAsset`): a place bound to another repository is not.
   */
  #isThere(asset: string): boolean {
    const state = this.#options.project()?.store.getState();
    return !!state && placedAsset(state, asset, this.#options.here?.())?.storage === "lfs";
  }

  /** Stops a file, where it is: it goes on from there with `resume`. */
  pause(asset: string): Promise<void> {
    return this.#change([asset], (kept) =>
      kept.state === "waiting" ? { ...kept, state: "paused" } : undefined,
    );
  }

  resume(asset: string): Promise<void> {
    return this.#change([asset], (kept) =>
      kept.state === "paused" ? { ...kept, state: "waiting" } : undefined,
    );
  }

  /** Tries a file that failed again, from where it got. */
  retry(asset: string): Promise<void> {
    return this.#change([asset], anew);
  }

  pauseAll(): Promise<void> {
    return this.#change(
      this.#records.filter(({ state }) => state === "waiting").map(({ asset }) => asset),
      (kept) => (kept.state === "waiting" ? { ...kept, state: "paused" } : undefined),
    );
  }

  resumeAll(): Promise<void> {
    return this.#change(
      this.#records.filter(({ state }) => state === "paused").map(({ asset }) => asset),
      (kept) => (kept.state === "paused" ? { ...kept, state: "waiting" } : undefined),
    );
  }

  /** Gives a file up: what the platform has of it goes too. Not one that is there. */
  async cancel(asset: string): Promise<void> {
    const record = this.#records.find((each) => each.asset === asset);
    if (!record || record.state === "done") return;
    await this.#giveUp([asset]);
  }

  /**
   * Gives these up: gone at once where the platform has nothing of them; otherwise "cancelling"
   * until the platform is told, so that what it holds for them goes now rather than a day later,
   * and takes no room of the person's meanwhile. Whichever window sends tells it once it can.
   */
  async #giveUp(assets: readonly string[]): Promise<void> {
    const store = this.#options.store;
    const key = this.#key;
    if (!store || key === undefined || assets.length === 0) return;
    const after = await store.update(key, assets, (kept) =>
      !kept || kept.state === "done"
        ? undefined
        : kept.upload === undefined
          ? null
          : { ...kept, state: "cancelling" },
    );
    await this.#tellCancelled(
      after.flatMap((each) => (each?.state === "cancelling" ? [each] : [])),
    );
  }

  /** Tells the platform what people gave up, and forgets it once it heard. */
  async #tellCancelled(records: readonly UploadRecord[]): Promise<void> {
    const lfs = this.#options.lfs();
    const store = this.#options.store;
    if (!lfs || !store) return;
    for (const record of records) {
      if (record.upload === undefined) continue;
      try {
        await lfs.cancel(record.upload);
      } catch (error) {
        // No answer: the next time the network is back.
        if (error instanceof LfsRefused && error.code === "notFound") {
          /* gone already */
        } else {
          console.warn("An upload could not be given up on the platform yet", error);
          continue;
        }
      }
      await store.update(record.key, [record.asset], (kept) =>
        kept?.state === "cancelling" && kept.upload === record.upload ? null : undefined,
      );
    }
  }

  /**
   * Gives up all that is not there yet: what helps where the platform has no room for more of the
   * person's files, as uploads that were given up while offline still take it.
   */
  giveUpAll(): Promise<void> {
    return this.#giveUp(
      this.#records.filter(({ state }) => state !== "done").map(({ asset }) => asset),
    );
  }

  /** Forgets the files that are there. */
  clearDone(): Promise<void> {
    return this.#change(
      this.#records.filter(({ state }) => state === "done").map(({ asset }) => asset),
      (kept) => (kept.state === "done" ? null : undefined),
    );
  }

  /** Tries again what failed for this: people did what it needed, such as signing in. */
  retryAll(problems: readonly UploadProblem[]): Promise<void> {
    const wanted = new Set<string>(problems);
    return this.#change(
      this.#records
        .filter(({ state, problem }) => state === "failed" && wanted.has(problem ?? ""))
        .map(({ asset }) => asset),
      anew,
    );
  }

  async #change(
    assets: readonly string[],
    change: (kept: UploadRecord) => UploadRecord | null | undefined,
  ): Promise<void> {
    const key = this.#key;
    const store = this.#options.store;
    if (key === undefined || !store || assets.length === 0) return;
    await store.update(key, assets, (kept) => (kept ? change(kept) : undefined));
  }

  // What people see.

  #itemOf(record: UploadRecord, ahead: number): UploadItem | undefined {
    const live = this.#claim ? this.#live.get(record.asset) : this.#heard.get(record.asset);
    const blocked = this.#options.project()?.blocked;
    const phase: UploadPhase =
      record.state === "done"
        ? "done"
        : record.state === "paused"
          ? "paused"
          : record.state === "failed"
            ? "failed"
            : (live?.phase ?? (blocked !== undefined ? "blocked" : "queued"));
    return {
      asset: record.asset,
      name: record.name,
      size: record.size,
      hash: record.hash,
      phase,
      received:
        record.state === "done" ? record.size : Math.max(live?.received ?? 0, record.received ?? 0),
      ...(live?.speed !== undefined && phase === "sending" && { speed: live.speed }),
      ...(live?.full && phase === "busy" && { full: true }),
      ...(record.problem !== undefined && { problem: record.problem as UploadProblem }),
      ...(phase === "queued" && { ahead }),
      ...(record.replaced && { replaced: true }),
      at: record.at,
      ...(record.doneAt !== undefined && { doneAt: record.doneAt }),
    };
  }

  #publish(): void {
    let ahead = 0;
    const items: UploadItem[] = [];
    for (const record of this.#records) {
      if (record.state === "cancelling") continue;
      const item = this.#itemOf(record, ahead);
      if (!item) continue;
      if (item.phase === "queued") ahead += 1;
      items.push(item);
    }
    this.#snapshot = {
      key: this.#key,
      items,
      sender: this.#claim ? "here" : this.#waiting ? "elsewhere" : "none",
      blocked: this.#key === undefined ? undefined : this.#options.project()?.blocked,
    };
    this.#emitter.emit();
    this.#tell();
  }

  /** Tells the other windows how the files this one sends go, now and then. */
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
    const message: LiveMessage = { t: "live", key, live: [...this.#live] };
    this.#line.post(message);
  }
}

/** Of what is kept of all projects, how many files of each are not there yet, by key. */
export function unfinishedByProject(records: readonly UploadRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records)
    if (record.state !== "done" && record.state !== "cancelling")
      counts.set(record.key, (counts.get(record.key) ?? 0) + 1);
  return counts;
}
