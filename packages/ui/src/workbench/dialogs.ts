import type { RepositoryConflict } from "@animaquill/host";
import type { ConflictList } from "../cloud/conflicts.ts";
import type { CloudCreate } from "../cloud/create.ts";
import type { OpeningAction, OpeningRow, RepositoryOpening } from "../cloud/open-repository.ts";
import type { RepositoryPicker } from "../cloud/repository-picker.ts";
import { Emitter } from "./emitter.ts";

export interface PromptOptions {
  readonly title: string;
  readonly value?: string;
  /** What people should know about what comes next, under the box. */
  readonly hint?: string;
  readonly confirm: string;
  /** Nothing is an answer too, as for no tags at all. */
  readonly allowEmpty?: boolean;
}

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  /** The word on the button that says no, where "cancel" would not say what it does. */
  readonly cancel?: string;
  /** The action cannot be taken back, so it should look that way. */
  readonly danger?: boolean;
  /** Only something to read, so there is nothing to cancel. */
  readonly noticeOnly?: boolean;
  /**
   * Saying no is what people most likely want, as it keeps something going: that button looks like
   * the main one, and the one that says yes does not.
   */
  readonly keep?: boolean;
  /** Lists below the message, which can get long. */
  readonly details?: readonly DialogDetail[];
  /** What is lost for good where people go on, standing out under the message. */
  readonly warning?: string;
}

export interface ChoiceOptions {
  readonly title: string;
  readonly message: string;
  /** What is lost for good where people go on, standing out under the message. */
  readonly warning?: string;
  /** In the order of the buttons. Cancelling is always there, in front of them. */
  readonly choices: readonly DialogChoice[];
  /** What people should know besides, one line each, under the message. */
  readonly notes?: readonly string[];
  /** Pictures side by side under the message, such as before and after a change. */
  readonly pictures?: readonly DialogPicture[];
  /** The choices are a sentence each: one under another, with cancelling apart below them. */
  readonly stacked?: boolean;
  /**
   * What it says is over, so there is nothing to cancel: no button for it, and closing it is
   * as the primary choice.
   */
  readonly done?: boolean;
}

export interface DialogPicture {
  readonly label: string;
  /** Where the picture is, such as an object URL that whoever asks takes away afterwards. */
  readonly url: string;
}

export interface DialogChoice {
  readonly id: string;
  readonly label: string;
  /** What people most likely want, or what cannot be taken back. */
  readonly kind?: "primary" | "danger";
}

/** Choices to make before something starts, one list each. */
export interface FormOptions {
  readonly title: string;
  readonly fields: readonly FormField[];
  /** What people should know first, one line each. */
  readonly notes?: readonly string[];
  /** The notes go above the fields: what the choice is about comes first. */
  readonly notesFirst?: boolean;
  readonly confirm: string;
}

export interface FormField {
  readonly id: string;
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  /** The id of the option chosen at first. */
  readonly value: string;
}

/** The id of the option chosen in each field, by field. */
export type FormAnswer = Readonly<Record<string, string>>;

export interface DialogDetail {
  readonly title: string;
  /** Each a line, or a line to click, which shows something without closing the dialog. */
  readonly items: readonly (string | DialogDetailLink)[];
}

export interface DialogDetailLink {
  readonly label: string;
  /** What a click on it shows, such as where on the timeline it is. */
  readonly show: () => void;
}

/** Choosing where a project of the platform is saved on GitHub, see `RepositoryPicker`. */
export interface RepositoryDialogOptions {
  readonly title: string;
  readonly picker: RepositoryPicker;
  /** Leaves the page to install the GitHub App, where it is not on the account. */
  readonly installApp?: () => void;
}

/** Making a new project: of this computer, or of the platform, see `CloudCreate`. */
export interface CreateDialogOptions {
  readonly title: string;
  readonly create: CloudCreate;
  /** What is made is a project that people imported, see `Workbench.importProject`. */
  readonly imported?: boolean;
}

/** "从仓库打开": the repositories, and what people chose to do with one of them. */
export interface OpenRepositoryDialogOptions {
  readonly title: string;
  readonly opening: RepositoryOpening;
}

/** What people chose in "从仓库打开", which the workbench then does. */
export interface OpenRepositoryChoice {
  readonly row: OpeningRow;
  readonly action: OpeningAction;
}

/** A file of the project that two sides have differently, for people to choose a side for. */
export interface ReconcileItem {
  readonly path: string;
  /** How the two sides have it, in words. */
  readonly status: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly value: string;
  /** What else to know about it before choosing, as that the side chosen takes it only in part. */
  readonly note?: string;
}

