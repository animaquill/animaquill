import { objectKey, type ProjectState, type ProjectStore } from "@animaquill/core";
import type { LocalFolder } from "@animaquill/host";
import { describeChanges, type ObjectChange } from "@animaquill/tools";
import type { TFunction } from "i18next";
import type { TurnChange } from "../chat/summary.ts";
import type { FolderMerge } from "../folder/session.ts";
import { changeLine } from "../chat/change-line.ts";
import {
  ToolNotes,
  knownTool,
  toolUses,
  type ToolBatchNote,
  type ToolClient,
  type ToolConnection,
  type ToolUse,
} from "../folder/tool-notes.ts";
import type { Dialogs } from "./dialogs.ts";
import { Emitter } from "./emitter.ts";
import type { Notifications } from "./notifications.ts";

/** How often the editor looks who is connected, and how often at the notes on batches besides. */
export const LOOK_EVERY_MS = 5_000;
const BATCHES_EVERY = 6;

/** What one batch of an AI tool on this computer changed in the open project, as far as it came. */
export interface ToolBatch {
  readonly origin: string;
  readonly client: ToolClient | undefined;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** What it changed, object by object: each field from before its first change to now. */
  readonly changes: readonly TurnChange[];
  /** The files that came in, for taking it back. */
  readonly files: readonly string[];
  /** Where people changed the same thing, and theirs stayed. */
  readonly conflicts: number;
  /** It came while the editor was not there. */
  readonly whileAway: boolean;
}

export interface ToolActivitySnapshot {
  /** The connections to the open project folder that are on, the earliest first. */
  readonly connections: readonly ToolConnection[];
  /** Who wrote to the open project folder lately, the latest first, as their notes say. */
  readonly uses: readonly ToolUse[];
  /** The clips the latest batch changed or made, which the timeline marks. */
  readonly marked: ReadonlySet<string>;
  /** There is a project folder to look at. */
  readonly folder: boolean;
}

export interface ToolActivityOptions {
  readonly t: TFunction;
  readonly notifications: Notifications;
  readonly dialogs: Dialogs;
  readonly showProblems: () => void;
  /** The folder of the open project, if any. */
  readonly folder: () => LocalFolder | undefined;
  /** The open project cannot be edited now, so the folder is left as it is. */
  readonly held: () => boolean;
  /** Takes a batch back as a whole, as the folder does it, see `ProjectFolders.undoBatch`. */
  readonly undo: (origin: string) => void;
  /** Has the folder looked at files that a batch says it wrote, see `FolderSession.lookAt`. */
  readonly lookAt: (paths: readonly string[]) => void;
}

const NOTHING: ReadonlySet<string> = new Set();

/** The name of an AI tool, for people. */
export function toolName(t: TFunction, client: ToolClient | undefined): string {
  const known = knownTool(client);
  if (known) return t(`localAi.tools.${known}`);
  return client?.name ?? t("localAi.tools.unknown");
}

const asTurnChange = (change: ObjectChange): TurnChange => ({
  key: objectKey({
    kind: change.kind,
    id: change.id,
    ...(change.timeline !== undefined && { timeline: change.timeline }),
  }),
  kind: change.kind,
  id: change.id,
  ...(change.timeline !== undefined && { timeline: change.timeline }),
  ...(change.name !== undefined && { name: change.name }),
  change: change.change,
  fields: change.fields ?? [],
  ...(change.lines && { lines: change.lines }),
});

/** A value of the project's own fields, in a few characters. */
function valueText(value: unknown): string {
  if (value === undefined) return "none";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [...text].length > 40 ? `${[...text].slice(0, 39).join("")}…` : text;
}

/**
 * The fields of the project itself that a merge changed, such as its name: the tools tell only
 * that the project changed, as its fields are not under an id.
 */
function withProjectFields(
  change: TurnChange,
  merge: FolderMerge,
  after: ProjectState,
): TurnChange {
  if (change.kind !== "project" || change.fields.length > 0) return change;
  const fields = [
    ...new Set(merge.paths.filter(([top]) => top === "manifest").map(([, field]) => field)),
  ].flatMap((field) => {
    if (field === undefined) return [];
    const before = (merge.before.manifest as Record<string, unknown>)[field];
    const now = (after.manifest as Record<string, unknown>)[field];
    return JSON.stringify(before) === JSON.stringify(now)
      ? []
      : [{ path: field, before: valueText(before), after: valueText(now) }];
  });
  return { ...change, fields };
}

