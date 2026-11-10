import {
  checkUpdate,
  hasDeletionsOf,
  isAhead,
  mergeUpdates,
  type ProjectStore,
} from "@animaquill/core";
import {
  Reassembler,
  SYNC_CLOSE,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  framesOf,
  readSyncServerMessage,
  unpackChecked,
  type CloudAccess,
  type CloudConnection,
  type CloudLine,
  type CloudLink,
  type LogEntry,
  type SyncClientMessage,
  type SyncKind,
  type SyncRejection,
  type SyncServerMessage,
  type WriterClaim,
} from "@animaquill/host";
import type { Journal } from "../workbench/session.ts";
import { Emitter } from "../workbench/emitter.ts";

/**
 * Keeps an open project in step with its copy on a platform, see docs/design/local-projects.md 7.2
 * and docs/design/data-sync.md 2. The platform numbers the changes it takes, one after the other,
 * and the log of the project in the browser is the queue of what goes there:
 *
 * - Every change goes into the log first, as always, and from there to the platform, oldest first,
 *   with who made it. `CloudLink.pushed` says how far the platform has the log; whatever comes after
 *   it goes again after a reload or a lost connection, which costs nothing: Yjs takes an update it
 *   has as nothing.
 * - What the platform sends goes into the project, and so into the log, as a change of "cloud".
 *   `CloudLink.seq` says up to which number all of it is in the log, and is only moved on once it
 *   is: the next connection asks for what came after it.
 * - A connection starts with what came after `seq`, then sends what the platform does not have, and
 *   then compares what both have, once, also what was taken away, so that nothing is missing on
 *   either side however the two got there. From then on changes go both ways as they happen.
 * - The platform gives each number a digest, which the link keeps with `seq`. A platform that came
 *   back from a backup has another one for the same number: then everything comes again from the
 *   start, and everything of this browser goes again, see `reset`.
 * - What goes is only what the log has, never what waits for a change that is not there: a log
 *   that lost something keeps that gap here, where the project goes on without it.
 * - Without a connection everything goes on here, folder included; a connection that breaks comes
 *   back on its own, sooner when the browser is back online or the window comes back.
 *
 * Only one window of a browser syncs a project, as only one writes its folder: changes of the other
 * windows reach it through the log. The others show what it says.
 *
 * Nothing here touches the page, so it runs the same with a platform in memory.
 */

export interface CloudTiming {
  /** Without a word from the platform for this long, the window asks whether it is still there. */
  readonly pingMs: number;
  /** ...and takes the connection for dead when nothing comes for this long after that. */
  readonly deadMs: number;
  /** How long a connection has to say hello and catch up. */
  readonly helloMs: number;
  /** The first wait before trying again, which doubles each time up to `longestRetryMs`. */
  readonly firstRetryMs: number;
  readonly longestRetryMs: number;
  /** How long a connection has to last to count as working, for the waits to start over. */
  readonly steadyMs: number;
  /** New changes in the log go once it was quiet for this long. */
  readonly scanMs: number;
  /** How often how far it got is noted down, at most. */
  readonly noteMs: number;
  /** How long the window that syncs has to answer before another one takes over. */
  readonly answerMs: number;
}

export const CLOUD_TIMING: CloudTiming = {
  pingMs: 15_000,
  deadMs: 10_000,
  helloMs: 30_000,
  firstRetryMs: 1000,
  longestRetryMs: 30_000,
  steadyMs: 10_000,
  scanMs: 30,
  noteMs: 1000,
  answerMs: 3000,
};

/** What the session needs to know of the world around it. The page's, unless a test says so. */
export interface CloudEnvironment {
  /**
   * Whether the browser thinks it has a network. Only a hint: a browser without any network but the
   * computer's own can still reach a platform on the computer, so it gets tried all the same, only
   * less often.
   */
  isOnline(): boolean;
  /** The browser is back online, or the window came back to the front: worth trying right away. */
  onWake(listener: () => void): () => void;
  /** The browser just lost its network: the connection is as good as gone. */
  onOffline(listener: () => void): () => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  now(): number;
  random(): number;
}

export const pageEnvironment = (): CloudEnvironment => ({
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  onWake(listener) {
    if (typeof addEventListener === "undefined") return () => {};
    const onVisible = () => {
      if (document.visibilityState === "visible") listener();
    };
    addEventListener("online", listener);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      removeEventListener("online", listener);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },
  onOffline(listener) {
    if (typeof addEventListener === "undefined") return () => {};
    addEventListener("offline", listener);
    return () => removeEventListener("offline", listener);
  },
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  random: () => Math.random(),
});

export type CloudState =
  /** Not connected yet. */
  | "starting"
  /** Connecting for the first time since the project opened. */
  | "connecting"
  | "online"
  /** The connection broke or did not come up, and the window tries again. */
  | "reconnecting"
  /** The browser has no network: changes wait here. */
  | "offline"
  /** It waits for people, see `CloudProblem`. */
  | "paused"
  | "closed";

/** What keeps a project from syncing until people do something. */
export type CloudProblem =
  /** Nobody is signed in, or the session ended: changes wait until people sign in again. */
  | { readonly kind: "signed-out" }
  /** The platform did not take a change, and taking it again will not help. */
  | { readonly kind: "rejected"; readonly reason: SyncRejection }
  /** The editor is older than the platform: reloading the page helps. */
  | { readonly kind: "outdated" }
  /** The project is not on the platform, or not one of whoever is signed in. */
  | { readonly kind: "missing" }
  /** The project here and the one on the platform do not fit together any more. */
  | { readonly kind: "diverged" }
  /** This browser cannot keep what syncing needs. */
  | { readonly kind: "unsupported" }
  /** Another window of this browser disconnected the project. */
  | { readonly kind: "unlinked" };

