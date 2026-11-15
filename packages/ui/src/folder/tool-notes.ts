import type { FileChange } from "@animaquill/core";
import { FolderError, type LocalFolder } from "@animaquill/host";
import { hashTextHex } from "@animaquill/media";

/**
 * What the local MCP (`animaquill mcp`, packages/local/src/mcp/notes.ts) leaves next to the
 * project in `.animaquill/`, as the editor reads it: notes on the batches an AI tool on this
 * computer wrote, which say whose a change of the folder is, and a file for each connection that
 * is on. The format is that of `notes.ts` (`format: 1`); the editor only reads it, and what it
 * cannot read says nothing.
 */

export const BATCHES_FOLDER = ".animaquill/batches";
export const CONNECTIONS_FOLDER = ".animaquill/mcp";
/** A connection that did not say it is there for this long is gone (`GONE_AFTER_MS` there). */
export const GONE_AFTER_MS = 2 * 60 * 1000;

/** Who wrote: the AI tool, as it names itself (`clientInfo`). */
export interface ToolClient {
  readonly name: string;
  readonly version?: string | undefined;
}

/** One batch an AI tool wrote: one task of it, see `BATCH_GAP_MS` of the local MCP. */
export interface ToolBatchNote {
  readonly batch: string;
  readonly session: string;
  readonly client: ToolClient | undefined;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** Each file as the batch left it: SHA-256 of its text in hex, or null where it took it away. */
  readonly files: ReadonlyMap<string, string | null>;
}

/** A connection of an AI tool to the project folder that is on. */
export interface ToolConnection {
  readonly session: string;
  readonly client: ToolClient | undefined;
  readonly startedAt: number;
  readonly aliveAt: number;
}

/** The AI tools the editor knows by name; any other goes by the name it gives itself. */
export type KnownTool = "claudeCode" | "codex" | "cursor" | "vscode" | "claudeDesktop";

/**
 * Which AI tool a client is, by the name it gives itself in `initialize`. Claude Code says
 * "claude-code", Cursor "cursor-vscode", Claude's apps "claude-ai"; the others as their names go.
 */
export function knownTool(client: ToolClient | undefined): KnownTool | undefined {
  const name = client?.name.toLowerCase() ?? "";
  if (name.includes("claude-code") || name.includes("claude code")) return "claudeCode";
  if (name.includes("codex")) return "codex";
  if (name.includes("cursor")) return "cursor";
  if (name.includes("visual studio code") || name.includes("vscode") || name === "vs code") {
    return "vscode";
  }
  if (name.startsWith("claude")) return "claudeDesktop";
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function clientOf(value: unknown): ToolClient | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim() === "") {
    return undefined;
  }
  // What a tool calls itself is shown as text, and only so much of it.
  const name = value.name.trim().slice(0, 60);
  const version = typeof value.version === "string" ? value.version.slice(0, 30) : undefined;
  return { name, ...(version !== undefined && { version }) };
}

/** A note on a batch, as `.animaquill/batches/<batch>.json` holds it, or nothing. */
export function parseBatchNote(text: string): ToolBatchNote | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.format !== 1 || typeof value.batch !== "string") return undefined;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value.batch)) return undefined;
  if (!isTime(value.startedAt) || !isTime(value.updatedAt) || !isRecord(value.files)) {
    return undefined;
  }
  const files = new Map<string, string | null>();
  for (const [path, hash] of Object.entries(value.files)) {
    if (hash === null || (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) {
      files.set(path, hash);
    }
  }
  return {
    batch: value.batch,
    session: typeof value.session === "string" ? value.session : "",
    client: clientOf(value.client),
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    files,
  };
}

/** A file of a connection, as `.animaquill/mcp/<session>.json` holds it, or nothing. */
export function parseConnection(text: string): ToolConnection | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.format !== 1 || typeof value.session !== "string") return undefined;
  if (!isTime(value.startedAt) || !isTime(value.aliveAt)) return undefined;
  return {
    session: value.session,
    client: clientOf(value.client),
    startedAt: value.startedAt,
    aliveAt: value.aliveAt,
  };
}

/** Whether a connection said it is there lately enough to count as on. */
export const isAlive = (connection: ToolConnection, now: number): boolean =>
  now - connection.aliveAt <= GONE_AFTER_MS;

const isNoteName = (name: string) => /^[A-Za-z0-9_-]+\.json$/.test(name);

