import type { PropertySpec } from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import { formatNumber, parseNumber, scrubbed, type ScrubKeys } from "./scrub.ts";

/** Moving less than this is a click, as on the timeline. */
const CLICK_REACH = 4;

/** What a field shows and whom it tells. */
export interface NumberEditProps {
  readonly spec: PropertySpec;
  /** What dragging starts from. */
  readonly value: number;
  /** The value is not its own but follows something else, so there is nothing to start typing from. */
  readonly automatic: boolean;
  readonly readOnly: boolean;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number) => void;
  readonly onCancel: () => void;
}

export interface NumberEditState {
  /** What is being typed. */
  readonly typed: string | undefined;
  /** Where a drag is right now. */
  readonly dragged: number | undefined;
}

interface Drag {
  readonly pointer: number;
  readonly x: number;
  readonly start: number;
  moved: boolean;
  latest: number | undefined;
}

const IDLE: NumberEditState = { typed: undefined, dragged: undefined };

/**
 * How a number gets changed. Dragging only shows, and letting go writes once. A click, or getting
 * there with Tab, starts typing, which writes on Enter or when leaving. Escape takes it all back.
 * What does not change anything writes nothing, so it leaves nothing to undo.
 */
export class NumberEdit {
  readonly #emitter = new Emitter();
  #props: NumberEditProps;
  #snapshot = IDLE;
  #drag: Drag | undefined;
  /** What typing started with: leaving that as it is changes nothing. */
  #before = "";

  constructor(props: NumberEditProps) {
    this.#props = props;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): NumberEditState => this.#snapshot;

  /** Props change with every render, and a gesture goes on with the latest. */
  update(props: NumberEditProps): void {
    this.#props = props;
  }

  #show(snapshot: NumberEditState): void {
    this.#snapshot = snapshot;
    this.#emitter.emit();
  }

  /** Whether this press is for dragging. A field that is being typed in is an ordinary text box. */
  press(pointer: number, x: number): boolean {
    if (this.#props.readOnly || this.#snapshot.typed !== undefined) return false;
    this.#drag = { pointer, x, start: this.#props.value, moved: false, latest: undefined };
    return true;
  }

  move(pointer: number, x: number, keys: ScrubKeys): void {
    const drag = this.#drag;
    if (drag?.pointer !== pointer) return;
    const pixels = x - drag.x;
    if (!drag.moved && Math.abs(pixels) < CLICK_REACH) return;
    drag.moved = true;
    const next = scrubbed(this.#props.spec, drag.start, pixels, keys);
    if (next === drag.latest) return;
    drag.latest = next;
    this.#show({ ...this.#snapshot, dragged: next });
    this.#props.onPreview(next);
  }

  /** Says whether it was a click after all. */
  release(pointer: number): boolean {
    const drag = this.#drag;
    if (drag?.pointer !== pointer) return false;
    this.#drag = undefined;
    if (!drag.moved) return true;
    this.#show(IDLE);
    if (drag.latest === undefined || drag.latest === drag.start) this.#props.onCancel();
    else this.#props.onCommit(drag.latest);
    return false;
  }

  /** Escape, or the pointer got lost. */
  cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = undefined;
    if (!drag?.moved) return;
    this.#show(IDLE);
    this.#props.onCancel();
  }

  startTyping(): void {
    const { readOnly, automatic, value, spec } = this.#props;
    if (readOnly || this.#snapshot.typed !== undefined) return;
    this.#before = automatic ? "" : formatNumber(value, spec);
    this.#show({ ...this.#snapshot, typed: this.#before });
  }

  type(text: string): void {
    if (this.#snapshot.typed !== undefined) this.#show({ ...this.#snapshot, typed: text });
  }

  get isInvalid(): boolean {
    const { typed } = this.#snapshot;
    return Boolean(typed) && parseNumber(typed as string, this.#props.spec) === undefined;
  }

  /** Writes what was typed. Something that is no number changes nothing. */
  finishTyping(): void {
    const { typed } = this.#snapshot;
    if (typed === undefined) return;
    this.#show({ ...this.#snapshot, typed: undefined });
    if (typed === this.#before) return;
    const number = parseNumber(typed, this.#props.spec);
    if (number !== undefined) this.#props.onCommit(number);
  }

  discardTyping(): void {
    if (this.#snapshot.typed !== undefined) this.#show({ ...this.#snapshot, typed: undefined });
  }

  /**
   * The field goes away, for example because another clip got selected. A drag is taken back, and
   * what was typed still goes to the clip it was typed for: leaving the field would have written it.
   */
  dispose(): void {
    this.cancelDrag();
    this.finishTyping();
  }
}
