import {
  CloudSignedOut,
  RepositoryRefused,
  type RepositoryAccess,
  type RepositoryCheck,
  type RepositoryChoice,
  type RepositoryLink,
  type RepositoryRefusal,
  type RepositoryStatus,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import {
  nameProblem,
  nextRepositoryName,
  unusableReason,
  type ChoiceRefusal,
  type NameProblem,
  type UnusableReason,
} from "./repository-text.ts";

/**
 * Choosing the repository a project of the platform is saved to, as the dialog "存到 GitHub" shows
 * it (docs/design/phase5-step14.md 3.1.5): a new private one by a name GitHub takes, or one of the
 * person's own that the App may touch, each with why it cannot be chosen where it cannot. No DOM.
 *
 * What the list cannot tell, such as a project at the top of a repository, the platform says when
 * people try it: the repository then shows as one that cannot be chosen, with why.
 *
 * With `precheck`, as where connecting a project chooses its repository (the design of the start
 * page, 3), the platform is asked about what people chose before they go on, a moment after they
 * stopped typing: a name that is taken shows at the name, a repository that cannot take the project
 * in the list, as if they had tried. A name people did not type themselves moves on to one that is
 * free: "atom-2", "atom-3". Where the platform cannot say, nothing shows, and trying tells.
 */

export type PickerMode = "create" | "existing";

export interface PickerList {
  readonly state: "idle" | "loading" | "ready" | "failed";
  readonly repositories: readonly RepositoryChoice[];
  readonly page: number;
  readonly more: boolean;
  /** Where people choose on GitHub which repositories the App may touch. */
  readonly manageUrl: string | undefined;
}

export interface PickerSnapshot {
  readonly mode: PickerMode;
  /**
   * Who a new repository belongs to, as people know the account. Undefined until it is known who
   * is signed in, see `setOwner`.
   */
  readonly owner: string | undefined;
  readonly name: string;
  readonly nameProblem: NameProblem | undefined;
  readonly list: PickerList;
  /** The GitHub App is not on the person's account: nothing can be chosen until it is. */
  readonly notInstalled: boolean;
  readonly selected: number | undefined;
  /** People said yes to a public repository. */
  readonly publicConfirmed: boolean;
  /** What the platform said about repositories people tried, by id. */
  readonly refused: ReadonlyMap<number, ChoiceRefusal>;
  /** A repository is being made or linked. */
  readonly working: boolean;
  /** The platform is being asked about what people chose, or will be in a moment, see `precheck`. */
  readonly checking: boolean;
  /** The platform said that what people chose now can take the project. */
  readonly checked: boolean;
  /** People typed the name themselves: it stays as they typed it, also where it is taken. */
  readonly nameTouched: boolean;
  /** Why the last try did not go, where that is not about one repository. */
  readonly failure: RepositoryRefusal | "signedOut" | undefined;
  /** What the platform said once the project was saved to a repository. */
  readonly linked: RepositoryStatus | undefined;
}

/** Asking the platform about what people chose before they go on, see `RepositoryPicker`. */
export interface PickerPrecheck {
  /** How long after the last change the platform is asked. */
  readonly delayMs?: number;
  /** Whether asking makes sense now: not while nobody is signed in. */
  readonly canAsk?: () => boolean;
  readonly setTimeout?: (run: () => void, ms: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export interface RepositoryPickerOptions {
  readonly access: RepositoryAccess;
  /**
   * The project, by its id on the platform: as a function where it is only known once people go
   * on, as for a project that connecting puts on the platform first.
   */
  readonly project: string | (() => string | undefined);
  /** The name a new repository gets at first. */
  readonly name: string;
  /**
   * In place of the repository the project is saved to now, also while archiving into that one
   * goes as it should, see `RepositoryLink.switch`.
   */
  readonly switching?: boolean;
  readonly precheck?: PickerPrecheck;
  /** The repository the project goes to now, where archiving into it paused: another one instead. */
  readonly current?: NonNullable<RepositoryStatus["repository"]>;
  /** Who the new repository belongs to, as people know the account. */
  readonly owner?: string;
  /**
   * Whether the account says the GitHub App is on it. Where it says not, the dialog says how to get
   * it, and asks the platform nothing until people look again.
   */
  readonly appInstalled?: boolean;
}

const NO_LIST: PickerList = {
  state: "idle",
  repositories: [],
  page: 0,
  more: false,
  manageUrl: undefined,
};

const codeOf = (error: unknown): RepositoryRefusal | "signedOut" =>
  error instanceof CloudSignedOut
    ? "signedOut"
    : error instanceof RepositoryRefused
      ? error.code
      : "unavailable";

/** How long after the last change the platform is asked about it, see `PickerPrecheck`. */
const CHECK_DELAY_MS = 400;

/** A name GitHub does not take, as the platform found when it was asked. */
const REFUSED_NAME = { nameProblem: "refused" } as const;

/** What the platform says about a repository people have that keeps it from being chosen. */
const KEEPS_OUT: ReadonlySet<string> = new Set<RepositoryRefusal>([
  "hasProject",
  "linkedElsewhere",
  "notPushable",
  "notFound",
]);

export class RepositoryPicker {
  readonly current: RepositoryPickerOptions["current"];
  readonly #access: RepositoryAccess;
  readonly #project: RepositoryPickerOptions["project"];
  readonly #switching: boolean;
  readonly #precheck: PickerPrecheck | undefined;
  readonly #emitter = new Emitter();
  #snapshot: PickerSnapshot;
  /** Only the last list asked for counts. */
  #listTurn = 0;
  /** ...and only the last question about what people chose. */
  #checkTurn = 0;
  #checkTimer: unknown;
  /** The name as it was given, which the names tried after it build on, and how many were tried. */
  #baseName: string;
  #nameTries = 1;
  /** Repositories the platform found public where the list did not say so. */
  readonly #public = new Set<number>();
  /** Whoever waits for the question about what people chose to be answered, see `settled`. */
  #waiting: (() => void)[] = [];
  #closed = false;

  constructor(options: RepositoryPickerOptions) {
    this.#access = options.access;
    this.#project = options.project;
    this.#switching = options.switching === true;
    this.#precheck = options.precheck;
    this.#baseName = options.name;
    this.current = options.current;
    this.#snapshot = {
      mode: "create",
      owner: options.owner,
      name: options.name,
      nameProblem: nameProblem(options.name),
      list: NO_LIST,
      notInstalled: options.appInstalled === false,
      selected: undefined,
      publicConfirmed: false,
      refused: new Map(),
      working: false,
      checking: false,
      checked: false,
      nameTouched: false,
      failure: undefined,
      linked: undefined,
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): PickerSnapshot => this.#snapshot;

  /** Who a new repository belongs to, see `PickerSnapshot.owner`. */
  get owner(): string | undefined {
    return this.#snapshot.owner;
  }

  /**
   * Says whose the new repository is, once that is known or as it changes: a dialog can open
   * before the account says who is signed in, as right after the page came back from signing in.
   */
  setOwner(owner: string | undefined): void {
    if (owner !== this.#snapshot.owner) this.#set({ owner });
  }

  #set(change: Partial<PickerSnapshot>): void {
    if (this.#closed) return;
    this.#snapshot = { ...this.#snapshot, ...change };
    if (!this.#snapshot.checking) this.#answerWaiting();
    this.#emitter.emit();
  }

  #answerWaiting(): void {
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  close(): void {
    this.#closed = true;
    this.#clearCheckTimer();
    this.#answerWaiting();
  }

  setMode(mode: PickerMode): void {
    this.#set({ mode, failure: undefined });
    if (mode === "existing" && this.#snapshot.list.state === "idle") void this.refresh();
    this.#checkSoon();
  }

  /** A name as people type it. `touched: false` for one the dialog puts there itself. */
  setName(name: string, { touched = true } = {}): void {
    if (!touched) {
      this.#baseName = name;
      this.#nameTries = 1;
    }
    this.#set({
      name,
      nameProblem: nameProblem(name.trim()),
      failure: undefined,
      nameTouched: touched,
    });
    this.#checkSoon();
  }

  /** Why a repository of the list cannot be chosen, or undefined where it can. */
  unusable(choice: RepositoryChoice): UnusableReason | undefined {
    return unusableReason(choice, this.#snapshot.refused.get(choice.id), this.current?.id);
  }

  select(id: number): void {
    const choice = this.#snapshot.list.repositories.find((each) => each.id === id);
    if (!choice || this.unusable(choice)) return;
    this.#set({ selected: id, publicConfirmed: false, failure: undefined });
    this.#checkSoon(0);
  }

  confirmPublic(yes: boolean): void {
    this.#set({ publicConfirmed: yes });
  }

  get selectedChoice(): RepositoryChoice | undefined {
    const { selected, list } = this.#snapshot;
    return list.repositories.find((each) => each.id === selected);
  }

  /**
   * The name is not the one it was at first: that one is taken, and people did not type this one
   * themselves, see `precheck`.
   */
  get nameMovedOn(): boolean {
    return !this.#snapshot.nameTouched && this.#nameTries > 1;
  }

  /** Whether people have to say yes to a repository being public before it can be chosen. */
  isPublic(choice: RepositoryChoice): boolean {
    return !choice.private || this.#public.has(choice.id);
  }

  /** Whether what people chose can go to the platform as it is. */
  get canSubmit(): boolean {
    const snapshot = this.#snapshot;
    if (snapshot.working || snapshot.notInstalled) return false;
    if (snapshot.mode === "create") return snapshot.nameProblem === undefined;
    const choice = this.selectedChoice;
    if (!choice || this.unusable(choice)) return false;
    return !this.isPublic(choice) || snapshot.publicConfirmed;
  }

  // ---- asking the platform before people go on

  /** Resolves once nothing is being asked about what people chose, see `precheck`. */
  settled(): Promise<void> {
    if (!this.#snapshot.checking || this.#closed) return Promise.resolve();
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /** Asks about what people chose again, as once someone is signed in, see `PickerPrecheck.canAsk`. */
  recheck(): void {
    this.#checkSoon(0);
  }

  #clearCheckTimer(): void {
    const clear =
      this.#precheck?.clearTimeout ??
      ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    clear(this.#checkTimer);
    this.#checkTimer = undefined;
  }

  /** What to ask the platform about: nothing where what people chose cannot go as it is anyway. */
  #toCheck(): RepositoryLink | undefined {
    const snapshot = this.#snapshot;
    if (snapshot.notInstalled || snapshot.working || snapshot.linked) return undefined;
    if (snapshot.mode === "create") {
      const name = snapshot.name.trim();
      return nameProblem(name) === undefined ? { create: { name } } : undefined;
    }
    const choice = this.selectedChoice;
    if (!choice || this.unusable(choice)) return undefined;
    // That it is public people see in the list: what else is wrong with it is worth knowing first.
    return { existing: { id: choice.id }, ...(this.isPublic(choice) && { confirmPublic: true }) };
  }

  #checkSoon(delayMs = this.#precheck?.delayMs ?? CHECK_DELAY_MS): void {
    const precheck = this.#precheck;
    if (!precheck || this.#closed) return;
    this.#clearCheckTimer();
    const turn = ++this.#checkTurn;
    const asked = this.#toCheck();
    if (!asked || precheck.canAsk?.() === false) {
      if (this.#snapshot.checking || this.#snapshot.checked)
        this.#set({ checking: false, checked: false });
      return;
    }
    this.#set({ checking: true, checked: false });
    const later = precheck.setTimeout ?? ((run, ms) => setTimeout(run, ms));
    this.#checkTimer = later(() => {
      this.#checkTimer = undefined;
      void this.#check(turn, asked);
    }, delayMs);
  }

  async #check(turn: number, asked: RepositoryLink): Promise<void> {
    if (turn !== this.#checkTurn || this.#closed) return;
    let said: RepositoryCheck;
    try {
      said = await this.#access.check(asked);
    } catch (error) {
      if (turn !== this.#checkTurn) return;
      // The platform could not say: nothing shows, and trying tells.
      const code = codeOf(error);
      this.#set({
        checking: false,
        ...(code === "signedOut" && { failure: code }),
        ...(code === "notInstalled" && { notInstalled: true }),
      });
      return;
    }
    if (turn !== this.#checkTurn) return;
    if (said.ok) {
      this.#set({ checking: false, checked: true });
      return;
    }
    if (said.reason === "notInstalled") {
      this.#set({ checking: false, notInstalled: true });
      return;
    }
    if ("create" in asked) {
      if (said.reason === "nameTaken") this.#nameTaken();
      else this.#set({ checking: false, ...(said.reason === "invalidName" && REFUSED_NAME) });
      return;
    }
    const { id } = asked.existing;
    if (KEEPS_OUT.has(said.reason)) {
      const refused = new Map(this.#snapshot.refused);
      refused.set(id, {
        code: said.reason as RepositoryRefusal,
        ...(said.files && { files: said.files }),
        ...(said.project && { project: said.project }),
      });
      const isSelected = this.#snapshot.selected === id;
      this.#set({
        checking: false,
        refused,
        ...(isSelected && { selected: undefined, publicConfirmed: false }),
      });
      return;
    }
    // Public after all, which the list did not say: people have to say yes first.
    if (said.reason === "public") this.#public.add(id);
    this.#set({ checking: false, ...(said.reason === "public" && { publicConfirmed: false }) });
  }

  /**
   * The person has a repository of this name already. A name they did not type themselves moves on
   * to the next one, which is asked about in turn; one they typed says so.
   */
  #nameTaken(): void {
    const next = this.#snapshot.nameTouched
      ? undefined
      : nextRepositoryName(this.#baseName, this.#nameTries);
    if (next === undefined) {
      this.#set({ checking: false, nameProblem: "taken" });
      return;
    }
    this.#nameTries += 1;
    this.#snapshot = { ...this.#snapshot, name: next, nameProblem: nameProblem(next) };
    this.#checkSoon(0);
  }

  /**
   * The first page of the list again, as after adding a repository on GitHub. Not where the App is
   * not installed: the platform would only say so.
   */
  refresh(): Promise<void> {
    return this.#snapshot.notInstalled ? Promise.resolve() : this.#load(1);
  }

  /** The next page of the list. */
  more(): Promise<void> {
    const { list } = this.#snapshot;
    return list.more ? this.#load(list.page + 1) : Promise.resolve();
  }

  async #load(page: number): Promise<void> {
    const turn = ++this.#listTurn;
    const before = this.#snapshot.list;
    this.#set({ list: { ...before, state: "loading" } });
    try {
      const answer = await this.#access.list(page);
      if (turn !== this.#listTurn) return;
      const repositories =
        page === 1
          ? answer.repositories
          : [
              ...before.repositories,
              ...answer.repositories.filter(
                (choice) => !before.repositories.some((each) => each.id === choice.id),
              ),
            ];
      const chosen = this.#snapshot.selected;
      const selected = repositories.some((each) => each.id === chosen) ? chosen : undefined;
      this.#set({
        list: {
          state: "ready",
          repositories,
          page: answer.page,
          more: answer.more,
          manageUrl: answer.manageUrl || undefined,
        },
        notInstalled: false,
        selected,
      });
      // What was chosen is not in the list any more: nothing is left to ask about.
      if (selected !== chosen) this.#checkSoon(0);
    } catch (error) {
      if (turn !== this.#listTurn) return;
      const code = codeOf(error);
      this.#set({
        list: { ...before, state: "failed" },
        ...(code === "notInstalled" ? { notInstalled: true } : {}),
        ...(code === "signedOut" ? { failure: code } : {}),
      });
    }
  }

  /**
   * Saves the project to what people chose. Resolves to the status once the platform took it; what
   * it refused shows in the snapshot, and the dialog stays.
   */
  async submit(): Promise<RepositoryStatus | undefined> {
    if (!this.canSubmit) return undefined;
    const snapshot = this.#snapshot;
    const project = typeof this.#project === "function" ? this.#project() : this.#project;
    if (project === undefined) return undefined;
    const choice = snapshot.mode === "existing" ? this.selectedChoice : undefined;
    const instead = this.#switching ? { switch: true } : {};
    // What is being asked about it is beside the point now: the platform says as it does it.
    this.#clearCheckTimer();
    this.#checkTurn += 1;
    this.#set({ working: true, checking: false, failure: undefined });
    try {
      const status = await this.#access.link(
        project,
        choice
          ? {
              existing: { id: choice.id },
              ...(this.isPublic(choice) && { confirmPublic: true }),
              ...instead,
            }
          : { create: { name: snapshot.name.trim() }, ...instead },
      );
      this.#set({ working: false, linked: status });
      return status;
    } catch (error) {
      const code = codeOf(error);
      if (choice && KEEPS_OUT.has(code)) {
        const refused = new Map(this.#snapshot.refused);
        refused.set(choice.id, {
          code: code as RepositoryRefusal,
          ...(error instanceof RepositoryRefused && error.files && { files: error.files }),
          ...(error instanceof RepositoryRefused && error.project && { project: error.project }),
        });
        this.#set({ working: false, refused, selected: undefined, publicConfirmed: false });
      } else {
        this.#set({
          working: false,
          ...(code === "notInstalled" ? { notInstalled: true } : { failure: code }),
        });
        // A name that got taken meanwhile: where people did not type it, the next one is found.
        if (code === "nameTaken" && !choice) this.#checkSoon(0);
      }
      return undefined;
    }
  }
}