/** The folder of the notes inside the project folder, or nothing where there is none. */
async function notesFolder(folder: LocalFolder, path: string): Promise<LocalFolder | undefined> {
  let at = folder;
  try {
    for (const name of path.split("/")) at = await at.inside(name);
  } catch (error) {
    if (error instanceof FolderError && error.reason === "missing") return undefined;
    throw error;
  }
  return at;
}

interface Cached<T> {
  readonly modified: number;
  readonly size: number;
  readonly value: T | undefined;
}

/**
 * Reads the notes of a folder, each again only once it changed: a merge asks for them every time
 * the folder changed, and most of them stay as they are.
 */
class NotesReader<T> {
  readonly #path: string;
  readonly #parse: (text: string) => T | undefined;
  #cache = new Map<string, Cached<T>>();

  constructor(path: string, parse: (text: string) => T | undefined) {
    this.#path = path;
    this.#parse = parse;
  }

  async read(folder: LocalFolder): Promise<T[]> {
    const inside = await notesFolder(folder, this.#path);
    if (!inside) {
      this.#cache.clear();
      return [];
    }
    const next = new Map<string, Cached<T>>();
    for await (const name of inside.list()) {
      if (!isNoteName(name)) continue;
      try {
        const file = await inside.file(name);
        const known = this.#cache.get(name);
        if (known && known.modified === file.lastModified && known.size === file.size) {
          next.set(name, known);
          continue;
        }
        const value = this.#parse(await file.text());
        next.set(name, { modified: file.lastModified, size: file.size, value });
      } catch {
        // Gone or being written right now: the next look finds it.
      }
    }
    this.#cache = next;
    return [...next.values()].flatMap(({ value }) => (value === undefined ? [] : [value]));
  }
}

/** The notes of the AI tools in one project folder, as the editor reads them. */
export class ToolNotes {
  readonly #batches = new NotesReader(BATCHES_FOLDER, parseBatchNote);
  readonly #connections = new NotesReader(CONNECTIONS_FOLDER, parseConnection);

  /** The notes on batches. Nothing where they cannot be read. */
  async batches(folder: LocalFolder): Promise<readonly ToolBatchNote[]> {
    try {
      return await this.#batches.read(folder);
    } catch {
      return [];
    }
  }

  /** The connections that are on now, the earliest first. */
  async connections(folder: LocalFolder, now = Date.now()): Promise<readonly ToolConnection[]> {
    try {
      const all = await this.#connections.read(folder);
      return all
        .filter((connection) => isAlive(connection, now))
        .toSorted((a, b) => a.startedAt - b.startedAt);
    } catch {
      return [];
    }
  }
}

/**
 * The batch of an AI tool that a merge is: the latest batch that left each file of it just as it
 * is now. Where no batch did, somebody else changed something too, and the merge is nobody's in
 * particular, as before.
 */
export function batchOfChanges(
  changes: readonly Pick<FileChange, "path" | "text">[],
  notes: readonly ToolBatchNote[],
): ToolBatchNote | undefined {
  if (changes.length === 0 || notes.length === 0) return undefined;
  const hashes = changes.map(({ path, text }) => ({
    path,
    hash: text === undefined ? null : hashTextHex(text),
  }));
  let found: ToolBatchNote | undefined;
  for (const note of notes) {
    if (found && note.updatedAt <= found.updatedAt) continue;
    if (hashes.every(({ path, hash }) => note.files.has(path) && note.files.get(path) === hash)) {
      found = note;
    }
  }
  return found;
}

/** The AI tools that wrote to this project, each with its last time and how many tasks. */
export interface ToolUse {
  readonly client: ToolClient | undefined;
  readonly lastAt: number;
  readonly batches: number;
}

/** What the notes on batches say about who wrote to the project, the latest first. */
export function toolUses(notes: readonly ToolBatchNote[]): readonly ToolUse[] {
  const uses = new Map<string, ToolUse>();
  for (const note of notes) {
    const key = note.client?.name ?? "";
    const known = uses.get(key);
    uses.set(key, {
      client: note.client ?? known?.client,
      lastAt: Math.max(known?.lastAt ?? 0, note.updatedAt),
      batches: (known?.batches ?? 0) + 1,
    });
  }
  return [...uses.values()].toSorted((a, b) => b.lastAt - a.lastAt);
}
