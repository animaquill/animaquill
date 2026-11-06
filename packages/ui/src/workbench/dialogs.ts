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
  | ProgressRequest;

/** Asks one thing at a time and answers with a promise. */
export class Dialogs {
  readonly #emitter = new Emitter();
  #nextId = 1;
  #current: DialogRequest | undefined;
  #answer: ((value: string | boolean | undefined) => void) | undefined;

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

  answer(value: string | boolean | undefined): void {
    const answer = this.#answer;
    this.#current = undefined;
    this.#answer = undefined;
    this.#emitter.emit();
    answer?.(value);
  }

  #ask(request: DialogRequest): Promise<string | boolean | undefined> {
    this.answer(undefined);
    return new Promise((resolve) => {
      this.#current = request;
      this.#answer = resolve;
      this.#emitter.emit();
    });
  }
}
