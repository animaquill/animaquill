/**
 * Opening a project, one step after the other, see the design of data and syncing (AnimaQuill
 * Cloud), 2.5: what it changes in, and from where, is in an order that one place says, not in the
 * order that the parts happen to start in.
 *
 * 1. `log`: the project is open from its log here (`ProjectSession.open`), and what this device
 *    kept with it is taken up: the undo logs of AI tasks and batches of files (`UndoKeeper`).
 * 2. `cloud`: online, where the browser is online, what the platform has comes first, until the
 *    project has all of it, or for `catchUpMs` at most.
 * 3. `folder`: offline, a project folder is compared with the project (`FolderSession.start`), and
 *    what changed in it while the editor was away comes in.
 * 4. `live`: it goes on as changes come: what AI tools on this computer wrote is looked at, and
 *    files that are not here start to download.
 *
 * A project has one of the two (docs/design/online-offline.md of AnimaQuill Cloud): online it is a
 * copy that syncs, offline a folder, or only the log in this browser.
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
  /**
   * The platform let go of its copy, which comes back from the repository meanwhile, as the step of
   * the platform found (`CloudSnapshot.restoring`): it waits for it as long as it waits at all.
   */
  readonly restoring?: boolean;
}

/** What opening needs of the syncing of a project, see `CloudProjects`. */
export interface OpeningCloud {
  /** Finds out whether the open project syncs, and starts syncing it where it does. */
  follow(): Promise<void>;
  /** How the project of this key syncs, where it does and is on the platform. */
  syncOf(key: string): OpeningSync | undefined;
}

export interface OpeningSync {
  getSnapshot(): Pick<CloudSnapshot, "state" | "restoring">;
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
   * Whether the project of this key opens as a folder: then it waits for the folder to be there,
   * so that what changed in it comes in before the project is live.
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
  /** See `OpeningSnapshot.restoring`. */
  restoring: boolean;
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
    // Given up on, see `giveUp`: nothing of it starts.
    if (run?.store === store && run.over.signal.aborted) return Promise.resolve();
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

  /**
   * The open project is being left: whatever of its opening did not happen yet does not, also as
   * its parts close one by one before the project does. Its folder does not start.
   */
  giveUp(): void {
    const run = this.#run;
    if (!run || run.step === "live") return;
    run.over.abort();
    this.#done.add(run.store);
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
      restoring: false,
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
    // 2. What the platform has.
    run.step = "cloud";
    this.#show(run);
    run.cloud = await this.#catchUp(run);
    if (this.#isOver(run)) return;
    // A folder is waited for, but not for ever: should it come after all, it starts as it comes,
    // see `folder`.
    if (this.#options.isFolder(run.key) && !run.folder) {
      const came = await this.#within(run.folderCame, this.#timing.catchUpMs, run);
      if (this.#isOver(run)) return;
      if (!came) console.warn("The folder of the project did not come: it opens without");
    }
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
    if (run.step === "live" || this.#isOver(run)) return;
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

  /**
   * Waits for what the platform has, see `CatchUp`: `catchUpMs` at most, from finding out whether
   * the project syncs on.
   */
  async #catchUp(run: Run): Promise<CatchUp> {
    const { cloud } = this.#options;
    if (!cloud) return "none";
    let timer: unknown;
    const late = new Promise<"timeout">((resolve) => {
      timer = this.#env.setTimeout(() => resolve("timeout"), this.#timing.catchUpMs);
    });
    try {
      const followed = await Promise.race([
        cloud.follow().then(() => "followed" as const),
        late,
        this.#overOf(run).then(() => "closed" as const),
      ]);
      if (followed !== "followed") return followed;
      if (this.#isOver(run)) return "closed";
      const sync = cloud.syncOf(run.key);
      if (!sync) return "none";
      if (!this.#env.isOnline()) return "offline";
      return await this.#caughtUp(run, sync, late);
    } finally {
      this.#env.clearTimeout(timer);
    }
  }

  /** Waits for `sync` to have what the platform has, or to fail, or for `late`. */
  #caughtUp(run: Run, sync: OpeningSync, late: Promise<"timeout">): Promise<CatchUp> {
    return new Promise<CatchUp>((resolve) => {
      let stop = () => {};
      let isEnded = false;
      const end = (outcome: CatchUp) => {
        if (isEnded) return;
        isEnded = true;
        stop();
        run.over.signal.removeEventListener("abort", closed);
        resolve(outcome);
      };
      const closed = () => end("closed");
      const look = () => {
        const snapshot = sync.getSnapshot();
        // On its way back from the repository: the line is not what is wrong, and it waits.
        if (snapshot.restoring !== undefined && snapshot.state !== "online") {
          if (!run.restoring) {
            run.restoring = true;
            this.#show(run);
          }
          return;
        }
        switch (snapshot.state) {
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
      void late.then(end);
      run.over.signal.addEventListener("abort", closed, { once: true });
      stop = sync.subscribe(look);
      look();
    });
  }

  /**
   * Waits for `work`, but not longer than `ms`, nor once the opening is over. Resolves to whether
   * the work was over first.
   */
  async #within(work: Promise<unknown>, ms: number, run: Run): Promise<boolean> {
    let timer: unknown;
    const done = await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = this.#env.setTimeout(() => resolve(false), ms);
      }),
      this.#overOf(run).then(() => false),
    ]);
    this.#env.clearTimeout(timer);
    return done;
  }

  #overOf(run: Run): Promise<void> {
    return new Promise<void>((resolve) => {
      if (run.over.signal.aborted) resolve();
      else run.over.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  #show(run: Run): void {
    if (this.#run !== run) return;
    this.#set({
      key: run.key,
      step: run.step,
      cloud: run.cloud,
      ...(run.restoring && { restoring: true }),
    });
  }

  #set(snapshot: OpeningSnapshot): void {
    const before = this.#snapshot;
    if (
      before.key === snapshot.key &&
      before.step === snapshot.step &&
      before.cloud === snapshot.cloud &&
      before.restoring === snapshot.restoring
    )
      return;
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }
}
