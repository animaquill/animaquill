/**
 * Opening a project, one step after the other, see the design of data and syncing (AnimaQuill
 * Cloud), 2.5: what it changes in, and from where, is in an order that one place says, not in the
 * order that the parts happen to start in.
 *
 * 1. `log`: the project is open from its log here (`ProjectSession.open`), and what this device
 *    kept with it is taken up: the undo logs of AI tasks and batches of files (`UndoKeeper`).
 * 2. `cloud`: where it syncs with a platform and the browser is online, what the platform has comes
 *    first, until the project has all of it, or for `catchUpMs` at most.
 * 3. `folder`: a project folder is compared with the project (`FolderSession.start`), and what
 *    changed in it while the editor was away comes in.
 * 4. `live`: both go on as changes come: what AI tools on this computer wrote is looked at, and
 *    files that are not here start to download.
 *
 * Why the platform comes before the folder: a folder is often a clone of the repository the
 * platform saves to, and the same change can come from both, as when people committed and pushed
 * while the editor was away, which the platform merged. Once the project has the platform's, the
 * folder has nothing new there, and nothing comes in twice. The other way round both insertions of
 * the same lines stay, and code would have them twice, without a word.
 *
 * Where the platform takes too long, cannot be reached, or the browser is offline, the folder comes
 * in first, as it does offline, and the platform after it. The change from the folder then says the
 * update of the platform it was made on (`ChangeSource.seq`): the platform knows that it was made
 * without what it merged, puts code back that came in twice, and lists what it cannot tell.
 *
 * Nothing here touches the page.
 */
import type { ProjectStore } from "@animaquill/core";
import type { CloudSnapshot } from "../cloud/session.ts";
import { Emitter } from "./emitter.ts";

export type OpeningStep = "log" | "cloud" | "folder" | "live";

/**
 * How the step of the platform ended: it does not sync ("none"), the browser is offline, the
 * project has what the platform has ("caught-up"), it took longer than `catchUpMs` ("timeout"),
 * syncing could not get there ("failed": the platform could not be reached, or will not sync it
 * now), or the project closed meanwhile.
 */
export type CatchUp = "none" | "offline" | "caught-up" | "timeout" | "failed" | "closed";

export interface OpeningSnapshot {
  /** The project being opened, or open, by its key; undefined while none is. */
  readonly key: string | undefined;
  readonly step: OpeningStep | undefined;
  /** How the step of the platform ended, once it did. */
  readonly cloud: CatchUp | undefined;
}

/** What opening needs of the syncing of a project, see `CloudProjects`. */
export interface OpeningCloud {
  /** Finds out whether the open project syncs, and starts syncing it where it does. */
  follow(): Promise<void>;
  /** How the project of this key syncs, where it does and is on the platform. */
  syncOf(key: string): OpeningSync | undefined;
}

export interface OpeningSync {
  getSnapshot(): Pick<CloudSnapshot, "state">;
  subscribe(listener: () => void): () => void;
}

export interface OpeningTiming {
  /** How long the folder waits for what the platform has, at most. */
  readonly catchUpMs: number;
  /** How long the folder waits for the undo logs to be taken up, at most. */
  readonly undoMs: number;
}

/**
 * 10 seconds: catching up takes well under a second on most lines, a few seconds after a long
 * time away. Longer than this, people would wonder why what they changed in the folder does not
 * show, and could not open another project meanwhile; and where it is over, the platform puts
 * right what comes in twice where it can, see above.
 */
export const OPENING_TIMING: OpeningTiming = { catchUpMs: 10_000, undoMs: 5000 };

export interface OpeningEnvironment {
  isOnline(): boolean;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
}