/** What two changes of one object come to: each field from the first before to the last after. */
function joined(first: TurnChange, next: TurnChange): TurnChange | undefined {
  if (first.change === "added") return next.change === "removed" ? undefined : first;
  if (next.change !== "changed" || first.change !== "changed") return next;
  const fields = new Map(first.fields.map((field) => [field.path, field]));
  for (const field of next.fields) {
    const was = fields.get(field.path);
    fields.set(field.path, { ...field, ...(was && { before: was.before }) });
  }
  const lines =
    first.lines && next.lines
      ? {
          added: first.lines.added + next.lines.added,
          removed: first.lines.removed + next.lines.removed,
        }
      : (next.lines ?? first.lines);
  return { ...next, fields: [...fields.values()], ...(lines && { lines }) };
}

/**
 * What AI tools on this computer do to the open project through its folder (the local MCP,
 * docs/design/mcp.md 6.16a): who is connected, as the files of their connections say; what each
 * batch they wrote changed, told in one notice that keeps counting while the batch goes on rather
 * than one notice a merge; the clips of the latest batch for the timeline; and who wrote lately,
 * for the settings. Nothing of it is saved: the notes in the folder are what stays.
 */
export class ToolActivity {
  readonly #options: ToolActivityOptions;
  readonly #emitter = new Emitter();
  readonly #notes = new ToolNotes();
  readonly #batches = new Map<string, ToolBatch>();
  readonly #notices = new Map<string, number>();
  /** Batches that the editor did not take in because the project was read-only, told once. */
  readonly #heldTold = new Set<string>();
  #heldSince: number | undefined;
  #store: ProjectStore | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticks = 0;
  #looking = false;
  /** When each batch of the folder looked at was last written, as far as this window read. */
  #seen: Map<string, number> | undefined;
  #snapshot: ToolActivitySnapshot = {
    connections: [],
    uses: [],
    marked: NOTHING,
    folder: false,
  };

  constructor(options: ToolActivityOptions) {
    this.#options = options;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ToolActivitySnapshot => this.#snapshot;

  /** Starts looking at the folder of whatever project is open, every `LOOK_EVERY_MS`. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.look(), LOOK_EVERY_MS);
    void this.look();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The batch of an origin of the open project, while this window knows it. */
  batchOf(origin: string | undefined): ToolBatch | undefined {
    return origin === undefined ? undefined : this.#batches.get(origin);
  }

  /** Looks now: who is connected, and every so often who wrote. */
  async look({ batches = false }: { readonly batches?: boolean } = {}): Promise<void> {
    if (this.#looking) return;
    this.#looking = true;
    try {
      const folder = this.#options.folder();
      if (!folder) {
        if (this.#snapshot.folder) this.#set({ connections: [], uses: [], folder: false });
        return;
      }
      const connections = await this.#notes.connections(folder);
      // While a tool is connected, what it writes is looked for at every look.
      const readBatches =
        batches ||
        connections.length > 0 ||
        this.#ticks++ % BATCHES_EVERY === 0 ||
        !this.#snapshot.folder;
      const notes = readBatches ? await this.#notes.batches(folder) : undefined;
      if (this.#options.folder() !== folder) return;
      if (notes) {
        this.#tellHeld(notes);
        this.#lookAtNew(notes);
      }
      const same =
        connections.length === this.#snapshot.connections.length &&
        connections.every(
          (each, index) =>
            each.session === this.#snapshot.connections[index]?.session &&
            each.client?.name === this.#snapshot.connections[index]?.client?.name,
        );
      this.#set({
        ...(!same && { connections }),
        ...(notes && { uses: toolUses(notes) }),
        folder: true,
      });
    } finally {
      this.#looking = false;
    }
  }

  /**
   * Has the folder look at the files of batches that were written since the last look: the watch
   * of the folder does not always tell (see `FolderSession.lookAt`), and what an AI tool wrote
   * should show at once. What is as the editor knows it stays as it is.
   */
  #lookAtNew(notes: readonly ToolBatchNote[]): void {
    const seen = this.#seen;
    this.#seen = new Map(notes.map((note) => [note.batch, note.updatedAt]));
    // The first look at a folder: what is there came in as the folder was compared on opening.
    if (!seen) return;
    const paths = new Set<string>();
    for (const note of notes) {
      if ((seen.get(note.batch) ?? -1) >= note.updatedAt) continue;
      for (const path of note.files.keys()) paths.add(path);
    }
    if (paths.size > 0) this.#options.lookAt([...paths]);
  }

  /**
   * What a project that cannot be edited now leaves in the folder: an AI tool writes there all the
   * same, and that comes in once it can be edited again. People hear of it once a batch.
   */
  #tellHeld(notes: readonly ToolBatchNote[]): void {
    if (!this.#options.held()) {
      this.#heldSince = undefined;
      return;
    }
    const since = (this.#heldSince ??= Date.now());
    const { t, notifications } = this.#options;
    for (const note of notes) {
      if (note.updatedAt < since || this.#heldTold.has(note.batch)) continue;
      this.#heldTold.add(note.batch);
      notifications.push(t("localAi.notice.held", { tool: toolName(t, note.client) }));
    }
  }

  /** Another project is open, or none: what was known of batches is of the one before. */
  follow(store: ProjectStore | undefined): void {
    if (store === this.#store) return;
    this.#store = store;
    this.#batches.clear();
    this.#notices.clear();
    this.#heldTold.clear();
    this.#heldSince = undefined;
    this.#seen = undefined;
    this.#set({ marked: NOTHING, connections: [], uses: [], folder: false });
    void this.look({ batches: true });
  }

  /** A batch of an AI tool came in, or more of one: tells people, and marks its clips. */
  merged(store: ProjectStore, merge: FolderMerge): void {
    const { tool } = merge;
    if (!tool) return;
    this.#store = store;
    const after = store.getState();
    const described = describeChanges(merge.before, after, merge.paths)
      .map(asTurnChange)
      .map((change) => withProjectFields(change, merge, after));
    const known = this.#batches.get(merge.origin);
    const changes = new Map((known?.changes ?? []).map((change) => [change.key, change]));
    for (const change of described) {
      const was = changes.get(change.key);
      const next = was ? joined(was, change) : change;
      if (next) changes.set(change.key, next);
      else changes.delete(change.key);
    }
    const batch: ToolBatch = {
      origin: merge.origin,
      client: tool.client ?? known?.client,
      startedAt: Math.min(known?.startedAt ?? tool.startedAt, tool.startedAt),
      updatedAt: Math.max(known?.updatedAt ?? 0, tool.updatedAt),
      changes: [...changes.values()],
      files: [...new Set([...(known?.files ?? []), ...merge.files])],
      conflicts: (known?.conflicts ?? 0) + merge.conflicts.length,
      whileAway: (known ? known.whileAway : true) && merge.atStart,
    };
    this.#batches.set(merge.origin, batch);
    this.#tell(batch, after);
    const marked = new Set(
      batch.changes
        .filter(({ kind, change }) => kind === "clip" && change !== "removed")
        .map(({ id }) => id),
    );
    this.#set({ marked });
    void this.look({ batches: true });
  }

  /** The batch was taken back: its clips are not marked any more, and its notice goes. */
  undone(origin: string): void {
    if (!this.#batches.has(origin)) return;
    // What it says is not so any more.
    const notice = this.#notices.get(origin);
    if (notice !== undefined) this.#options.notifications.dismiss(notice);
    this.#notices.delete(origin);
    this.#set({ marked: NOTHING });
  }

  #tell(batch: ToolBatch, state: ProjectState): void {
    const { t, notifications, showProblems } = this.#options;
    const tool = toolName(t, batch.client);
    const count = batch.changes.length;
    const [first] = batch.changes;
    const firstText = first ? changeLine(t, first, state) : undefined;
    const message = batch.whileAway
      ? t("localAi.notice.whileAway", { tool, count: batch.files.length })
      : firstText === undefined
        ? t("localAi.notice.changedNone", { tool })
        : t(count > 1 ? "localAi.notice.changedMore" : "localAi.notice.changed", {
            tool,
            count,
            first: firstText,
          });
    const id = notifications.update(this.#notices.get(batch.origin), message, {
      stays: batch.whileAway,
      actions: [
        { label: t("localAi.notice.show"), run: () => void this.show(batch.origin) },
        { label: t("localAi.notice.undo"), run: () => this.#options.undo(batch.origin) },
      ],
      ...(batch.conflicts > 0 && {
        warning: {
          text: t("localAi.notice.yoursKept", { count: batch.conflicts }),
          action: { label: t("localAi.notice.show"), run: showProblems },
        },
      }),
    });
    this.#notices.set(batch.origin, id);
  }

  /** What a batch changed, all of it, to read. */
  async show(origin: string): Promise<void> {
    const batch = this.#batches.get(origin);
    if (!batch) return;
    const { t, dialogs } = this.#options;
    const state = this.#store?.getState();
    const lines = batch.changes.map((change) => changeLine(t, change, state));
    await dialogs.confirm({
      title: t("localAi.notice.showTitle", {
        tool: toolName(t, batch.client),
        count: batch.changes.length,
      }),
      message: batch.files.join("、"),
      confirm: t("dialog.close"),
      noticeOnly: true,
      ...(lines.length > 0 && { details: [{ title: t("localAi.notice.changes"), items: lines }] }),
    });
  }

  #set(next: Partial<ToolActivitySnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    this.#emitter.emit();
  }
}
