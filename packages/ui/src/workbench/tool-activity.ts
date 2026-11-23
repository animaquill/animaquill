import type { ChatEntry } from "@animaquill/agent";
import { objectKey, type ProjectState, type ProjectStore } from "@animaquill/core";
import { scoped } from "@animaquill/host";
import type { BridgeSession, ObjectChange } from "@animaquill/tools";
import type { TFunction } from "i18next";
import { summaryOf, type TurnChange } from "../chat/summary.ts";
import { changeLine } from "../chat/change-line.ts";
import type { BridgeWrite } from "../local-ai/bridge/executor.ts";
import {
  knownTool,
  type ToolClient,
  type ToolConnection,
  type ToolUse,
} from "../local-ai/tools.ts";
import type { Dialogs } from "./dialogs.ts";
import { Emitter } from "./emitter.ts";
import type { Notifications } from "./notifications.ts";

/** Where this browser keeps who changed each project lately, and how many of them. */
const USES_KEY = "animaquill.localAi.uses";
const KEPT_USES = 10;

/** What one batch of an AI tool on this computer changed in the open project, as far as it came. */
export interface ToolBatch {
  readonly origin: string;
  readonly client: ToolClient | undefined;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** What it changed, object by object: each field from before its first change to now. */
  readonly changes: readonly TurnChange[];
}

export interface ToolActivitySnapshot {
  /** The AI tools connected to the open project, the earliest first. */
  readonly connections: readonly ToolConnection[];
  /** Who changed the open project lately, the latest first, as this browser saw it. */
  readonly uses: readonly ToolUse[];
  /** The clips the latest batch changed or made, which the timeline marks. */
  readonly marked: ReadonlySet<string>;
}

export interface ToolActivityOptions {
  readonly t: TFunction;
  readonly notifications: Notifications;
  readonly dialogs: Dialogs;
  /** Takes a batch back as a whole. */
  readonly undo: (origin: string) => void;
  /** What this browser keeps the open project by, for who changed it lately. */
  readonly projectKey: () => string | undefined;
}

const NOTHING: ReadonlySet<string> = new Set();

/** The name of an AI tool, for people. */
export function toolName(t: TFunction, client: ToolClient | undefined): string {
  const known = knownTool(client);
  if (known) return t(`localAi.tools.${known}`);
  return client?.name ?? t("localAi.tools.unknown");
}

