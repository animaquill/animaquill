import {
  newSyncId,
  type AccountAccess,
  type CloudAccess,
  type LocalFolder,
  type RepositoryAccess,
  type RepositoryStatus,
  type WindowMemory,
} from "@animaquill/host";
import { NEW_FRAME_RATES, newFormat, type FormatShape, type NewProject } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { Emitter } from "../workbench/emitter.ts";
import {
  connectProblemText,
  type ConnectEnvironment,
  type ConnectNeed,
  type ConnectProblem,
  type ConnectStepState,
} from "./connect.ts";
import type { Downloaded } from "./download.ts";
import type { CloudProjectsSnapshot } from "./projects.ts";
import { RepositoryPicker, type PickerMode } from "./repository-picker.ts";
import { repositoryNameOf, type ToPinyin } from "./repository-name.ts";
import { pauseText } from "./repository-text.ts";
import type { RepositoryWatch } from "./repository-watch.ts";
import { UploadFailed, upload, type Upload } from "./upload.ts";

/**
 * Making a new project, see the design of the start page (docs/design/start-and-cloud.md of
 * AnimaQuill Cloud), 3: people choose a project of this computer, which is a folder, or a project
 * of the platform, which always has a repository. There is no project that is only in this browser
 * without the platform any more: the browser can clear what it stores at any time. Only tests can
 * still make one, see `Host.projectsHereForTests`.
 *
 * A project of the platform is made platform first, and this computer after, so that wherever it
 * stops, what is left is a whole project of some kind, or nothing:
 *
 * 0. What has to be there first: someone signed in, the GitHub App on the account. Both leave the
 *    page; what the dialog was at goes into what the window remembers, see `takeCreateIntent`.
 *    Where people want a folder too, it is chosen in the press that goes on: the browser only asks
 *    then. Choosing none is changing one's mind: nothing is made.
 * 1. "upload": the project, made in memory, goes to the platform in one connection, see `upload`.
 *    Nothing is in this browser yet. The id of the project there is noted in what the window
 *    remembers until it has its repository: a page that goes away right here leaves a project
 *    without a repository on the platform, which the next start page takes away, see
 *    `tidyCreated`, and nothing else does.
 * 2. "repository": as the dialog that connects a project, see `RepositoryPicker`.
 * 3. "place": the project is whole now, and comes into this browser as a copy that syncs, see
 *    `CloudProjects.keepUploaded`, and into the folder where people chose one. Nothing is taken
 *    back from here on: what does not work out says so, and the project is there to open.
 * 4. "archive": the first archive, which the platform does by itself, as for connecting.
 *
 * Giving up before the repository takes the project on the platform away again, after the
 * connection that made it is closed: the platform keeps the id from being used again, so a request
 * to make it that is still on its way makes nothing. Where the platform cannot say that it is
 * gone, people are told, and can let go all the same: the next start page takes it away then.
 *
 * No DOM: the dialog shows the snapshot, and the picker's.
 */

export type CreateKind =
  /** A folder on this computer. */
  | "local"
  /** A project of the platform. */
  | "cloud"
  /** For tests only: a project in this browser without the platform, see `Host.projectsHereForTests`. */
  | "browser";

export type CreateStepId = "upload" | "repository" | "place" | "archive";

/** The format a new project is made in, see `newFormat`. */
export type NewFormat = NonNullable<NewProject["format"]>;
export type NewFrameRate = (typeof NEW_FRAME_RATES)[number];

/** Why the folder people chose cannot take the new project. */
export type FolderRefusal =
  /** It is a project already. */
  | "project"
  /** It is inside a project. */
  | "inside"
  /** An export that stopped halfway is in it. */
  | "incomplete"
  /** It could not be read. */
  | "failed";

/** A folder people chose for the new project, and where in it the project goes. */
export interface FolderChoice {
  readonly folder: LocalFolder;
  /** A folder of its own inside it, by name, for a folder that has other things in it. */
  readonly inside: string | undefined;
}

export type CreateProblem =
  | ConnectProblem
  | { readonly step: "folder"; readonly code: FolderRefusal }
  | {
      readonly step: "place";
      /** "browser": it could not come into this browser. "folder": not into the folder. */
      readonly code: "browser" | "folder";
    }
  | { readonly step: "name" };

