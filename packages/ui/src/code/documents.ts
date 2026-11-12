import { entryOf, type ProjectStore, type CommandFailure } from "@animaquill/core";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";

/** A file that is open for editing, in a tab of the code panel. */
export interface CodeDocument {
  readonly path: string;
  /** What people see, with what they typed. */
  readonly text: string;
  /** What they started from. Undefined when the project has no such file (any more). */
  readonly base: string | undefined;
  /** Goes up when the text comes from anywhere but the editor, which then has to take it over. */
  readonly version: number;
  /** The project moved on under edits that are not saved, so that saving would overwrite it. */
  readonly conflict: "changed" | "removed" | undefined;
}

/** What a tab with unsaved edits is, without anything that only matters while it is open. */
export type Draft = Pick<CodeDocument, "path" | "text" | "base">;

export const isDirty = ({ text, base }: CodeDocument): boolean => text !== base;

/** Where to go in a file. */
export interface CodePlace {
  readonly line: number;
  readonly column?: number;
}

export interface CodeSnapshot {
  readonly documents: readonly CodeDocument[];
  readonly active: string | undefined;
  /** Somebody asked to see this place. The number tells one request from the next. */
  readonly reveal: (CodePlace & { readonly path: string; readonly request: number }) | undefined;
}

export interface CodeMessages {
  commandFailed(failure: CommandFailure): void;
  /** It went away with nothing unsaved in it. */
  closedRemoved(path: string): void;
}

export interface CodeQuestions {
  /** Unsaved edits in a tab that is closing. Undefined means stay. */
  unsaved(path: string): Promise<"save" | "discard" | undefined>;
  /** Saving would overwrite what changed elsewhere. Undefined means do nothing. */
  overwrite(path: string): Promise<"overwrite" | "theirs" | undefined>;
}

const NOTHING_OPEN: CodeSnapshot = { documents: [], active: undefined, reveal: undefined };

/** What can be aimed at. A project can say anything, also in what it reports about itself. */
const isLine = (line: number) => Number.isSafeInteger(line) && line > 0;

/**
 * The open files of a project. Changes to a file only count once they are saved, with a command, and
 * until then they stay in here, in this window. The project goes on changing meanwhile: other
 * windows, an import, and undo all end up here as a file that is not what it was. Without edits a
 * tab just follows. With edits nothing that people typed goes away by itself, and they get to say
 * what happens.
 */
export class CodeDocuments {
  readonly #emitter = new Emitter();
  readonly #session: ProjectSession;
  readonly #messages: CodeMessages;
  readonly #questions: CodeQuestions;
  #store: ProjectStore | undefined;
  #stopStore = () => {};
  #snapshot = NOTHING_OPEN;
  #request = 0;
  #moving = false;

  constructor(session: ProjectSession, messages: CodeMessages, questions: CodeQuestions) {
    this.#session = session;
    this.#messages = messages;
    this.#questions = questions;
    session.subscribe(this.#followSession);
    this.#followSession();
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): CodeSnapshot => this.#snapshot;

  get hasUnsaved(): boolean {
    return this.#snapshot.documents.some(isDirty);
  }

  get unsaved(): readonly string[] {
    return this.#snapshot.documents.filter(isDirty).map(({ path }) => path);
  }

  #set(changes: Partial<CodeSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...changes };
    this.#emitter.emit();
  }

