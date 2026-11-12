import type { CloudConnect } from "../cloud/connect.ts";
import type { CloudCreate } from "../cloud/create.ts";
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
  /** Lists below the message, which can get long. */
  readonly details?: readonly DialogDetail[];
}

export interface ChoiceOptions {
  readonly title: string;
  readonly message: string;
  /** In the order of the buttons. Cancelling is always there, in front of them. */
  readonly choices: readonly DialogChoice[];
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

/** Connecting the open project to the platform in one dialog, see `CloudConnect`. */
export interface ConnectDialogOptions {
  /** What it is called as it opens: the dialog says the same, and follows what it finds out. */
  readonly title: string;
  readonly connect: CloudConnect;
}

/** Making a new project: of this computer, or of the platform, see `CloudCreate`. */
export interface CreateDialogOptions {
  readonly title: string;
  readonly create: CloudCreate;
  /** What is made is a project that people imported, see `Workbench.importProject`. */
  readonly imported?: boolean;
}

/** A file of the project that two sides have differently, for people to choose a side for. */
export interface ReconcileItem {
  readonly path: string;
  /** How the two sides have it, in words. */
  readonly status: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly value: string;
}

/** Which side each file is to be, see `ReconcileItem`, as one choice for every file. */
export interface ReconcileDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly items: readonly ReconcileItem[];
  /** Choices for every file at once, by the id of the option. */
  readonly all: readonly { readonly id: string; readonly label: string }[];
  readonly notes: readonly string[];
  /** Why the last choices could not be carried out. */
  readonly error?: string;
  readonly confirm: string;
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

export type DialogRequest =
  | ({ readonly kind: "prompt"; readonly id: number } & PromptOptions)
  | ({ readonly kind: "confirm"; readonly id: number } & ConfirmOptions)
  | ({ readonly kind: "choice"; readonly id: number } & ChoiceOptions)
  | ({ readonly kind: "form"; readonly id: number } & FormOptions)
  | ({ readonly kind: "repository"; readonly id: number } & RepositoryDialogOptions)
  | ({ readonly kind: "connect"; readonly id: number } & ConnectDialogOptions)
  | ({ readonly kind: "create"; readonly id: number } & CreateDialogOptions)
  | ({ readonly kind: "reconcile"; readonly id: number } & ReconcileDialogOptions)
  | ProgressRequest;

type DialogValue = string | boolean | FormAnswer | undefined;

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

  /**
   * Resolves to true once the picker saved the project to a repository, and to false when people
   * cancelled or put it off.
   */
  async repository(options: RepositoryDialogOptions): Promise<boolean> {
    return (await this.#ask({ kind: "repository", id: this.#nextId++, ...options })) === true;
  }

  /**
   * Stays until the dialog answers, which it does once connecting is over or given up, see
   * `CloudConnect.cancel`. Another dialog that takes its place ends it too: whoever asked looks at
   * what the connection came to then.
   */
  async connect(options: ConnectDialogOptions): Promise<void> {
    await this.#ask({ kind: "connect", id: this.#nextId++, ...options });
  }

  /**
   * Stays until the dialog answers, as it does once making the project is over or given up, see
   * `CloudCreate.cancel`, or another dialog takes its place.
   */
  async create(options: CreateDialogOptions): Promise<void> {
    await this.#ask({ kind: "create", id: this.#nextId++, ...options });
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