export interface CloudSnapshot {
  readonly state: CloudState;
  readonly problem: CloudProblem | undefined;
  /** Whether this window syncs the project, or another one of this browser does. */
  readonly here: boolean;
  /** When the project was last in step with the platform, in milliseconds since 1970. */
  readonly syncedAt: number | undefined;
  /** Changes of this browser that the platform does not have yet, as far as is known. */
  readonly pending: number;
  /** When the next try is, while reconnecting. */
  readonly retryAt: number | undefined;
  /** The last update of the platform that the project has. */
  readonly seq: number;
}

export interface CloudSessionOptions {
  readonly store: ProjectStore;
  readonly journal: Journal;
  readonly cloud: CloudAccess;
  /** Where the project goes, and how far it got. */
  readonly link: CloudLink;
  /** Which window this is, see `ChangeSource.window`. */
  readonly window: string;
  /** The version of the editor, for the platform to know. */
  readonly editor: string;
  /**
   * The project goes to the platform for the first time, as a new one with the id of the link: its
   * whole state is the first version there.
   */
  readonly create?: { readonly name: string; readonly projectId: string };
  /** Hears the last update of the platform that the project has, for changes to say so. */
  readonly onSeq?: (seq: number) => void;
  readonly timing?: Partial<CloudTiming>;
  readonly environment?: CloudEnvironment;
}

/** A change on its way to the platform, by the id of its message. */
interface InFlight {
  readonly marks: readonly number[];
}

/** What happened to a connection, for what comes next. */
type Ending =
  /** `later`: the platform said to come back later, as when it restarts: not all at once. */
  | { readonly kind: "retry"; readonly later?: true }
  | { readonly kind: "resync" }
  | { readonly kind: "pause"; readonly problem: CloudProblem }
  | { readonly kind: "closed" };

/** Pushes go in batches of entries of the same maker up to this many bytes. */
const BATCH_BYTES = 256 * 1024;
/** ...and this many entries. */
const BATCH_ENTRIES = 200;
/** After the platform came back from a restart, windows come back within this long, by chance. */
const SPREAD_MS = 15_000;
/** Updates of a catch-up that the project takes in together, and their bytes. */
const CATCH_UP_UPDATES = 500;
const CATCH_UP_BYTES = 4 * 1024 * 1024;
/** Kinds of entries that are on the platform by what they are. */
const NOT_PUSHED = new Set(["cloud", "merged"]);
/** A platform that keeps not having what it says it has is not tried forever. */
const MOST_RESYNCS = 3;

const kindOf = (kind: string): SyncKind =>
  kind === "user" || kind === "folder" || kind === "ai" ? kind : "other";

const isPushed = (entry: LogEntry) => NOT_PUSHED.has(entry.source?.kind ?? "other");

const problemOf = (code: number): CloudProblem | undefined => {
  switch (code) {
    case SYNC_CLOSE.signedOut:
      return { kind: "signed-out" };
    case SYNC_CLOSE.forbidden:
    case SYNC_CLOSE.missing:
      return { kind: "missing" };
    case SYNC_CLOSE.outdated:
      return { kind: "outdated" };
    case SYNC_CLOSE.protocol:
      return { kind: "rejected", reason: "malformed" };
    case SYNC_CLOSE.tooLarge:
      return { kind: "rejected", reason: "too-large" };
    case SYNC_CLOSE.quota:
      return { kind: "rejected", reason: "quota" };
    default:
      return undefined;
  }
};

/**
 * What windows say to each other about a project, see `CloudAccess.line`: how it syncs, asking for
 * that, and asking the window that syncs to put all it has into the log, for a window that opened
 * from a log that lost something.
 */
type Word =
  | { readonly kind: "status"; readonly snapshot: CloudSnapshot }
  | { readonly kind: "ask" }
  | {
      readonly kind: "refill";
      /** The state vector of the window that asks, so that it gets only what it lacks. */
      readonly vector: Uint8Array;
    };

const isWord = (data: unknown): data is Word =>
  typeof data === "object" &&
  data !== null &&
  ((data as Word).kind === "ask" ||
    ((data as Word).kind === "refill" &&
      (data as { vector?: unknown }).vector instanceof Uint8Array) ||
    ((data as Word).kind === "status" &&
      typeof (data as { snapshot?: unknown }).snapshot === "object"));

export class CloudSession {
  readonly #store: ProjectStore;
  readonly #journal: Journal;
  readonly #cloud: CloudAccess;
  readonly #key: string;
  readonly #project: string;
  readonly #window: string;
  readonly #editor: string;
  readonly #timing: CloudTiming;
  readonly #env: CloudEnvironment;
  readonly #onSeq: ((seq: number) => void) | undefined;
  #create: CloudSessionOptions["create"];
  readonly #emitter = new Emitter();
  readonly #line: CloudLine | undefined;
  #snapshot: CloudSnapshot;
  #closed = false;
  #started = false;

  /** The last update of the platform that the log has all of up to, see `CloudLink.seq`. */
  #seq: number;
  /** What the platform said stands for its updates up to `seq`, see `CloudLink.digest`. */
  #digest: string;
  /** ...as noted down. */
  #notedSeq: number;
  /** The platform came back from a backup: the link starts over once the log has what came. */
  #resetPending = false;
  /**
   * What the project waits for that the platform does not have either: a gap of the log here, which
   * nothing can fill. The project goes on without it, see `missingKey`.
   */
  #localGap: string | undefined;
  /** Where the hello of the current connection asked to start. */
  #helloAfter = 0;
  /** Changes go one at a time, as after the platform found a batch too large. */
  #oneByOne = false;
  /** Everything in the log up to this mark is on the platform, see `CloudLink.pushed`. */
  #pushed: number;
  #notedPushed: number;
  /** Changes after `pushed` that the platform took, by their marks. */
  readonly #acked = new Set<number>();
  /** Changes after `pushed` that are on their way, by their marks. */
  readonly #sent = new Set<number>();
  /** How many changes the last look at the log found that the platform does not have. */
  #pending = 0;
  #syncedAt: number | undefined;

