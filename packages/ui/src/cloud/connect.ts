import type {
  AccountAccess,
  CloudLink,
  RepositoryAccess,
  RepositoryRefusal,
  RepositoryStatus,
  SyncRejection,
  WindowMemory,
} from "@animaquill/host";
import type { TFunction } from "i18next";
import { Emitter } from "../workbench/emitter.ts";
import type { CloudProjects, LinkRefusal } from "./projects.ts";
import { RepositoryPicker, type PickerMode } from "./repository-picker.ts";
import { connectRepositoryName, pauseText } from "./repository-text.ts";
import type { CloudProblem, CloudSession } from "./session.ts";

/**
 * Connecting a project to the platform in one dialog, see the design of the start page
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud), 3: a project of the platform always has a
 * repository, so people choose it here, and one press does the rest, in three steps:
 *
 * 1. "upload": the project gets a link, and its first connection makes it on the platform, see
 *    `CloudProjects.beginLink`. What keeps it from getting there shows, and the link stays: the
 *    next try goes on with the same project, which the platform has by then or makes.
 * 2. "repository": a new private repository, or one people have, see `RepositoryPicker`. What the
 *    platform says no to shows where people chose, and they choose again.
 * 3. "archive": the first archive, which the platform does by itself. Nothing is taken back where
 *    it does not get there: the project is connected and has its repository, and archiving goes on,
 *    or says what it waits for, in the panel of the platform.
 *
 * Before anything is made, the platform is asked whether what people chose can be: a name that is
 * taken, a repository that holds another project. And first of all people have to be signed in,
 * with the GitHub App on their account: both leave the page, so what the dialog was at goes into
 * what the window remembers, see `takeIntent`, and the dialog comes back with it.
 *
 * Giving up before the project has its repository takes back what the dialog made: the project
 * on the platform goes, and the link, see `CloudProjects.abandonConnect`. Nothing is left that
 * people did not ask for. Only what this try made, though: the link it made itself, or the one it
 * made before the page left to sign in, which what the window remembers says. A link that was
 * there when the dialog opened is not the dialog's to take back, whether or not its project got
 * to the platform yet: another computer may be working on that project by now. It only gets what
 * is missing, and stays whatever people do here; so does a project from before every project of
 * the platform had a repository.
 *
 * No DOM: the dialog shows the snapshot, and the picker's.
 */

export interface ConnectTiming {
  /**
   * How long the first version of the project may be on its way without a connection before the
   * dialog says that the platform cannot be reached. It goes on trying after that.
   */
  readonly patienceMs: number;
  /** How long after people last changed what they chose the platform is asked about it. */
  readonly checkMs: number;
}

export const CONNECT_TIMING: ConnectTiming = { patienceMs: 8000, checkMs: 400 };

/** The clock of the dialog. The page's, unless a test says so. */
export interface ConnectEnvironment {
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (timer: unknown) => void;
  now(): number;
}

