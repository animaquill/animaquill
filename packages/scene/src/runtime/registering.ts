import { REGISTRATION_LIMITS, type SceneElement } from "@animaquill/core/registration";
import type { ObjectDescriptor } from "@animaquill/schema/properties";
import { MESSAGE_RULES, TokenBucket, weightOf } from "../budget.ts";
import type { FromScene } from "../protocol.ts";

/** What a registration is made of, as it is now. */
export interface RegistrationParts {
  objects(): readonly ObjectDescriptor[];
  elements(): readonly SceneElement[];
  /** The parameters code read on the way, with what the clip held for them then. */
  params(): Readonly<Record<string, unknown>>;
  /** Whether code registered everything it wanted to, as far as it can tell. */
  settled(): boolean;
}

export interface RegistrationHooks {
  send(message: FromScene): void;
  report(code: string, target?: string): void;
  /** Real time, in milliseconds. */
  now(): number;
  later(run: () => void, ms: number): void;
}

/** A registration goes again after a change, and not more often than this. */
export const REGISTRATION_EVERY_MS = 1000;
/**
 * What registrations may weigh, so that a scene stays well within what the compositor allows: one
 * as long as it can be, and then a little more as time goes on. Everything else a scene says is
 * small, and pictures do not count.
 */
export const REGISTRATION_BURST = MESSAGE_RULES.maxRegistrationBytes;
export const REGISTRATION_BYTES_PER_SECOND = 256 * 1024;

const stringify = JSON.stringify;

/**
 * Tells the editor what code registered and which elements there are: once the first frame ran,
 * because code may register in there, and again whenever that changes, after a moment. What did not
 * change does not go again. What is too long loses what came last, and too much at once would take
 * the scene away, so then the editor only hears that what it has is not all there is, and the rest
 * comes later. Whatever keeps it from being all there is gets said, without saying all of it again.
 */
export class RegistrationSender {
  readonly #parts: RegistrationParts;
  readonly #hooks: RegistrationHooks;
  readonly #bytes: TokenBucket;
  #framesRan = false;
  #failed = false;
  #cut = false;
  #waiting = false;
  #sent = Number.NEGATIVE_INFINITY;
  #told: { readonly body: string; readonly complete: boolean } | undefined;
  #saidTooMuch = false;

  constructor(parts: RegistrationParts, hooks: RegistrationHooks) {
    this.#parts = parts;
    this.#hooks = hooks;
    this.#bytes = new TokenBucket(REGISTRATION_BURST, REGISTRATION_BYTES_PER_SECOND, hooks.now());
  }

  /** The frame callbacks ran once: what code registers in there is there from now on. */
  framesRan(): void {
    if (this.#framesRan) return;
    this.#framesRan = true;
    this.changed();
  }

  /** Code threw: what came after it may never have registered. That stays. */
  failed(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.changed();
  }

  /** Something about what is registered changed. It goes after a moment, with what else changes. */
  changed(): void {
    if (!this.#framesRan) return;
    this.#later(Math.max(REGISTRATION_EVERY_MS - (this.#hooks.now() - this.#sent), 0));
  }

  #later(ms: number): void {
    if (this.#waiting) return;
    this.#waiting = true;
    this.#hooks.later(() => this.#send(), ms);
  }

  /** A registration as JSON, as long as it may be. Leaves out what comes last when it is longer. */
  #body(): string {
    const all = this.#parts.objects();
    const rest = { elements: this.#parts.elements(), params: this.#parts.params() };
    const bodyOf = (count: number) => stringify({ objects: all.slice(0, count), ...rest });
    // Room for what goes in front of it.
    const limit = REGISTRATION_LIMITS.text - 32;
    let fits = all.length;
    const whole = bodyOf(fits);
    if (whole.length <= limit) return whole;
    let low = 0;
    while (low < fits) {
      const middle = (low + fits + 1) >> 1;
      if (bodyOf(middle).length > limit) fits = middle - 1;
      else low = middle;
    }
    if (!this.#cut) this.#hooks.report("object-too-many", "bytes");
    this.#cut = true;
    return bodyOf(fits);
  }

  #unsure(): void {
    if (!this.#told?.complete) return;
    this.#hooks.send({ type: "objects-unsure" });
    this.#told = { ...this.#told, complete: false };
  }

  #send(): void {
    this.#waiting = false;
    const body = this.#body();
    const complete = !this.#failed && !this.#cut && this.#parts.settled();
    if (this.#told?.body === body) {
      if (!complete) this.#unsure();
      return;
    }
    const registration = `{"complete":${complete},${body.slice(1)}`;
    const message: FromScene = { type: "objects", registration };
    const weight = weightOf(message, MESSAGE_RULES.maxRegistrationBytes);
    if (!this.#bytes.take(weight, this.#hooks.now())) {
      this.#unsure();
      if (!this.#saidTooMuch) this.#hooks.report("object-churn");
      this.#saidTooMuch = true;
      this.#later((weight / REGISTRATION_BYTES_PER_SECOND) * 1000);
      return;
    }
    this.#sent = this.#hooks.now();
    this.#told = { body, complete };
    this.#hooks.send(message);
  }
}