/** Which side each file is to be, see `ReconcileItem`, as one choice for every file. */
export interface ReconcileDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly items: readonly ReconcileItem[];
  /** Choices for every file at once, by the id of the option. */
  readonly all: readonly { readonly id: string; readonly label: string }[];
  readonly notes: readonly string[];
  /** Why the last choices could not be carried out, or what to look at before going on. */
  readonly error?: string;
  readonly confirm: string;
  /**
   * What the choices as they are now come to, in a line above the buttons, and the word of the
   * button that carries them out: `loud` where they take something away that people may not
   * expect.
   */
  readonly summarize?: (values: FormAnswer) => {
    readonly text: string;
    readonly confirm: string;
    readonly loud: boolean;
    /** Whether the choices can be carried out as they are, as once every file has one. */
    readonly ready?: boolean;
  };
}

export interface ProgressOptions {
  readonly title: string;
  /** The word on the button that stops it. */
  readonly cancel: string;
  /** What it says from then on, until it has come to a stop. */
  readonly stopping: string;
}

export interface ProgressState {
  readonly title?: string;
  /** What it is working on right now. */
  readonly detail?: string;
  /** How much of it is done, from 0 to 1. Without it nobody knows yet. */
  readonly ratio?: number;
  /** The same for people to read. */
  readonly amount?: string;
}

/** A dialog that stays for as long as something takes, and can be asked to stop it. */
export interface ProgressDialog {
  /** Aborts when people want it to stop. It goes on until whoever runs it has got to that point. */
  readonly signal: AbortSignal;
  update(state: ProgressState): void;
  close(): void;
}

export type ProgressRequest = {
  readonly kind: "progress";
  readonly id: number;
  readonly stopped: boolean;
  readonly stop: () => void;
} & ProgressOptions &
  ProgressState;

/** Which assets of the open project go into the large file storage, see `PlacesDialog`. */
/** The places both the project and GitHub changed, see `ConflictList`. */
export interface ConflictsDialogOptions {
  readonly title: string;
  readonly list: ConflictList;
  /** An archive is on its way, as the status says. */
  readonly archiving: () => boolean;
  /** Goes to what a conflict is about, without closing the dialog. */
  readonly locate: (conflict: RepositoryConflict) => void;
  readonly openFile: (path: string) => void;
  /** Opens an address in a new tab, as a commit on GitHub. */
  readonly open: (url: string) => void;
}

export interface PlacesDialogOptions {
  readonly title: string;
  /** Chosen to start with, in place of those the project uses. */
  readonly chosen?: readonly string[];
}

/**
 * "平台存储满了" / "在线项目数满了" (docs/design/online-offline.md of AnimaQuill Cloud, 3.6): a new
 * project, an import or a restore found no room on the platform. It lists what takes the most, or
 * what was changed longest ago where the number is full, from the person's `PlatformSpaceState`,
 * with what makes room. Letting go of a copy goes on in the dialog (`release`), which then answers
 * "freed"; what takes another dialog is answered for whoever showed it to do, see
 * `PlatformFullAnswer`.
 */
export interface PlatformFullOptions {
  /** "平台存储满了（5.0 GB / 5 GB）", as it was as the dialog came up. */
  readonly title: string;
  /** What is full: the number of projects, or the bytes. */
  readonly by: "count" | "storage";
  /** Lets go of the copy of a project, people having said so here: whether it went. */
  readonly release: (project: string, name: string) => Promise<boolean>;
  /** When each project last changed, for "count": milliseconds since 1970, by its id. */
  readonly changedAt?: ReadonlyMap<string, number>;
}

/** What people chose in `PlatformFullOptions`: room was made, or what to do with a project. */
export type PlatformFullAnswer =
  | { readonly kind: "freed" }
  | {
      /** "open": what keeps it is seen to in the project, and what was asked is given up. */
      readonly kind: "saveToFolder" | "delete" | "open";
      readonly project: string;
      readonly name: string;
    };

export type DialogRequest =
  | ({ readonly kind: "prompt"; readonly id: number } & PromptOptions)
  | ({ readonly kind: "confirm"; readonly id: number } & ConfirmOptions)
  | ({ readonly kind: "choice"; readonly id: number } & ChoiceOptions)
  | ({ readonly kind: "form"; readonly id: number } & FormOptions)
  | ({ readonly kind: "repository"; readonly id: number } & RepositoryDialogOptions)
  | ({ readonly kind: "create"; readonly id: number } & CreateDialogOptions)
  | ({ readonly kind: "openRepository"; readonly id: number } & OpenRepositoryDialogOptions)
  | ({ readonly kind: "reconcile"; readonly id: number } & ReconcileDialogOptions)
  | ({ readonly kind: "places"; readonly id: number } & PlacesDialogOptions)
  | ({ readonly kind: "conflicts"; readonly id: number } & ConflictsDialogOptions)
  | ({ readonly kind: "platformFull"; readonly id: number } & PlatformFullOptions)
  | ProgressRequest;

