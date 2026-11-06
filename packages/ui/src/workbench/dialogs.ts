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
}

export type DialogRequest =
  | ({ readonly kind: "prompt"; readonly id: number } & PromptOptions)
  | ({ readonly kind: "confirm"; readonly id: number } & ConfirmOptions);

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