export interface OpeningOptions {
  readonly session: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): { readonly store?: ProjectStore | undefined; readonly key?: string | undefined };
  };
  /** Resolves once what this device kept of the undo logs of `store` is taken up, see `UndoKeeper`. */
  readonly undoLoaded: (store: ProjectStore) => Promise<void>;
  readonly cloud?: OpeningCloud | undefined;
  /**
   * Whether the project of this key opens as a folder: then the step of the platform waits for
   * the folder to be there (`folder`), as which project of the platform it is goes by it.
   */
  readonly isFolder: (key: string) => boolean;
  /** The project is live, see `OpeningStep`. */
  readonly live?: (store: ProjectStore) => void;
  readonly timing?: Partial<OpeningTiming> | undefined;
  readonly environment?: OpeningEnvironment | undefined;
}

/** One opening of one project, which another one takes over from. */
interface Run {
  readonly store: ProjectStore;
  readonly key: string;
  step: OpeningStep;
  cloud: CatchUp | undefined;
  readonly over: AbortController;
  /** The folder is there, and starts with this, see `folder`; `done` hears what came of it. */
  folder:
    | { readonly start: () => Promise<void>; readonly done: (started: Promise<void>) => void }
    | undefined;
  readonly folderCame: Promise<void>;
  readonly folderComes: () => void;
}

const pageEnvironment = (): OpeningEnvironment => ({
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});

const NOTHING: OpeningSnapshot = { key: undefined, step: undefined, cloud: undefined };

export class ProjectOpening {
  readonly #options: OpeningOptions;
  readonly #timing: OpeningTiming;
  readonly #env: OpeningEnvironment;
  readonly #emitter = new Emitter();
  #run: Run | undefined;
  /** Stores whose opening is over, or was given up on as another project opened. */
  readonly #done = new WeakSet<ProjectStore>();
  #snapshot: OpeningSnapshot = NOTHING;

  constructor(options: OpeningOptions) {
    this.#options = options;
    this.#timing = { ...OPENING_TIMING, ...options.timing };
    this.#env = options.environment ?? pageEnvironment();
    options.session.subscribe(() => this.#follow());
    this.#follow();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): OpeningSnapshot => this.#snapshot;

  /** Whether `store`, or the open project, is open and live, see `OpeningStep`. */
  isLive(store: ProjectStore | undefined = this.#options.session.getSnapshot().store): boolean {
    const run = this.#run;
    return store !== undefined && run?.store === store && run.step === "live";
  }

  /**
   * The step of the folder of `store`, which `start` does, once the step of the platform is over;
   * at once for a project that is open already, as one that moved into a folder. Resolves once
   * `start` did, or once the project is not opening any more, which then does not start.
   */
  folder(store: ProjectStore, start: () => Promise<void>): Promise<void> {
    const run = this.#run;
    if (run?.store !== store || run.folder || (run.step !== "log" && run.step !== "cloud")) {
      // Gone before the folder came: nothing of it starts.
      if (this.#done.has(store) && this.#isGone(store)) return Promise.resolve();
      return start();
    }
    return new Promise<void>((resolve, reject) => {
      run.folder = { start, done: (started) => started.then(resolve, reject) };
      run.over.signal.addEventListener("abort", () => resolve(), { once: true });
      run.folderComes();
    });
  }

  /** Whether `store` is not the open project any more. */
  #isGone(store: ProjectStore): boolean {
    return this.#options.session.getSnapshot().store !== store;
  }

  #follow(): void {
    const { store, key } = this.#options.session.getSnapshot();
    const before = this.#run;
    if (before && before.store === store && before.key === key) return;
    if (before) {
      before.over.abort();
      this.#done.add(before.store);
    }
    this.#run = undefined;
    if (!store || key === undefined) {
      this.#set(NOTHING);
      return;
    }
    let folderComes = () => {};
    const folderCame = new Promise<void>((resolve) => {
      folderComes = resolve;
    });
    const run: Run = {
      store,
      key,
      step: "log",
      cloud: undefined,
      over: new AbortController(),
      folder: undefined,
      folderCame,
      folderComes,
    };
    this.#run = run;
    this.#show(run);
    void this.#go(run).catch((error: unknown) => {
      console.warn("Opening the project did not go as it should", error);
      // Whatever it is, the project goes on as it would without this.
      if (this.#run === run) void this.#goLive(run);
    });
  }

