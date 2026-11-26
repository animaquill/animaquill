import {
  CloudSignedOut,
  type AccountAccess,
  type LocalRepository,
  type RepositoryAccess,
  type RepositoryChoice,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";
import { unusableReason, type ChoiceRefusal, type UnusableReason } from "./repository-text.ts";

/**
 * "从仓库打开" (the design of U1, 2.2): people choose a repository, and it opens as the project of
 * theirs that it is already, or comes back as a new one from what it has, or, empty, gets a new
 * project. On GitHub the list is the repositories the App may touch; where the server keeps every
 * project in a repository of its own, it is those of them that no project is saved to. What a
 * repository with files has at its top only the platform says, so a repository people select is
 * asked about once. No DOM: the dialog shows the snapshot.
 */

/** What the button does for the repository people selected. */
export type OpeningAction =
  /** It is a project of theirs already: that one opens. */
  | { readonly kind: "open"; readonly project: { readonly id: string; readonly name: string } }
  /** It has a project at its top: that comes back as a new project of the platform, and opens. */
  | { readonly kind: "restore" }
  /** It can take a project: a new one is made, saved to it. */
  | { readonly kind: "create" };

export type RowState =
  | { readonly kind: "action"; readonly action: OpeningAction }
  /** The platform is being asked about it. */
  | { readonly kind: "checking" }
  | {
      readonly kind: "unusable";
      readonly reason: UnusableReason;
      readonly refusal: ChoiceRefusal | undefined;
    };

export type OpeningRow =
  | { readonly id: string; readonly kind: "github"; readonly choice: RepositoryChoice }
  | { readonly id: string; readonly kind: "local"; readonly repository: LocalRepository };

export interface OpeningSnapshot {
  readonly source: "github" | "local";
  readonly list: "idle" | "loading" | "ready" | "failed";
  readonly rows: readonly OpeningRow[];
  readonly more: boolean;
  readonly manageUrl: string | undefined;
  readonly filter: string;
  readonly selected: string | undefined;
  /** What each repository is, as far as it is known, by the id of its row. */
  readonly states: ReadonlyMap<string, RowState>;
  /** What has to happen before anything can be listed. */
  readonly need: "signIn" | "installApp" | undefined;
}

export interface RepositoryOpeningOptions {
  /** GitHub's repositories, where projects are saved there. */
  readonly access?: RepositoryAccess | undefined;
  /** The repositories of the server's own, where it keeps every project in one. */
  readonly localRepositories?: (() => Promise<readonly LocalRepository[]>) | undefined;
  readonly account?: AccountAccess | undefined;
}

const RESTORE = { kind: "action", action: { kind: "restore" } } as const satisfies RowState;
const CREATE = { kind: "action", action: { kind: "create" } } as const satisfies RowState;
const CHECKING = { kind: "checking" } as const satisfies RowState;

/** What the list alone says about a repository of GitHub, or undefined where the platform has to. */
function listedState(choice: RepositoryChoice): RowState | undefined {
  if (choice.linkedProject) {
    return { kind: "action", action: { kind: "open", project: choice.linkedProject } };
  }
  const reason = unusableReason(choice, undefined, undefined);
  if (reason) return { kind: "unusable", reason, refusal: undefined };
  return choice.empty ? CREATE : undefined;
}

export class RepositoryOpening {
  readonly #options: RepositoryOpeningOptions;
  readonly #emitter = new Emitter();
  #snapshot: OpeningSnapshot;
  #page = 0;
  #closed = false;

  constructor(options: RepositoryOpeningOptions) {
    this.#options = options;
    const source = options.access ? "github" : "local";
    this.#snapshot = {
      source,
      list: "idle",
      rows: [],
      more: false,
      manageUrl: undefined,
      filter: "",
      selected: undefined,
      states: new Map(),
      need: this.#needOf(),
    };
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): OpeningSnapshot => this.#snapshot;

  #needOf(): OpeningSnapshot["need"] {
    const who = this.#options.account?.getSnapshot();
    if (who?.status === "signedOut") return "signIn";
    if (this.#options.access && who?.status === "signedIn" && who.appInstalled === false) {
      return "installApp";
    }
    return undefined;
  }

  /** The rows the filter leaves, in the order of the list. */
  get shown(): readonly OpeningRow[] {
    const wanted = this.#snapshot.filter.trim().toLowerCase();
    if (wanted === "") return this.#snapshot.rows;
    return this.#snapshot.rows.filter((row) =>
      (row.kind === "github" ? row.choice.fullName : row.repository.name)
        .toLowerCase()
        .includes(wanted),
    );
  }

  get selectedRow(): OpeningRow | undefined {
    const { selected, rows } = this.#snapshot;
    return rows.find(({ id }) => id === selected);
  }

  /** What the button does now: nothing while it is not known, or where nothing can be done. */
  get action(): OpeningAction | undefined {
    const { selected, states } = this.#snapshot;
    // What the filter hides is not what people look at: nothing to do with it.
    if (selected !== undefined && !this.shown.some(({ id }) => id === selected)) return undefined;
    const state = selected === undefined ? undefined : states.get(selected);
    return state?.kind === "action" ? state.action : undefined;
  }

  stateOf(row: OpeningRow): RowState | undefined {
    return this.#snapshot.states.get(row.id);
  }

  /** Lists the first page again, as at first and after "刷新". */
  async refresh(): Promise<void> {
    this.#page = 0;
    this.#set({ need: this.#needOf() });
    if (this.#snapshot.need) return;
    await this.#load(true);
  }

  async more(): Promise<void> {
    if (!this.#snapshot.more || this.#snapshot.list === "loading") return;
    await this.#load(false);
  }

  async #load(first: boolean): Promise<void> {
    const { access, localRepositories } = this.#options;
    this.#set({ list: "loading" });
    try {
      if (access) {
        const page = this.#page + 1;
        const listed = await access.list(page);
        if (this.#closed) return;
        this.#page = listed.page;
        const rows: OpeningRow[] = listed.repositories.map((choice) => ({
          id: String(choice.id),
          kind: "github",
          choice,
        }));
        const states = new Map(first ? [] : this.#snapshot.states);
        for (const row of rows) {
          const known = row.kind === "github" ? listedState(row.choice) : undefined;
          if (known) states.set(row.id, known);
        }
        this.#set({
          list: "ready",
          rows: first ? rows : [...this.#snapshot.rows, ...rows],
          more: listed.more,
          manageUrl: listed.manageUrl,
          states,
          ...(first && { selected: undefined }),
        });
      } else {
        const found = (await localRepositories?.()) ?? [];
        if (this.#closed) return;
        const rows: OpeningRow[] = found.map((repository) => ({
          id: repository.dir,
          kind: "local",
          repository,
        }));
        // Each of them has a project that no project of the platform is saved to: it comes back.
        const states = new Map<string, RowState>(rows.map(({ id }) => [id, RESTORE]));
        this.#set({ list: "ready", rows, more: false, states, selected: undefined });
      }
    } catch (error) {
      if (this.#closed) return;
      if (error instanceof CloudSignedOut) this.#set({ list: "idle", need: "signIn" });
      else this.#set({ list: "failed" });
    }
  }

  setFilter(filter: string): void {
    this.#set({ filter });
  }

  /** Selects a repository, and asks the platform about it where the list could not say. */
  select(id: string): void {
    const row = this.#snapshot.rows.find((each) => each.id === id);
    if (!row) return;
    const state = this.#snapshot.states.get(id);
    if (state?.kind === "unusable") return;
    this.#set({ selected: id });
    if (state === undefined && row.kind === "github") void this.#check(row);
  }

  async #check(row: Extract<OpeningRow, { kind: "github" }>): Promise<void> {
    const access = this.#options.access;
    if (!access) return;
    this.#setState(row.id, CHECKING);
    let said: RowState | undefined;
    try {
      const check = await access.check({
        existing: { id: row.choice.id },
        // Whether it is public is said when it comes back: here only what it has counts.
        ...(!row.choice.private && { confirmPublic: true }),
      });
      if (check.ok) said = CREATE;
      else if (check.reason === "hasProject") said = RESTORE;
      else {
        const refusal: ChoiceRefusal = {
          code: check.reason as ChoiceRefusal["code"],
          ...(check.files && { files: check.files }),
          ...(check.project && { project: check.project }),
        };
        if (check.reason === "linkedElsewhere" && check.project) {
          said = { kind: "action", action: { kind: "open", project: check.project } };
        } else {
          const reason = unusableReason(row.choice, refusal, undefined) ?? "notFound";
          said = { kind: "unusable", reason, refusal };
        }
      }
    } catch {
      // The platform could not say: asked again when people select it again.
      said = undefined;
    }
    if (this.#closed) return;
    const states = new Map(this.#snapshot.states);
    if (said) states.set(row.id, said);
    else states.delete(row.id);
    const gone = said?.kind === "unusable" && this.#snapshot.selected === row.id;
    this.#set({ states, ...(gone && { selected: undefined }) });
  }

  #setState(id: string, state: RowState): void {
    this.#set({ states: new Map(this.#snapshot.states).set(id, state) });
  }

  close(): void {
    this.#closed = true;
  }

  #set(change: Partial<OpeningSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit();
  }
}
