import { Emitter } from "./emitter.ts";

export interface PromptOptions {
  readonly title: string;
  readonly value?: string;
  readonly confirm: string;
}

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
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
  readonly items: readonly string[];
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