  #isOver(run: Run): boolean {
    return run.over.signal.aborted || this.#run !== run;
  }

  async #go(run: Run): Promise<void> {
    // 1. What this device kept with the log.
    await this.#within(this.#options.undoLoaded(run.store), this.#timing.undoMs, run);
    if (this.#isOver(run)) return;
    // Which project of the platform a folder is goes by the folder, which has to be there.
    if (this.#options.isFolder(run.key)) {
      await Promise.race([run.folderCame, this.#overOf(run)]);
      if (this.#isOver(run)) return;
    }
    // 2. What the platform has.
    run.step = "cloud";
    this.#show(run);
    run.cloud = await this.#catchUp(run);
    if (this.#isOver(run)) return;
    // 3. The folder.
    run.step = "folder";
    this.#show(run);
    if (run.folder) {
      await this.#startFolder(run.folder);
      if (this.#isOver(run)) return;
    }
    // 4. Both go on.
    await this.#goLive(run);
  }

  /** Starts the folder, and tells whoever attached it what came of that. */
  async #startFolder(folder: NonNullable<Run["folder"]>): Promise<void> {
    let started: Promise<void>;
    try {
      started = folder.start();
    } catch (error) {
      started = Promise.reject(error);
    }
    folder.done(started);
    // Where it failed, the project goes on all the same: whoever attached the folder hears why.
    await started.catch(() => {});
  }

  async #goLive(run: Run): Promise<void> {
    if (run.step === "live") return;
    // A folder that waited for a step that failed still starts.
    if (run.folder && run.step !== "folder") {
      run.step = "folder";
      await this.#startFolder(run.folder);
      if (this.#isOver(run)) return;
    }
    run.step = "live";
    this.#done.add(run.store);
    this.#show(run);
    this.#options.live?.(run.store);
  }

  /** Waits for what the platform has, see `CatchUp`. */
  async #catchUp(run: Run): Promise<CatchUp> {
    const { cloud } = this.#options;
    if (!cloud) return "none";
    await cloud.follow();
    if (this.#isOver(run)) return "closed";
    const sync = cloud.syncOf(run.key);
    if (!sync) return "none";
    if (!this.#env.isOnline()) return "offline";
    return new Promise<CatchUp>((resolve) => {
      let stop = () => {};
      let timer: unknown;
      const end = (outcome: CatchUp) => {
        stop();
        this.#env.clearTimeout(timer);
        run.over.signal.removeEventListener("abort", closed);
        resolve(outcome);
      };
      const closed = () => end("closed");
      const look = () => {
        switch (sync.getSnapshot().state) {
          case "online":
            end("caught-up");
            return;
          case "offline":
            end("offline");
            return;
          // It could not connect, and tries again later; or waits for people.
          case "reconnecting":
          case "paused":
          case "closed":
            end("failed");
            return;
          case "starting":
          case "connecting":
            return;
        }
      };
      timer = this.#env.setTimeout(() => end("timeout"), this.#timing.catchUpMs);
      run.over.signal.addEventListener("abort", closed, { once: true });
      stop = sync.subscribe(look);
      look();
    });
  }

  /** Waits for `work`, but not longer than `ms`, nor once the opening is over. */
  async #within(work: Promise<unknown>, ms: number, run: Run): Promise<void> {
    let timer: unknown;
    await Promise.race([
      work.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = this.#env.setTimeout(resolve, ms);
      }),
      this.#overOf(run),
    ]);
    this.#env.clearTimeout(timer);
  }

  #overOf(run: Run): Promise<void> {
    return new Promise<void>((resolve) => {
      if (run.over.signal.aborted) resolve();
      else run.over.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  #show(run: Run): void {
    if (this.#run !== run) return;
    this.#set({ key: run.key, step: run.step, cloud: run.cloud });
  }

  #set(snapshot: OpeningSnapshot): void {
    const before = this.#snapshot;
    if (
      before.key === snapshot.key &&
      before.step === snapshot.step &&
      before.cloud === snapshot.cloud
    )
      return;
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }
}