export interface CreateSnapshot {
  readonly kind: CreateKind;
  /** What the project is called. */
  readonly name: string;
  /** Whether a copy goes into a folder on this computer as well, for a project of the platform. */
  readonly withFolder: boolean;
  /** The shape it is made in, and for "custom" the size people typed, as they typed it. */
  readonly shape: FormatShape;
  readonly width: string;
  readonly height: string;
  readonly fps: NewFrameRate;
  /** What has to be there first, for a project of the platform. */
  readonly need: ConnectNeed | undefined;
  readonly account: string | undefined;
  /**
   * "choosing": people choose, and can go on. "working": the steps run. "archiving": the project
   * is whole and here, and the first archive is on its way or waits: the dialog can close. "done":
   * it is archived, or it is whole and could not come here. "cancelled": people gave up, and
   * nothing of it is left.
   */
  readonly phase: "choosing" | "working" | "archiving" | "done" | "cancelled";
  readonly steps: Readonly<Record<CreateStepId, ConnectStepState>>;
  readonly problem: CreateProblem | undefined;
  /** What the dialog made is being taken back. */
  readonly cancelling: boolean;
  /** Giving up could not make sure that the platform has nothing left of it, see `cancel`. */
  readonly unconfirmed: boolean;
  /** The repository it is saved to, once it is. */
  readonly linked: RepositoryStatus | undefined;
  /** What this browser keeps the new project by, once it is here. */
  readonly key: string | undefined;
  /** The folder it went into, by name, once it did. */
  readonly folder: string | undefined;
}

/** What the dialog was at when the page left, to sign in or to install the App, see `takeCreateIntent`. */
export interface CreateIntent {
  readonly at: number;
  readonly name: string;
  readonly withFolder: boolean;
  readonly shape?: FormatShape;
  readonly width?: string;
  readonly height?: string;
  readonly fps?: NewFrameRate;
  readonly mode: PickerMode;
  readonly repository: string;
  readonly touched: boolean;
  readonly selected?: number;
}

/** Where the window remembers what the dialog was at, see `Host.windowMemory`. */
const INTENT_KEY = "cloud.create";
/** Where the window remembers the projects it is making on the platform, see `tidyCreated`. */
const CREATED_KEY = "cloud.created";
/** After this long people are doing something else. */
const INTENT_MS = 30 * 60_000;
/** How long a connection that was told to close has to be closed for good before the project goes. */
const CLOSE_WAIT_MS = 4000;
/** How long the platform has to say that a project is gone. */
const REMOVE_WAIT_MS = 25_000;

const isIntent = (value: unknown): value is CreateIntent => {
  const intent = value as Partial<CreateIntent> | null;
  return (
    typeof intent === "object" &&
    intent !== null &&
    typeof intent.at === "number" &&
    typeof intent.name === "string" &&
    typeof intent.withFolder === "boolean" &&
    (intent.mode === "create" || intent.mode === "existing") &&
    typeof intent.repository === "string" &&
    typeof intent.touched === "boolean" &&
    (intent.selected === undefined || typeof intent.selected === "number") &&
    (intent.shape === undefined ||
      ["landscape", "portrait", "square", "custom"].includes(intent.shape)) &&
    (intent.width === undefined || typeof intent.width === "string") &&
    (intent.height === undefined || typeof intent.height === "string") &&
    (intent.fps === undefined || (NEW_FRAME_RATES as readonly string[]).includes(intent.fps))
  );
};

/**
 * What the dialog that makes a project of the platform was at when the page left, once: the window
 * forgets it as it says it. Undefined where it was at nothing, or too long ago.
 */
export function takeCreateIntent(memory: WindowMemory, now: number): CreateIntent | undefined {
  const kept = memory.read(INTENT_KEY);
  if (kept === undefined || kept === "") return undefined;
  memory.write(INTENT_KEY, "");
  try {
    const intent: unknown = JSON.parse(kept);
    if (!isIntent(intent)) return undefined;
    return now - intent.at >= 0 && now - intent.at < INTENT_MS ? intent : undefined;
  } catch {
    return undefined;
  }
}

