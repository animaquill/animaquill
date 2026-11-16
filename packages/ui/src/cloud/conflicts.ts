import {
  objectKey,
  objectOfPath,
  type CommandCall,
  type ObjectRef,
  type ProjectStore,
} from "@animaquill/core";
import {
  type RepositoryAccess,
  type RepositoryConflict,
  type RepositoryStatus,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The list of the places where the project and changes on GitHub both changed the same thing
 * (docs/design/start-and-cloud.md of AnimaQuill Cloud, 10, screen G2), as the dialog shows it and
 * what people choose there. No DOM.
 *
 * - The platform has the conflicts (`RepositoryAccess.conflicts`); each says what the project has
 *   (`ours`), what went (`theirs`), and what people chose.
 * - "换成 GitHub 的" is an edit of people's own (`conflict.take`), which Ctrl+Z takes back like any
 *   other; once the platform has it, the choice goes there (`keep: "theirs"` with the update it is
 *   in), and archiving goes on once nothing waits. "全部换成 GitHub 的" is one edit: one step back.
 * - "保留这里的" changes nothing of the project, only the platform's list.
 * - What only people can settle (the file of an asset, what points at something the editor took
 *   away, a file of code that may have a part twice) has no way to take the other side: "看过了"
 *   keeps the project's.
 * - A place that changed again since (`conflict-not-taken` with "changed", or "stale" on the
 *   platform) goes with what is done, saying so.
 */

/** Kinds whose other side `conflict.take` takes, see `ConflictKind` of @animaquill/core. */
export const TAKEABLE: ReadonlySet<string> = new Set(["value", "lines", "file", "order"]);

/** One place both sides changed, as the list has it. */
export interface ConflictRow {
  readonly conflict: RepositoryConflict;
  /** "open", or what was chosen: "ours", "theirs", or "stale" once it changed again since. */
  readonly state: string;
  /** Taking GitHub's side did not go: the place changed since ("changed"), or something else. */
  readonly failed?: "changed" | "other";
}

/** The places of one object, such as a clip, or one file of code. */
export interface ConflictGroup {
  readonly key: string;
  /** The object, as the conflicts say it: "片段“开场”"; empty for the project as a whole. */
  readonly title: string;
  readonly file: string;
  readonly object: ObjectRef | undefined;
  readonly rows: readonly ConflictRow[];
}

export interface ConflictListSnapshot {
  readonly status: "loading" | "ready" | "failed";
  /** What waits for people, by object, in the order of the platform. */
  readonly open: readonly ConflictGroup[];
  /** What was settled, newest first. */
  readonly handled: readonly ConflictRow[];
  /** A choice is on its way. */
  readonly busy: boolean;
  /** The last choice could not be told to the platform: it can be made again. */
  readonly trouble: boolean;
}

export interface ConflictListOptions {
  readonly access: RepositoryAccess;
  /** The project, by its id on the platform. */
  readonly project: string;
  readonly store: () => ProjectStore | undefined;
  /**
   * Resolves to the update of the platform that has every change made here so far, once it has
   * it, or undefined where it did not get there in time, see `CloudSession`.
   */
  readonly sent: () => Promise<number | undefined>;
  /** What the platform said of archiving afterwards, see `RepositoryWatch.take`. */
  readonly status?: (status: RepositoryStatus) => void;
}

/** The object of a conflict and what of it, as people read the label: "片段“开场”的 时长". */
export function splitLabel(label: string): { readonly object: string; readonly part?: string } {
  const at = label.lastIndexOf("的 ");
  return at > 0 ? { object: label.slice(0, at), part: label.slice(at + 2) } : { object: label };
}

const isCode = (conflict: RepositoryConflict) =>
  conflict.kind === "lines" || conflict.kind === "file" || conflict.kind === "check-duplicate";

/** The object a conflict is about, where it is one people can go to. */
export function objectOfConflict(conflict: RepositoryConflict): ObjectRef | undefined {
  if (isCode(conflict)) return { kind: "file", id: conflict.file };
  const object = objectOfPath(conflict.path);
  return object.kind === "project" ? undefined : object;
}

/** The conflicts that wait, by object, in the order they come. */
export function groupsOf(rows: readonly ConflictRow[]): ConflictGroup[] {
  const groups = new Map<
    string,
    { key: string; title: string; file: string; rows: ConflictRow[] }
  >();
  for (const row of rows) {
    const { conflict } = row;
    const object = objectOfConflict(conflict);
    // What is about the project as a whole, such as its name, is one group.
    const key = isCode(conflict) ? `file:${conflict.file}` : object ? objectKey(object) : "project";
    const known = groups.get(key);
    if (known) known.rows.push(row);
    else
      groups.set(key, {
        key,
        title: isCode(conflict) ? conflict.file : object ? splitLabel(conflict.label).object : "",
        file: conflict.file,
        rows: [row],
      });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    object: objectOfConflict(group.rows[0]!.conflict),
  }));
}

