/** The compositor answers right away unless it hangs, and that should not cost the keyboard too. */
const NO_ANSWER_MS = 30;

/**
 * Keeps the keyboard with the editor. Code in a scene can take the focus in ways nothing can stop,
 * which would leave people typing into a scene, with no shortcut working and nothing to see.
 *
 * Taking it back is not enough, because the scene can go on doing it. Who took it can only be told
 * from the compositor, and only while it still has it, so the compositor gets asked first. It counts,
 * and takes a frame away that does this again and again. Taking it back in the `blur` event itself
 * would look as if it worked, while keys go on going to the frame: the browser is not done yet.
 */
export class KeyboardKeeper {
  readonly #frame: HTMLIFrameElement;
  readonly #ask: (request: number) => void;
  /** The page of the frame, which can be a window of its own. */
  readonly #document: Document;
  /** The window of that page, when it is not this one. */
  readonly #view: Window | undefined;
  #lastRequest = 0;
  /** What the keyboard goes back to, if it was anywhere. */
  #focused: HTMLElement | undefined;
  #answered: (() => void) | undefined;

  constructor(
    frame: HTMLIFrameElement,
    ask: (request: number) => void,
    page: Document = frame.ownerDocument ?? document,
  ) {
    this.#frame = frame;
    this.#ask = ask;
    this.#document = page;
    this.#view = page.defaultView ?? undefined;
    page.addEventListener("focusin", this.#onFocusIn);
    (this.#view ?? globalThis).addEventListener("blur", this.#onBlur);
  }

  dispose(): void {
    this.#document.removeEventListener("focusin", this.#onFocusIn);
    (this.#view ?? globalThis).removeEventListener("blur", this.#onBlur);
  }

  /** The compositor has looked at who it was. */
  checked(request: number): void {
    if (request === this.#lastRequest) this.#answered?.();
  }

  #onFocusIn = ({ target }: FocusEvent): void => {
    if (target !== this.#frame) this.#focused = target as HTMLElement;
  };

  #onBlur = (): void => {
    if (this.#document.activeElement !== this.#frame || this.#answered) return;
    this.#lastRequest += 1;
    const takeBack = () => {
      if (!this.#answered) return;
      this.#answered = undefined;
      clearTimeout(timer);
      (this.#view ?? window).focus();
      if (this.#focused?.isConnected) this.#focused.focus();
      else this.#frame.blur();
    };
    const timer = setTimeout(takeBack, NO_ANSWER_MS);
    this.#answered = takeBack;
    this.#ask(this.#lastRequest);
  };
}