/** The projects of the platform this window began to make and that have no repository yet. */
function createdOf(memory: WindowMemory): string[] {
  try {
    const kept: unknown = JSON.parse(memory.read(CREATED_KEY) || "[]");
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function noteCreated(memory: WindowMemory, project: string, isMade: boolean): void {
  const rest = createdOf(memory).filter((id) => id !== project);
  memory.write(CREATED_KEY, JSON.stringify(isMade ? [...rest, project] : rest));
}

/**
 * Takes away what making a project of the platform left behind in this window, as where the page
 * went away before the project had its repository: only projects this window noted that it began
 * to make, and only those the platform says have no repository. Every other project without one
 * stays, as another page or another computer may be making it right now. Once after the page
 * loaded, before anything is made. Never rejects.
 */
export async function tidyCreated(
  cloud: Pick<CloudAccess, "list" | "remove">,
  memory: WindowMemory,
): Promise<void> {
  const noted = createdOf(memory);
  if (noted.length === 0 || !cloud.remove) return;
  let listed: Awaited<ReturnType<CloudAccess["list"]>>;
  try {
    listed = await cloud.list();
  } catch {
    // Not now: the next page asks again.
    return;
  }
  for (const project of noted) {
    const summary = listed.find((each) => each.id === project);
    let isOver = summary === undefined || summary.attention !== "noRepository";
    if (!isOver) {
      try {
        // "missing" and "hasRepository" are as good: nothing is left to take away.
        await cloud.remove(project);
        isOver = true;
      } catch (error) {
        console.warn("A project that was not made to the end stays on the platform for now", error);
      }
    }
    if (isOver) noteCreated(memory, project, false);
  }
}

/** A project to make, as it is before anything of it is anywhere. */
export interface CreateContent {
  /** All of it, as one update, see `ProjectStore.encodeWhole`. */
  readonly state: Uint8Array;
  /** Its own id, see `Manifest.id`. */
  readonly projectId: string;
}

export interface CloudCreateOptions {
  /** The platform, where the editor is hosted on one. */
  readonly cloud?: CloudAccess;
  readonly access?: RepositoryAccess;
  readonly account?: AccountAccess;
  /** What the project is called at first. */
  readonly name: string;
  /**
   * What the project is, given what it is called and the format people chose: a new empty one, or
   * one that was imported, which keeps its own formats.
   */
  readonly content: (name: string, format: NewFormat) => CreateContent;
  /** The project is imported: only a project of the platform, see `CreateSnapshot.kind`. */
  readonly imported?: boolean;
  /**
   * Makes a project of this computer in a folder people choose, which has to be called right in
   * the press: see `ProjectFolders.createNamed`. Missing where the browser cannot write folders.
   */
  readonly createLocal?: (name: string, format: NewFormat) => Promise<void>;
  /** For tests only, see `Host.projectsHereForTests`: a project in this browser. */
  readonly createHere?: (name: string, format: NewFormat) => Promise<void>;
  /**
   * What turns Chinese into pinyin, for the name of a new repository, see `repositoryNameOf`:
   * loaded once the dialog is there. Without it Chinese counts as anything else.
   */
  readonly pinyin?: () => Promise<ToPinyin>;
  /**
   * Asks people for a folder, right in the press, and where in it the project goes, see
   * `ProjectFolders.chooseForNew`. Undefined where they changed their mind.
   */
  readonly chooseFolder?: (name: string) => Promise<FolderChoice | FolderRefusal | undefined>;
  /**
   * Keeps what the platform has of the new project as a copy in this browser that syncs, see
   * `CloudProjects.keepUploaded`. Resolves to its key, or to undefined where it could not.
   */
  readonly keep: (project: string, made: Downloaded) => Promise<string | undefined>;
  /**
   * Opens the copy, and moves it into the folder people chose, where they did. Resolves to whether
   * it is open, and whether it is in the folder.
   */
  readonly open: (
    key: string,
    folder: FolderChoice | undefined,
  ) => Promise<{ readonly opened: boolean; readonly inFolder: boolean }>;
  /** How the open project syncs, to follow its first archive. */
  readonly projects?: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): CloudProjectsSnapshot;
    readonly repository: RepositoryWatch | undefined;
  };
  readonly signIn?: () => Promise<void> | void;
  readonly installApp?: () => Promise<void> | void;
  /** Whether the page is going away now, after `signIn` or `installApp`, see `CloudConnect`. */
  readonly leaving?: () => boolean;
  readonly memory?: WindowMemory;
  readonly intent?: CreateIntent;
  /** Which window this is, and the version of the editor, for the platform. */
  readonly window: string;
  readonly editor: string;
  readonly checkMs?: number;
  readonly environment?: ConnectEnvironment;
}

const WAITING: CreateSnapshot["steps"] = {
  upload: "waiting",
  repository: "waiting",
  place: "waiting",
  archive: "waiting",
};