  #claim: WriterClaim | undefined;
  #waiting: AbortController | undefined;
  #isTakingOver = false;
  #isAsking = false;
  readonly #stops: (() => void)[] = [];

  #connection: CloudConnection | undefined;
  /** Where the current connection is: saying hello, catching up, or there. */
  #phase: "hello" | "catching-up" | "ready" = "hello";
  #headAtWelcome = 0;
  /** Updates of the catch-up that wait to be taken in together, see `CATCH_UP_UPDATES`. */
  #caught: Extract<SyncServerMessage, { t: "update" }>[] = [];
  #caughtBytes = 0;
  #nextId = 1;
  readonly #inFlight = new Map<number, InFlight>();
  #checked = false;
  #checking = false;
  #resyncs = 0;
  #resync = false;
  /**
   * The platform did not have what a change needed: the next connection compares first, and sends
   * what the platform lacks, before the changes that need it.
   */
  #repairFirst = false;
  #attempt = 0;
  #end: ((ending: Ending) => void) | undefined;
  #pingTimer: unknown;
  #deadTimer: unknown;
  #helloTimer: unknown;
  #scanTimer: unknown;
  #noteTimer: unknown;
  #scanning: Promise<void> | undefined;
  #scanAgain = false;
  /** Whatever waits for a while, woken early when the network or the window comes back. */
  readonly #sleepers = new Set<() => void>();
  #unpause: (() => void) | undefined;
  /** The last mark looked at while not connected, see `#scanOnce`. */
  #seen = 0;
  /** Whatever this window does with the store and the log, one at a time. */
  #work: Promise<void> = Promise.resolve();

  constructor(options: CloudSessionOptions) {
    const { store, journal, cloud, link, timing, environment } = options;
    this.#store = store;
    this.#journal = journal;
    this.#cloud = cloud;
    this.#key = link.key;
    this.#project = link.project;
    this.#window = options.window;
    this.#editor = options.editor;
    this.#create = options.create;
    this.#onSeq = options.onSeq;
    this.#timing = { ...CLOUD_TIMING, ...timing };
    this.#env = environment ?? pageEnvironment();
    this.#seq = link.seq;
    this.#digest = link.digest ?? "";
    this.#notedSeq = link.seq;
    this.#pushed = link.pushed;
    this.#notedPushed = link.pushed;
    this.#syncedAt = link.syncedAt;
    this.#line = cloud.line(link.key);
    this.#snapshot = {
      state: "starting",
      problem: undefined,
      here: false,
      syncedAt: link.syncedAt,
      pending: 0,
      retryAt: undefined,
      seq: link.seq,
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): CloudSnapshot => this.#snapshot;

  /** The key of the project in this browser, see `CloudLink.key`. */
  get key(): string {
    return this.#key;
  }

  /** The id of the project on the platform. */
  get project(): string {
    return this.#project;
  }