  #find(path: string): CodeDocument | undefined {
    return this.#snapshot.documents.find((document) => document.path === path);
  }

  #replace(path: string, change: (document: CodeDocument) => CodeDocument): void {
    const documents = this.#snapshot.documents.map((document) =>
      document.path === path ? change(document) : document,
    );
    this.#set({ documents });
  }

  #fileOf(path: string): string | undefined {
    return entryOf(this.#store?.getState().files, path);
  }

  #followSession = (): void => {
    const { store } = this.#session;
    if (store === this.#store) return;
    this.#stopStore();
    this.#store = store;
    this.#stopStore = store?.subscribe(this.#followProject) ?? (() => {});
    if (this.#snapshot !== NOTHING_OPEN) {
      this.#snapshot = NOTHING_OPEN;
      this.#emitter.emit();
    }
  };

  /** One document after a change of the project, or undefined when its tab has nothing to show. */
  #follow(document: CodeDocument): CodeDocument | undefined {
    const now = this.#fileOf(document.path);
    const { text, base, version } = document;
    if (now === base) return document;
    // Saved here, or somebody came to the same text: either way there is nothing left to tell.
    if (now === text) return { ...document, base: now, conflict: undefined };
    if (isDirty(document)) {
      const conflict = now === undefined ? "removed" : "changed";
      return document.conflict === conflict ? document : { ...document, conflict };
    }
    if (now === undefined) return undefined;
    return { ...document, text: now, base: now, version: version + 1, conflict: undefined };
  }

  #followProject = (): void => {
    const { documents, active } = this.#snapshot;
    if (documents.length === 0 || this.#moving) return;
    const followed = documents.map((document) => this.#follow(document));
    if (followed.every((document, index) => document === documents[index])) return;
    const left = followed.filter((document) => document !== undefined);
    const gone = documents.filter((_, index) => followed[index] === undefined);
    const stillThere = left.some(({ path }) => path === active);
    this.#set({ documents: left, active: stillThere ? active : left.at(-1)?.path });
    for (const { path } of gone) this.#messages.closedRemoved(path);
  };

  /** Resolves to whether there is such a file. A place is only a place if it can be one. */
  open(path: string, place?: CodePlace): boolean {
    const known = this.#find(path);
    const text = this.#fileOf(path);
    if (!known && text === undefined) return false;
    const documents = known
      ? this.#snapshot.documents
      : [
          ...this.#snapshot.documents,
          { path, text: text as string, base: text, version: 0, conflict: undefined },
        ];
    this.#request += 1;
    const reveal =
      place && isLine(place.line) ? { ...place, path, request: this.#request } : undefined;
    this.#set({ documents, active: path, reveal });
    return true;
  }

  activate(path: string): void {
    if (this.#find(path) && this.#snapshot.active !== path) this.#set({ active: path });
  }

  /** People typed. This comes from the editor, which has the text already. */
  edit(path: string, text: string): void {
    const document = this.#find(path);
    if (!document || document.text === text) return;
    this.#replace(path, (current) => ({ ...current, text }));
    // People can type their way out of a conflict, or undo all the way back.
    if (document.conflict) this.#followProject();
  }

  /** Resolves to whether what is in the tab is what the project has now. */
  async save(path = this.#snapshot.active): Promise<boolean> {
    const document = path === undefined ? undefined : this.#find(path);
    if (!document) return false;
    if (document.conflict) {
      const answer = await this.#questions.overwrite(document.path);
      if (answer === undefined) return false;
      if (answer === "theirs") {
        this.takeTheirs(document.path);
        return true;
      }
    }
    return this.#write(document.path);
  }

  #write(path: string): boolean {
    // People can type while a question is open, and what they see is what they mean to save.
    const document = this.#find(path);
    const store = this.#store;
    if (!document || !store) return false;
    if (document.text === this.#fileOf(path)) {
      this.#followProject();
      return true;
    }
    const result = store.execute({ type: "file.write", params: { path, text: document.text } });
    if (!result.ok) this.#messages.commandFailed(result.error);
    return result.ok;
  }

  /** Saves every tab. Resolves to whether nothing is left unsaved. */
  async saveAll(): Promise<boolean> {
    let saved = true;
    for (const path of this.unsaved) saved = (await this.save(path)) && saved;
    return saved;
  }

  /** Gives up what is in the tab for what the project has. The editor can still undo that. */
  takeTheirs(path: string): void {
    const now = this.#fileOf(path);
    if (now === undefined) {
      this.#drop(path);
      return;
    }
    this.#replace(path, (document) => ({
      ...document,
      text: now,
      base: now,
      version: document.version + 1,
      conflict: undefined,
    }));
  }

  /** Goes on with what is in the tab, as if the change had been there when people started. */
  keepMine(path: string): void {
    const now = this.#fileOf(path);
    this.#replace(path, (document) => ({ ...document, base: now, conflict: undefined }));
  }

  /**
   * Runs a command that gives files other paths, by the old ones. What is in their tabs goes along.
   * Seen from here a rename is a file going away, so this has to know before it happens.
   */
  moving(moves: ReadonlyMap<string, string>, run: () => boolean): boolean {
    this.#moving = true;
    try {
      const moved = run();
      if (moved) this.#move(moves);
      return moved;
    } finally {
      this.#moving = false;
      this.#followProject();
    }
  }

  #move(moves: ReadonlyMap<string, string>): void {
    const { active } = this.#snapshot;
    const documents = this.#snapshot.documents.map((document) => {
      const path = moves.get(document.path);
      if (path === undefined) return document;
      return { ...document, path, base: this.#fileOf(path), conflict: undefined };
    });
    this.#set({ documents, active: moves.get(active ?? "") ?? active });
  }

  #drop(path: string): void {
    const { documents, active } = this.#snapshot;
    const index = documents.findIndex((document) => document.path === path);
    if (index === -1) return;
    const left = documents.filter((document) => document.path !== path);
    const next = left[Math.min(index, left.length - 1)]?.path;
    this.#set({ documents: left, active: active === path ? next : active });
  }

  /** Resolves to whether the tab went. */
  async close(path: string): Promise<boolean> {
    const document = this.#find(path);
    if (!document) return true;
    if (isDirty(document)) {
      const answer = await this.#questions.unsaved(path);
      if (answer === undefined) return false;
      if (answer === "save" && !(await this.save(path))) return false;
    }
    this.#drop(path);
    return true;
  }

  /**
   * Brings back what a window had not saved, as if people had typed it again. Nothing gets written:
   * whatever the project is now, it stays that way until people save, and what changed in the
   * meantime is a conflict like any other. Resolves to how many came back with something to save.
   */
  restore(drafts: readonly Draft[]): number {
    if (!this.#store) return 0;
    const open = new Set(this.#snapshot.documents.map(({ path }) => path));
    const back = drafts
      .filter(({ path, text, base }) => !open.has(path) && text !== base)
      .map(({ path, text, base }): CodeDocument => ({
        path,
        text,
        base,
        version: 0,
        conflict: undefined,
      }));
    if (back.length === 0) return 0;
    const documents = [...this.#snapshot.documents, ...back];
    this.#set({ documents, active: this.#snapshot.active ?? back[0]?.path });
    this.#followProject();
    // Somebody may have saved the same text since, which leaves nothing to come back.
    return this.unsaved.filter((path) => back.some((draft) => draft.path === path)).length;
  }

  /** What is not saved, for keeping it on the device. */
  get drafts(): readonly Draft[] {
    return this.#snapshot.documents.filter(isDirty).map(({ path, text, base }) => ({
      path,
      text,
      base,
    }));
  }

  /** Lets go of everything in the tabs. For people who said they want that. */
  discardAll(): void {
    this.#set({ documents: [], active: undefined, reveal: undefined });
  }
}
