import { childFrameIndex, FOREIGN_MESSAGE_RULES, MessageBudget } from "@animaquill/scene";

/**
 * How often a sender gets reported. Everything it wrote before it is gone arrives here too, and an
 * index that gets said a second time can be the frame next to it by then.
 */
const REPORT_EVERY_MS = 1000;

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

  /**
   * `evict` gets the index of the frame in the compositor, and how many frames it has: frames that
   * came or went on the way there would make that another one.
   */
  constructor(compositor: () => Window | null, evict: (index: number, frames: number) => void) {
    this.#compositor = compositor;
    this.#evict = evict;
  }

  /** Call this with the source of a message, and leave the rest of it alone. */
  note(source: MessageEventSource | null, now = performance.now()): void {
    if (!source) return;
    let budget = this.#budgets.get(source);
    if (!budget) {
      budget = new MessageBudget(now, FOREIGN_MESSAGE_RULES);
      this.#budgets.set(source, budget);
    }
    if (budget.admit(now) === "ok") return;
    const reported = this.#reported.get(source);
    if (reported !== undefined && now - reported < REPORT_EVERY_MS) return;
    const page = this.#compositor();
    const index = page ? childFrameIndex(page, source as Window) : undefined;
    if (!page || index === undefined) return;
    this.#reported.set(source, now);
    this.#evict(index, page.length);
  }
}