  /** Starts syncing, or waiting for the window that does. */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#stops.push(
      this.#journal.onChange(() => {
        this.#scanSoon();
        this.#maybeTakeOver();
      }),
      this.#env.onWake(() => this.#wakeAll()),
      // The connection would find out by itself, but only after a while without an answer.
      this.#env.onOffline(() => this.#end?.({ kind: "retry" })),
    );
    if (this.#line) {
      const line = this.#line;
      this.#stops.push(
        line.listen((data) => {
          if (!isWord(data)) return;
          if (data.kind === "ask" && this.#snapshot.here) {
            line.post({ kind: "status", snapshot: this.#snapshot } satisfies Word);
          } else if (data.kind === "refill" && this.#claim) {
            void this.#journal.refill(data.vector).catch((error: unknown) => {
              console.warn("The log could not get all of the project again", error);
            });
          } else if (data.kind === "status" && !this.#snapshot.here && !this.#claim) {
            this.#follow(data.snapshot);
          }
        }),
      );
    }
    void this.#run().catch((error: unknown) => {
      console.warn("The project does not sync any more", error);
      this.#set({ state: "paused", problem: { kind: "unsupported" } });
    });
  }

  /** Tries again right away, as after people signed in again, or asked for it. */
  resume(): void {
    if (this.#closed) return;
    this.#resyncs = 0;
    this.#attempt = 0;
    const unpause = this.#unpause;
    this.#unpause = undefined;
    unpause?.();
    this.#wakeAll();
  }

  /**
   * Goes on from the project as it is here, where syncing stopped at changes that the platform does
   * not take, and people changed what was wrong since: what the platform does not have goes as one
   * repair, see "check", and the changes of the log so far count as sent. What it holds is the same:
   * it only goes in one piece, not as the changes that made it. Resolves once that is set to go.
   */
  async resyncFromHere(): Promise<void> {
    if (this.#closed || !(await this.#journal.saved())) return;
    const entries = (await this.#journal.entries(this.#pushed)) ?? [];
    const last = entries.at(-1)?.mark;
    if (last !== undefined) {
      for (const entry of entries) this.#acked.add(entry.mark);
      this.#pushed = Math.max(this.#pushed, last);
      this.#seen = Math.max(this.#seen, last);
    }
    this.#oneByOne = false;
    this.#repairFirst = false;
    await this.#note().catch(() => {});
    this.resume();
  }

  #wakeAll(): void {
    for (const wake of this.#sleepers) wake();
  }

  /** Stops syncing. What the platform does not have yet stays in the log for next time. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    this.#waiting?.abort();
    this.#end?.({ kind: "closed" });
    this.#unpause?.();
    this.#wakeAll();
    this.#env.clearTimeout(this.#scanTimer);
    this.#env.clearTimeout(this.#noteTimer);
    await this.#work.catch(() => {});
    await this.#note().catch(() => {});
    this.#claim?.release();
    this.#claim = undefined;
    this.#line?.close();
    this.#set({ state: "closed", here: false });
  }

  #set(change: Partial<CloudSnapshot>): void {
    const next = { ...this.#snapshot, ...change };
    const before = this.#snapshot;
    if (
      before.state === next.state &&
      before.problem === next.problem &&
      before.here === next.here &&
      before.syncedAt === next.syncedAt &&
      before.pending === next.pending &&
      before.retryAt === next.retryAt &&
      before.seq === next.seq
    )
      return;
    this.#snapshot = next;
    if (next.here) this.#line?.post({ kind: "status", snapshot: next } satisfies Word);
    this.#emitter.emit();
  }

  /** What the window that syncs says, shown here. */
  #follow(snapshot: CloudSnapshot): void {
    if (snapshot.seq > 0) this.#onSeq?.(snapshot.seq);
    this.#set({
      state: snapshot.state === "closed" ? "starting" : snapshot.state,
      problem: snapshot.problem,
      here: false,
      syncedAt: snapshot.syncedAt,
      pending: snapshot.pending,
      retryAt: snapshot.retryAt,
      seq: snapshot.seq,
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#work.then(task);
    this.#work = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- whose turn it is

  async #run(): Promise<void> {
    while (!this.#closed) {
      const claim = await this.#claimTurn();
      if (!claim || this.#closed) {
        claim?.release();
        return;
      }
      this.#claim = claim;
      this.#set({ here: true });
      // What the window that synced before did last is in the log: the platform may need it.
      await this.#journal.readLog().catch(() => {});
      // ...and it noted down how far it got, which this window goes on from.
      if (await this.#takeOver()) await this.#sync(claim);
      else {
        this.#set({ state: "paused", problem: { kind: "unlinked" } });
        await new Promise<void>((resolve) => {
          this.#unpause = resolve;
        });
      }
      claim.release();
      this.#claim = undefined;
      if (this.#closed) return;
      this.#set({ here: false });
    }
  }

  /** Goes on from where the link says, as another window may have synced. False: it is gone. */
  async #takeOver(): Promise<boolean> {
    let link;
    try {
      link = await this.#cloud.links.get(this.#key);
    } catch (error) {
      console.warn("How far the project synced could not be read", error);
      return true;
    }
    if (!link || link.project !== this.#project) return false;
    if (link.seq !== this.#seq || this.#notedSeq !== link.seq) {
      // As the window that synced before left it, also after the platform came back from a backup.
      this.#seq = link.seq;
      this.#digest = link.digest ?? "";
      this.#notedSeq = link.seq;
    }
    this.#pushed = Math.max(this.#pushed, link.pushed);
    this.#notedPushed = Math.max(this.#notedPushed, link.pushed);
    if (link.syncedAt !== undefined) this.#syncedAt = Math.max(this.#syncedAt ?? 0, link.syncedAt);
    this.#set({ seq: this.#seq, syncedAt: this.#syncedAt });
    return true;
  }

  async #claimTurn(): Promise<WriterClaim | undefined> {
    const syncer = this.#cloud.syncer(this.#key);
    for (;;) {
      if (this.#closed) return undefined;
      if (this.#isTakingOver) {
        this.#isTakingOver = false;
        try {
          return await syncer.claim({ steal: true });
        } catch (error) {
          console.warn("Could not take over syncing the project", error);
        }
      }
      const waiting = new AbortController();
      this.#waiting = waiting;
      let isGranted = false;
      try {
        const claim = await syncer.claim({
          signal: waiting.signal,
          onWaiting: () => {
            if (isGranted || this.#closed || this.#waiting !== waiting) return;
            this.#set({ here: false, state: "starting" });
            this.#line?.post({ kind: "ask" } satisfies Word);
            // What this window could not read of the log, the one that syncs has.
            if (this.#journal.damaged() > 0) {
              const vector = this.#store.stateVector();
              this.#line?.post({ kind: "refill", vector } satisfies Word);
            }
          },
        });
        isGranted = true;
        return claim;
      } catch (error) {
        if (!waiting.signal.aborted) {
          if (error instanceof DOMException && error.name === "AbortError") return undefined;
          console.warn("Could not find out which window syncs the project", error);
          await this.#sleep(this.#timing.longestRetryMs);
        }
      } finally {
        if (this.#waiting === waiting) this.#waiting = undefined;
      }
    }
  }

  /**
   * People changed something here while another window syncs. A browser can put that window to sleep
   * with its turn: once it does not answer, this one takes over.
   */
  #maybeTakeOver(): void {
    if (this.#claim || this.#snapshot.here || this.#isAsking || this.#closed) return;
    if (!this.#waiting) return;
    this.#isAsking = true;
    void (async () => {
      try {
        await this.#sleep(this.#timing.scanMs);
        if (this.#claim || this.#closed || !this.#waiting) return;
        if (await this.#cloud.syncer(this.#key).answers(this.#timing.answerMs)) return;
        if (this.#claim || this.#closed) return;
        this.#isTakingOver = true;
        this.#waiting?.abort();
      } finally {
        this.#isAsking = false;
      }
    })();
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.#sleepers.delete(wake);
        this.#env.clearTimeout(timer);
        resolve();
      };
      const timer = this.#env.setTimeout(wake, ms);
      this.#sleepers.add(wake);
    });
  }

  // ---- connections

  /** Syncs while this window has the turn: one connection after the other. */
  async #sync(claim: WriterClaim): Promise<void> {
    const turn = { lost: false };
    void claim.lost.then(() => {
      turn.lost = true;
      this.#end?.({ kind: "closed" });
      this.#wakeAll();
      this.#unpause?.();
    });
    if (!this.#journal.entries()) {
      this.#set({ state: "paused", problem: { kind: "unsupported" } });
      await new Promise<void>((resolve) => {
        this.#unpause = resolve;
      });
      return;
    }
    this.#scanSoon();
    while (!this.#closed && !turn.lost) {
      const startedAt = this.#env.now();
      const ending = await this.#connect();
      if (this.#closed || turn.lost || ending.kind === "closed") return;
      if (ending.kind === "pause") {
        this.#set({ state: "paused", problem: ending.problem, retryAt: undefined });
        await new Promise<void>((resolve) => {
          this.#unpause = resolve;
        });
        this.#set({ problem: undefined });
        continue;
      }
      if (ending.kind === "resync") {
        this.#resyncs += 1;
        if (this.#resyncs > MOST_RESYNCS) {
          this.#set({ state: "paused", problem: { kind: "diverged" }, retryAt: undefined });
          await new Promise<void>((resolve) => {
            this.#unpause = resolve;
          });
          this.#set({ problem: undefined });
          continue;
        }
        this.#resync = true;
      }
      // A connection that worked for a while starts the waits over.
      const lasted = this.#env.now() - startedAt;
      this.#attempt = lasted >= this.#timing.steadyMs ? 1 : this.#attempt + 1;
      if (ending.kind === "resync") continue;
      // Offline, the next try is once the browser says it is back, or after the longest wait.
      const isOnline = this.#env.isOnline();
      const step = isOnline
        ? Math.min(
            this.#timing.longestRetryMs,
            this.#timing.firstRetryMs * 2 ** Math.max(0, this.#attempt - 1),
          )
        : this.#timing.longestRetryMs;
      // Half of it for sure, the rest by chance: windows that lost the platform at once do not all
      // come back at once. A platform that restarts gets them back over a while.
      const wait =
        step / 2 +
        (this.#env.random() * step) / 2 +
        (ending.later ? this.#env.random() * SPREAD_MS : 0);
      this.#set({
        state: isOnline ? "reconnecting" : "offline",
        retryAt: this.#env.now() + wait,
      });
      await this.#sleep(wait);
    }
  }

  /** One connection, from hello to whatever ends it. */
  async #connect(): Promise<Ending> {
    const connection = this.#cloud.connect();
    this.#connection = connection;
    this.#phase = "hello";
    this.#leftBefore = Number.POSITIVE_INFINITY;
    this.#caught = [];
    this.#caughtBytes = 0;
    this.#inFlight.clear();
    this.#sent.clear();
    this.#checked = false;
    this.#checking = false;
    if (this.#snapshot.state !== "online") {
      this.#set({
        state: this.#attempt === 0 ? "connecting" : "reconnecting",
        retryAt: undefined,
      });
    }
    let settle: (ending: Ending) => void = () => {};
    const ended = new Promise<Ending>((resolve) => {
      settle = resolve;
    });
    this.#end = settle;
    const isCurrent = () => this.#connection === connection;
    const frames = new Reassembler(SYNC_LIMITS.state);
    connection.onMessage((data) => {
      if (!isCurrent()) return;
      // A part of a large message counts as much as a whole one: a slow line gets through.
      this.#heard();
      const whole = frames.take(data);
      if (whole === "more") return;
      const message = whole && readSyncServerMessage(whole);
      if (!message) {
        // More than this editor takes is no line that broke: trying again gets the same.
        settle(
          frames.tooLarge
            ? { kind: "pause", problem: { kind: "rejected", reason: "too-large" } }
            : { kind: "retry" },
        );
        return;
      }
      void this.#enqueue(async () => {
        // What a connection that is over said is of no use: the next one asks again.
        if (isCurrent()) await this.#receive(message);
      }).catch((error: unknown) => {
        console.warn("A message of the platform could not be taken in", error);
        settle({ kind: "retry" });
      });
    });
    void connection.closed.then(({ code }) => {
      const problem = problemOf(code);
      settle(
        problem
          ? { kind: "pause", problem }
          : code === SYNC_CLOSE.unavailable || code === SYNC_CLOSE.tooMany
            ? { kind: "retry", later: true }
            : { kind: "retry" },
      );
    });
    try {
      await connection.opened;
    } catch {
      // It says why once it is closed, which it is.
    }
    if (isCurrent() && !this.#closed) {
      // A large first version takes long on a slow line: as long as it goes, it is no reason.
      const noWelcome = () => {
        if (this.#isSending()) {
          this.#helloTimer = this.#env.setTimeout(noWelcome, this.#timing.helloMs);
          return;
        }
        settle({ kind: "retry" });
      };
      this.#helloTimer = this.#env.setTimeout(noWelcome, this.#timing.helloMs);
      await this.#enqueue(() => this.#hello(connection)).catch(() => {
        settle({ kind: "retry" });
      });
      this.#heard();
    }
    const ending = await ended;
    this.#end = undefined;
    this.#connection = undefined;
    this.#phase = "hello";
    this.#env.clearTimeout(this.#helloTimer);
    this.#env.clearTimeout(this.#pingTimer);
    this.#env.clearTimeout(this.#deadTimer);
    connection.close(1000, "");
    this.#inFlight.clear();
    this.#sent.clear();
    // What arrived up to here is in the log once the log is written.
    await this.#note().catch(() => {});
    return ending;
  }

  #send(message: SyncClientMessage): void {
    const connection = this.#connection;
    if (!connection) return;
    for (const frame of framesOf(message)) connection.send(frame);
  }

  async #hello(connection: CloudConnection): Promise<void> {
    const device = await this.#cloud.links.device();
    if (this.#connection !== connection) return;
    const create = this.#create;
    // Only what is whole: what waits for a change that is gone would wait there forever.
    const state = create ? this.#store.encodeWhole() : new Uint8Array(0);
    if (state.length > SYNC_LIMITS.state) {
      // The platform takes no first version this large: saying so beats sending it over and over.
      this.#end?.({ kind: "pause", problem: { kind: "rejected", reason: "too-large" } });
      return;
    }
    const after = this.#resync ? 0 : this.#seq;
    this.#resync = false;
    this.#helloAfter = after;
    this.#send({
      t: "hello",
      v: SYNC_PROTOCOL,
      project: this.#project,
      after,
      ...(after > 0 && { digest: this.#digest }),
      device,
      window: this.#window,
      editor: this.#editor,
      ...(create && { create }),
      payload: state,
    });
  }

  /** Something came from the platform, so it is there. */
  #heard(): void {
    this.#env.clearTimeout(this.#pingTimer);
    this.#env.clearTimeout(this.#deadTimer);
    this.#pingTimer = this.#env.setTimeout(() => this.#sound(), this.#timing.pingMs);
  }

  /**
   * Asks the platform whether it is there, after a while of hearing nothing. While what this window
   * sends is still on its way, and moving, that is the answer: what it asks goes behind it.
   */
  #sound(): void {
    if (this.#isSending()) {
      this.#pingTimer = this.#env.setTimeout(() => this.#sound(), this.#timing.pingMs);
      return;
    }
    this.#send({ t: "ping" });
    const dead = () => {
      if (this.#isSending()) {
        this.#deadTimer = this.#env.setTimeout(dead, this.#timing.deadMs);
        return;
      }
      this.#end?.({ kind: "retry" });
    };
    this.#deadTimer = this.#env.setTimeout(dead, this.#timing.deadMs);
  }

  /** Bytes of this window still on their way out when last asked, see `#isSending`. */
  #leftBefore = Number.POSITIVE_INFINITY;

  /** Whether what this window sends is still on its way out, and less of it than when last asked. */
  #isSending(): boolean {
    const left = this.#connection?.buffered?.() ?? 0;
    const isMoving = left > 0 && left < this.#leftBefore;
    this.#leftBefore = left > 0 ? left : Number.POSITIVE_INFINITY;
    return isMoving;
  }

  async #receive(message: SyncServerMessage): Promise<void> {
    switch (message.t) {
      case "welcome":
        this.#env.clearTimeout(this.#helloTimer);
        this.#phase = "catching-up";
        this.#headAtWelcome = message.head;
        // The project is there: the first version is not to be made again.
        this.#create = undefined;
        if (message.reset) {
          // The platform came back from a backup, or has less than this window thought: what it
          // has comes again from the start, and everything of this browser goes again.
          this.#seq = 0;
          this.#digest = "";
          this.#pushed = 0;
          this.#seen = 0;
          this.#acked.clear();
          this.#sent.clear();
          this.#resetPending = true;
        }
        return;
      case "update": {
        if (this.#phase === "catching-up") {
          // Thousands of them, after a while away, go in together: one change of the project, and
          // as few entries of the log.
          this.#caught.push(message);
          this.#caughtBytes += message.payload.length;
          if (this.#caught.length >= CATCH_UP_UPDATES || this.#caughtBytes >= CATCH_UP_BYTES) {
            this.#takeCaught();
          }
          return;
        }
        if (!this.#store.applyCloud([message.payload], message.seq)) {
          // Not read: nothing says the project has it, and the next connection gets all of it.
          this.#end?.({ kind: "resync" });
          return;
        }
        this.#raise(message.seq, message.digest);
        this.#noteSoon();
        if (this.#phase === "ready" && this.#waitsForCloud()) this.#end?.({ kind: "resync" });
        return;
      }
      case "synced": {
        if (!this.#takeCaught()) return;
        this.#phase = "ready";
        this.#raise(message.head, message.digest);
        if (this.#store.isMissingUpdates) {
          if (this.#helloAfter === 0 || this.#store.missingKey === this.#localGap) {
            // All the platform has is here, and the project still waits: for something of the log
            // here that is gone for good. It goes on without it.
            this.#localGap = this.#store.missingKey;
            this.#store.catchUp([]);
          } else {
            // Something the platform sent needs something this window does not have.
            this.#end?.({ kind: "resync" });
            return;
          }
        }
        this.#set({ state: "online", retryAt: undefined, problem: undefined });
        this.#noteSoon();
        // What the platform lacks goes first where a change needed it, see `#repairFirst`.
        if (!this.#repairFirst) await this.#scan();
        this.#maybeCheck();
        return;
      }
      case "ack": {
        const sent = this.#inFlight.get(message.id);
        if (!sent) return;
        this.#inFlight.delete(message.id);
        for (const mark of sent.marks) {
          this.#sent.delete(mark);
          this.#acked.add(mark);
        }
        this.#raise(message.seq, message.digest);
        this.#noteSoon();
        if (this.#inFlight.size === 0) {
          if (this.#repairFirst && this.#checked) {
            // What the changes needed is there now: they go.
            this.#repairFirst = false;
            this.#resyncs = 0;
          }
          this.#scanSoon();
          this.#maybeCheck();
        }
        return;
      }
      case "reject": {
        const sent = this.#inFlight.get(message.id);
        this.#inFlight.delete(message.id);
        if (message.reason === "too-large" && (sent?.marks.length ?? 0) > 1) {
          // Each of them on its own may be small enough.
          this.#oneByOne = true;
          this.#end?.({ kind: "retry" });
        } else if (message.reason === "incomplete") {
          // What the change needs never got there, as after the platform lost something: the next
          // connection sends it first. Twice in a row is as much as that can help.
          if (this.#repairFirst) {
            this.#end?.({ kind: "resync" });
          } else {
            this.#repairFirst = true;
            this.#end?.({ kind: "retry" });
          }
        } else if (message.retry) {
          this.#end?.({ kind: "retry" });
        } else {
          this.#end?.({ kind: "pause", problem: { kind: "rejected", reason: message.reason } });
        }
        return;
      }
      case "checked": {
        this.#checking = false;
        const theirs = unpackChecked(message.payload);
        if (!theirs) {
          this.#end?.({ kind: "retry" });
          return;
        }
        if (isAhead(theirs.stateVector, this.#store.stateVector())) {
          // The platform has something this window never got: all of it again.
          this.#end?.({ kind: "resync" });
          return;
        }
        // What the platform took away and this window did not hear of, as after a backup.
        if (!this.#store.applyCloud([theirs.deletions], message.head)) {
          this.#end?.({ kind: "resync" });
          return;
        }
        this.#checked = true;
        const isMissing =
          isAhead(this.#store.stateVector(), theirs.stateVector) ||
          !hasDeletionsOf(theirs.deletions, this.#store.deletions());
        // Only what the log has: what is here and could not go into the log yet would come back as
        // something new after a crash, and twice.
        if (isMissing && (await this.#journal.saved()) && this.#phase === "ready") {
          // Something that never went, as from a log that lost an entry, or a platform that came
          // back from a backup: it goes now.
          this.#push(this.#store.diffSince(theirs.stateVector), {
            kind: "repair",
            base: message.head,
            marks: [],
            behind: true,
          });
        } else if (this.#repairFirst) {
          this.#repairFirst = false;
          await this.#scan();
        } else {
          this.#resyncs = 0;
          this.#inStep();
        }
        return;
      }
      case "pong":
        return;
    }
  }

  /** Takes in the updates of the catch-up that wait. False where one could not be read. */
  #takeCaught(): boolean {
    const caught = this.#caught;
    const last = caught.at(-1);
    this.#caught = [];
    this.#caughtBytes = 0;
    if (!last) return true;
    if (
      !this.#store.applyCloud(
        caught.map((update) => update.payload),
        last.seq,
      )
    ) {
      // Not read: nothing says the project has them, and the next connection gets all of it.
      this.#end?.({ kind: "resync" });
      return false;
    }
    this.#raise(last.seq, last.digest);
    this.#noteSoon();
    return true;
  }

  /** The platform got to `seq`, whose digest is `digest`, and this window has all of it. */
  #raise(seq: number, digest: string): void {
    if (seq < this.#seq) return;
    this.#seq = seq;
    this.#digest = digest;
    this.#onSeq?.(this.#seq);
    this.#set({ seq: this.#seq });
  }

  /** Whether the project waits for a change that the platform has, as opposed to a gap here. */
  #waitsForCloud(): boolean {
    return this.#store.isMissingUpdates && this.#store.missingKey !== this.#localGap;
  }

  /** Compares what both have, once a connection sent everything it had to. */
  #maybeCheck(): void {
    if (this.#phase !== "ready" || this.#checked || this.#checking) return;
    if (this.#inFlight.size > 0) return;
    this.#checking = true;
    this.#send({ t: "check" });
  }

  /** Everything is on both sides, as far as is known: when that was is worth showing. */
  #inStep(): void {
    if (this.#phase !== "ready" || !this.#checked || this.#inFlight.size > 0) return;
    if (this.#pending > 0) return;
    this.#syncedAt = this.#env.now();
    this.#set({ syncedAt: this.#syncedAt });
    this.#noteSoon();
  }

  // ---- what goes to the platform

  #scanSoon(): void {
    if (this.#closed) return;
    this.#env.clearTimeout(this.#scanTimer);
    // Without a connection only the count of what waits changes: no hurry.
    const wait = this.#phase === "ready" ? this.#timing.scanMs : this.#timing.noteMs;
    this.#scanTimer = this.#env.setTimeout(() => {
      void this.#enqueue(() => this.#scan()).catch((error: unknown) => {
        console.warn("The log of the project could not be read for syncing", error);
      });
    }, wait);
  }

  /**
   * Reads what the log has after `pushed`, sends what the platform does not have yet, and moves
   * `pushed` on as far as the platform has all of it. The log is what counts, not what was heard of
   * it: another window's change can be heard of late.
   */
  async #scan(): Promise<void> {
    if (this.#scanning) {
      this.#scanAgain = true;
      return this.#scanning;
    }
    this.#scanning = (async () => {
      try {
        do {
          this.#scanAgain = false;
          await this.#scanOnce();
        } while (this.#scanAgain && !this.#closed);
      } finally {
        this.#scanning = undefined;
      }
    })();
    return this.#scanning;
  }

  async #scanOnce(): Promise<void> {
    if (!this.#claim) return;
    if (this.#phase !== "ready" && this.#seen > this.#pushed) {
      // Without a connection, only what is new since the last look: a long time offline makes a
      // long log, and it is read again as a whole once there is a connection.
      const added = (await this.#journal.entries(this.#seen)) ?? [];
      this.#seen = added.at(-1)?.mark ?? this.#seen;
      this.#pending += added.filter((entry) => !isPushed(entry)).length;
      this.#set({ pending: this.#pending });
      return;
    }
    const entries = (await this.#journal.entries(this.#pushed)) ?? [];
    this.#seen = Math.max(this.#seen, entries.at(-1)?.mark ?? 0);
    let pushed = this.#pushed;
    let isContiguous = true;
    const waiting: LogEntry[] = [];
    for (const entry of entries) {
      const done = isPushed(entry) || this.#acked.has(entry.mark);
      if (done && isContiguous) {
        pushed = entry.mark;
        this.#acked.delete(entry.mark);
        continue;
      }
      isContiguous = false;
      if (!done) waiting.push(entry);
    }
    this.#pushed = Math.max(this.#pushed, pushed);
    this.#pending = waiting.length;
    this.#set({ pending: waiting.length });
    if (this.#pushed > this.#notedPushed) this.#noteSoon();
    if (this.#phase !== "ready" || this.#repairFirst) return;
    const fresh = waiting.filter((entry) => !this.#sent.has(entry.mark));
    for (const batch of this.#batches(fresh)) this.#pushEntries(batch);
    if (waiting.length === 0 && this.#inFlight.size === 0) this.#inStep();
  }

  /** Entries in a row of the same maker, as one change each, up to a size. */
  *#batches(entries: readonly LogEntry[]): Generator<LogEntry[]> {
    let batch: LogEntry[] = [];
    let bytes = 0;
    const sameAs = (a: LogEntry, b: LogEntry) =>
      a.source?.kind === b.source?.kind &&
      a.source?.window === b.source?.window &&
      a.source?.seq === b.source?.seq;
    for (const entry of entries) {
      const first = batch[0];
      const isFull =
        this.#oneByOne ||
        batch.length >= BATCH_ENTRIES ||
        bytes + entry.update.length > BATCH_BYTES;
      if (first && (!sameAs(first, entry) || isFull)) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push(entry);
      bytes += entry.update.length;
    }
    if (batch.length > 0) yield batch;
  }

  #pushEntries(batch: readonly LogEntry[]): void {
    const first = batch[0];
    if (!first) return;
    // Damaged in the log, or waiting for a change that is not in it: the project has none of it,
    // and neither will the platform, which would wait for that change forever. Should it come
    // after all, what the project has of it goes when the two compare.
    const unusable = batch.filter(
      (entry) => checkUpdate(entry.update) === "malformed" || !this.#store.hasAllOf(entry.update),
    );
    if (unusable.length > 0) {
      console.warn(`${unusable.length} changes in the log do not go to the platform`);
      for (const entry of unusable) this.#acked.add(entry.mark);
      const rest = batch.filter((entry) => !unusable.includes(entry));
      if (rest.length > 0) this.#pushEntries(rest);
      return;
    }
    const update =
      batch.length === 1 ? first.update : mergeUpdates(batch.map((entry) => entry.update));
    const base = first.source?.seq ?? 0;
    this.#push(update, {
      kind: kindOf(first.source?.kind ?? "other"),
      base,
      at: first.source?.at,
      window: first.source?.window,
      marks: batch.map((entry) => entry.mark),
      behind: base < this.#headAtWelcome,
    });
  }

  #push(
    update: Uint8Array,
    {
      kind,
      base,
      at,
      window,
      marks,
      behind,
    }: {
      readonly kind: SyncKind;
      readonly base: number;
      readonly at?: number | undefined;
      readonly window?: string | undefined;
      readonly marks: readonly number[];
      readonly behind: boolean;
    },
  ): void {
    if (update.length > SYNC_LIMITS.update) {
      // The platform takes no change this large: saying so beats sending it over and over.
      this.#end?.({ kind: "pause", problem: { kind: "rejected", reason: "too-large" } });
      return;
    }
    const id = this.#nextId++;
    this.#inFlight.set(id, { marks });
    for (const mark of marks) this.#sent.add(mark);
    this.#send({
      t: "push",
      id,
      kind,
      base,
      at: at ?? this.#env.now(),
      window: window ?? this.#window,
      behind,
      payload: update,
    });
  }

  // ---- noting down how far it got

  #noteSoon(): void {
    if (this.#noteTimer !== undefined || this.#closed) return;
    this.#noteTimer = this.#env.setTimeout(() => {
      this.#noteTimer = undefined;
      void this.#enqueue(() => this.#note()).catch((error: unknown) => {
        console.warn("How far the project synced could not be noted down", error);
      });
    }, this.#timing.noteMs);
  }

  /**
   * Notes down how far it got: `seq` only once the log has what came up to there, so that the next
   * connection does not skip what a crash took before it was written. After the platform came back
   * from a backup, the link starts over with what it has now.
   */
  async #note(): Promise<void> {
    const seq = this.#seq;
    const digest = this.#digest;
    const pushed = this.#pushed;
    const syncedAt = this.#syncedAt;
    const isReset = this.#resetPending;
    if (!isReset && seq === this.#notedSeq && pushed === this.#notedPushed) return;
    // What waits for an update that has not come is not all there.
    const saved =
      seq > this.#notedSeq || isReset
        ? !this.#waitsForCloud() && (await this.#journal.saved())
        : true;
    // What came from the platform is noted once the log has it.
    if (!saved) this.#noteSoon();
    let isThere: boolean;
    if (isReset) {
      if (!saved || this.#phase !== "ready") return;
      isThere = await this.#cloud.links.reset(this.#key, this.#project, { seq, digest, pushed });
      if (isThere) {
        this.#resetPending = false;
        this.#notedSeq = seq;
        this.#notedPushed = pushed;
      }
    } else {
      const change = {
        ...(saved && seq > this.#notedSeq && { seq, digest }),
        ...(pushed > this.#notedPushed && { pushed }),
        ...(syncedAt !== undefined && { syncedAt }),
      };
      if (Object.keys(change).length === 0) return;
      isThere = await this.#cloud.links.update(this.#key, this.#project, change);
      if (isThere && change.seq !== undefined) this.#notedSeq = change.seq;
      if (isThere && change.pushed !== undefined) this.#notedPushed = change.pushed;
    }
    // Another window disconnected the project: this one stops too.
    if (!isThere) this.#end?.({ kind: "pause", problem: { kind: "unlinked" } });
  }
}