export const asTurnChange = (change: ObjectChange): TurnChange => ({
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
export function withProjectFields(
  change: TurnChange,
  merge: { readonly paths: readonly (readonly string[])[]; readonly before: ProjectState },
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

/**
 * What AI tools on this computer do to the open project through `animaquill mcp`
 * (docs/design/online-offline.md of AnimaQuill Cloud, 5; mcp.md 6.16a): who is connected, as the
 * relay says; what each batch they changed, told in one notice that keeps counting while the batch
 * goes on rather than one notice a change; the clips of the latest batch for the timeline; and who
 * changed the project lately, for the settings.
 */
export class ToolActivity {
  readonly #options: ToolActivityOptions;
  readonly #emitter = new Emitter();
  readonly #batches = new Map<string, { batch: ToolBatch; entries: ChatEntry[] }>();
  readonly #notices = new Map<string, number>();
  #store: ProjectStore | undefined;
  #snapshot: ToolActivitySnapshot = { connections: [], uses: [], marked: NOTHING };

  constructor(options: ToolActivityOptions) {
    this.#options = options;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): ToolActivitySnapshot => this.#snapshot;

  /** The batch of an origin of the open project, while this window knows it. */
  batchOf(origin: string | undefined): ToolBatch | undefined {
    return origin === undefined ? undefined : this.#batches.get(origin)?.batch;
  }

  /** Who the relay says is connected to the project of this window. */
  connected(sessions: readonly BridgeSession[]): void {
    const connections = sessions
      .map(({ session, client, since }) => ({ session, client, startedAt: since }))
      .toSorted((a, b) => a.startedAt - b.startedAt);
    const known = this.#snapshot.connections;
    const same =
      connections.length === known.length &&
      connections.every(
        (each, index) =>
          each.session === known[index]?.session &&
          each.client?.name === known[index]?.client?.name,
      );
    if (!same) this.#set({ connections });
  }

  /** Another project is open, or none: what was known of batches is of the one before. */
  follow(store: ProjectStore | undefined): void {
    if (store === this.#store) return;
    this.#store = store;
    this.#batches.clear();
    this.#notices.clear();
    this.#set({ marked: NOTHING, uses: this.#readUses() });
  }

  /** A session changed the project: tells people, and marks its clips. */
  wrote(write: BridgeWrite): void {
    const { origin, client, store, result, tool } = write;
    this.#store = store;
    const known = this.#batches.get(origin);
    const now = Date.now();
    const entries = known?.entries ?? [];
    entries.push({
      role: "tool",
      at: now,
      task: origin,
      name: tool,
      ok: !result.isError,
      text: result.text,
      ...(result.data && { data: result.data }),
    } as unknown as ChatEntry);
    const { changes } = summaryOf(entries);
    const batch: ToolBatch = {
      origin,
      client: client ?? known?.batch.client,
      startedAt: known?.batch.startedAt ?? now,
      updatedAt: now,
      changes,
    };
    this.#batches.set(origin, { batch, entries });
    if (!known) this.#used(batch);
    this.#tell(batch);
    const marked = new Set(
      batch.changes
        .filter(({ kind, change }) => kind === "clip" && change !== "removed")
        .map(({ id }) => id),
    );
    this.#set({ marked });
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

  #tell(batch: ToolBatch): void {
    const { t, notifications } = this.#options;
    const state = this.#store?.getState();
    const tool = toolName(t, batch.client);
    const count = batch.changes.length;
    const [first] = batch.changes;
    const firstText = first ? changeLine(t, first, state) : undefined;
    const message =
      firstText === undefined
        ? t("localAi.notice.changedNone", { tool })
        : t(count > 1 ? "localAi.notice.changedMore" : "localAi.notice.changed", {
            tool,
            count,
            first: firstText,
          });
    const id = notifications.update(this.#notices.get(batch.origin), message, {
      actions: [
        { label: t("localAi.notice.show"), run: () => void this.show(batch.origin) },
        { label: t("localAi.notice.undo"), run: () => this.#options.undo(batch.origin) },
      ],
    });
    this.#notices.set(batch.origin, id);
  }

  /** What a batch changed, all of it, to read. */
  async show(origin: string): Promise<void> {
    const batch = this.#batches.get(origin)?.batch;
    if (!batch) return;
    const { t, dialogs } = this.#options;
    const state = this.#store?.getState();
    const lines = batch.changes.map((change) => changeLine(t, change, state));
    await dialogs.confirm({
      title: t("localAi.notice.showTitle", {
        tool: toolName(t, batch.client),
        count: batch.changes.length,
      }),
      message: "",
      confirm: t("dialog.close"),
      noticeOnly: true,
      ...(lines.length > 0 && { details: [{ title: t("localAi.notice.changes"), items: lines }] }),
    });
  }

  /** Who changed the open project lately, as this browser keeps it. */
  #readUses(): readonly ToolUse[] {
    const project = this.#options.projectKey();
    if (project === undefined) return [];
    try {
      const all = JSON.parse(localStorage.getItem(scoped(USES_KEY)) ?? "{}") as Record<
        string,
        ToolUse[]
      >;
      const uses = all[project];
      return Array.isArray(uses) ? uses : [];
    } catch {
      return [];
    }
  }

  /** A new batch of a tool: it changed the project now, once more. */
  #used(batch: ToolBatch): void {
    const project = this.#options.projectKey();
    if (project === undefined) return;
    const name = batch.client?.name ?? "";
    const before = this.#readUses();
    const was = before.find((use) => (use.client?.name ?? "") === name);
    const uses = [
      { client: batch.client, lastAt: batch.updatedAt, batches: (was?.batches ?? 0) + 1 },
      ...before.filter((use) => use !== was),
    ].slice(0, KEPT_USES);
    try {
      const all = JSON.parse(localStorage.getItem(scoped(USES_KEY)) ?? "{}") as Record<
        string,
        ToolUse[]
      >;
      all[project] = uses;
      localStorage.setItem(scoped(USES_KEY), JSON.stringify(all));
    } catch {
      // Not kept: the list shows what this window saw.
    }
    this.#set({ uses });
  }

  #set(next: Partial<ToolActivitySnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next };
    this.#emitter.emit();
  }
}