const pageClock = (): ConnectEnvironment => ({
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

export type ConnectStepId = "upload" | "repository" | "archive";
export type ConnectStepState = "waiting" | "running" | "done" | "failed";

/** What has to be there before people can choose anything. */
export type ConnectNeed =
  /** Who is signed in is not known yet. */
  | "account"
  | "signIn"
  /** The GitHub App on the person's account. */
  | "installApp";

/** Why a step stopped. */
export type ConnectProblem =
  | {
      readonly step: "upload";
      /**
       * It could not begin, see `LinkRefusal`; there is no network ("offline") or no platform at
       * the other end ("unreachable"), which it gets over by itself; or the platform does not take
       * the project: nobody is signed in, the editor is too old, the project is too large or more
       * than the person may keep, or something else, see `reason`. "stopped": syncing ended, as
       * where another window disconnected the project. "undone": the platform would not make the
       * project, as connecting it was given up on before, see `CloudProblem`; the link is gone,
       * and trying again starts anew. "missing": the same where the project may be of another
       * account than the one that is signed in, which keeps its link.
       */
      readonly code:
        | LinkRefusal
        | "offline"
        | "unreachable"
        | "signedOut"
        | "outdated"
        | "tooLarge"
        | "quota"
        | "rejected"
        | "undone"
        | "missing"
        | "stopped";
      readonly reason?: SyncRejection;
    }
  | {
      readonly step: "repository";
      /** What the platform said, or "choice" where it shows at what people chose. */
      readonly code: RepositoryRefusal | "signedOut" | "choice";
    }
  | {
      readonly step: "archive";
      /** Archiving paused, see `RepositoryStatus.reason`, or failed and is tried again. */
      readonly code: "paused" | "retrying";
      readonly status: RepositoryStatus;
    };

export interface ConnectSnapshot {
  readonly need: ConnectNeed | undefined;
  /** What people know the account by, once someone is signed in: whose the new repository is. */
  readonly account: string | undefined;
  /** The project is on the platform already: only its repository and the first archive are left. */
  readonly repositoryOnly: boolean;
  /**
   * "choosing": people choose, and can go on. "working": the first two steps run. "archiving":
   * the project is connected and has its repository, and the first archive is on its way or
   * waits: the dialog can close. "done": the first archive is there. "cancelled": people gave up,
   * and the project is one of this computer only again. That can also come true by itself, after
   * `unconfirmed`: once it turns out that the platform took the project away after all, see
   * `CloudProjects`. The dialog is over then, without anyone having pressed anything.
   */
  readonly phase: "choosing" | "working" | "archiving" | "done" | "cancelled";
  readonly steps: Readonly<Record<ConnectStepId, ConnectStepState>>;
  readonly problem: ConnectProblem | undefined;
  /** What the dialog made is being taken back. */
  readonly cancelling: boolean;
  /**
   * Giving up could not make sure that the platform has nothing left of the project, as without a
   * network: the project stays connected, without a repository, until people try again or say
   * to let go all the same, see `cancel`.
   */
  readonly unconfirmed: boolean;
  /** The repository the project is saved to, once it is. */
  readonly linked: RepositoryStatus | undefined;
}

/** What the dialog was at when the page left, see `takeIntent`. */
export interface ConnectIntent {
  /** The project, by what this browser keeps it by. */
  readonly key: string;
  /** When, in milliseconds since 1970. */
  readonly at: number;
  readonly mode: PickerMode;
  readonly name: string;
  /** Whether people typed the name themselves, see `PickerSnapshot.nameTouched`. */
  readonly touched: boolean;
  readonly selected?: number;
  /** The project of the platform that the dialog made, which giving up takes away again. */
  readonly created?: string;
}

/** Where the window remembers what the dialog was at, see `Host.windowMemory`. */
const INTENT_KEY = "cloud.connect";
/** After this long people are doing something else. */
const INTENT_MS = 30 * 60_000;

const isIntent = (value: unknown): value is ConnectIntent => {
  const intent = value as Partial<ConnectIntent> | null;
  return (
    typeof intent === "object" &&
    intent !== null &&
    typeof intent.key === "string" &&
    typeof intent.at === "number" &&
    (intent.mode === "create" || intent.mode === "existing") &&
    typeof intent.name === "string" &&
    typeof intent.touched === "boolean" &&
    (intent.selected === undefined || typeof intent.selected === "number") &&
    (intent.created === undefined || typeof intent.created === "string")
  );
};

/**
 * What the dialog that connects the project this browser keeps by `key` was at when the page left,
 * as to sign in, once: the window forgets it as it says it. Undefined where it was at nothing, at
 * another project, or too long ago.
 */
export function takeIntent(
  memory: WindowMemory,
  key: string,
  now: number,
): ConnectIntent | undefined {
  const kept = memory.read(INTENT_KEY);
  if (kept === undefined || kept === "") return undefined;
  memory.write(INTENT_KEY, "");
  try {
    const intent: unknown = JSON.parse(kept);
    if (!isIntent(intent) || intent.key !== key) return undefined;
    return now - intent.at >= 0 && now - intent.at < INTENT_MS ? intent : undefined;
  } catch {
    return undefined;
  }
}

export interface CloudConnectOptions {
  readonly projects: CloudProjects;
  readonly access: RepositoryAccess;
  readonly account: AccountAccess;
  /** The open project: what this browser keeps it by, and what it and its folder are called. */
  readonly key: string;
  readonly name: string;
  readonly folder: string | undefined;
  /** Signs in: the page goes and comes back. */
  readonly signIn: () => Promise<void> | void;
  /** Leaves the page to install the GitHub App on the account, and comes back. */
  readonly installApp?: () => Promise<void> | void;
  /**
   * Whether the page is going away now, after `signIn` or `installApp` were asked for: people can
   * stay after all, as with something that is not saved. Without it, it is taken to go.
   */
  readonly leaving?: () => boolean;
  readonly memory?: WindowMemory;
  /** What the dialog was at when the page left, see `takeIntent`. */
  readonly intent?: ConnectIntent;
  readonly timing?: Partial<ConnectTiming>;
  readonly environment?: ConnectEnvironment;
}

const WAITING: ConnectSnapshot["steps"] = {
  upload: "waiting",
  repository: "waiting",
  archive: "waiting",
};

/** Whether something says when it is over, as a promise does. */
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === "function";

/**
 * What keeps a project from getting to the platform, as the dialog says it. `isOwn`: whether the
 * project is one of whoever is signed in, as far as its link says.
 */
const uploadProblemOf = (problem: CloudProblem, isOwn: boolean): ConnectProblem => {
  switch (problem.kind) {
    case "missing":
      // The platform would not make it: given up on before, unless it is somebody else's.
      return { step: "upload", code: problem.unmade && isOwn ? "undone" : "missing" };
    case "signed-out":
      return { step: "upload", code: "signedOut" };
    case "outdated":
      return { step: "upload", code: "outdated" };
    case "unsupported":
      return { step: "upload", code: "unsupported" };
    case "rejected":
      if (problem.reason === "too-large") return { step: "upload", code: "tooLarge" };
      if (problem.reason === "quota") return { step: "upload", code: "quota" };
      return { step: "upload", code: "rejected", reason: problem.reason };
    default:
      return { step: "upload", code: "stopped" };
  }
};

export class CloudConnect {
  /** What people choose: a new repository by its name, or one they have. */
  readonly picker: RepositoryPicker;
  /** What the project is called, for the title. */
  readonly name: string;
  readonly #projects: CloudProjects;
  readonly #access: RepositoryAccess;
  readonly #account: AccountAccess;
  readonly #key: string;
  readonly #options: CloudConnectOptions;
  readonly #timing: ConnectTiming;
  readonly #env: ConnectEnvironment;
  readonly #emitter = new Emitter();
  readonly #stops: (() => void)[] = [];
  #snapshot: ConnectSnapshot;
  #closed = false;
  /** The project is on the platform, as far as this dialog knows. */
  #uploaded: boolean;
  /**
   * The project of the platform that this try to connect made: giving up takes it away. Only one
   * whose link this dialog made itself, or made before the page left, see `ConnectIntent.created`.
   */
  #created: string | undefined;
  /** A link is being made right now: giving up waits for it, and takes it back. */
  #beginning: Promise<unknown> | undefined;
  /** The platform said that nobody is signed in, whatever the account says: only signing in helps. */
  #sawSignedOut = false;
  /** The page was asked to leave, to sign in or to install the App. */
  #left = false;
  /** A repository of the list to choose once the list has it, as before the page left. */
  #toSelect: number | undefined;
  /** A repository is being made or linked: giving up waits for what comes of it. */
  #linking: Promise<unknown> | undefined;
  /** Hears how the first archive goes, once it is on its way. */
  #stopArchive: (() => void) | undefined;

  constructor(options: CloudConnectOptions) {
    const { projects, access, account, intent } = options;
    this.#options = options;
    this.#projects = projects;
    this.#access = access;
    this.#account = account;
    this.#key = options.key;
    this.name = options.name;
    this.#timing = { ...CONNECT_TIMING, ...options.timing };
    this.#env = options.environment ?? pageClock();
    this.#uploaded = projects.isOnPlatform;
    // A link that is there already is not of this try, however far it got: only what the window
    // remembers of the dialog before the page left says otherwise.
    this.#created = intent?.created;
    const who = account.getSnapshot();
    this.picker = new RepositoryPicker({
      access,
      project: () => this.#link()?.project,
      name: intent?.name ?? connectRepositoryName(options.folder, options.name),
      ...(who.status === "signedIn" && { owner: who.name, appInstalled: who.appInstalled }),
      precheck: {
        delayMs: this.#timing.checkMs,
        canAsk: () => !this.#closed && this.#needOf() === undefined,
        setTimeout: this.#env.setTimeout,
        clearTimeout: this.#env.clearTimeout,
      },
    });
    this.#snapshot = {
      need: this.#needOf(),
      account: who.status === "signedIn" ? who.name : undefined,
      repositoryOnly: this.#uploaded,
      phase: "choosing",
      steps: { ...WAITING, ...(this.#uploaded && { upload: "done" as const }) },
      problem: undefined,
      cancelling: false,
      unconfirmed: false,
      linked: undefined,
    };
    if (intent) {
      if (intent.touched) this.picker.setName(intent.name);
      if (intent.mode === "existing") {
        this.#toSelect = intent.selected;
        this.picker.setMode("existing");
      }
    }
    this.#stops.push(
      account.subscribe(() => this.#followAccount()),
      this.picker.subscribe(() => this.#followPicker()),
      projects.subscribe(() => this.#followProjects()),
    );
    // Asks once more: the dialog is where it matters most that the answer is right.
    void account.refresh();
    if (this.#snapshot.need === undefined) this.picker.recheck();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ConnectSnapshot => this.#snapshot;

  #set(change: Partial<ConnectSnapshot>): void {
    if (this.#closed) return;
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit();
  }

  #step(id: ConnectStepId, state: ConnectStepState): void {
    this.#set({ steps: { ...this.#snapshot.steps, [id]: state } });
  }

  /** The link of the project, where this window syncs it. */
  #link(): CloudLink | undefined {
    const snapshot = this.#projects.getSnapshot();
    return snapshot.kind === "linked" && snapshot.link.key === this.#key
      ? snapshot.link
      : undefined;
  }

  #session(): CloudSession | undefined {
    const snapshot = this.#projects.getSnapshot();
    return snapshot.kind === "linked" && snapshot.link.key === this.#key
      ? snapshot.session
      : undefined;
  }

  #needOf(): ConnectNeed | undefined {
    const who = this.#account.getSnapshot();
    if (this.#sawSignedOut || who.status === "signedOut") return "signIn";
    if (who.status === "unknown") return "account";
    // What the account says, or what the platform said when it was asked for repositories.
    if (!who.appInstalled || this.picker.getSnapshot().notInstalled) return "installApp";
    return undefined;
  }

  #followAccount(): void {
    const who = this.#account.getSnapshot();
    const before = this.#snapshot.need;
    const need = this.#needOf();
    // Whose the new repository is: known only now where the dialog opened before the account was.
    this.picker.setOwner(who.status === "signedIn" ? who.name : undefined);
    this.#set({ need, account: who.status === "signedIn" ? who.name : undefined });
    if (before === undefined || need !== undefined) return;
    // Now the platform can be asked.
    const { mode, list } = this.picker.getSnapshot();
    if (mode === "existing" && list.state !== "ready" && list.state !== "loading")
      void this.picker.refresh();
    this.picker.recheck();
  }

  #followPicker(): void {
    const { list, selected } = this.picker.getSnapshot();
    if (this.#toSelect !== undefined && list.state === "ready") {
      const wanted = this.#toSelect;
      this.#toSelect = undefined;
      if (selected === undefined) this.picker.select(wanted);
    }
    // Whoever shows the dialog hears of what people choose here too.
    this.#set({ need: this.#needOf() });
  }

  #followProjects(): void {
    if (this.#closed) return;
    const { phase, problem, steps, unconfirmed, cancelling } = this.#snapshot;
    // Giving up could not make sure that the project is gone, and now it is not connected any
    // more: the platform would not make it again, see `CloudProjects`.
    if (unconfirmed && !cancelling && this.#projects.getSnapshot().kind !== "linked")
      void this.#seeUndone();
    // The project got to the platform after the dialog said that it could not: the step is done,
    // and going on is people's to say.
    if (phase !== "choosing" || this.#uploaded) return;
    if (steps.upload === "waiting") {
      // Known only now, as right after the project opened: it is on the platform already.
      if (!this.#projects.isOnPlatform) return;
      this.#uploaded = true;
      // It was there before this try did anything: not this try's to take back, unless the
      // dialog made it before the page left.
      if (this.#created !== this.#options.intent?.created) this.#created = undefined;
      this.#set({ repositoryOnly: true, steps: { ...steps, upload: "done" } });
      return;
    }
    if (steps.upload !== "failed") return;
    const link = this.#link();
    const session = this.#session();
    if (!link || session?.getSnapshot().state !== "online") return;
    this.#uploaded = true;
    void this.#projects.noteMade(link);
    this.#set({
      steps: { ...steps, upload: "done" },
      ...(problem?.step === "upload" && { problem: undefined }),
    });
  }

  /**
   * What giving up could not make sure of happened after all: the link of the project is gone, as
   * where the platform would not make the project again. That is what people asked for, so the
   * dialog is over.
   */
  async #seeUndone(): Promise<void> {
    let isLinked: boolean;
    try {
      isLinked = (await this.#projects.linkOf(this.#key)) !== undefined;
    } catch {
      return;
    }
    const { unconfirmed, cancelling } = this.#snapshot;
    if (this.#closed || !unconfirmed || cancelling || isLinked) return;
    this.#set({ unconfirmed: false, phase: "cancelled" });
    this.#left = false;
    this.close();
  }

  /** Whether what people chose can go on now. */
  get canSubmit(): boolean {
    const { phase, need, cancelling } = this.#snapshot;
    return phase === "choosing" && need === undefined && !cancelling && this.picker.canSubmit;
  }

  /**
   * Whether closing the dialog now takes back what it made, see `cancel`: the project is on its
   * way to the platform or there, by this dialog, and has no repository yet.
   */
  get takesBack(): boolean {
    const { phase, linked } = this.#snapshot;
    if ((phase !== "choosing" && phase !== "working") || linked !== undefined) return false;
    // A link that is being made right now is this try's as soon as it is there.
    if (this.#beginning) return true;
    const link = this.#link();
    return link !== undefined && this.#isMine(link);
  }

  /** Whether the project of a link is one that this try to connect put on the platform, or was about to. */
  #isMine(link: CloudLink): boolean {
    return link.project === this.#created;
  }

  // ---- leaving the page, and coming back

  #noteIntent(): void {
    const { memory } = this.#options;
    if (!memory) return;
    const { mode, name, nameTouched, selected } = this.picker.getSnapshot();
    const intent: ConnectIntent = {
      key: this.#key,
      at: this.#env.now(),
      mode,
      name,
      touched: nameTouched,
      ...(selected !== undefined && { selected }),
      ...(this.#created !== undefined && { created: this.#created }),
    };
    memory.write(INTENT_KEY, JSON.stringify(intent));
  }

  #forgetIntent(): void {
    this.#options.memory?.write(INTENT_KEY, "");
  }

  async #leaveFor(go: (() => Promise<void> | void) | undefined): Promise<void> {
    if (!go || this.#closed) return;
    this.#noteIntent();
    this.#left = true;
    const gone = go();
    // Only what says when leaving is over can say that people stayed after all, as with something
    // that could not be kept. Asked right away, a page that is still on its way out looks like
    // one that stayed, and comes back without the dialog. So without a word about it, what the
    // dialog was at is kept: for the page that comes back, or until it is too old, or until
    // people close the dialog themselves.
    if (!isThenable(gone)) return;
    await gone;
    if (this.#options.leaving?.() === false) {
      this.#left = false;
      this.#forgetIntent();
    }
  }

  /** Signs in: the page goes, and the dialog comes back with what people chose. */
  signIn(): Promise<void> {
    return this.#leaveFor(this.#options.signIn);
  }

  /** Installs the GitHub App on the account: the page goes, and the dialog comes back. */
  installApp(): Promise<void> {
    return this.#leaveFor(this.#options.installApp);
  }

  // ---- the three steps

  /**
   * Goes on with what people chose: the project to the platform, its repository, the first
   * archive. Where a step stops, the snapshot says why, and this can be called again.
   */
  async submit(): Promise<void> {
    if (!this.canSubmit) return;
    const { name } = this.picker.getSnapshot();
    this.#set({ phase: "working", problem: undefined, unconfirmed: false });
    try {
      // What the platform says about the choice comes first: nothing is made for a name that is
      // taken.
      await this.picker.settled();
      if (this.#closed || this.#snapshot.cancelling) return;
      if (!this.picker.canSubmit) {
        this.#stopAt({ step: "repository", code: "choice" }, { failed: false });
        return;
      }
      // Another name than the one people saw when they pressed: they look at it first.
      if (this.picker.getSnapshot().name !== name) return;
      if (!(await this.#upload())) return;
      // People gave up while the project got there: no repository is made for one that is on
      // its way out again.
      if (this.#closed || this.#snapshot.cancelling) return;
      const linking = this.#linkRepository();
      this.#linking = linking;
      const isLinked = await linking;
      this.#linking = undefined;
      if (isLinked) this.#followArchive();
    } finally {
      // However it ended, people can go on from here: as where they gave up meanwhile, and the
      // platform could not say that the project is gone.
      if (this.#snapshot.phase === "working") this.#set({ phase: "choosing" });
    }
  }

  /** Back to choosing, with why. */
  #stopAt(problem: ConnectProblem, { failed = true } = {}): false {
    if (this.#snapshot.cancelling) return false;
    this.#set({
      phase: "choosing",
      problem,
      ...(failed && { steps: { ...this.#snapshot.steps, [problem.step]: "failed" } }),
    });
    return false;
  }

  async #upload(): Promise<boolean> {
    if (this.#uploaded) return true;
    this.#step("upload", "running");
    let link = this.#link();
    // What kept it from getting there the last time: trying again starts from that.
    const stale = this.#session()?.getSnapshot().problem;
    if (!link) {
      const beginning = this.#projects.beginLink().then((made) => {
        // Only a link that was made just now is this try's to take back: one that turned out to
        // be there already, as one another window made a moment ago, is not. Noted before
        // anyone who waits for the link hears of it, see `cancel`.
        if (typeof made !== "string" && made.isNew) this.#created = made.link.project;
        return made;
      });
      this.#beginning = beginning;
      const begun = await beginning.finally(() => {
        this.#beginning = undefined;
      });
      if (typeof begun === "string") {
        return this.#closed ? false : this.#stopAt({ step: "upload", code: begun });
      }
      link = begun.link;
      if (this.#closed) return false;
    } else {
      // On its way since before: once more, should it wait for people.
      this.#session()?.resume();
    }
    const problem = await this.#whenOnline(link, stale);
    if (this.#closed) return false;
    if (problem) {
      if (problem.step === "upload" && problem.code === "signedOut") this.#signedOut();
      return this.#stopAt(problem);
    }
    await this.#projects.noteMade(link);
    this.#uploaded = true;
    this.#step("upload", "done");
    return true;
  }

  #signedOut(): void {
    this.#sawSignedOut = true;
    this.#set({ need: this.#needOf() });
  }

  /**
   * Waits for the project to be on the platform. Resolves to what keeps it from getting there, or
   * to undefined once it is. Without a network it says so at once, and where the platform does
   * not answer after a while: syncing goes on trying either way.
   */
  #whenOnline(
    link: CloudLink,
    stale: CloudProblem | undefined,
  ): Promise<ConnectProblem | undefined> {
    return new Promise((resolve) => {
      const since = this.#env.now();
      let timer: unknown;
      let stop = () => {};
      const settle = (problem: ConnectProblem | undefined) => {
        stop();
        this.#env.clearTimeout(timer);
        resolve(problem);
      };
      const look = () => {
        const session = this.#session();
        if (this.#closed || !session || session.project !== link.project) {
          settle({ step: "upload", code: "stopped" });
          return;
        }
        const { state, problem } = session.getSnapshot();
        if (state === "online") settle(undefined);
        // Not what it stopped at before this try: that one it is getting over just now.
        else if (state === "paused" && problem && problem !== stale)
          settle(uploadProblemOf(problem, this.#projects.isOwn(link)));
        else if (state === "closed") settle({ step: "upload", code: "stopped" });
        else if (state === "offline") settle({ step: "upload", code: "offline" });
        else if (state === "reconnecting" && this.#env.now() - since >= this.#timing.patienceMs)
          settle({ step: "upload", code: "unreachable" });
      };
      stop = this.#projects.subscribe(look);
      timer = this.#env.setTimeout(look, this.#timing.patienceMs);
      look();
    });
  }

  async #linkRepository(): Promise<boolean> {
    this.#step("repository", "running");
    const status = await this.picker.submit();
    if (this.#closed) return false;
    if (status) return this.#linked(status);
    const { failure } = this.picker.getSnapshot();
    if (failure === "alreadyLinked") {
      // The answer to a try before did not come back: the project has its repository.
      const project = this.#link()?.project;
      const now = project && (await this.#access.status(project).catch(() => undefined));
      if (this.#closed) return false;
      if (now && now.repository) return this.#linked(now);
    }
    if (failure === "signedOut") this.#signedOut();
    return this.#stopAt({ step: "repository", code: failure ?? "choice" });
  }

  #linked(status: RepositoryStatus): true {
    this.#projects.repository?.take(status, { hurry: true });
    this.#set({
      linked: status,
      problem: undefined,
      steps: { ...this.#snapshot.steps, upload: "done", repository: "done" },
    });
    return true;
  }

  /** The first archive: the platform does it, and the dialog says how it goes. */
  #followArchive(): void {
    this.#set({
      phase: "archiving",
      steps: { ...this.#snapshot.steps, archive: "running" },
      cancelling: false,
      unconfirmed: false,
    });
    const look = () => {
      if (this.#closed || this.#snapshot.phase !== "archiving") return;
      const status = this.#projects.repository?.status;
      if (!status || !status.repository) return;
      // Which repository it is, where the dialog did not hear it from linking it.
      if (!this.#snapshot.linked) this.#set({ linked: status });
      const { steps, problem } = this.#snapshot;
      if (status.lastArchive) {
        this.#stopArchive?.();
        this.#stopArchive = undefined;
        this.#set({ phase: "done", problem: undefined, steps: { ...steps, archive: "done" } });
      } else if (status.state === "paused") {
        this.#set({
          problem: { step: "archive", code: "paused", status },
          steps: { ...steps, archive: "failed" },
        });
      } else if ((status.failures ?? 0) > 0) {
        this.#set({
          problem: { step: "archive", code: "retrying", status },
          steps: { ...steps, archive: "running" },
        });
      } else if (problem || steps.archive !== "running") {
        this.#set({ problem: undefined, steps: { ...steps, archive: "running" } });
      }
    };
    this.#stopArchive = this.#projects.subscribe(look);
    look();
  }

  // ---- giving up

  /**
   * People close the dialog. Where the project is connected and has its repository, or where the
   * dialog made nothing, that is all: "closed". Where the dialog put the project on the platform,
   * or was about to, and it has no repository yet, that is taken back, see
   * `CloudProjects.abandonConnect`: "cancelled" once the project is one of this computer only
   * again. "kept": the platform has a repository for it after all, so it stays connected.
   * "unconfirmed": the platform could not say that the project is gone; the dialog stays, and with
   * `force` people let go all the same.
   */
  async cancel({ force = false } = {}): Promise<"closed" | "cancelled" | "kept" | "unconfirmed"> {
    if (this.#closed) return "closed";
    if (this.#snapshot.cancelling) return "unconfirmed";
    if (!this.takesBack) return this.#over();
    this.#set({ cancelling: true, unconfirmed: false });
    // A link that is being made right now is there in a moment, and what a repository being made
    // right now comes to decides what there is to take back.
    await this.#beginning?.catch(() => {});
    await this.#linking?.catch(() => {});
    const link = this.#link();
    if (this.#closed) return "closed";
    if (this.#snapshot.linked) {
      this.#set({ cancelling: false });
      return "kept";
    }
    // Nothing of this try: no link came of it, or the one that did was there already.
    if (!link || !this.#isMine(link)) {
      this.#set({ cancelling: false });
      return this.#over();
    }
    const outcome = await this.#projects.abandonConnect(link, { force });
    if (this.#closed) return outcome;
    if (outcome === "cancelled") {
      this.#set({ cancelling: false, phase: "cancelled" });
      this.#over();
      return outcome;
    }
    if (outcome === "kept") {
      // Its repository is there: what is left is the first archive.
      this.#uploaded = true;
      this.#set({
        cancelling: false,
        problem: undefined,
        steps: { ...this.#snapshot.steps, upload: "done", repository: "done" },
      });
      this.#followArchive();
      return outcome;
    }
    this.#set({ cancelling: false, unconfirmed: true });
    return outcome;
  }

  /** People closed the dialog themselves: it is over, and so is what it was at when a page left. */
  #over(): "closed" {
    this.#left = false;
    this.close();
    return "closed";
  }

  /** The dialog is over. What it was at when the page left is forgotten, unless the page is leaving. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stop of this.#stops.splice(0)) stop();
    this.#stopArchive?.();
    this.#stopArchive = undefined;
    this.picker.close();
    if (!this.#left) this.#forgetIntent();
  }
}

const plain = { interpolation: { escapeValue: false } } as const;

/** The refusals about repositories that have words of their own; the others say their code. */
const REPOSITORY_FAILURES = {
  nameTaken: true,
  invalidName: true,
  alreadyLinked: true,
  notFound: true,
  signedOut: true,
  busy: true,
  unavailable: true,
} as const;

/** Why a step stopped, and what helps, in words. */
export function connectProblemText(problem: ConnectProblem, t: TFunction): string {
  if (problem.step === "upload") {
    return problem.code === "rejected"
      ? t("cloud.connect.problem.rejected", {
          reason: t(`cloud.reason.${problem.reason ?? "malformed"}`),
          ...plain,
        })
      : t(`cloud.connect.problem.${problem.code}`);
  }
  if (problem.step === "repository") {
    if (problem.code === "choice") return t("cloud.connect.problem.choice");
    return problem.code in REPOSITORY_FAILURES
      ? t(`repository.failure.${problem.code as keyof typeof REPOSITORY_FAILURES}`)
      : t("repository.failure.other", { code: problem.code, ...plain });
  }
  if (problem.code === "retrying") return t("cloud.connect.problem.retrying");
  const { reason, fix } = pauseText(problem.status, t);
  return t("cloud.connect.problem.paused", { reason, fix, ...plain });
}

/** What a step is called. The second one says what it does: a new repository, or one people have. */
export function connectStepText(id: ConnectStepId, mode: PickerMode, t: TFunction): string {
  if (id === "repository")
    return t(mode === "create" ? "cloud.connect.step.create" : "cloud.connect.step.existing");
  return t(`cloud.connect.step.${id}`);
}
