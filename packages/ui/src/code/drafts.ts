import { MAX_SOURCE_BYTES, type ProjectStore } from "@animaquill/core";
import type { DraftStore } from "@animaquill/host";
import { RelativePath } from "@animaquill/schema";
import { PlaceKeeper, type KeeperMessages } from "../workbench/keeper.ts";
import type { ProjectSession } from "../workbench/session.ts";
import type { CodeDocuments, Draft } from "./documents.ts";

const FORMAT_VERSION = 1;

/** More than this is no code anybody is writing at the same time, and the device has a limit. */
const MAX_DRAFTS = 100;

/** Bytes per character at the most, in UTF-8. */
const MOST_BYTES_PER_CHARACTER = 3;

export interface DraftMessages extends KeeperMessages {
  /** What a window had not saved came back. */
  restored(count: number): void;
  /** Some of it could not, because it was not something this editor can open. */
  dropped(count: number): void;
}

interface StoredDraft {
  readonly path: string;
  readonly text: string;
  /** What the edits started from. Null for a file that the project did not have. */
  readonly base: string | null;
}

interface Stored {
  readonly version: typeof FORMAT_VERSION;
  readonly drafts: readonly StoredDraft[];
}

/** Only code of a project is something to edit. What a device kept can be anything. */
const isCodePath = (path: unknown): path is string =>
  typeof path === "string" &&
  /^(scenes|sounds|code)\//.test(path) &&
  RelativePath.safeParse(path).success;

const fits = (text: string) => text.length * MOST_BYTES_PER_CHARACTER <= MAX_SOURCE_BYTES;

/** What was kept, and how much of it could not be used. Anything else is read as nothing. */
export function readDrafts(kept: unknown): { drafts: readonly Draft[]; dropped: number } {
  const { version, drafts } = (kept ?? {}) as Partial<Stored>;
  if (version !== FORMAT_VERSION || !Array.isArray(drafts)) {
    return { drafts: [], dropped: kept === undefined ? 0 : 1 };
  }
  const usable: Draft[] = [];
  const seen = new Set<string>();
  for (const draft of drafts.slice(0, MAX_DRAFTS) as Partial<StoredDraft>[]) {
    const { path, text, base } = draft ?? {};
    const isBase = base === null || (typeof base === "string" && fits(base));
    if (!isCodePath(path) || typeof text !== "string" || !fits(text) || !isBase || seen.has(path)) {
      continue;
    }
    seen.add(path);
    usable.push({ path, text, base: base ?? undefined });
  }
  return { drafts: usable, dropped: drafts.length - usable.length };
}

function toStored(drafts: readonly Draft[]): Stored | undefined {
  if (drafts.length === 0) return undefined;
  const stored = drafts
    .slice(0, MAX_DRAFTS)
    .map(({ path, text, base }) => ({ path, text, base: base ?? null }));
  return { version: FORMAT_VERSION, drafts: stored };
}

/**
 * Keeps code that is not saved on the device, in a place of this window, so that a reload or a crash
 * does not take it. It comes back as unsaved tabs: nothing goes into the project by itself, so that
 * whatever happened to the project meanwhile, it opens as it is.
 */
export class CodeDrafts {
  readonly #session: ProjectSession;
  readonly #code: CodeDocuments;
  readonly #places: DraftStore;
  readonly #messages: DraftMessages;
  #store: ProjectStore | undefined;
  #keeper: PlaceKeeper | undefined;
  #leaving: Promise<void> = Promise.resolve();
  #documents: unknown;

  constructor(
    session: ProjectSession,
    code: CodeDocuments,
    places: DraftStore,
    messages: DraftMessages,
  ) {
    this.#session = session;
    this.#code = code;
    this.#places = places;
    this.#messages = messages;
    // The tabs start over with a new project first, and only then does this go with it.
    code.subscribe(this.#followCode);
    session.subscribe(this.#followSession);
    this.#followSession();
  }

  /** Resolves to whether all of it is on the device. */
  async settle(): Promise<boolean> {
    return (await this.#keeper?.settled()) !== false;
  }

  #followCode = (): void => {
    const { documents } = this.#code.getSnapshot();
    // The tabs empty themselves for another project, which is no reason to forget what was kept.
    if (documents === this.#documents || this.#session.store !== this.#store) return;
    this.#documents = documents;
    this.#keeper?.keep();
  };

  #followSession = (): void => {
    const { store } = this.#session;
    if (store === this.#store) return;
    this.#leaving = this.#keeper?.close() ?? this.#leaving;
    this.#store = store;
    this.#keeper = undefined;
    if (!store) return;
    const { id } = store.getState().manifest;
    const leaving = this.#leaving;
    const keeper = new PlaceKeeper(
      () => toStored(this.#code.drafts),
      () => leaving.then(() => this.#places.open(id)),
      this.#messages,
      (kept) => {
        if (this.#keeper !== keeper) return;
        const { drafts, dropped } = readDrafts(kept);
        const restored = this.#code.restore(drafts);
        if (restored > 0) this.#messages.restored(restored);
        if (dropped > 0) this.#messages.dropped(dropped);
        // What came back is in the tabs now, and what is kept has to be that and nothing else.
        if (dropped > 0 || restored !== drafts.length) keeper.keep();
      },
    );
    this.#keeper = keeper;
  };
}