const pageClock = (): ConnectEnvironment => ({
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === "function";

/** What kept the project from getting to the platform, as the dialog says it. */
const uploadProblemOf = (error: unknown): ConnectProblem => {
  const code = error instanceof UploadFailed ? error.code : "offline";
  switch (code) {
    case "missing":
      return { step: "upload", code: "undone" };
    case "signedOut":
    case "tooLarge":
    case "quota":
    case "outdated":
    case "offline":
      return { step: "upload", code: code === "offline" ? "unreachable" : code };
    case "rejected":
      return { step: "upload", code: "rejected", reason: "invalid" };
    default:
      return { step: "upload", code: "stopped" };
  }
};

export class CloudCreate {
  /** The repository to save a project of the platform to, where there is a platform. */
  readonly picker: RepositoryPicker | undefined;
  /** What can be made here: a folder, a project of the platform, one for tests. */
  readonly kinds: readonly CreateKind[];
  readonly #options: CloudCreateOptions;
  readonly #env: ConnectEnvironment;
  readonly #emitter = new Emitter();
  readonly #stops: (() => void)[] = [];
  #snapshot: CreateSnapshot;
  #closed = false;
  #left = false;
  #sawSignedOut = false;
  #toSelect: number | undefined;
  /** The project on the platform this dialog makes, by its id there, once it began to. */
  #project: string | undefined;
  /** It is on the platform, as the platform said. */
  #made: Downloaded | undefined;
  /** The connection that makes it, while it does, and how to stop it. */
  #upload: { readonly upload: Upload; readonly stop: AbortController } | undefined;
  #uploading: Promise<unknown> | undefined;
  #linking: Promise<unknown> | undefined;
  /** The folder people chose, once they did: choosing again only after a problem with it. */
  #folder: FolderChoice | undefined;
  /** The steps run, until they stop: see `whenIdle`. */
  #working: Promise<void> | undefined;
  #stopArchive: (() => void) | undefined;

  constructor(options: CloudCreateOptions) {
    this.#options = options;
    this.#env = options.environment ?? pageClock();
    const { access, account, intent } = options;
    this.kinds = [
      ...(options.createLocal || options.chooseFolder ? (["local"] as const) : []),
      ...(options.cloud && access && account ? (["cloud"] as const) : []),
      ...(options.createHere && !options.imported ? (["browser"] as const) : []),
    ];
    const who = account?.getSnapshot();
    this.picker =
      access &&
      new RepositoryPicker({
        access,
        project: () => (this.#made ? this.#project : undefined),
        name:
          intent?.repository ??
          repositoryNameOf(intent?.name ?? options.name, undefined, this.#env.now()),
        ...(who?.status === "signedIn" && { owner: who.name, appInstalled: who.appInstalled }),
        precheck: {
          delayMs: options.checkMs ?? 400,
          canAsk: () =>
            !this.#closed && this.#snapshot.kind === "cloud" && this.#needOf() === undefined,
          setTimeout: this.#env.setTimeout,
          clearTimeout: this.#env.clearTimeout,
        },
      });
    const kind: CreateKind = intent || options.imported ? "cloud" : this.#defaultKind();
    this.#snapshot = {
      kind,
      name: intent?.name ?? options.name,
      withFolder: intent?.withFolder === true && options.chooseFolder !== undefined,
      shape: intent?.shape ?? "landscape",
      width: intent?.width ?? "1920",
      height: intent?.height ?? "1080",
      fps: intent?.fps ?? "30",
      need: undefined,
      account: who?.status === "signedIn" ? who.name : undefined,
      phase: "choosing",
      steps: WAITING,
      problem: undefined,
      cancelling: false,
      unconfirmed: false,
      linked: undefined,
      key: undefined,
      folder: undefined,
    };
    this.#snapshot = { ...this.#snapshot, need: this.#needOf() };
    if (intent && this.picker) {
      if (intent.touched) this.picker.setName(intent.repository);
      if (intent.mode === "existing") {
        this.#toSelect = intent.selected;
        this.picker.setMode("existing");
      }
    }
    if (account) this.#stops.push(account.subscribe(() => this.#followAccount()));
    if (this.picker) this.#stops.push(this.picker.subscribe(() => this.#followPicker()));
    if (account && this.kinds.includes("cloud")) void account.refresh();
    if (this.#snapshot.need === undefined) this.picker?.recheck();
    if (this.picker && options.pinyin) {
      options.pinyin().then(
        (toPinyin) => {
          this.#toPinyin = toPinyin;
          this.#nameRepository();
        },
        (error: unknown) => console.warn("Pinyin could not be loaded", error),
      );
    }
  }

  #toPinyin: ToPinyin | undefined;
  /** People chose the kind themselves: what the account says does not change it any more. */
  #kindChosen = false;

  /**
   * What a new project is by default, see the design, 3: a project of the platform where someone
   * is signed in, and one of this computer where not; only what can be made here; and in a
   * browser that tests run in, one in the browser.
   */
  #defaultKind(): CreateKind {
    const { kinds } = this;
    if (kinds.includes("browser")) return "browser";
    if (!kinds.includes("local")) return kinds[0] ?? "cloud";
    if (!kinds.includes("cloud")) return "local";
    return this.#options.account?.getSnapshot().status === "signedIn" ? "cloud" : "local";
  }

  /** The repository is called after the project, until people name it themselves. */
  #nameRepository(): void {
    const picker = this.picker;
    if (!picker || picker.getSnapshot().nameTouched || this.#isBegun()) return;
    const name = repositoryNameOf(this.#snapshot.name, this.#toPinyin, this.#env.now());
    if (name !== picker.getSnapshot().name) picker.setName(name, { touched: false });
  }

  /** The format people chose, or undefined where the format of a project does not take it. */
  get format(): NewFormat | undefined {
    const { shape, width, height, fps } = this.#snapshot;
    const size = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);
    return newFormat(
      shape,
      fps,
      shape === "custom" ? { width: size(width), height: size(height) } : undefined,
    );
  }

  setShape(shape: FormatShape): void {
    if (this.#snapshot.phase !== "choosing" || this.#isBegun()) return;
    this.#set({ shape });
  }

  /** A size of people's own, as they type it: see `format` for whether it can be. */
  setSize(width: string, height: string): void {
    if (this.#snapshot.phase !== "choosing" || this.#isBegun()) return;
    this.#set({ shape: "custom", width, height });
  }

  setFps(fps: NewFrameRate): void {
    if (this.#snapshot.phase !== "choosing" || this.#isBegun()) return;
    this.#set({ fps });
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): CreateSnapshot => this.#snapshot;

  #set(change: Partial<CreateSnapshot>): void {
    if (this.#closed) return;
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit();
  }

  #step(id: CreateStepId, state: ConnectStepState): void {
    this.#set({ steps: { ...this.#snapshot.steps, [id]: state } });
  }

  #needOf(): ConnectNeed | undefined {
    const account = this.#options.account;
    if (!account || !this.picker) return undefined;
    const who = account.getSnapshot();
    if (this.#sawSignedOut || who.status === "signedOut") return "signIn";
    if (who.status === "unknown") return "account";
    if (!who.appInstalled || this.picker.getSnapshot().notInstalled) return "installApp";
    return undefined;
  }

  #followAccount(): void {
    const who = this.#options.account?.getSnapshot();
    const before = this.#snapshot.need;
    if (who?.status === "signedIn") this.#sawSignedOut = false;
    const need = this.#needOf();
    this.picker?.setOwner(who?.status === "signedIn" ? who.name : undefined);
    this.#set({ need, account: who?.status === "signedIn" ? who.name : undefined });
    // Who is signed in decides what a new project is, until people chose.
    if (!this.#kindChosen && !this.#options.intent && !this.#options.imported) {
      const kind = this.#defaultKind();
      if (kind !== this.#snapshot.kind && this.#snapshot.phase === "choosing" && !this.#isBegun())
        this.#set({ kind, need: this.#needOf() });
    }
    if (before === undefined || need !== undefined || !this.picker) return;
    const { mode, list } = this.picker.getSnapshot();
    if (mode === "existing" && list.state !== "ready" && list.state !== "loading")
      void this.picker.refresh();
    this.picker.recheck();
  }

  #followPicker(): void {
    const picker = this.picker;
    if (!picker) return;
    const { list, selected } = picker.getSnapshot();
    if (this.#toSelect !== undefined && list.state === "ready") {
      const wanted = this.#toSelect;
      this.#toSelect = undefined;
      if (selected === undefined) picker.select(wanted);
    }
    this.#set({ need: this.#needOf() });
  }

  // ---- what people choose

  setKind(kind: CreateKind): void {
    if (!this.kinds.includes(kind) || this.#snapshot.phase !== "choosing" || this.#isBegun())
      return;
    this.#kindChosen = true;
    this.#set({ kind, problem: undefined, need: undefined });
    this.#set({ need: this.#needOf() });
    if (kind === "cloud") this.picker?.recheck();
  }

  setName(name: string): void {
    if (this.#snapshot.phase !== "choosing" || this.#isBegun()) return;
    this.#set({ name, ...(this.#snapshot.problem?.step === "name" && { problem: undefined }) });
    this.#nameRepository();
  }

  setWithFolder(withFolder: boolean): void {
    if (!this.#options.chooseFolder || this.#snapshot.phase !== "choosing") return;
    if (this.#made) return;
    this.#folder = undefined;
    this.#set({
      withFolder,
      ...(this.#snapshot.problem?.step === "folder" && { problem: undefined }),
    });
  }

  /** The project is on its way to the platform, or there: what it is cannot change any more. */
  #isBegun(): boolean {
    return this.#project !== undefined;
  }

  /** Whether what people chose can go on now. */
  get canSubmit(): boolean {
    const { phase, need, cancelling, kind, name } = this.#snapshot;
    if (phase !== "choosing" || cancelling || name.trim() === "") return false;
    if (!this.format) return false;
    if (kind !== "cloud") return true;
    return need === undefined && this.picker?.canSubmit === true;
  }

  /**
   * Whether closing the dialog now takes back what it made: the project is on its way to the
   * platform or there, by this dialog, and has no repository yet.
   */
  get takesBack(): boolean {
    const { phase, linked } = this.#snapshot;
    return (phase === "choosing" || phase === "working") && linked === undefined && this.#isBegun();
  }

  /** Whether the steps are running: whoever shows the dialog waits for them, see `whenIdle`. */
  get isWorking(): boolean {
    return this.#working !== undefined;
  }

  /** Resolves once the steps stopped running, or right away where they do not. */
  async whenIdle(): Promise<void> {
    await this.#working;
  }

  // ---- leaving the page, and coming back

  #noteIntent(): void {
    const { memory } = this.#options;
    const picker = this.picker;
    // What is imported is not kept through a reload: people choose the folder again.
    if (!memory || !picker || this.#options.imported) return;
    const { mode, name, nameTouched, selected } = picker.getSnapshot();
    const intent: CreateIntent = {
      at: this.#env.now(),
      name: this.#snapshot.name,
      withFolder: this.#snapshot.withFolder,
      shape: this.#snapshot.shape,
      width: this.#snapshot.width,
      height: this.#snapshot.height,
      fps: this.#snapshot.fps,
      mode,
      repository: name,
      touched: nameTouched,
      ...(selected !== undefined && { selected }),
    };
    memory.write(INTENT_KEY, JSON.stringify(intent));
  }

  async #leaveFor(go: (() => Promise<void> | void) | undefined): Promise<void> {
    if (!go || this.#closed) return;
    this.#noteIntent();
    this.#left = true;
    const gone = go();
    if (!isThenable(gone)) return;
    await gone;
    if (this.#options.leaving?.() === false) {
      this.#left = false;
      this.#options.memory?.write(INTENT_KEY, "");
    }
  }

  signIn(): Promise<void> {
    return this.#leaveFor(this.#options.signIn);
  }

  installApp(): Promise<void> {
    return this.#leaveFor(this.#options.installApp);
  }

  // ---- making it

  /**
   * Goes on with what people chose. Has to be called right in the press: a folder is asked for
   * first, and the browser only asks then. Where a step stops, the snapshot says why, and this can
   * be called again.
   */
  submit(): Promise<void> {
    if (!this.canSubmit || this.#working) return Promise.resolve();
    const { kind, name } = this.#snapshot;
    const trimmed = name.trim();
    const format = this.format;
    if (!format) return Promise.resolve();
    if (kind === "local") return this.#elsewhere(this.#options.createLocal?.(trimmed, format));
    if (kind === "browser") return this.#elsewhere(this.#options.createHere?.(trimmed, format));
    // Before anything waits: the browser asks for a folder only right after people pressed.
    const asking =
      this.#snapshot.withFolder && !this.#folder && !this.#made
        ? this.#options.chooseFolder?.(trimmed)
        : undefined;
    const working = this.#run(trimmed, format, asking).finally(() => {
      this.#working = undefined;
      if (this.#snapshot.phase === "working") this.#set({ phase: "choosing" });
    });
    this.#working = working;
    return working;
  }

  /** A project that is not of the platform: whoever makes it says how it goes. The dialog is over. */
  async #elsewhere(making: Promise<void> | undefined): Promise<void> {
    this.#set({ phase: "done" });
    this.#left = false;
    this.close();
    await making;
  }

  async #run(
    name: string,
    format: NewFormat,
    asking: Promise<FolderChoice | FolderRefusal | undefined> | undefined,
  ): Promise<void> {
    this.#set({ phase: "working", problem: undefined, unconfirmed: false });
    if (asking) {
      let chosen: FolderChoice | FolderRefusal | undefined;
      try {
        chosen = await asking;
      } catch {
        chosen = "failed";
      }
      if (this.#closed) return;
      // People changed their mind: nothing is made.
      if (chosen === undefined) return;
      if (typeof chosen === "string") {
        this.#set({ problem: { step: "folder", code: chosen } });
        return;
      }
      this.#folder = chosen;
    }
    const picker = this.picker;
    if (!picker) return;
    if (!this.#made) {
      await picker.settled();
      if (this.#closed || this.#snapshot.cancelling) return;
      if (!picker.canSubmit) {
        this.#set({ problem: { step: "repository", code: "choice" } });
        return;
      }
      if (!(await this.#toPlatform(name, format))) return;
    }
    if (this.#closed || this.#snapshot.cancelling) return;
    if (!this.#snapshot.linked) {
      const linking = this.#linkRepository();
      this.#linking = linking;
      const isLinked = await linking;
      this.#linking = undefined;
      if (!isLinked) return;
    }
    await this.#place();
  }

  async #toPlatform(name: string, format: NewFormat): Promise<boolean> {
    const { cloud, memory, content } = this.#options;
    if (!cloud) return false;
    this.#step("upload", "running");
    // The same id on every try: where an answer did not come back, the platform has it already.
    this.#project ??= newSyncId();
    const project = this.#project;
    if (memory) noteCreated(memory, project, true);
    const made = content(name, format);
    const stop = new AbortController();
    const sending = upload(cloud, {
      project,
      state: made.state,
      create: { name, projectId: made.projectId },
      window: this.#options.window,
      editor: this.#options.editor,
      signal: stop.signal,
    });
    this.#upload = { upload: sending, stop };
    const outcome = sending.done.then(
      (downloaded) => ({ downloaded }),
      (error: unknown) => ({ error }),
    );
    this.#uploading = outcome;
    const result: { downloaded?: Downloaded; error?: unknown } = await outcome;
    this.#uploading = undefined;
    if (this.#closed || this.#snapshot.cancelling) return false;
    if (!result.downloaded) {
      const problem = uploadProblemOf(result.error);
      if (problem.step === "upload" && problem.code === "signedOut") this.#signedOut();
      // The platform would not make it under this id: the next try makes it anew.
      if (problem.step === "upload" && problem.code === "undone") {
        if (memory) noteCreated(memory, project, false);
        this.#project = undefined;
      }
      this.#stopAt(problem);
      return false;
    }
    this.#made = result.downloaded;
    this.#step("upload", "done");
    return true;
  }

  #signedOut(): void {
    this.#sawSignedOut = true;
    this.#set({ need: this.#needOf() });
  }

  #stopAt(problem: CreateProblem): void {
    if (this.#snapshot.cancelling) return;
    const step = problem.step === "folder" || problem.step === "name" ? undefined : problem.step;
    this.#set({
      phase: "choosing",
      problem,
      ...(step && { steps: { ...this.#snapshot.steps, [step]: "failed" } }),
    });
  }

  async #linkRepository(): Promise<boolean> {
    const picker = this.picker;
    const project = this.#project;
    if (!picker || !project) return false;
    this.#step("repository", "running");
    const status = await picker.submit();
    if (this.#closed) return false;
    if (status) return this.#linked(status);
    const { failure } = picker.getSnapshot();
    if (failure === "alreadyLinked") {
      // The answer to a try before did not come back: the project has its repository.
      const now = await this.#options.access?.status(project).catch(() => undefined);
      if (this.#closed) return false;
      if (now?.repository) return this.#linked(now);
    }
    if (failure === "signedOut") this.#signedOut();
    this.#stopAt({ step: "repository", code: failure ?? "choice" });
    return false;
  }

  #linked(status: RepositoryStatus): true {
    // Whole now: nothing is taken back from here on, and nothing is left to tidy away.
    const { memory } = this.#options;
    if (memory && this.#project) noteCreated(memory, this.#project, false);
    this.#set({
      linked: status,
      problem: undefined,
      cancelling: false,
      unconfirmed: false,
      steps: { ...this.#snapshot.steps, upload: "done", repository: "done" },
    });
    return true;
  }

  /** Into this browser, and into the folder people chose, and open. Nothing is taken back here. */
  async #place(): Promise<void> {
    const project = this.#project;
    const made = this.#made;
    if (!project || !made) return;
    this.#step("place", "running");
    const key = this.#snapshot.key ?? (await this.#options.keep(project, made));
    if (!key) {
      this.#set({
        phase: "done",
        problem: { step: "place", code: "browser" },
        steps: { ...this.#snapshot.steps, place: "failed" },
      });
      return;
    }
    this.#set({ key });
    const folder = this.#folder;
    const { opened, inFolder } = await this.#options.open(key, folder);
    const isPlaced = opened && (!folder || inFolder);
    this.#set({
      ...(inFolder && folder && { folder: folder.inside ?? folder.folder.name }),
      ...(!isPlaced && { problem: { step: "place", code: opened ? "folder" : "browser" } }),
      steps: { ...this.#snapshot.steps, place: isPlaced ? "done" : "failed" },
    });
    if (!opened) {
      this.#set({ phase: "done" });
      return;
    }
    this.#followArchive(project);
  }

  /** The first archive: the platform does it, and the dialog says how it goes. */
  #followArchive(project: string): void {
    const projects = this.#options.projects;
    this.#set({ phase: "archiving", steps: { ...this.#snapshot.steps, archive: "running" } });
    if (!projects) return;
    let hurried = false;
    const look = () => {
      if (this.#closed || this.#snapshot.phase !== "archiving") return;
      const snapshot = projects.getSnapshot();
      if (snapshot.kind !== "linked" || snapshot.link.project !== project) return;
      // What the repository was linked with, and asked about often for a while, as connecting does:
      // the first archive is on its way.
      const { linked } = this.#snapshot;
      if (!hurried && linked && projects.repository) {
        hurried = true;
        projects.repository.take(linked, { hurry: true });
      }
      const status = projects.repository?.status;
      if (!status?.repository) return;
      const { steps, problem } = this.#snapshot;
      // What went wrong with putting it here stays to read.
      const keep = problem?.step === "place" ? { problem } : { problem: undefined };
      if (status.lastArchive) {
        this.#stopArchive?.();
        this.#stopArchive = undefined;
        this.#set({ phase: "done", ...keep, steps: { ...steps, archive: "done" } });
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
      }
    };
    this.#stopArchive = projects.subscribe(look);
    look();
  }

  // ---- giving up

  /**
   * People close the dialog. Where nothing was made, or the project is whole, that is all:
   * "closed". Where the dialog put the project on the platform, or was about to, and it has no
   * repository yet, it is taken away: "cancelled" once the platform says it is gone. "kept": it has
   * its repository after all, and goes on. "unconfirmed": the platform could not say; the dialog
   * stays, and with `force` people let go all the same, which leaves it for the next start page
   * to take away, see `tidyCreated`.
   */
  async cancel({ force = false } = {}): Promise<"closed" | "cancelled" | "kept" | "unconfirmed"> {
    if (this.#closed) return "closed";
    if (this.#snapshot.cancelling) return "unconfirmed";
    if (!this.takesBack) return this.#over();
    const project = this.#project;
    const { cloud, memory } = this.#options;
    this.#set({ cancelling: true, unconfirmed: false });
    // What is on its way stops, and is over before the platform is asked: a request to make it
    // that is still on its way would make it after the platform took it away.
    this.#upload?.stop.abort();
    await this.#uploading;
    await this.#linking;
    if (this.#closed) return "closed";
    if (this.#snapshot.linked) {
      this.#set({ cancelling: false });
      // It goes on: into this browser, and open.
      if (!this.#working) void this.#keepGoing();
      return "kept";
    }
    if (this.#upload) await this.#within(CLOSE_WAIT_MS, this.#upload.upload.closed).catch(() => {});
    let outcome: "removed" | "missing" | "hasRepository" | "unknown" = "unknown";
    if (project && cloud?.remove) {
      try {
        outcome = await this.#within(REMOVE_WAIT_MS, cloud.remove(project));
      } catch (error) {
        console.warn("The platform could not say that the new project is gone", error);
      }
    }
    if (this.#closed) return "closed";
    if (outcome === "hasRepository") {
      // Linked after all, where the answer did not come back: it has a repository.
      const status =
        project && (await this.#options.access?.status(project).catch(() => undefined));
      this.#set({ cancelling: false });
      if (status && status.repository) {
        this.#linked(status);
        if (!this.#working) void this.#keepGoing();
        return "kept";
      }
      this.#set({ unconfirmed: true });
      return "unconfirmed";
    }
    if (outcome === "unknown" && !force) {
      this.#set({ cancelling: false, unconfirmed: true });
      return "unconfirmed";
    }
    // Gone, or people let go: what is left the next start page takes away.
    if (outcome !== "unknown" && memory && project) noteCreated(memory, project, false);
    this.#set({ cancelling: false, unconfirmed: false, phase: "cancelled" });
    return this.#over();
  }

  /** The steps after the repository, where giving up found that the project has one. */
  async #keepGoing(): Promise<void> {
    const working = this.#place().finally(() => {
      this.#working = undefined;
    });
    this.#working = working;
    await working;
  }

  #within<T>(ms: number, asked: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.#env.setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
      asked.then(
        (value) => {
          this.#env.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          this.#env.clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

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
    this.picker?.close();
    if (!this.#left) this.#options.memory?.write(INTENT_KEY, "");
  }
}

const plain = { interpolation: { escapeValue: false } } as const;

/** Why a step stopped, and what helps, in words. */
export function createProblemText(problem: CreateProblem, t: TFunction): string {
  switch (problem.step) {
    case "folder":
      return t(`newProject.folder.${problem.code}`);
    case "place":
      return t(`newProject.place.${problem.code}`);
    case "name":
      return t("newProject.nameEmpty");
    case "upload":
      if (problem.code === "undone") return t("newProject.undone");
      return connectProblemText(problem, t);
    case "archive":
      if (problem.code === "retrying") return t("cloud.connect.problem.retrying");
      return t("cloud.connect.problem.paused", { ...pauseText(problem.status, t), ...plain });
    default:
      return connectProblemText(problem, t);
  }
}

/** What a step is called. */
export function createStepText(
  id: CreateStepId,
  mode: PickerMode,
  withFolder: boolean,
  t: TFunction,
): string {
  if (id === "repository")
    return t(mode === "create" ? "cloud.connect.step.create" : "cloud.connect.step.existing");
  if (id === "place") return t(withFolder ? "newProject.step.folder" : "newProject.step.browser");
  if (id === "upload") return t("newProject.step.upload");
  return t("cloud.connect.step.archive");
}
