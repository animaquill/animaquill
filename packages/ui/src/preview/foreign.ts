import {
  childFrameIndex,
  childFrameOf,
  FOREIGN_MESSAGE_RULES,
  MessageBudget,
} from "@animaquill/scene";

/**
 * How often a sender gets reported. Everything it wrote before it is gone arrives here too, and an
 * index that gets said a second time can be the frame next to it by then.
 */
const REPORT_EVERY_MS = 1000;

/** Where a message without a sender counts. */
const UNKNOWN = {};

/**
 * Everything but the compositor that writes to this page. Nothing has any business doing that, and a
 * scene can reach `top` as easily as `parent`, so this is where a scene that means harm ends up.
 *
 * A message only gets built when somebody reads `event.data`. Reading one big one can take all the
 * memory of this page, and with it everything people are working on. So this never looks at what is
 * in them. It only counts, per sender, and tells the compositor which frame has to go.
 */
export class ForeignMessages {
  readonly #budgets = new WeakMap<object, MessageBudget>();
  readonly #reported = new WeakMap<object, number>();
  readonly #compositor: () => Window | null;
  readonly #evict: (index: number, frames: number) => void;
  readonly #page: Window | undefined;

  /**
   * `evict` gets the index of the frame in the compositor, and how many frames it has: frames that
   * came or went on the way there would make that another one.
   */
  constructor(
    compositor: () => Window | null,
    evict: (index: number, frames: number) => void,
    page: Window | undefined = globalThis.window,
  ) {
    this.#compositor = compositor;
    this.#evict = evict;
    this.#page = page;
  }

  /**
   * Call this with the source of a message, and leave the rest of it alone. What counts is the frame
   * of the scene that sent it: a frame inside a scene costs nothing to make, so a sender that counts
   * on its own could make new ones for ever. Anything else counts by the frame of this page that it
   * is in, which also stops a frame that cannot be told apart from adding up to nothing.
   */
  note(source: MessageEventSource | null, now = performance.now()): void {
    const page = this.#compositor();
    const sender = source as Window | null;
    const scene = page ? childFrameOf(page, sender) : undefined;
    const around = this.#page && childFrameOf(this.#page, sender);
    const key: object = scene ?? around ?? sender ?? UNKNOWN;
    let budget = this.#budgets.get(key);
    if (!budget) {
      budget = new MessageBudget(now, FOREIGN_MESSAGE_RULES);
      this.#budgets.set(key, budget);
    }
    if (budget.admit(now) === "ok") return;
    const reported = this.#reported.get(key);
    if (reported !== undefined && now - reported < REPORT_EVERY_MS) return;
    const index = page && scene ? childFrameIndex(page, scene) : undefined;
    if (!page || index === undefined) return;
    this.#reported.set(key, now);
    this.#evict(index, page.length);
  }
}
