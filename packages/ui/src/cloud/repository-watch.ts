import {
  CloudSignedOut,
  RepositoryRefused,
  type RepositoryAccess,
  type RepositoryRefusal,
  type RepositoryStatus,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * How archiving a project of the platform into its GitHub repository goes, as the window keeps up
 * with it (docs/design/phase5-step14.md 3.1.10): the platform archives by itself, and this asks it
 * over HTTP, as the sync protocol has no word for it.
 *
 * - While the repository cannot be used, every 5 minutes in the back as well: whether the project
 *   can be edited goes by it, also for other windows of the project, see `CloudProjects`.
 * - Once a minute while the window is in front, and once when it comes back to the front. A window
 *   in the back does not ask: every window of the browser asks with the same session, which the
 *   platform counts (120 in ten minutes where it cannot tell the address).
 * - After "archive now", or a new repository, every 3 seconds until the archive is done, for at most
 *   2 minutes.
 * - Once more, a moment after the project changed, where what the platform said last is that
 *   everything is archived: that is of before the change, see `noteSeq`. Not for every change:
 *   once it says that changes wait, it is right about that until they are archived.
 * - Never more than `budget` questions in ten minutes, whatever else says; a "busy" waits as long
 *   as the platform says.
 *
 * "Archive now" the platform takes once a minute: one too soon waits here until it may go.
 */

export interface RepositoryTiming {
  /** How often to ask while the window is in front. */
  readonly everyMs: number;
  /** How often to ask while an archive people asked for runs... */
  readonly hurryMs: number;
  /** ...for at most this long. */
  readonly hurryForMs: number;
  /** At most this many questions in `budgetMs`. */
  readonly budget: number;
  readonly budgetMs: number;
  /**
   * How long after the project changed the platform is asked again, where what it said last is
   * of before the change, see `RepositoryWatch.noteSeq`: changes that come together count once.
   */
  readonly aheadMs: number;
  /** ...and not more often than this, whatever it answers. */
  readonly aheadEveryMs: number;
  /**
   * How often to ask while the window is in the back and the repository cannot be used: what the
   * platform says decides whether the project can be edited, also in a window people do not see,
   * which other windows of the project may go by.
   */
  readonly heldMs: number;
}

export const REPOSITORY_TIMING: RepositoryTiming = {
  everyMs: 60_000,
  hurryMs: 3000,
  hurryForMs: 120_000,
  budget: 80,
  budgetMs: 10 * 60_000,
  aheadMs: 1500,
  aheadEveryMs: 15_000,
  heldMs: 5 * 60_000,
};

export interface RepositoryEnvironment {
  /** Whether the window is in front, where people see it. */
  isVisible(): boolean;
  /** The window came back to the front. Returns how to stop listening. */
  onVisible(listener: () => void): () => void;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  now(): number;
}

export const pageRepositoryEnvironment = (): RepositoryEnvironment => ({
  isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  onVisible(listener) {
    if (typeof document === "undefined") return () => {};
    const onChange = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

/** Why the last question got no status: people are signed out, or the platform said no. */
export type RepositoryTrouble = "signedOut" | RepositoryRefusal;

export interface RepositoryWatchSnapshot {
  /** What the platform said last, kept while it cannot be asked. Undefined until it said anything. */
  readonly status: RepositoryStatus | undefined;
  /** When the platform said that. */
  readonly checkedAt: number | undefined;
  /** Why the last question got no answer. */
  readonly trouble: RepositoryTrouble | undefined;
  /** An archive people asked for is on its way: asked often. */
  readonly hurrying: boolean;
  /** "Archive now" waits for the platform to take it again, until then. */
  readonly archiveAt: number | undefined;
}

/** How "archive now" went. */
export type ArchiveNowOutcome =
  | { readonly kind: "started" }
  /** The platform takes one a minute: it goes by itself at `at`. */
  | { readonly kind: "waiting"; readonly at: number }
  | {
      readonly kind: "refused";
      readonly code: RepositoryTrouble;
      readonly error?: RepositoryRefused;
    };

const EMPTY: RepositoryWatchSnapshot = {
  status: undefined,
  checkedAt: undefined,
  trouble: undefined,
  hurrying: false,
  archiveAt: undefined,
};

export interface RepositoryWatchOptions {
  readonly access: RepositoryAccess;
  /** The project, by its id on the platform. */
  readonly project: string;
  readonly timing?: Partial<RepositoryTiming>;
  readonly environment?: RepositoryEnvironment;
}

export class RepositoryWatch {
  readonly project: string;
  readonly #access: RepositoryAccess;
  readonly #timing: RepositoryTiming;
  readonly #env: RepositoryEnvironment;
  readonly #emitter = new Emitter();
  #snapshot: RepositoryWatchSnapshot = EMPTY;
  #timer: unknown;
  #archiveTimer: unknown;
  /** When people last asked for an archive, for how long to hurry. */
  #hurrySince: number | undefined;
  /** The platform said to wait until then. */
  #quietUntil = 0;
  /** When the questions in the last `budgetMs` went. */
  #asked: number[] = [];
  #asking: Promise<void> | undefined;
  #stopVisible: (() => void) | undefined;
  #closed = false;
  #started = false;
  /** The last update of the platform that the project here has, as syncing says, see `noteSeq`. */
  #seq = 0;
  #aheadTimer: unknown;
  /** When the platform was last asked because its word was of before a change. */
  #aheadAskedAt: number | undefined;

  constructor(options: RepositoryWatchOptions) {
    this.project = options.project;
    this.#access = options.access;
    this.#timing = { ...REPOSITORY_TIMING, ...options.timing };
    this.#env = options.environment ?? pageRepositoryEnvironment();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): RepositoryWatchSnapshot => this.#snapshot;

  get status(): RepositoryStatus | undefined {
    return this.#snapshot.status;
  }

  #set(change: Partial<RepositoryWatchSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit();
    // What it says now can be of before a change as well.
    if (change.status) this.#lookAhead();
  }

  /**
   * What syncing says: the last update of the platform that the project here has. Where that is
   * past what the platform's last word about archiving knew of (`RepositoryStatus.head`), and
   * that word is that everything is archived, it is of before a change: "archived just now" would
   * stay there for up to a minute with a change waiting. The platform is asked again then, once
   * a moment passed, so that changes that come together count once. Once it says that changes
   * wait, it is right about that however many more come, until they are archived: nothing more
   * is asked for those, and how long they wait is kept up with as ever.
   */
  noteSeq(seq: number): void {
    if (seq <= this.#seq) return;
    this.#seq = seq;
    this.#lookAhead();
  }

  /** Whether the platform's last word says "all archived" of a project that changed since. */
  #isBehind(): boolean {
    const status = this.#snapshot.status;
    if (!status || status.state !== "ready" || this.#seq <= status.head) return false;
    return (
      !status.archiving && status.dirtySince === undefined && status.head <= status.archivedSeq
    );
  }

  #lookAhead(): void {
    if (this.#closed || !this.#started || this.#aheadTimer !== undefined) return;
    if (!this.#isBehind()) return;
    const now = this.#env.now();
    const wait = Math.max(
      this.#timing.aheadMs,
      this.#aheadAskedAt === undefined ? 0 : this.#aheadAskedAt + this.#timing.aheadEveryMs - now,
    );
    this.#aheadTimer = this.#env.setTimeout(() => {
      this.#aheadTimer = undefined;
      // A window in the back does not ask: coming back does. And what was asked meanwhile, as
      // every minute, may have said it already.
      if (this.#closed || !this.#env.isVisible() || !this.#isBehind()) return;
      this.#aheadAskedAt = this.#env.now();
      void this.refresh();
    }, wait);
  }

  /** Asks now, and from then on as the window goes. */
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#stopVisible = this.#env.onVisible(() => void this.refresh());
    void this.refresh();
  }

  close(): void {
    this.#closed = true;
    this.#stopVisible?.();
    this.#stopVisible = undefined;
    this.#env.clearTimeout(this.#timer);
    this.#env.clearTimeout(this.#archiveTimer);
    this.#env.clearTimeout(this.#aheadTimer);
    this.#timer = undefined;
    this.#archiveTimer = undefined;
    this.#aheadTimer = undefined;
  }

  /** Asks the platform now, unless a question is on its way already, or it said to wait. */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#asking ??= this.#ask().finally(() => {
      this.#asking = undefined;
      this.#schedule();
    });
    return this.#asking;
  }

  /** What the platform said in answer to something else, such as linking a repository. */
  take(status: RepositoryStatus, { hurry = false } = {}): void {
    if (this.#closed) return;
    if (hurry) this.#hurrySince = this.#env.now();
    this.#set({
      status,
      checkedAt: this.#env.now(),
      trouble: undefined,
      hurrying: hurry || this.#isHurrying(status),
    });
    this.#schedule();
  }

  get #hurryOver(): boolean {
    return (
      this.#hurrySince === undefined ||
      this.#env.now() - this.#hurrySince >= this.#timing.hurryForMs
    );
  }

  #isHurrying(status: RepositoryStatus | undefined): boolean {
    return !this.#hurryOver && status?.archiving === true;
  }

  async #ask(): Promise<void> {
    const now = this.#env.now();
    if (now < this.#quietUntil || !this.#withinBudget(now)) return;
    this.#asked.push(now);
    try {
      const status = await this.#access.status(this.project);
      if (this.#closed) return;
      this.#set({
        status,
        checkedAt: this.#env.now(),
        trouble: undefined,
        hurrying: this.#isHurrying(status),
      });
    } catch (error) {
      if (this.#closed) return;
      const trouble = troubleOf(error);
      if (error instanceof RepositoryRefused && error.code === "busy")
        this.#quietUntil = this.#env.now() + (error.retryAfter ?? 60) * 1000;
      this.#set({ trouble, hurrying: trouble === "signedOut" ? false : this.#snapshot.hurrying });
    }
  }

  #withinBudget(now: number): boolean {
    this.#asked = this.#asked.filter((at) => now - at < this.#timing.budgetMs);
    return this.#asked.length < this.#timing.budget;
  }

  /** When to ask next: soon while hurrying, now and then otherwise, never while in the back. */
  #schedule(): void {
    this.#env.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed || !this.#started) return;
    // Signed out: nothing to ask until someone signs in, which asks again, see `CloudProjects`.
    if (this.#snapshot.trouble === "signedOut") return;
    // In the back only while the repository cannot be used, and less often.
    const isHeld = this.#snapshot.status?.unusable !== undefined;
    if (!this.#env.isVisible() && !isHeld) return;
    const now = this.#env.now();
    let wait = !this.#env.isVisible()
      ? this.#timing.heldMs
      : this.#snapshot.hurrying
        ? this.#timing.hurryMs
        : this.#timing.everyMs;
    wait = Math.max(wait, this.#quietUntil - now);
    this.#asked = this.#asked.filter((at) => now - at < this.#timing.budgetMs);
    const oldest = this.#asked[0];
    if (this.#asked.length >= this.#timing.budget && oldest !== undefined)
      wait = Math.max(wait, oldest + this.#timing.budgetMs - now);
    this.#timer = this.#env.setTimeout(() => {
      this.#timer = undefined;
      // Gone to the back meanwhile: coming back asks, unless the repository cannot be used.
      if (this.#env.isVisible() || this.#snapshot.status?.unusable !== undefined)
        void this.refresh();
    }, wait);
  }

  /**
   * Archives now. `replace`: for a pause because files changed on GitHub, the commit people saw
   * them on, which the archive goes on top of with the editor's content.
   */
  async archiveNow(options: { readonly replace?: string } = {}): Promise<ArchiveNowOutcome> {
    if (this.#closed) return { kind: "refused", code: "unavailable" };
    this.#env.clearTimeout(this.#archiveTimer);
    this.#archiveTimer = undefined;
    try {
      const status = await this.#access.archiveNow(this.project, options);
      this.#set({ archiveAt: undefined });
      this.take(status, { hurry: true });
      return { kind: "started" };
    } catch (error) {
      if (this.#closed) return { kind: "refused", code: "unavailable" };
      const code = troubleOf(error);
      const refused = error instanceof RepositoryRefused ? error : undefined;
      if (code === "busy") {
        // Once a minute: it goes by itself once the platform takes it again.
        const at = this.#env.now() + (refused?.retryAfter ?? 60) * 1000;
        this.#set({ archiveAt: at });
        this.#archiveTimer = this.#env.setTimeout(() => {
          this.#archiveTimer = undefined;
          void this.archiveNow(options);
        }, at - this.#env.now());
        return { kind: "waiting", at };
      }
      this.#set({ archiveAt: undefined });
      void this.refresh();
      return { kind: "refused", code, ...(refused && { error: refused }) };
    }
  }
}

const troubleOf = (error: unknown): RepositoryTrouble => {
  if (error instanceof CloudSignedOut) return "signedOut";
  if (error instanceof RepositoryRefused) return error.code;
  return "unavailable";
};