const LOADING: ConflictListSnapshot = {
  status: "loading",
  open: [],
  handled: [],
  busy: false,
  trouble: false,
};

export class ConflictList {
  readonly #options: ConflictListOptions;
  readonly #emitter = new Emitter();
  #rows: ConflictRow[] = [];
  #snapshot: ConflictListSnapshot = LOADING;
  #closed = false;

  constructor(options: ConflictListOptions) {
    this.#options = options;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ConflictListSnapshot => this.#snapshot;

  get project(): string {
    return this.#options.project;
  }

  /** Reads the list from the platform again, and with it what values were too large for it. */
  async load(): Promise<void> {
    const { access, project } = this.#options;
    if (!access.conflicts) return this.#set({ status: "failed" });
    if (this.#snapshot.status !== "ready") this.#set({ status: "loading" });
    try {
      const listed = await access.conflicts(project);
      const whole = await Promise.all(
        listed.map(async (conflict) =>
          conflict.large && conflict.state === "open" && access.conflict
            ? await access.conflict(project, conflict.id).catch(() => conflict)
            : conflict,
        ),
      );
      if (this.#closed) return;
      const failed = new Map(this.#rows.map((row) => [row.conflict.id, row.failed]));
      this.#rows = whole.map((conflict) => {
        const was = failed.get(conflict.id);
        return { conflict, state: conflict.state, ...(was && { failed: was }) };
      });
      this.#show({ status: "ready" });
    } catch {
      if (!this.#closed) this.#set({ status: "failed" });
    }
  }

  close(): void {
    this.#closed = true;
  }

  /** How many wait. */
  get openCount(): number {
    return this.#rows.filter(({ state }) => state === "open").length;
  }

  /** "保留这里的", or "看过了": the project stays as it is. */
  async keep(ids: readonly string[]): Promise<void> {
    const open = this.#open(ids);
    if (open.length === 0 || this.#snapshot.busy) return;
    this.#set({ busy: true, trouble: false });
    try {
      await this.#tell(
        open.map(({ conflict }) => conflict.id),
        "ours",
      );
    } finally {
      this.#set({ busy: false });
    }
  }

  /**
   * "换成 GitHub 的": GitHub's side, as one edit of people's own for all of them, where the project
   * still has its own side there; what changed since goes with what is done.
   */
  async take(ids: readonly string[]): Promise<void> {
    const store = this.#options.store();
    const open = this.#open(ids).filter(({ conflict }) => TAKEABLE.has(conflict.kind));
    if (!store || open.length === 0 || this.#snapshot.busy) return;
    this.#set({ busy: true, trouble: false });
    try {
      let going = [...open];
      const failed = new Map<string, "changed" | "other">();
      let changed = false;
      // One edit for all of them: one that cannot be taken goes out, and the rest go again.
      while (going.length > 0) {
        const calls: CommandCall[] = going.map(({ conflict }) => ({
          type: "conflict.take",
          params: { conflict: takenOf(conflict) },
        }));
        const result = store.executeBatch(calls);
        if (result.ok) {
          changed = result.patches.length > 0;
          break;
        }
        const index = result.error.index ?? 0;
        const which = going[index];
        if (!which) {
          for (const row of going) failed.set(row.conflict.id, "other");
          going = [];
          break;
        }
        const why = (result.error.params as { why?: unknown }).why;
        failed.set(
          which.conflict.id,
          result.error.code === "conflict-not-taken" && why === "changed" ? "changed" : "other",
        );
        going = going.filter((row) => row !== which);
      }
      if (failed.size > 0) {
        this.#rows = this.#rows.map((row) => {
          const why = failed.get(row.conflict.id);
          return why ? { ...row, failed: why } : row;
        });
        this.#show({});
      }
      // A place that changed since: what people chose there stands, and the list moves it on.
      const since = [...failed].filter(([, why]) => why === "changed").map(([id]) => id);
      if (since.length > 0) await this.#tell(since, "ours");
      if (going.length === 0) return;
      // Where the project had GitHub's side already, there is nothing for the platform to wait for.
      const seq = changed ? await this.#options.sent() : undefined;
      await this.#tell(
        going.map(({ conflict }) => conflict.id),
        "theirs",
        seq,
      );
    } finally {
      this.#set({ busy: false });
    }
  }

  /** "全部保留这里的". */
  keepAll(): Promise<void> {
    return this.keep(this.#open(undefined).map(({ conflict }) => conflict.id));
  }

  /** "全部换成 GitHub 的": what only people can settle stays open. */
  takeAll(): Promise<void> {
    return this.take(
      this.#open(undefined)
        .filter(({ conflict }) => TAKEABLE.has(conflict.kind))
        .map(({ conflict }) => conflict.id),
    );
  }

  #open(ids: readonly string[] | undefined): ConflictRow[] {
    const wanted = ids && new Set(ids);
    return this.#rows.filter(
      ({ conflict, state }) => state === "open" && (!wanted || wanted.has(conflict.id)),
    );
  }