type DialogValue =
  string | boolean | FormAnswer | OpenRepositoryChoice | PlatformFullAnswer | undefined;

/** Asks one thing at a time and answers with a promise. */
export class Dialogs {
  readonly #emitter = new Emitter();
  #nextId = 1;
  #current: DialogRequest | undefined;
  #answer: ((value: DialogValue) => void) | undefined;

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): DialogRequest | undefined => this.#current;

  /** Resolves to the text, or to undefined when cancelled. */
  prompt(options: PromptOptions): Promise<string | undefined> {
    return this.#ask({ kind: "prompt", id: this.#nextId++, ...options }) as Promise<
      string | undefined
    >;
  }

  async confirm(options: ConfirmOptions): Promise<boolean> {
    return (await this.#ask({ kind: "confirm", id: this.#nextId++, ...options })) === true;
  }

  /** Resolves to the id of the choice, or to undefined when cancelled. */
  choose(options: ChoiceOptions): Promise<string | undefined> {
    return this.#ask({ kind: "choice", id: this.#nextId++, ...options }) as Promise<
      string | undefined
    >;
  }

  /** Resolves to what was chosen, or to undefined when cancelled. */
  form(options: FormOptions): Promise<FormAnswer | undefined> {
    return this.#ask({ kind: "form", id: this.#nextId++, ...options }) as Promise<
      FormAnswer | undefined
    >;
  }

  /** Resolves to the option chosen for each file, by its path, or to undefined when cancelled. */
  reconcile(options: ReconcileDialogOptions): Promise<FormAnswer | undefined> {
    return this.#ask({ kind: "reconcile", id: this.#nextId++, ...options }) as Promise<
      FormAnswer | undefined
    >;
  }

  /** Resolves to whether people started to send files, or to false when they cancelled. */
  async places(options: PlacesDialogOptions): Promise<boolean> {
    return (await this.#ask({ kind: "places", id: this.#nextId++, ...options })) === true;
  }

  /** Stays until people close it, or another dialog takes its place. */
  async conflicts(options: ConflictsDialogOptions): Promise<void> {
    await this.#ask({ kind: "conflicts", id: this.#nextId++, ...options });
  }

  /**
   * Resolves to true once the picker saved the project to a repository, and to false when people
   * cancelled or put it off.
   */
  async repository(options: RepositoryDialogOptions): Promise<boolean> {
    return (await this.#ask({ kind: "repository", id: this.#nextId++, ...options })) === true;
  }

  /**
   * Stays until the dialog answers, as it does once making the project is over or given up, see
   * `CloudCreate.cancel`, or another dialog takes its place.
   */
  async create(options: CreateDialogOptions): Promise<void> {
    await this.#ask({ kind: "create", id: this.#nextId++, ...options });
  }

  /** Resolves to what people chose to do with a repository, or undefined where they did not. */
  async openRepository(
    options: OpenRepositoryDialogOptions,
  ): Promise<OpenRepositoryChoice | undefined> {
    const answer = await this.#ask({ kind: "openRepository", id: this.#nextId++, ...options });
    return typeof answer === "object" && "action" in answer
      ? (answer as OpenRepositoryChoice)
      : undefined;
  }

  /** Resolves to what people chose, or undefined where they closed it, see `PlatformFullOptions`. */
  async platformFull(options: PlatformFullOptions): Promise<PlatformFullAnswer | undefined> {
    const answer = await this.#ask({ kind: "platformFull", id: this.#nextId++, ...options });
    return typeof answer === "object" && answer !== null && "kind" in answer
      ? (answer as PlatformFullAnswer)
      : undefined;
  }

  /** Stays until `close`. Like every dialog it takes the place of the one before. */
  progress(options: ProgressOptions): ProgressDialog {
    this.answer(undefined);
    const id = this.#nextId++;
    const controller = new AbortController();
    const change = (state: Partial<ProgressRequest>) => {
      const current = this.#current;
      if (current?.id !== id || current.kind !== "progress") return;
      this.#current = { ...current, ...state };
      this.#emitter.emit();
    };
    this.#current = {
      kind: "progress",
      id,
      ...options,
      stopped: false,
      stop: () => {
        controller.abort();
        change({ stopped: true });
      },
    };
    this.#emitter.emit();
    return {
      signal: controller.signal,
      update: change,
      close: () => {
        if (this.#current?.id === id) this.answer(undefined);
      },
    };
  }

  answer(value: DialogValue): void {
    const answer = this.#answer;
    this.#current = undefined;
    this.#answer = undefined;
    this.#emitter.emit();
    answer?.(value);
  }

  #ask(request: DialogRequest): Promise<DialogValue> {
    this.answer(undefined);
    return new Promise((resolve) => {
      this.#current = request;
      this.#answer = resolve;
      this.#emitter.emit();
    });
  }
}
