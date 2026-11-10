import {
  CloudSignedOut,
  RepositoryRefused,
  type RepositoryAccess,
  type RepositoryChoice,
  type RepositoryRefusal,
  type RepositoryStatus,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import {
  nameProblem,
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
  /** Why the last try did not go, where that is not about one repository. */
  readonly failure: RepositoryRefusal | "signedOut" | undefined;
  /** What the platform said once the project was saved to a repository. */
  readonly linked: RepositoryStatus | undefined;
}

export interface RepositoryPickerOptions {
  readonly access: RepositoryAccess;
  /** The project, by its id on the platform. */
  readonly project: string;
  /** The name a new repository gets at first. */
  readonly name: string;
  /** Right after connecting the project: people can put it off ("以后再说"). */
  readonly asking?: boolean;
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

export class RepositoryPicker {
  readonly asking: boolean;
  readonly current: RepositoryPickerOptions["current"];
  readonly owner: string | undefined;
  readonly #access: RepositoryAccess;
  readonly #project: string;
  readonly #emitter = new Emitter();
  #snapshot: PickerSnapshot;
  /** Only the last list asked for counts. */
  #listTurn = 0;
  #closed = false;

  constructor(options: RepositoryPickerOptions) {
    this.#access = options.access;
    this.#project = options.project;
    this.asking = options.asking === true;
    this.current = options.current;
    this.owner = options.owner;
    this.#snapshot = {
      mode: "create",
      name: options.name,
      nameProblem: nameProblem(options.name),
      list: NO_LIST,
      notInstalled: options.appInstalled === false,
      selected: undefined,
      publicConfirmed: false,
      refused: new Map(),
      working: false,
      failure: undefined,
      linked: undefined,
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): PickerSnapshot => this.#snapshot;

  #set(change: Partial<PickerSnapshot>): void {
    if (this.#closed) return;
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit();
  }

  close(): void {
    this.#closed = true;
  }

  setMode(mode: PickerMode): void {
    this.#set({ mode, failure: undefined });
    if (mode === "existing" && this.#snapshot.list.state === "idle") void this.refresh();
  }

  setName(name: string): void {
    this.#set({ name, nameProblem: nameProblem(name.trim()), failure: undefined });
  }

  /** Why a repository of the list cannot be chosen, or undefined where it can. */
  unusable(choice: RepositoryChoice): UnusableReason | undefined {
    return unusableReason(choice, this.#snapshot.refused.get(choice.id), this.current?.id);
  }

  select(id: number): void {
    const choice = this.#snapshot.list.repositories.find((each) => each.id === id);
    if (!choice || this.unusable(choice)) return;
    this.#set({ selected: id, publicConfirmed: false, failure: undefined });
  }

  confirmPublic(yes: boolean): void {
    this.#set({ publicConfirmed: yes });
  }

  get selectedChoice(): RepositoryChoice | undefined {
    const { selected, list } = this.#snapshot;
    return list.repositories.find((each) => each.id === selected);
  }

  /** Whether what people chose can go to the platform as it is. */
  get canSubmit(): boolean {
    const snapshot = this.#snapshot;
    if (snapshot.working || snapshot.notInstalled) return false;
    if (snapshot.mode === "create") return snapshot.nameProblem === undefined;
    const choice = this.selectedChoice;
    if (!choice || this.unusable(choice)) return false;
    return choice.private || snapshot.publicConfirmed;
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
      const selected = repositories.some((each) => each.id === this.#snapshot.selected)
        ? this.#snapshot.selected
        : undefined;
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
    const choice = snapshot.mode === "existing" ? this.selectedChoice : undefined;
    this.#set({ working: true, failure: undefined });
    try {
      const status = await this.#access.link(
        this.#project,
        choice
          ? { existing: { id: choice.id }, ...(!choice.private && { confirmPublic: true }) }
          : { create: { name: snapshot.name.trim() } },
      );
      this.#set({ working: false, linked: status });
      return status;
    } catch (error) {
      const code = codeOf(error);
      const about =
        choice &&
        (code === "hasProject" ||
          code === "linkedElsewhere" ||
          code === "notPushable" ||
          code === "notFound");
      if (choice && about) {
        const refused = new Map(this.#snapshot.refused);
        refused.set(choice.id, {
          code,
          ...(error instanceof RepositoryRefused && error.files && { files: error.files }),
        });
        this.#set({ working: false, refused, selected: undefined, publicConfirmed: false });
      } else {
        this.#set({
          working: false,
          ...(code === "notInstalled" ? { notInstalled: true } : { failure: code }),
        });
      }
      return undefined;
    }
  }
}