  /** Tells the platform what people chose. Where it cannot be told, people can choose again. */
  async #tell(ids: readonly string[], keep: "ours" | "theirs", seq?: number): Promise<void> {
    const { access, project } = this.#options;
    if (!access.resolve) return;
    try {
      const status = await access.resolve(project, {
        ids,
        keep,
        ...(seq !== undefined && { seq }),
      });
      if (this.#closed) return;
      const chosen = new Set(ids);
      const at = Date.now();
      this.#rows = this.#rows.map((row) =>
        chosen.has(row.conflict.id) && row.state === "open"
          ? { ...row, state: keep, conflict: { ...row.conflict, resolvedAt: at } }
          : row,
      );
      this.#show({});
      this.#options.status?.(status);
    } catch {
      // Signed out, the platform away, or "behind" where the change did not get there in time.
      if (!this.#closed) this.#set({ trouble: true });
    }
  }

  #show(change: Partial<ConflictListSnapshot>): void {
    const open = this.#rows.filter(({ state }) => state === "open");
    const handled = this.#rows
      .filter(({ state }) => state !== "open")
      .toSorted(
        (a, b) =>
          (b.conflict.resolvedAt ?? b.conflict.at) - (a.conflict.resolvedAt ?? a.conflict.at),
      );
    this.#set({ ...change, open: groupsOf(open), handled });
  }

  #set(change: Partial<ConflictListSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...change };
    this.#emitter.emit();
  }
}

/** What `conflict.take` is given of a conflict: the fields `MergeConflict` has. */
export function takenOf(conflict: RepositoryConflict): Record<string, unknown> {
  return {
    file: conflict.file,
    path: [...conflict.path],
    kind: conflict.kind,
    ...(conflict.lines && { lines: conflict.lines }),
    ...(conflict.ours !== undefined && { ours: conflict.ours }),
    ...(conflict.theirs !== undefined && { theirs: conflict.theirs }),
    ...(conflict.around && { around: conflict.around }),
  };
}
